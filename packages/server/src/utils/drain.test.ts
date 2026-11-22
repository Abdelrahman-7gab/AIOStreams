import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  drainServer,
  exitAfterShutdown,
  once,
  registerWebSocketServer,
} from './drain.js';

/** A server whose `/slow` answers after `slowMs` and `/hang` never does. */
async function start(slowMs: number) {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') setTimeout(() => res.end('done'), slowMs);
    else if (req.url === '/hang') res.write('partial');
    else res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const get = (path: string) =>
    new Promise<{ status?: number; body: string; error?: string }>(
      (resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
          res.on('error', (e) => resolve({ body, error: e.message }));
        });
        req.on('error', (e) => resolve({ body: '', error: e.message }));
      }
    );
  return { server, get };
}

describe('drainServer', () => {
  it('lets a request in flight finish, then closes', async () => {
    const { server, get } = await start(300);
    const inFlight = get('/slow');
    await new Promise((r) => setTimeout(r, 50));
    const drained = drainServer(server, 5000);
    expect(await inFlight).toEqual({ status: 200, body: 'done' });
    expect(await drained).toBe(true);
    expect(server.listening).toBe(false);
  });

  it('takes no new connections while draining', async () => {
    const { server, get } = await start(300);
    const inFlight = get('/slow');
    await new Promise((r) => setTimeout(r, 50));
    const drained = drainServer(server, 5000);
    const late = await get('/');
    expect(late.error).toBeDefined();
    await inFlight;
    await drained;
  });

  it('cuts what is still open after the timeout', async () => {
    const { server, get } = await start(0);
    const hanging = get('/hang');
    await new Promise((r) => setTimeout(r, 50));
    const startedAt = Date.now();
    expect(await drainServer(server, 200)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    // The client got what was sent, then the connection was closed under it.
    const cut = await hanging;
    expect(cut.body).toBe('partial');
    expect(cut.error).toBeDefined();
  });

  it('does nothing for a server that is not listening', async () => {
    expect(await drainServer(undefined, 100)).toBe(true);
    expect(await drainServer(http.createServer(), 100)).toBe(true);
  });

  describe('with WebSocket clients', () => {
    /**
     * A registered server; `authMs` delays each upgrade the way the Jellyfin
     * socket's sign-in check does, and `beforeClose` is passed to the drain.
     */
    async function startWs(
      opts: { authMs?: number; beforeClose?: () => Promise<void> } = {}
    ) {
      const { server, get } = await start(400);
      const wss = new WebSocketServer({ noServer: true });
      registerWebSocketServer(wss, { beforeClose: opts.beforeClose });
      server.on('upgrade', (req, socket, head) => {
        const upgrade = () =>
          wss.handleUpgrade(req, socket, head, (ws) =>
            wss.emit('connection', ws, req)
          );
        if (opts.authMs) setTimeout(upgrade, opts.authMs);
        else upgrade();
      });
      const { port } = server.address() as AddressInfo;
      const connect = () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`);
        const opened = new Promise<void>((r) => ws.once('open', () => r()));
        const closed = new Promise<{ code: number; at: number }>((r) =>
          ws.once('close', (code) => r({ code, at: Date.now() }))
        );
        return { ws, opened, closed };
      };
      const first = connect();
      await first.opened;
      const closed = first.closed.then((c) => c.code);
      return {
        server,
        get,
        wss,
        client: first.ws,
        closed,
        connect,
        firstClosed: first.closed,
      };
    }

    /** Makes a client ignore the close handshake, so only a terminate ends it. */
    const deaf = (client: WebSocket) =>
      (
        client as unknown as { _receiver: { removeAllListeners(): void } }
      )._receiver.removeAllListeners();

    it('closes sockets with 1001 and finishes well under the window', async () => {
      const { server, closed } = await startWs();
      const startedAt = Date.now();
      expect(await drainServer(server, 10_000)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(await closed).toBe(1001);
    });

    it('still lets an in-flight request finish while sockets close', async () => {
      const { server, get, closed } = await startWs();
      const inFlight = get('/slow');
      await new Promise((r) => setTimeout(r, 50));
      expect(await drainServer(server, 10_000)).toBe(true);
      expect(await inFlight).toEqual({ status: 200, body: 'done' });
      expect(await closed).toBe(1001);
    });

    it('terminates a client that never answers the close frame', async () => {
      const { server, client } = await startWs();
      deaf(client);
      const startedAt = Date.now();
      expect(await drainServer(server, 10_000)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3000);
    });

    it('closes with 1001 a socket upgraded after the drain started, and still finishes early', async () => {
      // The sign-in check of the second client is still running when the drain starts.
      const { server, connect } = await startWs({ authMs: 300 });
      const late = connect();
      await new Promise((r) => setTimeout(r, 50));
      const startedAt = Date.now();
      expect(await drainServer(server, 4000)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect((await late.closed).code).toBe(1001);
    }, 10_000);

    it('terminates the clients still open when the timeout fires', async () => {
      const { server, client, firstClosed } = await startWs();
      deaf(client);
      const startedAt = Date.now();
      // Shorter than the close frame's grace, so only the timeout can end it.
      expect(await drainServer(server, 200)).toBe(false);
      const { at } = await firstClosed;
      expect(at - startedAt).toBeLessThan(600);
    });

    it("awaits a server's beforeClose before telling its clients 1001", async () => {
      const events: string[] = [];
      const beforeClose = vi.fn(async () => {
        events.push('beforeClose started');
        await new Promise((r) => setTimeout(r, 300));
        events.push('beforeClose done');
      });
      const { server, wss, closed, connect } = await startWs({
        authMs: 100,
        beforeClose,
      });
      // Its sign-in finishes while beforeClose runs: it is turned away at once.
      const late = connect();
      void late.closed.then(({ code }) =>
        events.push(`late client closed ${code}`)
      );
      const firstClosed = closed.then((code) => {
        events.push(`client closed ${code}`);
      });
      await new Promise((r) => setTimeout(r, 20));
      const startedAt = Date.now();
      expect(await drainServer(server, 10_000)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      await firstClosed;
      expect(beforeClose).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        'beforeClose started',
        'late client closed 1001',
        'beforeClose done',
        'client closed 1001',
      ]);
      wss.close();
    });

    it('still closes the clients when beforeClose fails', async () => {
      const { server, wss, closed } = await startWs({
        beforeClose: () => Promise.reject(new Error('store down')),
      });
      expect(await drainServer(server, 10_000)).toBe(true);
      expect(await closed).toBe(1001);
      wss.close();
    });
  });
});

describe('exitAfterShutdown', () => {
  it('exits 0 once the shutdown finishes', async () => {
    const exit = vi.fn();
    const onError = vi.fn();
    await exitAfterShutdown(async () => undefined, onError, exit);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('logs and exits 1 when a teardown step throws', async () => {
    const exit = vi.fn();
    const onError = vi.fn();
    const err = new Error('closeDb failed');
    await exitAfterShutdown(() => Promise.reject(err), onError, exit);
    expect(onError).toHaveBeenCalledExactlyOnceWith(err);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 even when logging the failure throws', async () => {
    const exit = vi.fn();
    await exitAfterShutdown(
      () => Promise.reject(new Error('boom')),
      () => {
        throw new Error('logger gone');
      },
      exit
    ).catch(() => undefined);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits on a second signal too when the first shutdown failed', async () => {
    const exit = vi.fn();
    const shutdown = once(() => Promise.reject(new Error('boom')));
    await exitAfterShutdown(shutdown, () => undefined, exit);
    await exitAfterShutdown(shutdown, () => undefined, exit);
    expect(exit.mock.calls).toEqual([[1], [1]]);
  });
});

describe('once', () => {
  it('runs the teardown once and the second call waits for the first', async () => {
    const events: string[] = [];
    const run = once(async () => {
      events.push('start');
      await new Promise((r) => setTimeout(r, 100));
      events.push('end');
      return 7;
    });
    const first = run();
    const second = run();
    expect(second).toBe(first);
    expect(await second).toBe(7);
    expect(events).toEqual(['start', 'end']);
  });
});
