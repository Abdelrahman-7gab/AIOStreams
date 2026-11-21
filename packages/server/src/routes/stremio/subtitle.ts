import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  SubtitleResponse,
  config as appConfig,
  checkSubtitles,
  createLogger,
  createSyncLink,
  findOffered,
  referenceFor,
  StremioTransformer,
  subtitleSyncEnabled,
  type Subtitle,
  type SyncLink,
} from '@aiostreams/core';
import { trackResource } from '../../middlewares/analytics.js';
import { rawExtras } from '../../utils/extras.js';

const logger = createLogger('server');
const router: Router = Router();

/** `filename=…&videoSize=…` as Stremio sends it, each value decoded. */
function fileExtras(extras: string | undefined) {
  const found: { filename?: string; size?: number } = {};
  for (const pair of extras?.split('&') ?? []) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const key = pair.slice(0, at);
    let value = pair.slice(at + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Kept as sent.
    }
    if (key === 'filename') found.filename = value;
    else if (key === 'videoSize' && Number(value) > 0)
      found.size = Number(value);
  }
  return found;
}

const EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'];

function extensionOf(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a full address; its own path is used.
  }
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS.includes(ext) ? ext : 'srt';
}

/**
 * Points each subtitle at this server's synced copy of it when the request
 * names a file this user was offered for the title. The copy is retimed to
 * that file's own subtitle, or served unchanged when it can't be.
 */
async function syncLinks(
  originalUrl: string,
  uuid: string,
  type: string,
  id: string,
  extras: string | undefined,
  answer: SubtitleResponse
) {
  const playing = fileExtras(extras);
  if (!playing.filename && !playing.size) return;
  const file = await findOffered(uuid, type, id, playing);
  if (!file) return;
  // The same mount this request came in on, variants included.
  const mount = originalUrl.slice(0, originalUrl.indexOf('/subtitles/'));
  const base = appConfig.bootstrap.baseUrl.replace(/\/+$/, '');
  const tokens = new Map<Subtitle, string>();
  const checks: { token: string; link: SyncLink }[] = [];
  for (const subtitle of answer.subtitles) {
    if (!subtitle.url || subtitle.id.startsWith('error.')) continue;
    if (!/^https?:\/\//.test(subtitle.url)) continue;
    const { token, link } = await createSyncLink(subtitle.url, file);
    if (!checks.length) void referenceFor(link);
    checks.push({ token, link });
    tokens.set(subtitle, token);
    subtitle.url = `${base}${mount}/subsync/${token}.${extensionOf(subtitle.url)}`;
  }

  // Players pick the first subtitle in their language, so the ones known to
  // match the file go first and the ones that matched nothing go last.
  const outcomes = await checkSubtitles(checks, CHECK_BUDGET_MS);
  const rank = (subtitle: Subtitle) => {
    const token = tokens.get(subtitle);
    const outcome = token ? outcomes.get(token) : undefined;
    if (outcome === 'retimed' || outcome === 'in-time') return 0;
    if (outcome === 'unmatched') return 2;
    return 1;
  };
  answer.subtitles = answer.subtitles
    .map((subtitle, at) => ({ subtitle, at, rank: rank(subtitle) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((s) => s.subtitle);
}

/** How long a subtitle list waits for its subtitles to be checked. */
const CHECK_BUDGET_MS = 6000;
/** Subtitles kept per language, the best matched first. */
const PER_LANGUAGE = 5;

/** At most `PER_LANGUAGE` subtitles of each language, in the order given. */
function capPerLanguage(answer: SubtitleResponse) {
  const seen = new Map<string, number>();
  answer.subtitles = answer.subtitles.filter((subtitle) => {
    if (subtitle.id.startsWith('error.')) return true;
    const count = (seen.get(subtitle.lang) ?? 0) + 1;
    seen.set(subtitle.lang, count);
    return count <= PER_LANGUAGE;
  });
}

router.use(trackResource('subtitle'));

interface SubtitleParams {
  type: string;
  id: string;
  extras?: string; // optional
}

router.get(
  '/:type/:id{/:extras}.json',
  async (
    req: Request<SubtitleParams>,
    res: Response<SubtitleResponse>,
    next: NextFunction
  ) => {
    if (!req.userData) {
      res.status(200).json(
        StremioTransformer.createDynamicError('subtitles', {
          errorDescription: 'Please configure the addon first',
        })
      );
      return;
    }
    const transformer = new StremioTransformer(req.userData);
    try {
      const { type, id } = req.params;
      const extras = rawExtras(req);

      const answer = transformer.transformSubtitles(
        await (
          await new AIOStreams(req.userData).initialise()
        ).getSubtitles(type, id, extras)
      );
      if (subtitleSyncEnabled() && req.userData.uuid)
        await syncLinks(
          req.originalUrl,
          req.userData.uuid,
          type,
          id,
          extras,
          answer
        ).catch((error) =>
          logger.warn({ error }, 'could not point subtitles at synced links')
        );
      if (subtitleSyncEnabled()) capPerLanguage(answer);
      res.status(200).json(answer);
    } catch (error) {
      let errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      let errors = [
        {
          description: errorMessage,
        },
      ];
      if (transformer.showError('subtitles', errors)) {
        logger.error(
          `Unexpected error during subtitle retrieval: ${errorMessage}`
        );
        res.status(200).json(
          StremioTransformer.createDynamicError('subtitles', {
            errorDescription: errorMessage,
          })
        );
        return;
      }
      next(error);
    }
  }
);

export default router;
