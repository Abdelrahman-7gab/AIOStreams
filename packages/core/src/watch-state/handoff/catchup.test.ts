import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  catchUpRoom,
  catchUpSteps,
  planCatchUp,
  sendCatchUp,
  startsWriting,
  type CatchUpStep,
} from './catchup-plan.js';
import type { WatchStateRow } from '../../db/repositories/watch-state.js';

const T = Date.UTC(2026, 10, 22, 20, 0, 0);

function row(over: Partial<WatchStateRow>): WatchStateRow {
  return {
    uuid: 'u',
    persona: '',
    itemKey: 'm|tt0816692',
    kind: 'movie',
    mediaType: 'movie',
    baseId: 'tt0816692',
    videoId: null,
    season: null,
    episode: null,
    positionMs: 0,
    durationMs: 0,
    played: false,
    playCount: 0,
    favorite: false,
    favoriteSinkId: null,
    favoriteAt: null,
    dropped: false,
    droppedSinkId: null,
    droppedAt: null,
    rating: null,
    ratingSinkId: null,
    ratingAt: null,
    likes: null,
    lastPlayedAt: T,
    updatedAt: T,
    origin: 'local',
    sinkId: null,
    externalAt: null,
    snapshot: null,
    sortAt: T,
    ...over,
  } as WatchStateRow;
}

const episode = (n: number, over: Partial<WatchStateRow> = {}) =>
  row({
    itemKey: `e|tt0903747:1:${n}`,
    kind: 'episode',
    mediaType: 'series',
    baseId: 'tt0903747',
    videoId: `tt0903747:1:${n}`,
    season: 1,
    episode: n,
    ...over,
  });

describe('startsWriting', () => {
  const events = ['start', 'pause', 'stop', 'played'];
  const pushes = { events, baseUrl: 'https://watch.example/sealed-config-1' };

  it('catches up a tracker that is new, or only now takes writes', () => {
    assert.equal(startsWriting(null, pushes), true);
    assert.equal(
      startsWriting({ events: [], baseUrl: pushes.baseUrl }, pushes),
      true
    );
  });

  it('leaves alone a tracker reconfigured on the same host', () => {
    // Watch Sync seals its config with a random IV: a re-save with the same
    // settings is a new path on the same host, and the same account.
    assert.equal(
      startsWriting(
        { events, baseUrl: 'https://watch.example/sealed-config-2' },
        pushes
      ),
      false
    );
  });

  it('catches up again when the tracker moves to another host', () => {
    assert.equal(
      startsWriting(
        { events, baseUrl: 'https://other-tracker.example/sealed-config-1' },
        pushes
      ),
      true
    );
  });

  it('leaves alone a tracker that already took writes, or still takes none', () => {
    assert.equal(startsWriting(pushes, pushes), false);
    assert.equal(
      startsWriting(null, { events: [], baseUrl: pushes.baseUrl }),
      false
    );
    // Watchlist-only or rating-only trackers get no playback history.
    assert.equal(
      startsWriting(null, { events: ['watchlisted'], baseUrl: pushes.baseUrl }),
      false
    );
  });
});

