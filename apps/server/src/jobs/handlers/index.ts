import type { Deps } from '../../domain/deps';
import type { JobHandlers } from '../types';
import { ensurePruneScheduled, pruneHandler } from './prune';
import { rebuildRatingsHandler } from './rebuildRatings';

export { ensurePruneScheduled };
export { telegramJobHandlers, type TelegramHandlerContext } from './telegram';

/** Handlers that need no Telegram or Lichess client; plan 3 adds the rest to this object. */
export function coreJobHandlers(deps: Deps): JobHandlers {
  return {
    rebuild_ratings: rebuildRatingsHandler(deps),
    prune: pruneHandler(deps),
  };
}
