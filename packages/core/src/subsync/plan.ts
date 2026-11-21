import { alignSubtitles, type Span } from './align.js';

/** How far off a whole subtitle may be. */
const WHOLE_LIMIT_MS = 600_000;
/** How far one part of it may drift from the whole. */
const PART_LIMIT_MS = 30_000;
/** Lines each part is matched on, and how far apart the parts start. */
const PART_LINES = 40;
const PART_STEP = 10;
/** Parts this many lines short of a full one aren't tried. */
const MIN_PART_LINES = 20;
/** A part needs this many of the file's lines around it to be judged. */
const MIN_PART_REFERENCE = 10;
/** When the whole is unsure: at least this many parts, and this share of them, must match clearly. */
const MIN_CLEAR_PARTS = 3;
const CLEAR_SHARE = 0.5;
/** Delays this close together are one delay. */
const SAME_DELAY_MS = 300;
/** Longer lines are signs or songs, which don't say when someone speaks. */
const LONGEST_MS = 12_000;
/**
 * What a change of delay costs, in lines that fit: a change is only made
 * where this many more lines line up after it, so one stray line never moves
 * the rest.
 */
const CHANGE_COST = 4;

export interface RetimePart {
  /** The first line, by position in the subtitle, the delay applies from. */
  fromLine: number;
  delayMs: number;
}

export interface RetimePlan {
  /** Every time is multiplied by this first, for a subtitle made for another frame rate. */
  ratio: number;
  /** Then each line, by its position in the subtitle, is moved by its delay. */
  delays: number[];
  /** The delays in the order they apply, for logs. */
  parts: RetimePart[];
}

/** Sorted, joined speech: the file's lines as one timeline to measure against. */
function timeline(reference: Span[]): Span[] {
  const sorted = reference
    .filter((l) => l.endMs > l.startMs && l.endMs - l.startMs <= LONGEST_MS)
    .sort((a, b) => a.startMs - b.startMs);
  const joined: Span[] = [];
  for (const span of sorted) {
    const last = joined.at(-1);
    if (last && span.startMs <= last.endMs)
      last.endMs = Math.max(last.endMs, span.endMs);
    else joined.push({ ...span });
  }
  return joined;
}

/** The share of `line` the timeline covers. */
function covered(line: Span, spans: Span[]): number {
  const length = line.endMs - line.startMs;
  if (length <= 0 || length > LONGEST_MS) return 0;
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].endMs <= line.startMs) lo = mid + 1;
    else hi = mid;
  }
  let overlap = 0;
  for (let i = lo; i < spans.length && spans[i].startMs < line.endMs; i++)
    overlap +=
      Math.min(spans[i].endMs, line.endMs) -
      Math.max(spans[i].startMs, line.startMs);
  return overlap / length;
}

/** Delays within `SAME_DELAY_MS` of each other, as their middle. */
function distinct(delays: number[]): number[] {
  const sorted = [...delays].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const d of sorted) {
    const last = groups.at(-1);
    if (last && d - last[0] <= SAME_DELAY_MS) last.push(d);
    else groups.push([d]);
  }
  return groups.map((g) => Math.round(g[Math.floor(g.length / 2)]));
}

/**
 * How to retime `target` to the file whose own subtitle shows its lines at
 * `reference`: one frame rate for the whole, then a delay per line, allowed
 * to change where the video was cut or padded. Matches on timing alone, so the
 * two can be in different languages. Null when the subtitle doesn't belong to
 * this file.
 */
export function planRetime(
  reference: Span[],
  target: Span[]
): RetimePlan | null {
  // A cut splits the match between two delays, so the whole may be unsure
  // while each part is clear; its parts decide then.
  const whole = alignSubtitles(reference, target, WHOLE_LIMIT_MS);
  if (!whole) return null;
  const { ratio } = whole;

  const order = target
    .map((_, i) => i)
    .sort((a, b) => target[a].startMs - target[b].startMs);
  const lines = order.map((i) => ({
    startMs: target[i].startMs * ratio,
    endMs: target[i].endMs * ratio,
  }));

  // Each part of the subtitle, already moved by the whole's delay, matched
  // against the file's lines near it.
  const found = [whole.delayMs];
  let tried = 0;
  let clear = 0;
  for (let from = 0; from < lines.length; from += PART_STEP) {
    const part = lines.slice(from, from + PART_LINES).map((l) => ({
      startMs: l.startMs + whole.delayMs,
      endMs: l.endMs + whole.delayMs,
    }));
    if (part.length < MIN_PART_LINES) break;
    const lo = part[0].startMs - PART_LIMIT_MS;
    const hi = part[part.length - 1].endMs + PART_LIMIT_MS;
    const near = reference.filter((r) => r.endMs > lo && r.startMs < hi);
    if (near.length < MIN_PART_REFERENCE) continue;
    tried++;
    const local = alignSubtitles(near, part, PART_LIMIT_MS);
    if (local?.confident && local.ratio === 1) {
      clear++;
      found.push(whole.delayMs + local.delayMs);
    }
  }
  // Unsure as a whole, it belongs to this file only if most of its parts clearly do.
  if (
    !whole.confident &&
    (clear < MIN_CLEAR_PARTS || clear < tried * CLEAR_SHARE)
  )
    return null;
  const delays = distinct(found);

  const spans = timeline(reference);
  const fits = lines.map((line) =>
    delays.map((d) =>
      covered({ startMs: line.startMs + d, endMs: line.endMs + d }, spans)
    )
  );

  // The best delay per line, paying `CHANGE_COST` for each change.
  const n = lines.length;
  const k = delays.length;
  const score = new Float64Array(k);
  const from: Int16Array[] = [];
  for (let j = 0; j < k; j++) score[j] = fits[0]?.[j] ?? 0;
  for (let i = 1; i < n; i++) {
    let best = 0;
    for (let j = 1; j < k; j++) if (score[j] > score[best]) best = j;
    const back = new Int16Array(k);
    const next = new Float64Array(k);
    for (let j = 0; j < k; j++) {
      const stay = score[j];
      const change = score[best] - CHANGE_COST;
      back[j] = stay >= change ? j : best;
      next[j] = Math.max(stay, change) + fits[i][j];
    }
    from.push(back);
    score.set(next);
  }
  let last = 0;
  for (let j = 1; j < k; j++) if (score[j] > score[last]) last = j;
  const choice = new Array<number>(n);
  choice[n - 1] = last;
  for (let i = n - 1; i > 0; i--) choice[i - 1] = from[i - 1][choice[i]];

  // One delay throughout unless the changes earn their cost.
  const wholeAt = delays.indexOf(
    delays.reduce((a, b) =>
      Math.abs(b - whole.delayMs) < Math.abs(a - whole.delayMs) ? b : a
    )
  );
  const uniform = fits.reduce((sum, f) => sum + f[wholeAt], 0);
  let changes = 0;
  for (let i = 1; i < n; i++) if (choice[i] !== choice[i - 1]) changes++;
  const chosen = score[last];
  if (changes === 0 || chosen - uniform < CHANGE_COST) choice.fill(wholeAt);

  const perLine = new Array<number>(target.length);
  const parts: RetimePart[] = [];
  for (let i = 0; i < n; i++) {
    const delayMs = delays[choice[i]];
    perLine[order[i]] = delayMs;
    if (i === 0 || choice[i] !== choice[i - 1])
      parts.push({ fromLine: order[i], delayMs });
  }
  return { ratio, delays: perLine, parts };
}