describe('planCatchUp', () => {
  it('sends resume points as pauses at their position', () => {
    const plan = planCatchUp([
      row({
        positionMs: 3_600_000,
        durationMs: 10_000_000,
        lastPlayedAt: T - 5,
      }),
    ]);
    assert.equal(plan.resumes.length, 1);
    assert.deepEqual(
      {
        kind: plan.resumes[0].kind,
        positionMs: plan.resumes[0].positionMs,
        durationMs: plan.resumes[0].durationMs,
        videoId: plan.resumes[0].videoId,
        at: plan.resumes[0].at,
      },
      {
        kind: 'pause',
        positionMs: 3_600_000,
        durationMs: 10_000_000,
        videoId: 'tt0816692',
        at: T - 5,
      }
    );
  });

  it('marks watched films one by one and watched episodes per show', () => {
    const plan = planCatchUp([
      row({ played: true }),
      episode(1, { played: true }),
      episode(2, { played: true }),
      episode(3, { positionMs: 60_000 }),
    ]);
    assert.equal(plan.watched.length, 1);
    assert.equal(plan.shows.length, 1);
    assert.equal(plan.shows[0].metaId, 'tt0903747');
    assert.equal(plan.shows[0].scope, 'series');
    assert.deepEqual(
      plan.shows[0].videos.map((v) => v.videoId),
      ['tt0903747:1:1', 'tt0903747:1:2']
    );
    assert.equal(plan.resumes[0].videoId, 'tt0903747:1:3');
  });

  it('never sends a tracker what came from a tracker', () => {
    const plan = planCatchUp([
      row({ played: true, origin: 'import' }),
      episode(1, { positionMs: 60_000, origin: 'import' }),
      row({
        itemKey: 'm|tt1',
        baseId: 'tt1',
        favorite: true,
        favoriteSinkId: 's',
      }),
    ]);
    assert.deepEqual(
      [plan.resumes, plan.watched, plan.shows, plan.favourites].map(
        (l) => l.length
      ),
      [0, 0, 0, 0]
    );
  });

  it('sends favourites set here, for films and shows only', () => {
    const plan = planCatchUp([
      row({ favorite: true }),
      episode(1, { favorite: true }),
    ]);
    assert.deepEqual(
      plan.favourites.map((f) => [f.kind, f.metaId]),
      [['watchlisted', 'tt0816692']]
    );
  });

  it('skips untouched rows and episodes without a video id', () => {
    const plan = planCatchUp([
      row({}),
      episode(1, { played: true, videoId: null }),
    ]);
    assert.deepEqual(
      [plan.resumes, plan.watched, plan.shows].map((l) => l.length),
      [0, 0, 0]
    );
  });

  it("dates a show's episodes by when they were watched, not by now", () => {
    const plan = planCatchUp([
      episode(1, { played: true, lastPlayedAt: T - 3_000 }),
      episode(2, { played: true, lastPlayedAt: T - 1_000 }),
      // Never played back here (marked from a list): its update is the date.
      episode(3, { played: true, lastPlayedAt: null, updatedAt: T - 2_000 }),
    ]);
    // One mark carries one date: the latest of the show's episodes.
    assert.equal(plan.shows[0].at, T - 1_000);
  });
});

const film = (n: number) =>
  row({ itemKey: `m|tt${n}`, baseId: `tt${n}`, played: true });

describe('catchUpSteps', () => {
  const plan = planCatchUp([
    row({ itemKey: 'm|tt9', baseId: 'tt9', positionMs: 60_000 }),
    film(1),
    row({ itemKey: 'm|tt5', baseId: 'tt5', favorite: true }),
    episode(1, { played: true }),
    episode(2, { played: true }),
  ]);

  it('queues shows, then films, then favourites, then resume points', () => {
    // A full queue drops its oldest rows first, so the resume points, which
    // nothing else carries again, go in last.
    assert.deepEqual(
      catchUpSteps(plan, { bulk: true, chunk: 100 }).map((s) => s.kind),
      ['show', 'film', 'favourite', 'resume']
    );
  });

  it('splits a show into chunks for a tracker that takes one event per episode', () => {
    const big = planCatchUp(
      Array.from({ length: 5 }, (_, i) => episode(i + 1, { played: true }))
    );
    const split = catchUpSteps(big, { bulk: false, chunk: 2 });
    assert.deepEqual(
      split.map((s) => (s.kind === 'show' ? s.mark.videos.length : -1)),
      [2, 2, 1]
    );
    assert.deepEqual(
      split.map((s) => s.size),
      [2, 2, 1]
    );
    for (const step of split) {
      assert.equal(step.kind, 'show');
      if (step.kind === 'show') assert.equal(step.mark.at, big.shows[0].at);
    }
    // A tracker taking bulk marks gets the show whole (its parts are keyed
    // by their index, so splitting would collide).
    assert.equal(catchUpSteps(big, { bulk: true, chunk: 2 }).length, 1);
  });
});

