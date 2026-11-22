import type { Server } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';

interface SocketServerOptions {
  /**
   * Runs, awaited, before the drain tells this server's clients 1001; for a
   * server whose clients' state has to be handed over while they are still
   * connected. A failure is ignored: the clients are closed regardless.
   */
  beforeClose?: () => Promise<void>;
}

/** WebSocket servers whose clients the drain says goodbye to. */
const socketServers = new Map<WebSocketServer, SocketServerOptions>();
/** How long a client gets to answer the close frame before its socket is destroyed. */
const CLOSE_GRACE_MS = 1000;
/** Set while a drain runs: a client that connects then is told to go at once. */
let draining = false;

/**
 * Registers a WebSocket server (made with `noServer`) for the drain. An
 * upgraded socket is invisible to `closeIdleConnections()` and
 * `closeAllConnections()`, yet `server.close()` waits for it, so the drain
 * closes these itself. Register before adding the server's own `connection`
 * listener, so a socket upgraded during a drain (one whose async sign-in
 * finished late) is closed before anything else sees it.
 */
export function registerWebSocketServer(
  wss: WebSocketServer,
  options: SocketServerOptions = {}
): void {
  socketServers.set(wss, options);
  wss.on('connection', (ws: WebSocket) => {
    if (draining) goAway(ws);
  });
  wss.once('close', () => socketServers.delete(wss));
}

/** Closes a client with 1001 "going away"; a straggler is terminated after a short grace. */
function goAway(ws: WebSocket): void {
  try {
    ws.close(1001, 'Server restarting');
  } catch {
    ws.terminate();
    return;
  }
  const t = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
  t.unref();
  ws.once('close', () => clearTimeout(t));
}

/** Tells every registered server's clients to go, each server after its `beforeClose`. */
function closeWebSocketClients(): void {
  for (const [wss, { beforeClose }] of socketServers) {
    const sweep = () => {
      for (const ws of wss.clients) goAway(ws);
    };
    if (!beforeClose) sweep();
    else void beforeClose().then(sweep, sweep);
  }
}

/** Cuts every registered client that is still open. */
function terminateWebSocketClients(): void {
  for (const wss of socketServers.keys())
    for (const ws of wss.clients) ws.terminate();
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
 * Awaits `shutdown`, then always exits: 0 when it finished, 1 when a step
 * threw (after `onError` is told). Without this a failed teardown leaves the
 * process up with its HTTP server closed, and `once()` hands every later
 * signal the same rejected promise, so it stays up until SIGKILL.
 */
export async function exitAfterShutdown(
  shutdown: () => Promise<unknown>,
  onError: (err: unknown) => void,
  exit: (code: number) => void = (code) => process.exit(code)
): Promise<void> {
  let code = 0;
  try {
    await shutdown();
  } catch (err) {
    code = 1;
    onError(err);
  } finally {
    exit(code);
  }
}

/**
 * Stops taking connections and waits for the requests already being answered,
 * so a rolling update's old container finishes them before it exits. Idle
 * keep-alive connections are closed at once; whatever is still open after
 * `timeoutMs` (a playing stream, say) is cut so shutdown never hangs.
 * WebSocket clients are told 1001 up front (a server's after its
 * `beforeClose`), as is any that connects while the drain runs, so apps
 * reconnect to the new container and `close()` can call back once the HTTP
 * requests finish; the timeout terminates the ones still open.
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
      draining = false;
      clearTimeout(timer);
      resolve(inTime);
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      terminateWebSocketClients();
      done(false);
    }, timeoutMs);
    timer.unref();
    draining = true;
    server.close(() => done(true));
    closeWebSocketClients();
    server.closeIdleConnections();
  });
}
