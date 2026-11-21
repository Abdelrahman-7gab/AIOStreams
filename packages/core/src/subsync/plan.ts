import { alignSubtitles, type Alignment, type Span } from './align.js';

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
/**
 * How well a delay fits is the share of its lines the file's speech covers,
 * against the share covered at delays far from it, which is what chance
 * alone gives. A delay must reach `MIN_FIT` and close `MIN_GAIN` of the gap
 * between chance and a perfect fit: dense dialogue leaves chance high, so a
 * fixed margin over it would ask for the impossible.
 */
const MIN_FIT = 0.5;
const MIN_GAIN = 0.5;
const CHANCE_OFFSETS_MS = [-67_000, -41_000, -23_000, 23_000, 41_000, 67_000];
/** Steps in one direction this many times read as a drift, not as cuts. */
const MIN_DRIFT_PARTS = 3;

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
  /** How well the retimed lines fit the file, and what chance alone gives, for logs. */
  fit: number;
  chance: number;
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
  target: Span[],
  why: PlanNote[] = []
): RetimePlan | null {
  const whole = alignSubtitles(reference, target, WHOLE_LIMIT_MS);
  if (!whole) {
    why.push({ outcome: 'no overlap with the file' });
    return null;
  }
  // A jump partway looks a little like a slow drift, so a frame rate is only
  // kept when it explains the lines better than steady time with its changes.
  const tries = [whole];
  if (whole.ratio !== 1) {
    const steady = alignSubtitles(reference, target, WHOLE_LIMIT_MS, [1]);
    if (steady) tries.push(steady);
  }
  let best: ScoredPlan | null = null;
  for (const at of tries) {
    const plan = planAt(reference, target, at, why);
    if (plan && (!best || plan.score > best.score)) best = plan;
  }
  if (!best) return null;
  // Delays that keep stepping one way are a frame rate the list above lacks:
  // a straight line through them gives that rate, tried as a whole of its own.
  if (best.parts.length >= MIN_DRIFT_PARTS) {
    const drift = driftOf(target, best);
    if (drift) {
      const plan = planAt(reference, target, drift, why);
      if (plan && plan.score >= best.score) best = plan;
    }
  }
  const { score: _score, ...plan } = best;
  return plan;
}

/**
 * The frame rate and delay a straight line through `plan`'s delays gives,
 * when they keep moving the same way; null when they go back and forth, as
 * cuts do.
 */
function driftOf(target: Span[], plan: RetimePlan): Alignment | null {
  const order = plan.parts.map((p) => p.delayMs);
  const steps = order.slice(1).map((d, i) => d - order[i]);
  if (!steps.every((s) => s > 0) && !steps.every((s) => s < 0)) return null;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  target.forEach((line, i) => {
    const x = line.startMs * plan.ratio;
    const y = plan.delays[i];
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  });
  const spread = n * sxx - sx * sx;
  if (!n || spread <= 0) return null;
  const slope = (n * sxy - sx * sy) / spread;
  const delayMs = Math.round((sy - slope * sx) / n);
  // A line's new time is s + delay + slope × s for its time s at the plan's
  // rate, so the rate grows by the slope and one delay remains.
  return { ratio: plan.ratio * (1 + slope), delayMs, confident: true };
}

type ScoredPlan = RetimePlan & {
  /** Lines that fit, less what its changes of delay cost. */
  score: number;
};

/** What one try at a frame rate and delay found, for logs. */
export interface PlanNote {
  ratio?: number;
  delayMs?: number;
  confident?: boolean;
  clearParts?: string;
  fit?: number;
  chance?: number;
  outcome: string;
}

/** The plan for `target` at the whole's frame rate and delay, `whole`. */
function planAt(
  reference: Span[],
  target: Span[],
  whole: Alignment,
  why: PlanNote[]
): ScoredPlan | null {
  const { ratio } = whole;
  const note: PlanNote = {
    ratio: Math.round(ratio * 1e5) / 1e5,
    delayMs: whole.delayMs,
    confident: whole.confident,
    outcome: 'planned',
  };
  why.push(note);
  // A cut splits the match between two delays, so the whole may be unsure
  // while each part is clear; its parts decide then.

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
    // The whole's frame rate is already applied; a part only finds its delay.
    const local = alignSubtitles(near, part, PART_LIMIT_MS, [1]);
    if (local?.confident) {
      clear++;
      found.push(whole.delayMs + local.delayMs);
    }
  }
  // Unsure as a whole, it belongs to this file only if most of its parts clearly do.
  note.clearParts = `${clear}/${tried}`;
  if (
    !whole.confident &&
    (clear < MIN_CLEAR_PARTS || clear < tried * CLEAR_SHARE)
  ) {
    note.outcome = 'unsure as a whole and too few parts clear';
    return null;
  }
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

  // How well lines `from`..`to` fit at their chosen delays, and at delays far
  // from them, which chance alone gives.
  const judge = (from: number, to: number) => {
    let fit = 0;
    let chance = 0;
    let counted = 0;
    for (let i = from; i < to; i++) {
      const line = lines[i];
      const length = line.endMs - line.startMs;
      if (length <= 0 || length > LONGEST_MS) continue;
      const d = delays[choice[i]];
      counted++;
      fit += fits[i][choice[i]];
      for (const off of CHANCE_OFFSETS_MS)
        chance +=
          covered(
            { startMs: line.startMs + d + off, endMs: line.endMs + d + off },
            spans
          ) / CHANCE_OFFSETS_MS.length;
    }
    return counted
      ? { fit: fit / counted, chance: chance / counted }
      : { fit: 0, chance: 0 };
  };
  const passes = (j: { fit: number; chance: number }) =>
    j.fit >= MIN_FIT && j.fit - j.chance >= MIN_GAIN * (1 - j.chance);

  // Every delay must fit on its own: a part that only chance supports means
  // the subtitle was made for another cut, and the parts can't be trusted.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++)
    if (i === 0 || choice[i] !== choice[i - 1]) runs.push([i, i + 1]);
    else runs[runs.length - 1][1] = i + 1;
  if (runs.length > 1 && !runs.every(([a, b]) => passes(judge(a, b))))
    choice.fill(wholeAt);
  const overall = judge(0, n);
  note.fit = Math.round(overall.fit * 100) / 100;
  note.chance = Math.round(overall.chance * 100) / 100;
  if (!passes(overall)) {
    note.outcome = 'fits no better than chance';
    return null;
  }

  const perLine = new Array<number>(target.length);
  const parts: RetimePart[] = [];
  for (let i = 0; i < n; i++) {
    const delayMs = delays[choice[i]];
    perLine[order[i]] = delayMs;
    if (i === 0 || choice[i] !== choice[i - 1])
      parts.push({ fromLine: order[i], delayMs });
  }
  return {
    ratio,
    delays: perLine,
    parts,
    fit: Math.round(overall.fit * 100) / 100,
    chance: Math.round(overall.chance * 100) / 100,
    score: overall.fit * n - CHANGE_COST * (parts.length - 1),
  };
}
