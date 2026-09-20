import pino from 'pino';
import type { Config } from './config';

export type Logger = pino.Logger;

/** JSON logs with numeric and public ids only (spec §12, §14). */
export function createLogger(level: Config['LOG_LEVEL'] = 'info'): Logger {
  return pino({ level, base: undefined });
}
