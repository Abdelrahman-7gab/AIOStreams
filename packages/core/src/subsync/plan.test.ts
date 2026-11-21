import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Span } from './align.js';
import { planRetime } from './plan.js';

/** A seeded generator, so every run builds the same episodes. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** An episode's dialogue: `count` lines of 1–4 s with 0.3–6 s between them. */
function episode(count: number, seed: number): Span[] {
  const next = random(seed);
  const lines: Span[] = [];
  let t = 30_000;
  for (let i = 0; i < count; i++) {
    t += 300 + next() * 5700;
    const length = 1000 + next() * 3000;
    lines.push({ startMs: Math.round(t), endMs: Math.round(t + length) });
    t += length;
  }
  return lines;
}

const moved = (lines: Span[], byMs: number) =>
  lines.map((l) => ({ startMs: l.startMs + byMs, endMs: l.endMs + byMs }));

const NEAR_MS = 120;

describe('planRetime', () => {
  it('finds one delay for a subtitle that is late throughout', () => {
    const reference = episode(400, 1);
    // The subtitle shows every line 2.5 s late, so each must move 2.5 s earlier.
    const target = moved(reference, 2500);
    const plan = planRetime(reference, target);
    assert.ok(plan);
    assert.equal(plan.ratio, 1);
    assert.equal(plan.parts.length, 1);
    for (const d of plan.delays)
      assert.ok(Math.abs(d - -2500) <= NEAR_MS, `delay ${d}`);
  });

  it('changes delay where a cut moved the second half', () => {
    const reference = episode(400, 2);
    // A black screen of 3 s that the subtitle's source didn't have: the
    // subtitle is 1 s early before it and 4 s early after it.
    const target = [
      ...moved(reference.slice(0, 200), -1000),
      ...moved(reference.slice(200), -4000),
    ];
    const plan = planRetime(reference, target);
    assert.ok(plan);
    assert.equal(plan.ratio, 1);
    assert.equal(plan.parts.length, 2, JSON.stringify(plan.parts));
    let right = 0;
    plan.delays.forEach((d, i) => {
      const want = i < 200 ? 1000 : 4000;
      if (Math.abs(d - want) <= NEAR_MS) right++;
    });
    // At most a few lines either side of the cut may take the other delay.
    assert.ok(right >= 395, `${right} of 400 lines placed`);
    assert.ok(
      Math.abs(plan.parts[1].fromLine - 200) <= 3,
      `cut at ${plan.parts[1].fromLine}`
    );
  });

  it('stretches a subtitle made for the PAL frame rate', () => {
    const reference = episode(400, 3);
    const film = 24000 / 1001;
    // Timed for 25 fps: every time runs at film/25 of the file's.
    const target = reference.map((l) => ({
      startMs: (l.startMs * film) / 25,
      endMs: (l.endMs * film) / 25,
    }));
    const plan = planRetime(reference, target);
    assert.ok(plan);
    assert.ok(Math.abs(plan.ratio - 25 / film) < 1e-9, `ratio ${plan.ratio}`);
    for (const d of plan.delays)
      assert.ok(Math.abs(d) <= NEAR_MS, `delay ${d}`);
  });

  it('stretches a subtitle made for 24 fps onto a 23.976 fps file', () => {
    const reference = episode(500, 7);
    // Timed for 24 fps: the file's time t shows at t × 1000/1001 in it, which
    // drifts about 2.7 s over 45 minutes.
    const target = reference.map((l) => ({
      startMs: (l.startMs * 1000) / 1001,
      endMs: (l.endMs * 1000) / 1001,
    }));
    const plan = planRetime(reference, target);
    assert.ok(plan);
    assert.ok(Math.abs(plan.ratio - 1001 / 1000) < 1e-9, `ratio ${plan.ratio}`);
    assert.equal(plan.parts.length, 1, JSON.stringify(plan.parts));
    for (const d of plan.delays)
      assert.ok(Math.abs(d) <= NEAR_MS, `delay ${d}`);
  });

  it('does not stitch together a subtitle whose second half is from elsewhere', () => {
    const reference = episode(400, 8);
    // Half matches the file (2 s late), half is another episode's lines.
    const other = episode(400, 77);
    const target = [
      ...moved(reference.slice(0, 200), 2000),
      ...other.slice(200),
    ];
    const plan = planRetime(reference, target);
    // Either it is left alone, or it gets the one delay its real half shows;
    // it never gets made-up jumps for the other half.
    if (plan) {
      assert.equal(plan.parts.length, 1, JSON.stringify(plan.parts));
      assert.ok(Math.abs(plan.parts[0].delayMs - -2000) <= NEAR_MS);
    }
  });

  it('leaves alone a subtitle that belongs to something else', () => {
    const reference = episode(400, 4);
    const target = episode(400, 99);
    assert.equal(planRetime(reference, target), null);
  });

  it('copes with a translation that drops, adds and jitters lines', () => {
    const reference = episode(500, 6);
    const next = random(42);
    // Late by 2 s, then by 22 s after line 375, where 20 s of footage the
    // subtitle's source didn't have was put in.
    const target: Span[] = [];
    const want: number[] = [];
    reference.forEach((l, i) => {
      if (next() < 0.15) return;
      const late = i < 375 ? 2000 : 22_000;
      const jitter = (next() - 0.5) * 600;
      target.push({
        startMs: l.startMs + late + jitter,
        endMs: l.endMs + late + jitter,
      });
      want.push(-late);
      if (next() < 0.1) {
        const at = l.endMs + late + 200;
        target.push({ startMs: at, endMs: at + 800 });
        want.push(-late);
      }
    });
    const plan = planRetime(reference, target);
    assert.ok(plan);
    let right = 0;
    plan.delays.forEach((d, i) => {
      if (Math.abs(d - want[i]) <= 400) right++;
    });
    assert.ok(
      right / target.length >= 0.97,
      `${right} of ${target.length} lines placed`
    );
  });

  it('keeps one delay when only a few stray lines disagree', () => {
    const reference = episode(400, 5);
    const target = moved(reference, 1500);
    // Three lines in the middle are off by another 6 s, as a typo would be.
    for (const i of [150, 151, 152]) {
      target[i] = {
        startMs: target[i].startMs + 6000,
        endMs: target[i].endMs + 6000,
      };
    }
    const plan = planRetime(reference, target);
    assert.ok(plan);
    assert.equal(plan.parts.length, 1, JSON.stringify(plan.parts));
  });
});
