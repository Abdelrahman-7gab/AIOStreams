import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// First: loading a repository before the config trips the logger's import cycle.
import { settingsStore } from '../../config/index.js';
import {
  catchUpHalt,
  catchUpRoom,
  catchUpSteps,
  planCatchUp,
  sendCatchUp,
  startsWriting,
  type CatchUpStep,
  type CatchUpStop,
} from './catchup-plan.js';
import {
  WatchStateRepository,
  type WatchStateRow,
} from '../../db/repositories/watch-state.js';
import {
  PlaybackHandoffRepository,
  type QueuedEvent,
  type SinkRow,
} from '../../db/repositories/playback-handoff.js';
import { SettingsRepository } from '../../db/repositories/settings.js';
import { dispatchBulkMark, dispatchPlayback } from './dispatch.js';
import { catchUpSink } from './catchup.js';
import type { ResolvedPlaybackSink } from './resolve.js';

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
    // A bulk body carries one date: the latest of the show's episodes.
    assert.equal(plan.shows[0].at, T - 1_000);
    // Each episode keeps its own, for a tracker sent one event per episode.
    assert.deepEqual(
      plan.shows[0].videos.map((v) => v.at),
      [T - 3_000, T - 1_000, T - 2_000]
    );
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
    // One queue row per episode.
    assert.deepEqual(
      split.map((s) => s.rows),
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

  it('counts a bulk show as the rows it queues, one per 500 episodes', () => {
    const long = planCatchUp(
      Array.from({ length: 1001 }, (_, i) => episode(i + 1, { played: true }))
    );
    assert.deepEqual(
      catchUpSteps(long, { bulk: true, chunk: 100 }).map((s) => s.rows),
      [3]
    );
    assert.deepEqual(
      catchUpSteps(plan, { bulk: true, chunk: 100 }).map((s) => s.rows),
      [1, 1, 1, 1]
    );
  });
});

