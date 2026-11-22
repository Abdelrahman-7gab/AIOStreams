import { createLogger } from '../../logging/logger.js';
import {
  WatchStateRepository,
  type WatchStateRow,
} from '../../db/repositories/watch-state.js';
import {
  dispatchBulkMark,
  dispatchListChange,
  dispatchPlayback,
} from './dispatch.js';
import { planCatchUp } from './catchup-plan.js';
import type { ResolvedPlaybackSink } from './resolve.js';
import type { WatchScope } from '../types.js';

const logger = createLogger('watch-state');

const PAGE = 500;
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
    for (const event of plan.resumes)
      await dispatchPlayback(scope, sinks, event);
    for (const event of plan.watched)
      await dispatchPlayback(scope, sinks, event);
    for (const show of plan.shows) await dispatchBulkMark(scope, sinks, show);
    for (const change of plan.favourites)
      await dispatchListChange(scope, sinks, change);
    logger.info(
      {
        addon: sink.name,
        persona: scope.persona || undefined,
        resumes: plan.resumes.length,
        films: plan.watched.length,
        shows: plan.shows.length,
        favourites: plan.favourites.length,
      },
      'sent this history to a tracker that started accepting it'
    );
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
