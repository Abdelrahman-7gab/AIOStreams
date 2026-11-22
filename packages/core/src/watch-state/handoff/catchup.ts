import { config as appConfig } from '../../config/index.js';
import { createLogger } from '../../logging/logger.js';
import {
  WatchStateRepository,
  type WatchStateRow,
} from '../../db/repositories/watch-state.js';
import {
  PlaybackHandoffRepository,
  type SinkRow,
} from '../../db/repositories/playback-handoff.js';
import {
  dispatchBulkMark,
  dispatchListChange,
  dispatchPlayback,
  type DispatchOptions,
} from './dispatch.js';
import {
  catchUpHalt,
  catchUpRoom,
  catchUpSteps,
  planCatchUp,
  sendCatchUp,
  type CatchUpResult,
  type CatchUpStep,
  type CatchUpStop,
} from './catchup-plan.js';
import type { ResolvedPlaybackSink } from './resolve.js';
import type { WatchScope } from '../types.js';

const logger = createLogger('watch-state');

const PAGE = 500;
/** How often a catch-up waiting on a full queue counts it again. */
const POLL_MS = 5_000;
/**
 * How long one wait may last. Ten delivery intervals at the default: a queue
 * that has not drained by then belongs to a tracker that is down or rejecting.
 */
const WAIT_TIMEOUT_MS = 10 * 60_000;

/** Unref'd: a catch-up waiting on a queue never holds up a shutdown. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Sinks whose catch-up is running here, so two paths noticing it at once send it once. */
const running = new Set<string>();

const STOPPED: Record<CatchUpStop, string> = {
  queue: 'stopped catching a tracker up: its delivery queue did not drain',
  removed: 'stopped catching a tracker up: its addon was removed',
  retired: 'stopped catching a tracker up: its addon is no longer in use',
  'writes-off': 'stopped catching a tracker up: it no longer takes writes',
  reconfigured:
    'stopped catching a tracker up: its addon was saved again with another address or routing',
};

/**
 * Replays this history's own plays, marks and favourites to one tracker:
 * `sink` as it was when `row` was written from it.
 *
 * It can run for a long time (it waits on a full queue), so it re-reads the
 * row before every step and stops once the addon was saved again, retired,
 * removed or switched to take no writes. It never writes the row: putting the
 * routing it captured back would undo the newer one, revive a retired sink and
 * post to the old address. Answers what it did, or null when it did not run.
 */
export async function catchUpSink(
  scope: WatchScope,
  sink: ResolvedPlaybackSink,
  row: SinkRow
): Promise<CatchUpResult | null> {
  const key = `${scope.uuid}|${scope.persona}|${sink.instanceId}`;
  if (running.has(key)) return null;
  running.add(key);
  try {
    const rows: WatchStateRow[] = [];
    let after: { persona: string; itemKey: string } | undefined;
    for (;;) {
      const page = await WatchStateRepository.listPage(
        scope.uuid,
        [scope.persona],
        { limit: PAGE, after }
      );
      rows.push(...page);
      if (page.length < PAGE) break;
      const last = page[page.length - 1];
      after = { persona: last.persona, itemKey: last.itemKey };
    }
    const plan = planCatchUp(rows);
    const sinks = [sink];
    /** The row as last read, unchanged since the catch-up started. */
    let current = row;
    const options: DispatchOptions = {
      sinkRow: async () => current,
      // Its own keys: a later catch-up of this sink is never deduplicated
      // against this one's rows.
      replay: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    };
    const { limit, chunk } = catchUpRoom(
      appConfig.watchState.deliveryMaxPendingPerSink
    );
    const send = async (step: CatchUpStep) => {
      switch (step.kind) {
        case 'show':
          return dispatchBulkMark(scope, sinks, step.mark, options);
        case 'favourite':
          return dispatchListChange(scope, sinks, step.change, options);
        default:
          return dispatchPlayback(scope, sinks, step.event, options);
      }
    };
    const result = await sendCatchUp(
      catchUpSteps(plan, { bulk: !!sink.bulk, chunk }),
      send,
      {
        limit,
        pollMs: POLL_MS,
        timeoutMs: WAIT_TIMEOUT_MS,
        pending: () => PlaybackHandoffRepository.countPending(row.id),
        halted: async () => {
          const fresh = await PlaybackHandoffRepository.getSink(row.id);
          const halt = catchUpHalt(row, fresh);
          if (!halt && fresh) current = fresh;
          return halt;
        },
        sleep,
        now: Date.now,
      }
    );
    const summary = {
      addon: sink.name,
      persona: scope.persona || undefined,
      resumes: plan.resumes.length,
      films: plan.watched.length,
      shows: plan.shows.length,
      favourites: plan.favourites.length,
      ...result,
    };
    if (result.stopped) {
      // Not retried: the tracker only catches up again on its next transition.
      logger.warn(summary, STOPPED[result.stopped]);
    } else {
      logger.info(
        summary,
        'sent this history to a tracker that started accepting it'
      );
    }
    return result;
  } catch (error) {
    logger.warn(
      {
        addon: sink.name,
        err: error instanceof Error ? error.message : String(error),
      },
      'could not catch a tracker up with this history'
    );
    return null;
  } finally {
    running.delete(key);
  }
}
