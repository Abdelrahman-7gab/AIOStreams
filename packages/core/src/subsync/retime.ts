import type { Span } from './align.js';
import type { RetimePlan } from './plan.js';

/** `00:01:02,345 --> 00:01:04,000` and WebVTT's `01:02.345 --> 01:04.000 align:start`. */
const CUE_TIMES =
  /^(\s*)((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})(\s*-->\s*)((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})(.*)$/;
/** ASS: `Dialogue: 0,0:01:02.34,0:01:04.00,Default,...`. */
const ASS_DIALOGUE =
  /^(Dialogue:\s*[^,]*,)(\d+:\d{2}:\d{2}[.:]\d{1,3}),(\d+:\d{2}:\d{2}[.:]\d{1,3})(,.*)$/;

type Format = 'cue' | 'ass';

function parseTime(text: string): number {
  const [clock, fraction = '0'] = text.split(/[,.]/);
  const parts = clock.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  const ms = Number(fraction.padEnd(3, '0').slice(0, 3));
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** The time in the same shape as `like`: its separator and its precision. */
function formatTime(ms: number, like: string, format: Format): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor(t / 60_000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const rest = t % 1000;
  if (format === 'ass')
    return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(Math.floor(rest / 10), 2)}`;
  const separator = like.includes(',') ? ',' : '.';
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(rest, 3)}`;
}

/** Where each line's times sit in `body`, in the order they appear. */
export interface TimedBody {
  lines: string[];
  format: Format;
  /** Indexes into `lines` that hold a line's times, one per subtitle line. */
  at: number[];
  spans: Span[];
}

/** The subtitle's lines and when they show; null for a format without readable times. */
export function readTimes(body: string): TimedBody | null {
  const lines = body.replace(/^﻿/, '').split(/\r?\n/);
  const at: number[] = [];
  const spans: Span[] = [];
  let format: Format | null = null;
  for (let i = 0; i < lines.length; i++) {
    const cue = CUE_TIMES.exec(lines[i]);
    if (cue && format !== 'ass') {
      format = 'cue';
      at.push(i);
      spans.push({ startMs: parseTime(cue[2]), endMs: parseTime(cue[4]) });
      continue;
    }
    const dialogue = ASS_DIALOGUE.exec(lines[i]);
    if (dialogue && format !== 'cue') {
      format = 'ass';
      at.push(i);
      spans.push({
        startMs: parseTime(dialogue[2]),
        endMs: parseTime(dialogue[3]),
      });
    }
  }
  return format && spans.length ? { lines, format, at, spans } : null;
}

/** `timed`'s body with every line moved as `plan` says; everything else is kept as it was. */
export function applyPlan(timed: TimedBody, plan: RetimePlan): string {
  const lines = [...timed.lines];
  const move = (ms: number, line: number) =>
    ms * plan.ratio + plan.delays[line];
  timed.at.forEach((row, line) => {
    const text = lines[row];
    if (timed.format === 'cue') {
      const m = CUE_TIMES.exec(text)!;
      const start = formatTime(move(parseTime(m[2]), line), m[2], 'cue');
      const end = formatTime(move(parseTime(m[4]), line), m[4], 'cue');
      lines[row] = `${m[1]}${start}${m[3]}${end}${m[5]}`;
    } else {
      const m = ASS_DIALOGUE.exec(text)!;
      const start = formatTime(move(parseTime(m[2]), line), m[2], 'ass');
      const end = formatTime(move(parseTime(m[3]), line), m[3], 'ass');
      lines[row] = `${m[1]}${start},${end}${m[4]}`;
    }
  });
  return lines.join('\n');
}
