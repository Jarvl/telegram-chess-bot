import { GameDtoSchema, PlayersPickerDtoSchema } from '@group-chess/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getEngineUser } from '../../src/domain/engineGames';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGroup, insertUser } from '../helpers/fixtures';
import { touchMember } from '../../src/domain/members';

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.membership.clearCaches();
  api.ctx.rateLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

async function world() {
  const group = await insertGroup(db, { telegramChatId: -1002000000003 });
  const member = await insertUser(db, { telegramUserId: 511, firstName: 'Mallory' });
  const outsider = await insertUser(db, { telegramUserId: 522, firstName: 'Oscar' });
  await touchMember(db, group.id, member.id, { verified: true });
  const tokens = {
    member: await api.sessionFor(member),
    outsider: await api.sessionFor(outsider),
  };
  return { group, member, outsider, tokens };
}

const getJson = async (path: string, token: string) => {
  const response = await api.request('GET', path, { token });
  return response.json();
};

const post = (path: string, token: string, body: unknown) =>
  api.request('POST', path, { token, body });

describe('the bot in the picker and the engine-games endpoint', () => {
  it('offers the bot and its levels in the picker, and never as a player', async () => {
    const { group, tokens } = await world();
    const body = await getJson(`/api/groups/${group.publicId}/players`, tokens.member);
    const parsed = PlayersPickerDtoSchema.parse(body);
    expect(parsed.bot).toEqual({ levels: ['beginner', 'casual', 'club', 'strong'] });
    const engine = await getEngineUser(db);
    expect(parsed.players.map((player) => player.id)).not.toContain(String(engine.id));
  });

  it('creates a game and returns it', async () => {
    const { group, tokens } = await world();
    const response = await post(`/api/groups/${group.publicId}/engine-games`, tokens.member, {
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    expect(response.status).toBe(200);
    const body = GameDtoSchema.parse(await response.json());
    expect(body.rated).toBe(false);
  });

  it('refuses an unknown level with a 4xx, not a 500', async () => {
    const { group, tokens } = await world();
    const response = await post(`/api/groups/${group.publicId}/engine-games`, tokens.member, {
      level: 'grandmaster',
      colour: 'white',
      timePerMove: 86_400,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('refuses a caller who is not a member of the group', async () => {
    const { group, tokens } = await world();
    const response = await post(`/api/groups/${group.publicId}/engine-games`, tokens.outsider, {
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    expect(response.status).toBe(403);
  });

  it('hides the bot when the engine is switched off', async () => {
    const disabled = await startTestApi(db, undefined, { ENGINE_ENABLED: false });
    try {
      const group = await insertGroup(db, { telegramChatId: -1002000000004 });
      const member = await insertUser(db, { telegramUserId: 533, firstName: 'Niles' });
      await touchMember(db, group.id, member.id, { verified: true });
      const token = await disabled.sessionFor(member);
      const response = await disabled.request('GET', `/api/groups/${group.publicId}/players`, {
        token,
      });
      const body = PlayersPickerDtoSchema.parse(await response.json());
      expect(body.bot).toBeNull();
    } finally {
      await disabled.stop();
    }
  });
});
