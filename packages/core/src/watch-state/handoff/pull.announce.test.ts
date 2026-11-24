import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// First: loading a repository before the config trips the logger's import cycle.
import '../../config/index.js';
import {
  WatchStateRepository,
  type WatchStateRow,
} from '../../db/repositories/watch-state.js';
import type { DbDriver } from '../../db/driver/types.js';
import {
  ANNOUNCE_CHUNK,
  LocalWatchStateProvider,
} from '../local-provider.js';
import { getWatchStateProvider } from '../index.js';
import type { WatchScope } from '../types.js';
import { announceImport, announcedRows } from './pull.js';

const T = Date.UTC(2026, 10, 24, 7, 0, 0);
const scope: WatchScope = { uuid: 'u', persona: '' } as WatchScope;

function row(itemKey: string, over: Partial<WatchStateRow> = {}): WatchStateRow {
  return {
    uuid: 'u',
    persona: '',
    itemKey,
    kind: 'movie',
    mediaType: 'movie',
    baseId: itemKey.slice(2),
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
    origin: 'import',
    sinkId: 's',
    externalAt: T,
    snapshot: null,
    sortAt: T,
    ...over,
  } as WatchStateRow;
}

afterEach(() => mock.restoreAll());

describe('announcedRows', () => {
  it('sends a changed row as it is now stored', () => {
    const stored = row('m|tt1', { positionMs: 1_200_000, durationMs: 6_000_000 });
    const out = announcedRows(new Map([['m|tt1', stored]]), ['m|tt1'], []);
    assert.deepEqual(out, [stored]);
  });

  it('sends a deleted resume point as nothing watched, keeping its identity', () => {
    const before = row('e|tt9:1:2', {
      kind: 'episode',
      positionMs: 900_000,
      durationMs: 2_400_000,
      played: true,
      playCount: 1,
    });
    const [out] = announcedRows(new Map(), [], [before]);
    assert.equal(out.itemKey, 'e|tt9:1:2');
    assert.equal(out.kind, 'episode');
    assert.equal(out.played, false);
    assert.equal(out.positionMs, 0);
    assert.equal(out.playCount, 0);
    assert.equal(out.lastPlayedAt, null);
  });

  it('prefers the stored row when a read deleted one spelling and wrote it again', () => {
    const stored = row('m|tt1', { played: true, playCount: 1 });
    const out = announcedRows(
      new Map([['m|tt1', stored]]),
      ['m|tt1'],
      [row('m|tt1', { positionMs: 5 })]
    );
    assert.deepEqual(out, [stored]);
  });

  it('skips a changed key that is no longer stored', () => {
    assert.deepEqual(announcedRows(new Map(), ['m|gone'], []), []);
  });
});

describe('LocalWatchStateProvider.announce', () => {
  it('tells every listener, in chunks', () => {
    const provider = new LocalWatchStateProvider();
    const sizes: number[] = [];
    const scopes: WatchScope[] = [];
    provider.onChange((s, rows) => {
      scopes.push(s);
      sizes.push(rows.length);
    });
    const total = ANNOUNCE_CHUNK * 2 + 7;
    provider.announce(
      scope,
      Array.from({ length: total }, (_, i) => row(`m|tt${i}`))
    );
    assert.deepEqual(sizes, [ANNOUNCE_CHUNK, ANNOUNCE_CHUNK, 7]);
    assert.ok(scopes.every((s) => s === scope));
  });

  it('sends nothing for no rows', () => {
    const provider = new LocalWatchStateProvider();
    let calls = 0;
    provider.onChange(() => calls++);
    provider.announce(scope, []);
    assert.equal(calls, 0);
  });

  it('keeps telling the others when one listener throws', () => {
    const provider = new LocalWatchStateProvider();
    let heard = 0;
    provider.onChange(() => {
      throw new Error('boom');
    });
    provider.onChange(() => heard++);
    provider.announce(scope, [row('m|tt1')]);
    assert.equal(heard, 1);
  });
});

describe('announceImport', () => {
  it('reads the changed rows after the write and pushes them with the deleted ones', async () => {
    const stored = row('m|tt1', { played: true });
    const getMany = mock.method(WatchStateRepository, 'getMany', async () =>
      new Map([['m|tt1', stored]])
    );
    const heard: WatchStateRow[][] = [];
    const off = getWatchStateProvider().onChange((_s, rows) => heard.push(rows));
    try {
      await announceImport(scope, new Set(['m|tt1']), [row('m|tt2')]);
    } finally {
      off();
    }
    assert.equal(getMany.mock.callCount(), 1);
    assert.deepEqual(getMany.mock.calls[0].arguments.slice(0, 2), [
      scope,
      ['m|tt1'],
    ]);
    assert.equal(heard.length, 1);
    assert.deepEqual(
      heard[0].map((r) => [r.itemKey, r.played]).sort(),
      [
        ['m|tt1', true],
        ['m|tt2', false],
      ]
    );
  });

  it('does nothing when the read changed nothing', async () => {
    const getMany = mock.method(WatchStateRepository, 'getMany', async () => new Map());
    let calls = 0;
    const off = getWatchStateProvider().onChange(() => calls++);
    try {
      await announceImport(scope, new Set(), []);
    } finally {
      off();
    }
    assert.equal(getMany.mock.callCount(), 0);
    assert.equal(calls, 0);
  });

  it('never fails the read when the lookup fails', async () => {
    mock.method(WatchStateRepository, 'getMany', async () => {
      throw new Error('db down');
    });
    await assert.doesNotReject(announceImport(scope, new Set(['m|tt1']), []));
  });
});

/** Answers the sweep's SELECT with `keys` and counts every row an UPDATE or DELETE names. */
function fakeDb(keys: string[]): DbDriver {
  return {
    query: async () => keys.map((item_key) => ({ item_key })),
    exec: async () => ({ rowCount: 1 }),
  } as unknown as DbDriver;
}

describe('stale sweeps report what they touched', () => {
  it('deleteStaleImports collects each unlisted row before deleting it', async () => {
    const getMany = mock.method(
      WatchStateRepository,
      'getMany',
      async (_s: WatchScope, keys: string[]) =>
        new Map(keys.map((k) => [k, row(k, { positionMs: 42 })]))
    );
    const gone: WatchStateRow[] = [];
    await WatchStateRepository.deleteStaleImports(
      scope,
      's',
      T,
      'resume',
      new Set(['m|kept']),
      fakeDb(['m|old', 'm|kept']),
      gone
    );
    assert.deepEqual(getMany.mock.calls[0].arguments[1], ['m|old']);
    assert.deepEqual(
      gone.map((r) => [r.itemKey, r.positionMs]),
      [['m|old', 42]]
    );
  });

  it('deleteStaleImports works as before without a collector', async () => {
    const getMany = mock.method(WatchStateRepository, 'getMany', async () => new Map());
    const removed = await WatchStateRepository.deleteStaleImports(
      scope,
      's',
      T,
      'watched',
      new Set(),
      fakeDb(['m|old'])
    );
    assert.equal(removed, 1);
    assert.equal(getMany.mock.callCount(), 0);
  });

  it('clearStaleRewatches reports the keys it reset', async () => {
    const reset: string[] = [];
    await WatchStateRepository.clearStaleRewatches(
      scope,
      's',
      T,
      new Set(['e|tt9:1:1']),
      fakeDb(['e|tt9:1:1', 'e|tt9:1:2']),
      reset
    );
    assert.deepEqual(reset, ['e|tt9:1:2']);
  });
});
