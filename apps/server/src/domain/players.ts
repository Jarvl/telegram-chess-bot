import { GLICKO2, flairById, isProvisional, type PlayerRef } from '@group-chess/shared';
import type { RatingRow, UserRow } from '../db/schema';
import { displayName } from './users';

/** The player shape the API sends everywhere; ratings default to 1500 provisional (spec §7.9). */
export function toPlayerRef(
  user: Pick<UserRow, 'id' | 'firstName' | 'username' | 'deletedAt' | 'isEngine' | 'flairWorn'>,
  rating: Pick<RatingRow, 'rating' | 'rd'> | null,
): PlayerRef {
  return {
    id: String(user.id),
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    rating: Math.round(rating?.rating ?? GLICKO2.initialRating),
    provisional: isProvisional(rating?.rd ?? GLICKO2.initialRd),
    isBot: user.isEngine,
    // Deleted players and the bot carry none; a stored id the catalog no longer has is not sent.
    flair:
      user.deletedAt || user.isEngine
        ? []
        : user.flairWorn.filter((id) => flairById(id) !== undefined),
  };
}
