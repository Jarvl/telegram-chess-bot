import { PREFS_DEFAULTS, PrefsSchema, type Prefs } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { users, type UserRow } from '../db/schema';
import { DomainError } from './errors';

export type TelegramUserInfo = {
  telegramUserId: number;
  firstName: string;
  username?: string | null;
  languageCode?: string | null;
};

/** Upsert keyed by Telegram id; refreshes the display fields and `last_seen_at` (spec §8). */
export async function ensureUser(tx: DbOrTx, info: TelegramUserInfo): Promise<UserRow> {
  const fields = {
    firstName: info.firstName,
    username: info.username ?? null,
    languageCode: info.languageCode ?? null,
  };
  const [row] = await tx
    .insert(users)
    .values({ telegramUserId: info.telegramUserId, ...fields })
    .onConflictDoUpdate({
      target: users.telegramUserId,
      set: { ...fields, lastSeenAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error('ensureUser returned no row');
  return row;
}

export async function getUserById(tx: DbOrTx, id: number): Promise<UserRow | null> {
  const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function requireUser(tx: DbOrTx, id: number): Promise<UserRow> {
  const row = await getUserById(tx, id);
  if (!row) throw new DomainError('not_found', 'user not found', { userId: id });
  return row;
}

/** Stored preferences over the defaults; keys no longer in the schema (e.g. `confirmMoves`) are dropped. */
export function prefsOf(user: Pick<UserRow, 'prefs'>): Prefs {
  return PrefsSchema.parse({ ...PREFS_DEFAULTS, ...user.prefs });
}

/** PRD §7.7: DMs go only to users who allowed them in Telegram and keep notifications on. */
export function wantsDms(user: Pick<UserRow, 'prefs' | 'dmAllowed' | 'deletedAt'>): boolean {
  return user.dmAllowed && user.deletedAt === null && prefsOf(user).notifications;
}

/** Merges a validated patch over the stored preferences; unknown keys are dropped, bad values refused. */
export async function updatePrefs(
  tx: DbOrTx,
  userId: number,
  patch: Partial<Prefs>,
): Promise<Prefs> {
  const parsed = PrefsSchema.partial().safeParse(patch);
  if (!parsed.success) {
    throw new DomainError('validation', 'invalid preferences', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  const [row] = await tx
    .update(users)
    .set({ prefs: sql`${users.prefs} || ${JSON.stringify(parsed.data)}::jsonb` })
    .where(eq(users.id, userId))
    .returning();
  if (!row) throw new DomainError('not_found', 'user not found', { userId });
  return prefsOf(row);
}

export async function recordWriteAccess(
  tx: DbOrTx,
  userId: number,
  allowed: boolean,
): Promise<void> {
  await tx
    .update(users)
    .set({ dmAllowed: allowed, writeAccessAskedAt: sql`now()` })
    .where(eq(users.id, userId));
}

export async function setDmAllowed(tx: DbOrTx, userId: number, allowed: boolean): Promise<void> {
  await tx.update(users).set({ dmAllowed: allowed }).where(eq(users.id, userId));
}

/** People are named by their Telegram handle; `first_name` only when they have no username. */
export function displayName(user: Pick<UserRow, 'firstName' | 'username' | 'deletedAt'>): string {
  if (user.deletedAt) return 'Deleted player';
  return user.username ? `@${user.username}` : user.firstName;
}
