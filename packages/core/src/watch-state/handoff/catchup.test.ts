import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planCatchUp, startsWriting } from './catchup-plan.js';
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
  const pushes = { events: ['start', 'pause', 'stop', 'played'], baseUrl: 'a' };

  it('catches up a tracker that is new, or only now takes writes', () => {
    assert.equal(startsWriting(null, pushes), true);
    assert.equal(startsWriting({ events: [], baseUrl: 'old' }, pushes), true);
  });

  it('catches up again when the tracker moves to another account', () => {
    assert.equal(startsWriting({ ...pushes, baseUrl: 'other' }, pushes), true);
  });

  it('leaves alone a tracker that already took writes, or still takes none', () => {
    assert.equal(startsWriting(pushes, pushes), false);
    assert.equal(startsWriting(null, { events: [], baseUrl: 'a' }), false);
    // Watchlist-only or rating-only trackers get no playback history.
    assert.equal(
      startsWriting(null, { events: ['watchlisted'], baseUrl: 'a' }),
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
});
