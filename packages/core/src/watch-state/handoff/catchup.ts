import { config as appConfig } from '../../config/index.js';
import { createLogger } from '../../logging/logger.js';
import {
  WatchStateRepository,
  type WatchStateRow,
} from '../../db/repositories/watch-state.js';
import { PlaybackHandoffRepository } from '../../db/repositories/playback-handoff.js';
import {
  dispatchBulkMark,
  dispatchListChange,
  dispatchPlayback,
  ensurePlaybackSink,
} from './dispatch.js';
import {
  catchUpRoom,
  catchUpSteps,
  planCatchUp,
  sendCatchUp,
  type CatchUpStep,
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

/** Replays this history's own plays, marks and favourites to one tracker. */
export async function catchUpSink(
  scope: WatchScope,
  sink: ResolvedPlaybackSink
): Promise<void> {
  const key = `${scope.uuid}|${scope.persona}|${sink.instanceId}`;
  if (running.has(key)) return;
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
    const row = await ensurePlaybackSink(scope, sink);
    const { limit, chunk } = catchUpRoom(
      appConfig.watchState.deliveryMaxPendingPerSink
    );
    const send = async (step: CatchUpStep) => {
      switch (step.kind) {
        case 'show':
          return dispatchBulkMark(scope, sinks, step.mark);
        case 'favourite':
          return dispatchListChange(scope, sinks, step.change);
        default:
          return dispatchPlayback(scope, sinks, step.event);
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
      logger.warn(
        summary,
        'stopped catching a tracker up: its delivery queue did not drain'
      );
    } else {
      logger.info(
        summary,
        'sent this history to a tracker that started accepting it'
      );
    }
  } catch (error) {
    logger.warn(
      {
        addon: sink.name,
        err: error instanceof Error ? error.message : String(error),
      },
      'could not catch a tracker up with this history'
    );
  } finally {
    running.delete(key);
  }
}
