import type { Deps } from '../../domain/deps';
import type { JobHandlers } from '../types';
import { ensurePruneScheduled, pruneHandler } from './prune';
import { rebuildRatingsHandler } from './rebuildRatings';

export { ensurePruneScheduled };
export { lichessJobHandlers, LichessPacer, type LichessHandlerContext } from './lichess';
export { sharePhotoJobHandlers } from './sharePhoto';
export { telegramJobHandlers, type TelegramHandlerContext } from './telegram';

/** Handlers that need no Telegram or Lichess client; `main.ts` merges the others in. */
export function coreJobHandlers(deps: Deps): JobHandlers {
  return {
    rebuild_ratings: rebuildRatingsHandler(deps),
    prune: pruneHandler(deps),
  };
}