describe('catchUpHalt', () => {
  const started = {
    baseUrl: 'https://watch.example/sealed-config-1',
    query: '',
    routingHash: 'h1',
    events: ['pause', 'played'],
    retiredAt: null,
  };

  it('carries on while the sink row is the one the catch-up started with', () => {
    assert.equal(catchUpHalt(started, { ...started }), null);
  });

  it('stops when the sink was removed, retired or stopped taking writes', () => {
    assert.equal(catchUpHalt(started, null), 'removed');
    assert.equal(catchUpHalt(started, { ...started, retiredAt: T }), 'retired');
    assert.equal(
      catchUpHalt(started, {
        ...started,
        events: ['watchlisted'],
        routingHash: 'h2',
      }),
      'writes-off'
    );
  });

  it('stops when the addon was saved again with another address or routing', () => {
    // A Watch Sync re-save seals a new path on the same host: maybe another account.
    assert.equal(
      catchUpHalt(started, {
        ...started,
        baseUrl: 'https://watch.example/sealed-config-2',
      }),
      'reconfigured'
    );
    assert.equal(
      catchUpHalt(started, { ...started, query: '?config=2' }),
      'reconfigured'
    );
    assert.equal(
      catchUpHalt(started, { ...started, routingHash: 'h2' }),
      'reconfigured'
    );
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
      rows: 1,
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
    const state = {
      pending: start,
      clock: 0,
      sleeps: 0,
      sent: [] as string[],
      halt: null as CatchUpStop | null,
    };
    return {
      state,
      send: async (step: CatchUpStep) => {
        state.sent.push(step.kind === 'film' ? step.event.videoId : step.kind);
        state.pending += step.rows;
        return step.rows;
      },
      room: {
        limit: 10,
        pollMs: 1_000,
        timeoutMs: 5_000,
        pending: async () => state.pending,
        halted: async () => state.halt,
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
      queued: 5,
      skipped: 0,
      unsent: 0,
      stopped: null,
    });
    assert.equal(q.state.sleeps, 0);
    assert.equal(q.state.sent.length, 5);
  });

  it('waits while the queue is above the limit, then carries on', async () => {
    const q = queue(9, 3);
    const result = await sendCatchUp(steps(4), q.send, q.room);
    assert.deepEqual(result, {
      queued: 4,
      skipped: 0,
      unsent: 0,
      stopped: null,
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
      return q.send(step);
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
    assert.equal(result.stopped, 'queue');
  });

  it('stops rather than overflow when the queue does not drain in time', async () => {
    const q = queue(50, 0);
    const result = await sendCatchUp(steps(3), q.send, q.room);
    assert.deepEqual(result, {
      queued: 0,
      skipped: 0,
      unsent: 3,
      stopped: 'queue',
    });
    assert.equal(q.state.sent.length, 0);
    assert.ok(q.state.clock >= q.room.timeoutMs);
    assert.ok(q.state.clock < q.room.timeoutMs + q.room.pollMs * 2);
  });

  it('counts a step that failed to send and keeps going', async () => {
    const q = queue(0, 0);
    let calls = 0;
    const send = async (step: CatchUpStep) => {
      if (++calls === 2) throw new Error('boom');
      return q.send(step);
    };
    const result = await sendCatchUp(steps(3), send, q.room);
    assert.deepEqual(result, {
      queued: 2,
      skipped: 1,
      unsent: 0,
      stopped: null,
    });
  });

  it('counts the rows the queue took, not the rows a step could add', async () => {
    const q = queue(0, 0);
    const added = [3, 0, 1];
    let i = 0;
    const send = async () => added[i++];
    // A step of 3 rows queued all 3; one already queued under its key added
    // none; one of 2 rows (a tracker that takes only one of them) added 1.
    const result = await sendCatchUp(
      [{ ...steps(1)[0], rows: 3 }, steps(1)[0], { ...steps(1)[0], rows: 2 }],
      send,
      q.room
    );
    assert.deepEqual(result, {
      queued: 4,
      skipped: 2,
      unsent: 0,
      stopped: null,
    });
  });

  it('stops before the next step once the sink is no longer the one it started with', async () => {
    const q = queue(0, 0);
    const send = async (step: CatchUpStep) => {
      const rows = await q.send(step);
      if (q.state.sent.length === 2) q.state.halt = 'reconfigured';
      return rows;
    };
    const result = await sendCatchUp(steps(5), send, q.room);
    assert.deepEqual(result, {
      queued: 2,
      skipped: 0,
      unsent: 3,
      stopped: 'reconfigured',
    });
    assert.deepEqual(q.state.sent, ['tt0', 'tt1']);
  });

  it('stops during a wait once the sink was retired', async () => {
    const q = queue(50, 0);
    const room = {
      ...q.room,
      sleep: async (ms: number) => {
        await q.room.sleep(ms);
        q.state.halt = 'retired';
      },
    };
    const result = await sendCatchUp(steps(2), q.send, room);
    assert.deepEqual(result, {
      queued: 0,
      skipped: 0,
      unsent: 2,
      stopped: 'retired',
    });
    // Noticed at the first poll, not at the end of the wait.
    assert.equal(q.state.sleeps, 1);
  });
});

/*
 * The catch-up end to end, against the real dispatch, with the repositories
 * stubbed: what it reads, what it queues, and what it must never write.
 */
describe('catchUpSink', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });
  afterEach(() => mock.restoreAll());

  const scope = { uuid: 'u', persona: '' };
  const tracker = (over: Partial<ResolvedPlaybackSink> = {}) =>
    ({
      instanceId: 'trk',
      name: 'Tracker',
      baseUrl: 'https://trk.example/sealed-1',
      query: '',
      events: ['pause', 'played', 'watchlisted'],
      pullable: false,
      types: [],
      ...over,
    }) as ResolvedPlaybackSink;
  const sinkRow = (over: Partial<SinkRow> = {}) =>
    ({
      id: 'sink-1',
      uuid: 'u',
      persona: '',
      addonInstanceId: 'trk',
      addonName: 'Tracker',
      baseUrl: 'https://trk.example/sealed-1',
      pullUrl: null,
      query: '',
      events: ['pause', 'played', 'watchlisted'],
      types: [],
      idPrefixes: null,
      status: 'ok',
      consecutiveFailures: 0,
      routingHash: 'h1',
      statusAt: 0,
      activeAt: Date.now(),
      retiredAt: null,
      ...over,
    }) as SinkRow;

  /** Stubs the repositories; `rows` answers each re-read of the sink row in turn. */
  function stub(
    history: WatchStateRow[],
    rows: (SinkRow | null)[],
    added?: (events: QueuedEvent[]) => number
  ) {
    const queued: QueuedEvent[][] = [];
    mock.method(WatchStateRepository, 'listPage', async () => history);
    let read = 0;
    const getSink = mock.method(
      PlaybackHandoffRepository,
      'getSink',
      async () => rows[Math.min(read++, rows.length - 1)]
    );
    mock.method(PlaybackHandoffRepository, 'countPending', async () => 0);
    mock.method(
      PlaybackHandoffRepository,
      'enqueueMany',
      async (_id: string, events: QueuedEvent[]) => {
        queued.push(events);
        return added ? added(events) : events.length;
      }
    );
    // Writes the catch-up must never make: they would put its captured
    // routing back on the row, and revive a retired one.
    const ensureSink = mock.method(
      PlaybackHandoffRepository,
      'ensureSink',
      async () => sinkRow()
    );
    const byAddon = mock.method(
      PlaybackHandoffRepository,
      'getSinkByAddon',
      async () => sinkRow()
    );
    mock.method(PlaybackHandoffRepository, 'touchActive', async () => {});
    return { queued, getSink, ensureSink, byAddon };
  }

  const films = (n: number) => Array.from({ length: n }, (_, i) => film(i + 1));

  it('replays the history without writing the sink row', async () => {
    const s = stub(films(3), [sinkRow()]);
    const result = await catchUpSink(scope, tracker(), sinkRow());
    assert.equal(result?.stopped, null);
    assert.equal(result?.queued, 3);
    assert.equal(s.queued.length, 3);
    assert.equal(s.ensureSink.mock.callCount(), 0);
    assert.equal(s.byAddon.mock.callCount(), 0);
  });

  for (const [what, changed, reason] of [
    [
      'saved again (a new sealed path)',
      sinkRow({ baseUrl: 'https://trk.example/sealed-2', routingHash: 'h2' }),
      'reconfigured',
    ],
    ['retired', sinkRow({ retiredAt: T }), 'retired'],
    [
      'switched to take no writes',
      sinkRow({ events: ['watchlisted'], routingHash: 'h3' }),
      'writes-off',
    ],
    ['removed', null, 'removed'],
  ] as const) {
    it(`stops, and writes nothing back, once the addon was ${what}`, async () => {
      // The row is read before each step: unchanged for the first, then changed.
      const s = stub(films(3), [sinkRow(), changed]);
      const result = await catchUpSink(scope, tracker(), sinkRow());
      assert.equal(result?.stopped, reason);
      assert.equal(result?.queued, 1);
      assert.equal(result?.unsent, 2);
      assert.equal(s.queued.length, 1, 'only the step before the change');
      assert.ok(
        s.queued[0][0].url.startsWith('https://trk.example/sealed-1/'),
        s.queued[0][0].url
      );
      assert.equal(s.ensureSink.mock.callCount(), 0);
      assert.equal(s.byAddon.mock.callCount(), 0);
    });
  }

  it('counts rows already queued under the same key as skipped, not sent', async () => {
    stub(films(2), [sinkRow()], () => 0);
    const result = await catchUpSink(scope, tracker(), sinkRow());
    assert.deepEqual(
      result && {
        queued: result.queued,
        skipped: result.skipped,
        unsent: result.unsent,
      },
      { queued: 0, skipped: 2, unsent: 0 }
    );
  });

  const watched = [
    episode(1, { played: true, lastPlayedAt: T - 3_000_000 }),
    episode(2, { played: true, lastPlayedAt: T - 1_000_000 }),
    film(1),
    row({ itemKey: 'm|tt9', baseId: 'tt9', positionMs: 60_000 }),
  ];

  for (const bulk of [false, true]) {
    it(`gives a second catch-up its own keys (${bulk ? 'bulk' : 'one event per episode'})`, async () => {
      const s = stub(watched, [sinkRow()]);
      await catchUpSink(scope, tracker({ bulk }), sinkRow());
      await catchUpSink(scope, tracker({ bulk }), sinkRow());
      const keys = s.queued.flat().map((e) => e.idempotencyKey);
      const half = keys.length / 2;
      assert.ok(half >= 3, `queued ${keys.length}`);
      const first = new Set(keys.slice(0, half));
      for (const key of keys.slice(half))
        assert.ok(!first.has(key), `${key} would be deduped`);
      // The body names the event by its key, as live events do.
      for (const e of s.queued.flat())
        assert.equal(JSON.parse(e.body).id, e.idempotencyKey);
    });
  }

  it("dates each episode sent one by one with its own watch, a bulk body with the show's last", async () => {
    const s = stub(watched.slice(0, 2), [sinkRow()]);
    await catchUpSink(scope, tracker({ bulk: false }), sinkRow());
    assert.deepEqual(
      s.queued.flat().map((e) => JSON.parse(e.body).at),
      [(T - 3_000_000) / 1000, (T - 1_000_000) / 1000]
    );
    s.queued.length = 0;
    await catchUpSink(scope, tracker({ bulk: true }), sinkRow());
    assert.deepEqual(
      s.queued.flat().map((e) => JSON.parse(e.body).at),
      [(T - 1_000_000) / 1000]
    );
  });
});

