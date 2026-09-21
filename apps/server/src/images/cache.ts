import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { boardImages } from '../db/schema';
import { BOARD_THEME, type BoardRenderInput } from './board';

/** `sha256(placement | side | lastMove | check | orientation | theme)` (spec §7.7). */
export function boardImageKey(input: BoardRenderInput, theme: string = BOARD_THEME): string {
  const [placement = '', side = 'w'] = input.fen.split(' ');
  const material = [
    placement,
    side,
    input.lastMove ?? '',
    input.check ? '1' : '0',
    input.orientation,
    theme,
  ];
  return createHash('sha256').update(material.join('|')).digest('hex');
}

export async function getCachedFileId(tx: DbOrTx, key: string): Promise<string | null> {
  const [row] = await tx
    .select({ fileId: boardImages.telegramFileId })
    .from(boardImages)
    .where(eq(boardImages.key, key));
  return row?.fileId ?? null;
}

export async function storeFileId(tx: DbOrTx, key: string, fileId: string): Promise<void> {
  await tx.insert(boardImages).values({ key, telegramFileId: fileId }).onConflictDoNothing();
}
