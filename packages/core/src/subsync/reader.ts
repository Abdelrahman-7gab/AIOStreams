import { appConfig, makeRequest, readBodyUpTo } from '../utils/index.js';
import { ReadError, type ByteReader } from './byte-reader.js';

/** The most one read asks for; `readAll` asks again for the rest. */
const MAX_READ = 4 * 1024 * 1024;
const MAX_HOPS = 6;

/**
 * This server's own playback links go to the port it listens on rather than
 * out through the public address and back.
 */
export function selfRouted(url: string): string {
  const base = appConfig.bootstrap.baseUrl?.replace(/\/+$/, '');
  if (!base || !url.startsWith(`${base}/`)) return url;
  const own =
    appConfig.bootstrap.internalUrl?.replace(/\/+$/, '') ||
    `http://127.0.0.1:${appConfig.bootstrap.port}`;
  return own + url.slice(base.length);
}

/**
 * Where `url` ends up after its redirects: a playback link answers with the
 * debrid service's file, which is read from there on.
 */
export async function finalUrl(
  url: string,
  timeoutMs: number
): Promise<string> {
  let current = selfRouted(url);
  // Only the answer's status and headers are wanted: the body is dropped unread.
  const ask = async (target: string, ranged: boolean) => {
    const res = await makeRequest(target, {
      timeout: timeoutMs,
      method: 'GET',
      rawOptions: { redirect: 'manual' },
      ignoreRecursion: true,
      headers: ranged ? { Range: 'bytes=0-0' } : {},
    });
    res.body?.cancel().catch(() => {});
    return res;
  };
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let res = await ask(current, true);
    // Some download servers refuse a one-byte range; asked plainly they answer.
    if (hop > 0 && (res.status === 400 || res.status === 416))
      res = await ask(current, false);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location)
        throw new Error(`redirect ${res.status} without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status >= 400) {
      // A bare request, without this server's usual headers, shows whether
      // something those add is what the file's server refuses.
      const bare = await plainAnswer(current, timeoutMs);
      if (bare.status >= 200 && bare.status < 300) return current;
      throw new Error(
        `${new URL(current).host} answered ${res.status} after ${hop} redirect${hop === 1 ? '' : 's'}` +
          `; asked bare it answered ${bare.status} (${bare.server}): ${bare.text}`
      );
    }
    return current;
  }
  throw new Error('too many redirects to the file');
}

/** The status, server and first words of the answer to a request with no extra headers. */
async function plainAnswer(url: string, timeoutMs: number) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let text = '';
    if (res.status >= 400) {
      const { body } = await readBodyUpTo(res, 300);
      text = body
        .toString('utf8')
        .replace(/\s+/g, ' ')
        .replace(/[A-Za-z0-9_-]{24,}/g, '…')
        .slice(0, 200);
    } else res.body?.cancel().catch(() => {});
    return {
      status: res.status,
      server: res.headers.get('server') ?? '?',
      text,
    };
  } catch (error) {
    return {
      status: 0,
      server: '?',
      text: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Reads byte ranges of the file at `url`, which must already be its final address. */
export function rangeReader(url: string, timeoutMs: number): ByteReader {
  return {
    async read(start, length) {
      const want = Math.min(length, MAX_READ);
      const res = await makeRequest(url, {
        timeout: timeoutMs,
        method: 'GET',
        ignoreRecursion: true,
        headers: { Range: `bytes=${start}-${start + want - 1}` },
      });
      if (res.status === 416) {
        res.body?.cancel().catch(() => {});
        return new Uint8Array(0);
      }
      // A whole-file answer is only usable when the read starts at the top.
      if (res.status !== 206 && !(res.status === 200 && start === 0)) {
        res.body?.cancel().catch(() => {});
        throw new ReadError(
          `the file answered ${res.status} to a range read`,
          res.status < 500
        );
      }
      const { body } = await readBodyUpTo(res, want);
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    },
  };
}
