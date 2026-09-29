/**
 * The flair catalog (flair spec §1): the emoji a player can earn and the rule that earns each one.
 * It is data only, so it adds almost nothing to the Mini App bundle.
 *
 * - A new flair built from existing rules is one entry in `FLAIR` plus one `flair.<id>` string in
 *   `i18n/en.ts`. An entry's position is its display position within its category.
 * - A new kind of condition is a move-pattern detector or a rule evaluator, with unit tests.
 * - Ids are permanent and never reused: awards and introduction dates are keyed by id.
 * - Editing a rule only affects future awards; flair already earned is kept.
 */
import type { MessageKey } from '../i18n';

/** Rank ladder (ratings held), feats (done in a game you won), dubious honours (done to you). */
export type FlairCategory = 'rank' | 'feat' | 'dubious';

/** Things a side can do in a game, found by the server in the game's stored moves (spec §1.8). */
export type MovePattern = 'en_passant' | 'castle_queenside' | 'promotion' | 'scholars_mate';

/** A game's result from one player's side. */
export type PlayerResult = 'win' | 'draw' | 'loss';

/**
 * What earns a flair (spec §1.4), evaluated for one player at one of their counted games:
 * - `held`: their rating after a rated game, rounded as displayed, is in `[min, max]`; a null bound
 *   is open.
 * - `won`: they won and made `pattern`. `lost`: they lost and their opponent made `pattern`.
 * - `streak`: the last `length` games that pass the filter all have `result`.
 * - `total`: at least `count` games that pass the filter have `result`.
 *
 * With `rated`, the filter skips casual games. A rule's answer at a game may depend only on that
 * game and the player's earlier counted games (§1.6), which is what lets each game be evaluated
 * once, as it ends.
 */
export type FlairRule =
  | { kind: 'held'; min: number | null; max: number | null }
  | { kind: 'won'; pattern: MovePattern }
  | { kind: 'lost'; pattern: MovePattern }
  | { kind: 'streak'; result: PlayerResult; length: number; rated: boolean }
  | { kind: 'total'; result: PlayerResult; count: number; rated: boolean };

export type FlairDefinition = {
  /** Permanent and never reused: what the database stores. */
  id: string;
  emoji: string;
  category: FlairCategory;
  rule: FlairRule;
};

/** How many flair a player wears at once. */
export const MAX_WORN_FLAIR = 3;

/** The categories in display order. */
export const FLAIR_CATEGORIES = ['rank', 'feat', 'dubious'] as const;

/** A rating band, both ends inclusive; `null` leaves that end open. */
export function held(min: number | null, max: number | null): FlairRule {
  return { kind: 'held', min, max };
}

/** Win a game in which you made `pattern`. */
export function won(pattern: MovePattern): FlairRule {
  return { kind: 'won', pattern };
}

/** Lose a game in which your opponent made `pattern`. */
export function lost(pattern: MovePattern): FlairRule {
  return { kind: 'lost', pattern };
}

/** `length` games in a row with `result`. With `rated`, casual games are skipped. */
export function streak(
  result: PlayerResult,
  length: number,
  options?: { rated?: boolean },
): FlairRule {
  return { kind: 'streak', result, length, rated: options?.rated ?? false };
}

/** `count` games with `result`, in a row or not. With `rated`, casual games are skipped. */
export function total(
  result: PlayerResult,
  count: number,
  options?: { rated?: boolean },
): FlairRule {
  return { kind: 'total', result, count, rated: options?.rated ?? false };
}

/** Every flair, in display order (spec §1.2). */
export const FLAIR = [
  { id: 'rank_under_1200', emoji: '🦍', category: 'rank', rule: held(null, 1199) },
  { id: 'rank_1200', emoji: '🧑‍🦼', category: 'rank', rule: held(1200, 1299) },
  { id: 'rank_1300', emoji: '🧑‍🦽', category: 'rank', rule: held(1300, 1399) },
  { id: 'rank_1400', emoji: '🧑‍🦯', category: 'rank', rule: held(1400, 1499) },
  { id: 'rank_1500', emoji: '🚶', category: 'rank', rule: held(1500, 1599) },
  { id: 'rank_1600', emoji: '🏃', category: 'rank', rule: held(1600, 1699) },
  { id: 'rank_1700', emoji: '🗿', category: 'rank', rule: held(1700, 1799) },
  { id: 'rank_1800', emoji: '🤖', category: 'rank', rule: held(1800, null) },
  { id: 'en_passant_win', emoji: '👑', category: 'feat', rule: won('en_passant') },
  { id: 'win_streak_5', emoji: '🔥', category: 'feat', rule: streak('win', 5, { rated: true }) },
  { id: 'queenside_castle_win', emoji: '🏰', category: 'feat', rule: won('castle_queenside') },
  { id: 'promotion_win', emoji: '♟️', category: 'feat', rule: won('promotion') },
  { id: 'draws_10', emoji: '🤝', category: 'feat', rule: total('draw', 10) },
  { id: 'scholars_mate_loss', emoji: '🪤', category: 'dubious', rule: lost('scholars_mate') },
] as const satisfies readonly FlairDefinition[];

export type FlairEntry = (typeof FLAIR)[number];

export type FlairId = FlairEntry['id'];

/** `undefined` for an id no longer in the catalog: stored rows can outlive a removed flair. */
export function flairById(id: string): FlairEntry | undefined {
  return FLAIR.find((flair) => flair.id === id);
}

/**
 * The `flair.<id>` description. The return type is the compile-time check that every id has a
 * string in `i18n/en.ts`: an id without one fails the build.
 */
export function flairDescriptionKey(id: FlairId): MessageKey {
  return `flair.${id}`;
}

/** The `flair.category.<category>` title, checked against the strings in the same way. */
export function flairCategoryKey(category: FlairCategory): MessageKey {
  return `flair.category.${category}`;
}
