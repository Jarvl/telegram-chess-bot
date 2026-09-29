import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { userPhotos } from '../../src/db/schema';
import {
  avatarUrl,
  deletePhoto,
  getPhotoBytes,
  getPhotoRow,
  photoHash,
  storePhoto,
  touchPhoto,
} from '../../src/domain/photos';
import { requireUser } from '../../src/domain/users';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/fixtures';
import { FIXTURE_JPEG } from '../helpers/photos';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('photo storage', () => {
  it('stores a photo and mirrors its hash onto the user', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    const row = await getPhotoRow(db, user.id);
    expect(row?.fileUniqueId).toBe('u-1');
    expect(row?.hash).toBe(photoHash(FIXTURE_JPEG));
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.compare(row!.bytes!, FIXTURE_JPEG)).toBe(0);
    expect((await requireUser(db, user.id)).photoHash).toBe(row?.hash);
  });

  it('records "no photo" as an all-null row and a null hash', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    await storePhoto(db, user.id, null);
    const row = await getPhotoRow(db, user.id);
    expect(row).toMatchObject({ fileUniqueId: null, hash: null, bytes: null });
    expect(row?.checkedAt).toBeInstanceOf(Date);
    expect((await requireUser(db, user.id)).photoHash).toBeNull();
  });

  it('stores the same bytes for two users', async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    await storePhoto(db, alice.id, { fileUniqueId: 'a', bytes: FIXTURE_JPEG });
    await storePhoto(db, bob.id, { fileUniqueId: 'b', bytes: FIXTURE_JPEG });
    expect((await requireUser(db, bob.id)).photoHash).toBe(photoHash(FIXTURE_JPEG));
    const bytes = await getPhotoBytes(db, photoHash(FIXTURE_JPEG));
    expect(Buffer.compare(bytes!, FIXTURE_JPEG)).toBe(0);
  });

  it('touches checked_at without changing the photo', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    await db
      .update(userPhotos)
      .set({ checkedAt: sql`now() - interval '2 days'` })
      .where(eq(userPhotos.userId, user.id));
    const before = (await getPhotoRow(db, user.id))!.checkedAt;
    await touchPhoto(db, user.id);
    const after = await getPhotoRow(db, user.id);
    expect(after!.checkedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(after?.hash).toBe(photoHash(FIXTURE_JPEG));
  });

  it('deletes the photo and clears the hash', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    await deletePhoto(db, user.id);
    expect(await getPhotoRow(db, user.id)).toBeNull();
    expect((await requireUser(db, user.id)).photoHash).toBeNull();
    expect(await getPhotoBytes(db, photoHash(FIXTURE_JPEG))).toBeNull();
  });

  it('builds the avatar url from a hash', () => {
    expect(avatarUrl('a'.repeat(64))).toBe(`/api/avatars/${'a'.repeat(64)}.jpg`);
  });
});
