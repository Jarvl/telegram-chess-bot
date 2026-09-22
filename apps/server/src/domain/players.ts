import { GLICKO2, isProvisional, type PlayerRef } from '@group-chess/shared';
import type { RatingRow, UserRow } from '../db/schema';
import { displayName } from './users';

/** The player shape the API sends everywhere; ratings default to 1500 provisional (spec §7.9). */
export function toPlayerRef(
  user: Pick<UserRow, 'id' | 'firstName' | 'username' | 'deletedAt'>,
  rating: Pick<RatingRow, 'rating' | 'rd'> | null,
): PlayerRef {
  return {
    id: String(user.id),
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    rating: Math.round(rating?.rating ?? GLICKO2.initialRating),
    provisional: isProvisional(rating?.rd ?? GLICKO2.initialRd),
  };
}
