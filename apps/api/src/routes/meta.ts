import { Router } from 'express';
import { MIDAS_VERSION } from '@midas/shared';
import { env } from '../config/env';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    appName: 'Midas',
    version: MIDAS_VERSION,
    environment: env.NODE_ENV,
    buildDate: process.env.BUILD_DATE ?? null,
    gitCommit: process.env.GIT_COMMIT ?? null,
  });
});

export default router;
