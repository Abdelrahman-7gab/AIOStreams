import { Router, Request, Response, NextFunction } from 'express';
import {
  AIOStreams,
  SubtitleResponse,
  config as appConfig,
  createLogger,
  createSyncLink,
  findOffered,
  referenceFor,
  StremioTransformer,
  subtitleSyncEnabled,
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
  let warmed = false;
  for (const subtitle of answer.subtitles) {
    if (!subtitle.url || subtitle.id.startsWith('error.')) continue;
    if (!/^https?:\/\//.test(subtitle.url)) continue;
    const { token, link } = await createSyncLink(subtitle.url, file);
    if (!warmed) {
      warmed = true;
      void referenceFor(link);
    }
    subtitle.url = `${base}${mount}/subsync/${token}.${extensionOf(subtitle.url)}`;
  }
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
