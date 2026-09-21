import pino from 'pino';
import type { Config } from './config';

export type Logger = pino.Logger;

/** Drizzle embeds bound parameters in query errors; they may be names, so they never reach a log. */
const BOUND_PARAMS = /\nparams: [^\n]*/g;

function sanitiseError(error: unknown): Record<string, unknown> {
  const serialised = pino.stdSerializers.err(error as Error) as Record<string, unknown>;
  for (const key of ['message', 'stack'] as const) {
    if (typeof serialised[key] === 'string')
      serialised[key] = (serialised[key] as string).replace(BOUND_PARAMS, '');
  }
  const cause = serialised.cause;
  if (cause && typeof cause === 'object') serialised.cause = sanitiseError(cause);
  return serialised;
}

/** JSON logs with numeric and public ids only (spec §12, §14). */
export function createLogger(
  level: Config['LOG_LEVEL'] = 'info',
  destination?: pino.DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: undefined,
    serializers: { err: sanitiseError },
  };
  return destination ? pino(options, destination) : pino(options);
}
