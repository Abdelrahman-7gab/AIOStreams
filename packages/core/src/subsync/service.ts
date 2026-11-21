import { createHash } from 'node:crypto';
import {
  Cache,
  createLogger,
  makeRequest,
  readBodyCapped,
} from '../utils/index.js';
import type { Span } from './align.js';
import { planRetime, type PlanNote } from './plan.js';
import { finalUrl } from './reader.js';
import { applyPlan, readTimes } from './retime.js';
import { pickReference, readFileTimings } from './timings.js';

const logger = createLogger('subsync');

const OFFERED_TTL_S = 6 * 3600;
const LINK_TTL_S = 24 * 3600;
const REFERENCE_TTL_S = 24 * 3600;
/** A file without usable timings is asked again after this, in case a read failed. */
const NO_REFERENCE_TTL_S = 3600;
const FILE_TIMEOUT_MS = 20_000;
const SUBTITLE_TIMEOUT_MS = 20_000;
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
/** Fewer lines than this is a placeholder (such as "translating…"), not a subtitle. */
const MIN_LINES = 30;
/** Delays smaller than this leave a subtitle as it is. */
const IN_SYNC_MS = 150;
const MAX_OFFERED = 300;

/** On unless `SUBTITLE_SYNC_ENABLED=false`. */
export function subtitleSyncEnabled(): boolean {
  return process.env.SUBTITLE_SYNC_ENABLED?.toLowerCase() !== 'false';
}

/** A file this server offered a user for a title: its playback link and what Stremio knows it by. */
export interface OfferedFile {
  url: string;
  filename?: string;
  size?: number;
}

/** A synced subtitle link: the subtitle it retimes and the file it is timed to. */
export interface SyncLink {
  subtitleUrl: string;
  fileUrl: string;
  /** What the file's timings are kept under, the same for every link to it. */
  fileKey: string;
}

/*
 * Kept in memory only, each within a byte budget (256 MB in all), dropping the
 * least recently used past it and every entry once its time is up.
 */
const MB = 1024 * 1024;
/** Strings count two bytes a character, as V8 may hold them. */
const textBytes = (...texts: (string | undefined)[]) =>
  texts.reduce((sum, t) => sum + (t?.length ?? 0) * 2, 64);

const offered = () =>
  Cache.getInstance<string, OfferedFile[]>(
    'subsync-offered',
    64 * MB,
    'memory',
    {
      sizeOf: (files: OfferedFile[]) =>
        files.reduce((sum, f) => sum + textBytes(f.url, f.filename), 64),
    }
  );
const links = () =>
  Cache.getInstance<string, SyncLink>('subsync-links', 32 * MB, 'memory', {
    sizeOf: (l: SyncLink) => textBytes(l.subtitleUrl, l.fileUrl, l.fileKey),
  });
const references = () =>
  Cache.getInstance<string, Span[] | 'none'>(
    'subsync-reference',
    32 * MB,
    'memory',
    {
      // A span is an object of two numbers, about 48 bytes.
      sizeOf: (spans: Span[] | 'none') =>
        spans === 'none' ? 64 : spans.length * 48 + 64,
    }
  );
const synced = () =>
  Cache.getInstance<string, { body: string; contentType: string }>(
    'subsync-body',
    128 * MB,
    'memory',
    {
      sizeOf: (b: { body: string; contentType: string }) =>
        textBytes(b.body, b.contentType),
    }
  );

const hash = (text: string) =>
  createHash('sha256').update(text).digest('base64url').slice(0, 32);

const titleKey = (scope: string, type: string, id: string) =>
  `${scope}|${type}|${id}`;

/** Remembers the files offered for a title, for the subtitle request that follows a play. */
export async function rememberOffered(
  scope: string,
  type: string,
  id: string,
  files: OfferedFile[]
): Promise<void> {
  const usable = files.filter((f) => f.url && (f.filename || f.size));
  if (!usable.length) return;
  await offered().set(
    titleKey(scope, type, id),
    usable.slice(0, MAX_OFFERED),
    OFFERED_TTL_S
  );
}

const baseName = (name: string) => {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Already plain.
  }
  return decoded.split(/[\\/]/).pop()!.trim().toLowerCase();
};

/** The offered file a subtitle request's file name and size name, if any. */
export async function findOffered(
  scope: string,
  type: string,
  id: string,
  playing: { filename?: string; size?: number }
): Promise<OfferedFile | undefined> {
  const files = await offered().get(titleKey(scope, type, id));
  if (!files?.length) return undefined;
  const name = playing.filename ? baseName(playing.filename) : undefined;
  const sameName = (f: OfferedFile) =>
    !!name && !!f.filename && baseName(f.filename) === name;
  const sameSize = (f: OfferedFile) =>
    !!playing.size && !!f.size && f.size === playing.size;
  return (
    files.find((f) => sameName(f) && sameSize(f)) ??
    files.find(sameSize) ??
    files.find(sameName)
  );
}

