import type {
  ChallengeStatus,
  ColourChoice,
  EndReason,
  EngineLevel,
  GameResult,
  GameStatus,
  GroupSettings,
  Prefs,
} from '@group-chess/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const tz = () => timestamp({ withTimezone: true });

export const users = pgTable(
  'users',
  {
    id: id(),
    telegramUserId: bigint({ mode: 'number' }).unique(),
    firstName: text().notNull(),
    username: text(),
    languageCode: text(),
    dmAllowed: boolean().notNull().default(false),
    writeAccessAskedAt: tz(),
    prefs: jsonb().$type<Partial<Prefs>>().notNull().default({}),
    isEngine: boolean().notNull().default(false),
    createdAt: tz().notNull().defaultNow(),
    lastSeenAt: tz().notNull().defaultNow(),
    deletedAt: tz(),
  },
  (t) => [
    uniqueIndex('users_single_engine')
      .on(t.isEngine)
      .where(sql`${t.isEngine}`),
  ],
);

export const groups = pgTable('groups', {
  id: id(),
  publicId: text().notNull().unique(),
  telegramChatId: bigint({ mode: 'number' }).notNull().unique(),
  title: text().notNull(),
  type: text().$type<'group' | 'supergroup'>().notNull(),
  isForum: boolean().notNull().default(false),
  botStatus: text().$type<'member' | 'administrator' | 'left'>().notNull().default('member'),
  botIsAdmin: boolean().notNull().default(false),
  botCanPin: boolean().notNull().default(false),
  welcomeMessageId: bigint({ mode: 'number' }),
  settings: jsonb().$type<Partial<GroupSettings>>().notNull().default({}),
  createdAt: tz().notNull().defaultNow(),
  updatedAt: tz().notNull().defaultNow(),
});

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    userId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    status: text().$type<'member' | 'left'>().notNull().default('member'),
    firstSeenAt: tz().notNull().defaultNow(),
    lastSeenAt: tz().notNull().defaultNow(),
    verifiedAt: tz(),
    blockedAt: tz(),
    blockedBy: bigint({ mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('group_members_seen').on(t.groupId, t.lastSeenAt),
  ],
);

export const challenges = pgTable(
  'challenges',
  {
    id: id(),
    publicId: text().notNull().unique(),
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    challengerId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    opponentId: bigint({ mode: 'number' }).references(() => users.id),
    timePerMove: integer(),
    challengerColour: text().$type<ColourChoice>().notNull(),
    rated: boolean().notNull(),
    status: text().$type<ChallengeStatus>().notNull().default('pending'),
    messageId: bigint({ mode: 'number' }),
    threadId: bigint({ mode: 'number' }),
    gameId: bigint({ mode: 'number' }),
    createdAt: tz().notNull().defaultNow(),
    expiresAt: tz().notNull(),
    resolvedAt: tz(),
  },
  (t) => [
    index('challenges_status_expires').on(t.status, t.expiresAt),
    index('challenges_group_status').on(t.groupId, t.status),
  ],
);

export const games = pgTable(
  'games',
  {
    id: id(),
    publicId: text().notNull().unique(),
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    whiteId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    blackId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    timePerMove: integer(),
    rated: boolean().notNull(),
    engineLevel: text().$type<EngineLevel>(),
    status: text().$type<GameStatus>().notNull().default('active'),
    result: text().$type<GameResult>(),
    endReason: text().$type<EndReason>(),
    fen: text().notNull(),
    plyCount: integer().notNull().default(0),
    version: integer().notNull().default(0),
    deadlineAt: tz(),
    reminderAt: tz(),
    drawOfferBy: text().$type<'white' | 'black'>(),
    drawOfferPly: integer(),
    lastDrawOfferPlyWhite: integer(),
    lastDrawOfferPlyBlack: integer(),
    cardMessageId: bigint({ mode: 'number' }),
    cardThreadId: bigint({ mode: 'number' }),
    cardMissing: boolean().notNull().default(false),
    lichessUrl: text(),
    lichessImportStatus: text().$type<'pending' | 'done' | 'failed'>(),
    whiteRatingBefore: doublePrecision(),
    whiteRatingAfter: doublePrecision(),
    whiteRdBefore: doublePrecision(),
    whiteRdAfter: doublePrecision(),
    blackRatingBefore: doublePrecision(),
    blackRatingAfter: doublePrecision(),
    blackRdBefore: doublePrecision(),
    blackRdAfter: doublePrecision(),
    voidedAt: tz(),
    voidedBy: bigint({ mode: 'number' }),
    startedAt: tz().notNull().defaultNow(),
    finishedAt: tz(),
    lastMoveAt: tz(),
  },
  (t) => [
    index('games_deadline_active')
      .on(t.deadlineAt)
      .where(sql`${t.status} = 'active'`),
    index('games_reminder_active')
      .on(t.reminderAt)
      .where(sql`${t.status} = 'active' and ${t.reminderAt} is not null`),
    index('games_group_status_last_move').on(t.groupId, t.status, t.lastMoveAt),
    index('games_white').on(t.whiteId),
    index('games_black').on(t.blackId),
  ],
);

