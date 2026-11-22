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
 * The host a sink's address points at. The path is the addon's whole
 * configuration, and Watch Sync (addon-sdk) seals it with a random IV, so
 * every re-save, even with the same settings, makes a new path.
 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

/**
 * Whether a sink just started accepting writes for this history: it is new,
 * it took none before, or it now points at another host.
 *
 * Only the host is compared, so a reconfigure or reinstall does not replay the
 * whole history to the same account. The trade-off, accepted: moving to a
 * different account on the same tracker host is not noticed and gets no
 * catch-up, since the account lives inside the sealed path.
 */
export function startsWriting(
  previous: { events: readonly string[]; baseUrl: string } | null,
  next: { events: readonly string[]; baseUrl: string }
): boolean {
  if (!acceptsWrites(next.events)) return false;
  return (
    !previous ||
    !acceptsWrites(previous.events) ||
    hostOf(previous.baseUrl) !== hostOf(next.baseUrl)
  );
}

export interface CatchUpPlan {
  /** Resume points, sent as pauses at their position. */
  resumes: PlaybackEventInput[];
  /** Watched films, one mark each. */
  watched: PlaybackEventInput[];
  /**
   * Watched episodes, one mark per show, dated by the latest of its episodes:
   * a mark carries one date.
   */
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
            at,
          };
          shows.set(row.baseId, show);
        } else if (at > (show.at ?? 0)) {
          show.at = at;
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

/** One dispatch of a catch-up, and how many rows it may add to the queue at most. */
export type CatchUpStep =
  | { kind: 'show'; mark: BulkMarkInput; size: number }
  | { kind: 'film' | 'resume'; event: PlaybackEventInput; size: number }
  | { kind: 'favourite'; change: ListChangeInput; size: number };

/**
 * The order a catch-up is queued in: shows, films, favourites, resume points.
 *
 * A full queue drops its oldest rows first, pings (`pause` among them) before
 * marks, so the resume points, which nothing else would carry again, go last.
 * A tracker without `bulk` takes one event per episode, so its shows are split
 * into `chunk`s the throttle can pace; a `bulk` tracker gets each show whole,
 * as its parts are keyed by their index and split marks would collide.
 */
export function catchUpSteps(
  plan: CatchUpPlan,
  sink: { bulk: boolean; chunk: number }
): CatchUpStep[] {
  const steps: CatchUpStep[] = [];
  const chunk = Math.max(1, sink.chunk);
  for (const mark of plan.shows) {
    if (sink.bulk || mark.videos.length <= chunk) {
      steps.push({ kind: 'show', mark, size: mark.videos.length });
      continue;
    }
    for (let i = 0; i < mark.videos.length; i += chunk) {
      const videos = mark.videos.slice(i, i + chunk);
      steps.push({
        kind: 'show',
        mark: { ...mark, videos },
        size: videos.length,
      });
    }
  }
  for (const event of plan.watched)
    steps.push({ kind: 'film', event, size: 1 });
  for (const change of plan.favourites)
    steps.push({ kind: 'favourite', change, size: 1 });
  for (const event of plan.resumes)
    steps.push({ kind: 'resume', event, size: 1 });
  return steps;
}

/** Share of a sink's queue cap a catch-up may fill before it waits. */
const ROOM_SHARE = 0.75;
const MAX_CHUNK = 100;

/**
 * How full a catch-up lets a sink's queue get (`limit`), and the most rows
 * one step adds (`chunk`), so a step started at the limit stays within the cap.
 */
export function catchUpRoom(cap: number): { limit: number; chunk: number } {
  const limit = Math.floor(cap * ROOM_SHARE);
  return { limit, chunk: Math.max(1, Math.min(MAX_CHUNK, cap - limit)) };
}

export interface QueueRoom {
  /** Rows the queue may hold before the catch-up waits. */
  limit: number;
  pollMs: number;
  /** How long one wait may last before the catch-up stops. */
  timeoutMs: number;
  /** The sink's pending rows, counted. */
  pending: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface CatchUpResult {
  /** Events handed to dispatch (an upper bound on rows queued). */
  sent: number;
  /** Events whose dispatch threw. */
  skipped: number;
  /** Events never sent because the catch-up stopped. */
  unsent: number;
  /** The queue did not drain in time, so the catch-up stopped. */
  stopped: boolean;
}

/**
 * Sends the steps in order, waiting while the sink's queue is above
 * `room.limit` so the catch-up never pushes it past the cap, where the oldest
 * rows, live pings included, would be dropped. The queue is counted again only
 * when the running estimate says the next step could cross the limit.
 */
export async function sendCatchUp(
  steps: readonly CatchUpStep[],
  send: (step: CatchUpStep) => Promise<void>,
  room: QueueRoom
): Promise<CatchUpResult> {
  const result: CatchUpResult = {
    sent: 0,
    skipped: 0,
    unsent: 0,
    stopped: false,
  };
  let estimate: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (estimate === null || estimate + step.size > room.limit) {
      const deadline = room.now() + room.timeoutMs;
      estimate = await room.pending();
      while (estimate > room.limit) {
        if (room.now() >= deadline) {
          result.stopped = true;
          for (const rest of steps.slice(i)) result.unsent += rest.size;
          return result;
        }
        await room.sleep(room.pollMs);
        estimate = await room.pending();
      }
    }
    try {
      await send(step);
      result.sent += step.size;
    } catch {
      result.skipped += step.size;
    }
    estimate += step.size;
  }
  return result;
}
