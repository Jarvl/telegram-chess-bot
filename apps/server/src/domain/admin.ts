import type { GroupSettingsDto } from '@group-chess/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { groupMembers, ratings, users, type GroupRow } from '../db/schema';
import { settingsOf } from './groups';
import { toPlayerRef } from './players';

export async function groupSettingsDto(tx: DbOrTx, group: GroupRow): Promise<GroupSettingsDto> {
  const blocked = await tx
    .select({ user: users, rating: ratings })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(ratings, and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, users.id)))
    .where(and(eq(groupMembers.groupId, group.id), isNotNull(groupMembers.blockedAt)))
    .orderBy(users.firstName);
  return {
    group: { id: group.publicId, title: group.title },
    settings: settingsOf(group),
    blocked: blocked.map((row) => toPlayerRef(row.user, row.rating)),
    botIsAdmin: group.botIsAdmin,
    isForum: group.isForum,
  };
}
