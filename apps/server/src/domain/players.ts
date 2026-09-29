import {
  GLICKO2,
  MAX_WORN_FLAIR,
  flairById,
  isProvisional,
  type PlayerRef,
} from '@group-chess/shared';
import type { RatingRow, UserRow } from '../db/schema';
import { avatarUrl } from './photos';
import { displayName } from './users';

/** The player shape the API sends everywhere; ratings default to 1500 provisional (spec §7.9). */
export function toPlayerRef(
  user: Pick<
    UserRow,
    'id' | 'firstName' | 'username' | 'deletedAt' | 'isEngine' | 'photoHash' | 'flairWorn'
  >,
  rating: Pick<RatingRow, 'rating' | 'rd'> | null,
): PlayerRef {
  return {
    id: String(user.id),
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    rating: Math.round(rating?.rating ?? GLICKO2.initialRating),
    provisional: isProvisional(rating?.rd ?? GLICKO2.initialRd),
    isBot: user.isEngine,
    photoUrl:
      user.photoHash && !user.isEngine && !user.deletedAt ? avatarUrl(user.photoHash) : null,
    // Deleted players and the bot carry none; a stored id the catalog no longer has is not sent.
    // Nor is a fourth: the app refuses a player with more, so one bad row would break its screens.
    flair:
      user.deletedAt || user.isEngine
        ? []
        : user.flairWorn.filter((id) => flairById(id) !== undefined).slice(0, MAX_WORN_FLAIR),
  };
}
