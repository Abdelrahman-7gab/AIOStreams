import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

/** WebSocket servers whose clients the drain says goodbye to. */
const socketServers = new Set<WebSocketServer>();
/** How long a client gets to answer the close frame before its socket is destroyed. */
const CLOSE_GRACE_MS = 1000;

/**
 * Registers a WebSocket server (made with `noServer`) for the drain. An
 * upgraded socket is invisible to `closeIdleConnections()` and
 * `closeAllConnections()`, yet `server.close()` waits for it, so the drain
 * closes these itself.
 */
export function registerWebSocketServer(wss: WebSocketServer): void {
  socketServers.add(wss);
}

/** Closes every registered client with 1001 "going away"; the stragglers are terminated after a short grace. */
function closeWebSocketClients(): void {
  for (const wss of socketServers) {
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'Server restarting');
      } catch {
        ws.terminate();
        continue;
      }
      const t = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
      t.unref();
      ws.once('close', () => clearTimeout(t));
    }
  }
}

/**
 * Runs `teardown` once; a second caller gets the first run's promise, so a
 * repeated signal waits for the shutdown in progress instead of starting
 * another that closes things under it.
 */
export function once<T>(teardown: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => (running ??= teardown());
}

/**
 * Stops taking connections and waits for the requests already being answered,
 * so a rolling update's old container finishes them before it exits. Idle
 * keep-alive connections are closed at once; whatever is still open after
 * `timeoutMs` (a playing stream, say) is cut so shutdown never hangs.
 * WebSocket clients are told 1001 up front so apps reconnect to the new
 * container and `close()` can call back once the HTTP requests finish.
 * Resolves true when everything finished in time.
 */
export function drainServer(
  server: Server | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!server || !server.listening) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (inTime: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(inTime);
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      done(false);
    }, timeoutMs);
    timer.unref();
    server.close(() => done(true));
    closeWebSocketClients();
    server.closeIdleConnections();
  });
}
