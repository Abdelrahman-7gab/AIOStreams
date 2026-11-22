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

/**
 * Why a catch-up stopped before its last step: its queue did not drain in
 * time, or the sink row is no longer the one it started replaying to.
 */
export type CatchUpStop =
  'queue' | 'removed' | 'retired' | 'writes-off' | 'reconfigured';

/** The parts of a sink row a catch-up checks before each step. */
export interface CatchUpSinkState {
  baseUrl: string;
  query: string;
  routingHash: string | null;
  events: readonly string[];
  retiredAt: number | null;
}

/**
 * Whether a catch-up must stop because its sink row changed under it: the
 * addon was removed, retired, switched to take no writes, or saved again with
 * another address or routing (a Watch Sync re-save seals a new path, which may
 * hold another account). The catch-up then stops instead of carrying on with
 * the configuration it captured, which would post to the old address.
 */
export function catchUpHalt(
  started: CatchUpSinkState,
  now: CatchUpSinkState | null
): CatchUpStop | null {
  if (!now) return 'removed';
  if (now.retiredAt != null) return 'retired';
  if (!acceptsWrites(now.events)) return 'writes-off';
  if (
    now.baseUrl !== started.baseUrl ||
    now.query !== started.query ||
    now.routingHash !== started.routingHash
  )
    return 'reconfigured';
  return null;
}

/** Episodes per queue row of a bulk mark. */
export const BULK_PART_SIZE = 500;

export interface CatchUpPlan {
  /** Resume points, sent as pauses at their position. */
  resumes: PlaybackEventInput[];
  /** Watched films, one mark each. */
  watched: PlaybackEventInput[];
  /**
   * Watched episodes, one mark per show. Each episode keeps its own date, for
   * a tracker sent one event per episode; the mark is dated by the latest of
   * them, as a bulk body carries one date.
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
          at,
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
  | { kind: 'show'; mark: BulkMarkInput; rows: number }
  | { kind: 'film' | 'resume'; event: PlaybackEventInput; rows: number }
  | { kind: 'favourite'; change: ListChangeInput; rows: number };

/**
 * The order a catch-up is queued in: shows, films, favourites, resume points.
 *
 * A full queue drops its oldest rows first, pings (`pause` among them) before
 * marks, so the resume points, which nothing else would carry again, go last.
 * A tracker without `bulk` takes one event per episode, so its shows are split
 * into `chunk`s the throttle can pace; a `bulk` tracker gets each show whole,
 * as its parts are keyed by their index and split marks would collide. A bulk
 * show queues one row per {@link BULK_PART_SIZE} episodes.
 */
export function catchUpSteps(
  plan: CatchUpPlan,
  sink: { bulk: boolean; chunk: number }
): CatchUpStep[] {
  const steps: CatchUpStep[] = [];
  const chunk = Math.max(1, sink.chunk);
  for (const mark of plan.shows) {
    if (sink.bulk) {
      const rows = Math.ceil(mark.videos.length / BULK_PART_SIZE);
      steps.push({ kind: 'show', mark, rows });
      continue;
    }
    if (mark.videos.length <= chunk) {
      steps.push({ kind: 'show', mark, rows: mark.videos.length });
      continue;
    }
    for (let i = 0; i < mark.videos.length; i += chunk) {
      const videos = mark.videos.slice(i, i + chunk);
      steps.push({
        kind: 'show',
        mark: { ...mark, videos },
        rows: videos.length,
      });
    }
  }
  for (const event of plan.watched)
    steps.push({ kind: 'film', event, rows: 1 });
  for (const change of plan.favourites)
    steps.push({ kind: 'favourite', change, rows: 1 });
  for (const event of plan.resumes)
    steps.push({ kind: 'resume', event, rows: 1 });
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
  /**
   * Why the catch-up must stop now, from a fresh read of the sink row
   * ({@link catchUpHalt}); null to carry on. Asked before every step and
   * after every wait's poll, since a wait can last minutes.
   */
  halted: () => Promise<CatchUpStop | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** What a catch-up did, in queue rows (one per event, one per bulk part). */
export interface CatchUpResult {
  /** Rows added to the sink's queue, as the queue counted them. */
  queued: number;
  /**
   * Rows the sent steps could have added but did not: the tracker does not
   * take that event or title, a row with the same key was already queued, the
   * sink was in its error backoff, or the dispatch failed.
   */
  skipped: number;
  /** Rows of the steps never sent because the catch-up stopped. */
  unsent: number;
  /** Why the catch-up stopped before its last step; null when it finished. */
  stopped: CatchUpStop | null;
}

/**
 * Sends the steps in order, waiting while the sink's queue is above
 * `room.limit` so the catch-up never pushes it past the cap, where the oldest
 * rows, live pings included, would be dropped. The queue is counted again only
 * when the running estimate says the next step could cross the limit. `send`
 * answers how many rows it queued. The catch-up stops as soon as
 * `room.halted` says the sink changed under it.
 */
export async function sendCatchUp(
  steps: readonly CatchUpStep[],
  send: (step: CatchUpStep) => Promise<number>,
  room: QueueRoom
): Promise<CatchUpResult> {
  const result: CatchUpResult = {
    queued: 0,
    skipped: 0,
    unsent: 0,
    stopped: null,
  };
  const stop = (reason: CatchUpStop, from: number) => {
    result.stopped = reason;
    for (const rest of steps.slice(from)) result.unsent += rest.rows;
    return result;
  };
  let estimate: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (estimate === null || estimate + step.rows > room.limit) {
      const deadline = room.now() + room.timeoutMs;
      estimate = await room.pending();
      while (estimate > room.limit) {
        if (room.now() >= deadline) return stop('queue', i);
        await room.sleep(room.pollMs);
        const halt = await room.halted();
        if (halt) return stop(halt, i);
        estimate = await room.pending();
      }
    }
    const halt = await room.halted();
    if (halt) return stop(halt, i);
    let queued = 0;
    try {
      queued = Math.min(step.rows, Math.max(0, await send(step)));
    } catch {
      // Counted below as skipped: a failed dispatch queued nothing.
    }
    result.queued += queued;
    result.skipped += step.rows - queued;
    estimate += queued;
  }
  return result;
}
