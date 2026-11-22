import type { Server } from 'node:http';

/**
 * Stops taking connections and waits for the requests already being answered,
 * so a rolling update's old container finishes them before it exits. Idle
 * keep-alive connections are closed at once; whatever is still open after
 * `timeoutMs` (a playing stream, say) is cut so shutdown never hangs.
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
    server.closeIdleConnections();
  });
}
