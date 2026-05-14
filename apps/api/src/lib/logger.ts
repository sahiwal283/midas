import pino from 'pino';
import { env } from '../config/env';

export const logger = pino(
  env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } }, level: 'debug' }
    : { level: 'info' },
);
