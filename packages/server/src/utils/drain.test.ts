import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { drainServer, once, registerWebSocketServer } from './drain.js';

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
    async function startWs() {
      const { server, get } = await start(400);
      const wss = new WebSocketServer({ noServer: true });
      registerWebSocketServer(wss);
      server.on('upgrade', (req, socket, head) =>
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      );
      const { port } = server.address() as AddressInfo;
      const client = new WebSocket(`ws://127.0.0.1:${port}/socket`);
      await new Promise((r) => client.once('open', r));
      const closed = new Promise<number>((r) => client.once('close', (c) => r(c)));
      return { server, get, client, closed };
    }

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
      // A client that ignores the close handshake.
      (client as unknown as { _receiver: { removeAllListeners(): void } })._receiver.removeAllListeners();
      const startedAt = Date.now();
      expect(await drainServer(server, 10_000)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3000);
    });
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
