import { Router, Request, Response } from 'express';
import { createLogger, getSyncLink, syncedSubtitle } from '@aiostreams/core';

const logger = createLogger('server');
const router: Router = Router();

interface SubsyncParams {
  token: string;
  ext: string;
}

/**
 * A subtitle retimed to the file its link was made for. Anything that keeps
 * it from being retimed sends the subtitle as it was, so a synced link is
 * never worse than the original.
 */
router.get(
  '/:token.:ext',
  async (req: Request<SubsyncParams>, res: Response) => {
    const { token } = req.params;
    const link = await getSyncLink(token);
    if (!link) {
      res.status(404).send('This subtitle link has expired.');
      return;
    }
    try {
      const answer = await syncedSubtitle(token, link);
      res.setHeader('Content-Type', answer.contentType);
      res.setHeader('X-Subtitle-Synced', answer.synced ? 'yes' : 'no');
      res.setHeader(
        'Cache-Control',
        answer.synced ? 'public, max-age=3600' : 'no-store'
      );
      res.status(200).send(answer.body);
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'could not serve a synced subtitle, sending the original'
      );
      res.redirect(302, link.subtitleUrl);
    }
  }
);

export default router;
