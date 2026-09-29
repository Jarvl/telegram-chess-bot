import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPhotoRow, photoHash, storePhoto } from '../../src/domain/photos';
import { requireUser } from '../../src/domain/users';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/fixtures';
import { FIXTURE_JPEG } from '../helpers/photos';

const { db, close } = openTestDb();
let api: TestApi;
const HASH = photoHash(FIXTURE_JPEG);

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.rateLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

describe('GET /api/avatars/:file', () => {
  it('serves a stored photo without a session', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    const response = await api.request('GET', `/api/avatars/${HASH}.jpg`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), FIXTURE_JPEG)).toBe(0);
  });

  it('404s an unknown hash', async () => {
    expect((await api.request('GET', `/api/avatars/${'0'.repeat(64)}.jpg`)).status).toBe(404);
  });

  it('404s a malformed name', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    for (const name of ['ABC.jpg', `${HASH}.png`, HASH, `${HASH.toUpperCase()}.jpg`])
      expect((await api.request('GET', `/api/avatars/${name}`)).status, name).toBe(404);
  });

  it('stops serving a photo once its owner deletes their data', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    const token = await api.sessionFor(user);
    expect((await api.request('DELETE', '/api/me', { token })).status).toBe(200);
    expect(await getPhotoRow(db, user.id)).toBeNull();
    expect((await requireUser(db, user.id)).photoHash).toBeNull();
    expect((await api.request('GET', `/api/avatars/${HASH}.jpg`)).status).toBe(404);
  });
});