/** A token for a synced link to `subtitleUrl` timed to `file`. */
export async function createSyncLink(
  subtitleUrl: string,
  file: OfferedFile
): Promise<{ token: string; link: SyncLink }> {
  const fileKey = hash(
    file.size && file.filename
      ? `${baseName(file.filename)}|${file.size}`
      : file.url
  );
  const token = hash(`${subtitleUrl}|${fileKey}`);
  const link = { subtitleUrl, fileUrl: file.url, fileKey };
  await links().set(token, link, LINK_TTL_S);
  return { token, link };
}

export const getSyncLink = (token: string) => links().get(token);

const loading = new Map<string, Promise<Span[] | null>>();

/** The file's own subtitle timings, read once per file however many ask. */
export function referenceFor(link: SyncLink): Promise<Span[] | null> {
  const running = loading.get(link.fileKey);
  if (running) return running;
  const load = (async () => {
    const kept = await references().get(link.fileKey);
    if (kept) return kept === 'none' ? null : kept;
    const started = Date.now();
    let reference: Span[] | null = null;
    try {
      const url = await finalUrl(link.fileUrl, FILE_TIMEOUT_MS);
      const tracks = await readFileTimings(url, FILE_TIMEOUT_MS);
      reference = tracks ? pickReference(tracks) : null;
      logger.debug(
        {
          tracks: tracks?.map(
            (t) =>
              `${t.number}:${t.language ?? '?'}:${t.kind}:${t.lines.length}`
          ),
          referenceLines: reference?.length ?? 0,
          ms: Date.now() - started,
        },
        'read the file’s subtitle timings'
      );
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'could not read the file’s subtitle timings'
      );
    }
    await references().set(
      link.fileKey,
      reference ?? 'none',
      reference ? REFERENCE_TTL_S : NO_REFERENCE_TTL_S
    );
    return reference;
  })().finally(() => loading.delete(link.fileKey));
  loading.set(link.fileKey, load);
  return load;
}

export interface SubtitleAnswer {
  /** Bytes as the client gets them: the subtitle's own, with only the times changed. */
  body: Buffer;
  contentType: string;
  synced: boolean;
}

async function fetchSubtitle(url: string) {
  const res = await makeRequest(url, {
    timeout: SUBTITLE_TIMEOUT_MS,
    method: 'GET',
    ignoreRecursion: true,
  });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`the subtitle answered ${res.status}`);
  }
  const body = await readBodyCapped(res, MAX_SUBTITLE_BYTES);
  return {
    body,
    contentType: res.headers.get('content-type') || 'text/plain; charset=utf-8',
  };
}

/**
 * The subtitle `link` names, retimed to its file's own subtitle when that can
 * be read and they belong together; otherwise the subtitle as it was.
 */
export async function syncedSubtitle(
  token: string,
  link: SyncLink
): Promise<SubtitleAnswer> {
  const kept = await synced().get(token);
  if (kept)
    return {
      body: Buffer.from(kept.body, 'latin1'),
      contentType: kept.contentType,
      synced: true,
    };

  const original = await fetchSubtitle(link.subtitleUrl);
  // Latin-1 maps every byte to one character, so text in any encoding comes
  // back byte for byte; only the ASCII timestamps are rewritten.
  const body = await retimeToFile(original.body.toString('latin1'), link);
  if (body === null) return { ...original, synced: false };
  await synced().set(
    token,
    { body, contentType: original.contentType },
    LINK_TTL_S
  );
  return {
    body: Buffer.from(body, 'latin1'),
    contentType: original.contentType,
    synced: true,
  };
}

/**
 * `text` retimed to the file `link` names, or null when it can't be: too few
 * lines, no readable timings in the file, or a subtitle for something else.
 */
export async function retimeToFile(
  text: string,
  link: SyncLink
): Promise<string | null> {
  const timed = readTimes(text);
  if (!timed || timed.spans.length < MIN_LINES) return null;
  const reference = await referenceFor(link);
  if (!reference) return null;
  const why: PlanNote[] = [];
  const plan = planRetime(reference, timed.spans, why);
  if (!plan) {
    logger.debug(
      { subtitle: link.subtitleUrl, lines: timed.spans.length, why },
      'the subtitle doesn’t match this file'
    );
    return null;
  }
  // Already in time: moving lines by less than a frame or two changes nothing anyone sees.
  if (
    plan.ratio === 1 &&
    plan.parts.every((p) => Math.abs(p.delayMs) < IN_SYNC_MS)
  ) {
    logger.debug(
      { subtitle: link.subtitleUrl, fit: plan.fit, chance: plan.chance },
      'the subtitle is already in time with this file'
    );
    return null;
  }
  logger.debug(
    {
      subtitle: link.subtitleUrl,
      ratio: plan.ratio,
      parts: plan.parts,
      fit: plan.fit,
      chance: plan.chance,
    },
    'retimed a subtitle to its file'
  );
  return applyPlan(timed, plan);
}