describe('catchUpRoom', () => {
  it('keeps the queue under three quarters of the cap, a chunk below it', () => {
    assert.deepEqual(catchUpRoom(2000), { limit: 1500, chunk: 100 });
    // A small cap still leaves room for at least one event at a time.
    assert.deepEqual(catchUpRoom(8), { limit: 6, chunk: 2 });
    assert.deepEqual(catchUpRoom(1), { limit: 0, chunk: 1 });
  });
});

describe('sendCatchUp', () => {
  const steps = (n: number): CatchUpStep[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'film' as const,
      size: 1,
      event: {
        kind: 'played' as const,
        type: 'movie',
        videoId: `tt${i}`,
        baseId: `tt${i}`,
        itemKey: `m|tt${i}`,
      },
    }));

  /** A queue that drains `drain` rows per poll, on a clock the sleeps move. */
  function queue(start: number, drain: number) {
    const state = { pending: start, clock: 0, sleeps: 0, sent: [] as string[] };
    return {
      state,
      send: async (step: CatchUpStep) => {
        state.sent.push(step.kind === 'film' ? step.event.videoId : step.kind);
        state.pending += step.size;
      },
      room: {
        limit: 10,
        pollMs: 1_000,
        timeoutMs: 5_000,
        pending: async () => state.pending,
        now: () => state.clock,
        sleep: async (ms: number) => {
          state.sleeps++;
          state.clock += ms;
          state.pending = Math.max(0, state.pending - drain);
        },
      },
    };
  }

  it('sends straight through while the queue has room', async () => {
    const q = queue(0, 0);
    const result = await sendCatchUp(steps(5), q.send, q.room);
    assert.deepEqual(result, {
      sent: 5,
      skipped: 0,
      unsent: 0,
      stopped: false,
    });
    assert.equal(q.state.sleeps, 0);
    assert.equal(q.state.sent.length, 5);
  });

  it('waits while the queue is above the limit, then carries on', async () => {
    const q = queue(9, 3);
    const result = await sendCatchUp(steps(4), q.send, q.room);
    assert.deepEqual(result, {
      sent: 4,
      skipped: 0,
      unsent: 0,
      stopped: false,
    });
    assert.ok(q.state.sleeps > 0, 'it waited for the queue to drain');
    // Never more than one event past the limit.
    assert.ok(q.state.pending <= q.room.limit + 1);
  });

  it('never sends while the queue is above the limit', async () => {
    const q = queue(0, 0);
    let peak = 0;
    const send = async (step: CatchUpStep) => {
      peak = Math.max(peak, q.state.pending);
      await q.send(step);
    };
    // Another writer fills the queue between our sends.
    const room = {
      ...q.room,
      pending: async () => {
        q.state.pending += 4;
        return q.state.pending;
      },
    };
    const result = await sendCatchUp(steps(30), send, room);
    assert.ok(peak <= room.limit, `sent at ${peak} pending`);
    assert.equal(result.stopped, true);
  });

  it('stops rather than overflow when the queue does not drain in time', async () => {
    const q = queue(50, 0);
    const result = await sendCatchUp(steps(3), q.send, q.room);
    assert.deepEqual(result, { sent: 0, skipped: 0, unsent: 3, stopped: true });
    assert.equal(q.state.sent.length, 0);
    assert.ok(q.state.clock >= q.room.timeoutMs);
    assert.ok(q.state.clock < q.room.timeoutMs + q.room.pollMs * 2);
  });

  it('counts a step that failed to send and keeps going', async () => {
    const q = queue(0, 0);
    let calls = 0;
    const send = async (step: CatchUpStep) => {
      if (++calls === 2) throw new Error('boom');
      await q.send(step);
    };
    const result = await sendCatchUp(steps(3), send, q.room);
    assert.deepEqual(result, {
      sent: 2,
      skipped: 1,
      unsent: 0,
      stopped: false,
    });
  });
});
