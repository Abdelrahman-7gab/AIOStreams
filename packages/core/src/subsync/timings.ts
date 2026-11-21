import type { Span } from './align.js';
import { readAll } from './byte-reader.js';
import { openMatroska } from './file.js';
import { indexLines } from './lines.js';
import { openMp4, sampleLines } from './mp4.js';
import { rangeReader } from './reader.js';

/** The first bytes hold the header, the track list and where the index is. */
const HEAD_BYTES = 256 * 1024;
/** Fewer lines than this is a forced or signs-only track, not the dialogue. */
export const MIN_REFERENCE_LINES = 30;

export interface TrackTimings {
  number: number;
  language?: string;
  kind: 'ass' | 'text' | 'pgs' | null;
  forced: boolean;
  /** When the track's lines show, from the file's index. */
  lines: Span[];
}

/**
 * When each of a file's own subtitle tracks shows its lines, read from a
 * Matroska file's index or an MP4's sample tables, so only the file's head and
 * index are downloaded. Null for another container or one without subtitles.
 */
export async function readFileTimings(
  fileUrl: string,
  timeoutMs: number
): Promise<TrackTimings[] | null> {
  const reader = rangeReader(fileUrl, timeoutMs);
  const start = await readAll(reader, 0, HEAD_BYTES);
  const mkv = await openMatroska(reader, start);
  if (mkv)
    return mkv.subtitles.map((track) => ({
      number: track.number,
      language: track.language,
      kind: track.kind,
      forced: track.isForced,
      lines: indexLines(mkv, track),
    }));
  // MP4 keeps every sample's time in its header, subtitles included.
  const mp4 = await openMp4(reader, start);
  if (!mp4?.subtitles.length) return null;
  return mp4.subtitles.map((track) => ({
    number: track.number,
    language: track.language,
    kind: track.kind,
    forced: track.isForced,
    lines: sampleLines(mp4, track.number),
  }));
}

/**
 * The track an added subtitle is timed against: a full one, text before
 * pictures as its index times are exact, then the one with the most lines.
 */
export function pickReference(tracks: TrackTimings[]): Span[] | null {
  const full = tracks.filter(
    (t) => !t.forced && t.lines.length >= MIN_REFERENCE_LINES
  );
  if (!full.length) return null;
  const rank = (t: TrackTimings) => (t.kind === 'pgs' ? 1 : 0);
  full.sort((a, b) => rank(a) - rank(b) || b.lines.length - a.lines.length);
  return full[0].lines;
}