describe('live dispatch keys', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });
  afterEach(() => mock.restoreAll());

  const scope = { uuid: 'u', persona: 'live' };
  const sink = (bulk: boolean) =>
    ({
      instanceId: `live-${bulk}`,
      name: 'Tracker',
      baseUrl: 'https://trk.example/sealed-1',
      query: '',
      events: ['pause', 'played'],
      bulk,
      pullable: false,
      types: [],
    }) as ResolvedPlaybackSink;

  function stub() {
    const queued: QueuedEvent[] = [];
    // A known tracker, already taking writes, so no catch-up starts.
    const existing = {
      id: 'live',
      routingHash: null,
      retiredAt: null,
      status: 'ok',
      statusAt: 0,
      activeAt: Date.now(),
      events: ['pause', 'played'],
      baseUrl: 'https://trk.example/sealed-1',
    } as unknown as SinkRow;
    mock.method(
      PlaybackHandoffRepository,
      'getSinkByAddon',
      async () => existing
    );
    mock.method(PlaybackHandoffRepository, 'ensureSink', async () => existing);
    mock.method(PlaybackHandoffRepository, 'touchActive', async () => {});
    mock.method(PlaybackHandoffRepository, 'countPending', async () => 0);
    mock.method(
      PlaybackHandoffRepository,
      'enqueueMany',
      async (_id: string, events: QueuedEvent[]) => {
        queued.push(...events);
        return events.length;
      }
    );
    return queued;
  }

  const mark = {
    kind: 'played' as const,
    type: 'series',
    metaId: 'tt0903747',
    scope: 'series' as const,
    season: null,
    videos: [1, 2].map((n) => ({
      videoId: `tt0903747:1:${n}`,
      season: 1,
      episode: n,
      itemKey: `e|tt0903747:1:${n}`,
    })),
  };

  it('keys a live mark on the time it was made, as before', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T });
    const queued = stub();
    await dispatchBulkMark(scope, [sink(true)], mark);
    await dispatchBulkMark(scope, [sink(false)], mark);
    await dispatchPlayback(scope, [sink(false)], {
      kind: 'played',
      type: 'movie',
      videoId: 'tt1',
      baseId: 'tt1',
      itemKey: 'm|tt1',
      at: T - 5_000,
      played: true,
    });
    assert.deepEqual(
      queued.map((e) => e.idempotencyKey),
      [
        `b|tt0903747|played|${T}|1`,
        `e|tt0903747:1:1|played|${T}`,
        `e|tt0903747:1:2|played|${T}`,
        `m|tt1|played|${T - 5_000}`,
      ]
    );
  });
});
