import type { WatchStateRow } from '../../db/repositories/watch-state.js';
import type { PlaybackEventKind } from './capability.js';
import type {
  BulkMarkInput,
  ListChangeInput,
  PlaybackEventInput,
} from './dispatch.js';

/** Events a tracker must accept before its history is replayed to it. */
const WRITES: readonly PlaybackEventKind[] = ['pause', 'played'];

/** Whether a sink accepts the events a catch-up sends. */
export function acceptsWrites(events: readonly string[]): boolean {
  return WRITES.some((event) => events.includes(event));
}

/**
 * Whether a sink just started accepting writes for this history: it is new,
 * it took none before, or it now points somewhere else (another account).
 */
export function startsWriting(
  previous: { events: readonly string[]; baseUrl: string } | null,
  next: { events: readonly string[]; baseUrl: string }
): boolean {
  if (!acceptsWrites(next.events)) return false;
  return (
    !previous ||
    !acceptsWrites(previous.events) ||
    previous.baseUrl !== next.baseUrl
  );
}

export interface CatchUpPlan {
  /** Resume points, sent as pauses at their position. */
  resumes: PlaybackEventInput[];
  /** Watched films, one mark each. */
  watched: PlaybackEventInput[];
  /** Watched episodes, one mark per show. */
  shows: BulkMarkInput[];
  favourites: ListChangeInput[];
}

/**
 * What a tracker is sent to catch up with a history: only what was watched
 * here. Rows an addon brought in (`import`) came from a tracker already, and
 * a favourite an addon's watchlist set belongs to that addon.
 */
export function planCatchUp(rows: readonly WatchStateRow[]): CatchUpPlan {
  const plan: CatchUpPlan = {
    resumes: [],
    watched: [],
    shows: [],
    favourites: [],
  };
  const shows = new Map<string, BulkMarkInput>();
  for (const row of rows) {
    if (row.favorite && row.favoriteSinkId == null && row.kind !== 'episode') {
      plan.favourites.push({
        kind: 'watchlisted',
        type: row.mediaType,
        metaId: row.baseId,
        itemKey: row.itemKey,
      });
    }
    if (row.origin !== 'local') continue;
    const at = row.lastPlayedAt ?? row.updatedAt;
    const video = row.videoId || row.baseId;
    if (row.played) {
      if (row.kind === 'episode') {
        if (!row.videoId) continue;
        let show = shows.get(row.baseId);
        if (!show) {
          show = {
            kind: 'played',
            type: row.mediaType,
            metaId: row.baseId,
            scope: 'series',
            season: null,
            videos: [],
          };
          shows.set(row.baseId, show);
        }
        show.videos.push({
          videoId: row.videoId,
          season: row.season ?? null,
          episode: row.episode ?? null,
          itemKey: row.itemKey,
        });
      } else {
        plan.watched.push({
          kind: 'played',
          type: row.mediaType,
          videoId: video,
          baseId: row.baseId,
          itemKey: row.itemKey,
          at,
          played: true,
        });
      }
    } else if (row.positionMs > 0) {
      plan.resumes.push({
        kind: 'pause',
        type: row.mediaType,
        videoId: video,
        baseId: row.baseId,
        itemKey: row.itemKey,
        season: row.season ?? null,
        episode: row.episode ?? null,
        at,
        positionMs: row.positionMs,
        durationMs: row.durationMs || undefined,
        played: false,
        sessionStartedAt: at,
      });
    }
  }
  plan.shows = [...shows.values()];
  return plan;
}