export const moves = pgTable(
  'moves',
  {
    gameId: bigint({ mode: 'number' })
      .notNull()
      .references(() => games.id),
    ply: integer().notNull(),
    uci: text().notNull(),
    san: text().notNull(),
    fenAfter: text().notNull(),
    playedAt: tz().notNull().defaultNow(),
    clientMoveId: text(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.ply] }),
    unique('moves_client_move_unique').on(t.gameId, t.clientMoveId),
  ],
);

export const ratings = pgTable(
  'ratings',
  {
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    userId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    rating: doublePrecision().notNull(),
    rd: doublePrecision().notNull(),
    volatility: doublePrecision().notNull(),
    gamesPlayed: integer().notNull().default(0),
    wins: integer().notNull().default(0),
    draws: integer().notNull().default(0),
    losses: integer().notNull().default(0),
    lastRatedGameAt: tz(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const shares = pgTable(
  'shares',
  {
    id: id(),
    gameId: bigint({ mode: 'number' })
      .notNull()
      .references(() => games.id),
    userId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    ply: integer().notNull(),
    messageId: bigint({ mode: 'number' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [index('shares_user_created').on(t.userId, t.createdAt)],
);

export const boardImages = pgTable('board_images', {
  key: text().primaryKey(),
  telegramFileId: text().notNull(),
  createdAt: tz().notNull().defaultNow(),
});

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text().notNull(),
    dedupKey: text(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    runAt: tz().notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(8),
    lockedUntil: tz(),
    lockedBy: text(),
    lastError: text(),
    createdAt: tz().notNull().defaultNow(),
    doneAt: tz(),
    failedAt: tz(),
  },
  (t) => [
    uniqueIndex('jobs_dedup_pending')
      .on(t.dedupKey)
      .where(sql`${t.doneAt} is null`),
    index('jobs_run_at_pending')
      .on(t.runAt)
      .where(sql`${t.doneAt} is null`),
  ],
);

export const telegramUpdates = pgTable('telegram_updates', {
  updateId: bigint({ mode: 'number' }).primaryKey(),
  receivedAt: tz().notNull().defaultNow(),
  /** Set when the handler finished; a stale row without it is an attempt that died and runs again. */
  processedAt: tz(),
});

export const adminActions = pgTable('admin_actions', {
  id: id(),
  groupId: bigint({ mode: 'number' })
    .notNull()
    .references(() => groups.id),
  adminUserId: bigint({ mode: 'number' })
    .notNull()
    .references(() => users.id),
  action: text().$type<'void' | 'block' | 'unblock' | 'settings'>().notNull(),
  targetGameId: bigint({ mode: 'number' }),
  targetUserId: bigint({ mode: 'number' }),
  details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: tz().notNull().defaultNow(),
});

/**
 * Tip jar spec §1: one row per successful Stars payment. Kept when the payer deletes their data —
 * the charge id and Telegram user id are what `refundStarPayment` needs.
 */
export const tips = pgTable('tips', {
  id: id(),
  userId: bigint({ mode: 'number' }).references(() => users.id),
  telegramUserId: bigint({ mode: 'number' }).notNull(),
  stars: integer().notNull(),
  telegramPaymentChargeId: text().notNull().unique(),
  paidAt: tz().notNull().defaultNow(),
  refundedAt: tz(),
});

export type UserRow = typeof users.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type GroupMemberRow = typeof groupMembers.$inferSelect;
export type ChallengeRow = typeof challenges.$inferSelect;
export type GameRow = typeof games.$inferSelect;
export type MoveRow = typeof moves.$inferSelect;
export type RatingRow = typeof ratings.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type TipRow = typeof tips.$inferSelect;
