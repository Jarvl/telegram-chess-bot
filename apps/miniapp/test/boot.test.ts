import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { boot } from '../src/boot';
import { Router } from '../src/router';
import { prefs, session } from '../src/state/session';
import { createTg } from '../src/tg/webapp';
import type { Prefetched } from '../src/ui/context';
import { fakeFetch } from './support/fakeFetch';
import { installFakeWebApp } from './support/fakeWebApp';
import { gameDto } from './support/gameFixtures';

const launchBody = (route: unknown, askWriteAccess = false) => ({
  token: 'jwt',
  user: { id: '1', name: 'Alice', username: 'alice' },
  prefs: {
    confirmMoves: true,
    closeAfterMove: true,
    notifications: true,
    boardTheme: null,
    pieceSet: null,
  },
  askWriteAccess,
  route,
  serverTime: new Date().toISOString(),
  bot: { username: 'TestChessBot', miniAppShortName: 'chess' },
});

function setup(
  version: string,
  startParam: string | undefined,
  handler: Parameters<typeof fakeFetch>[0],
) {
  installFakeWebApp({ version, initData: 'user=x&hash=y', startParam, writeAccess: true });
  const tg = createTg(window.Telegram!.WebApp);
  const { fetch, calls } = fakeFetch(handler);
  const client = createApiClient({ fetch });
  const router = new Router(tg, { closeWhenEmpty: false });
  const prefetched: Prefetched = {};
  return { tg, client, router, prefetched, calls, record: window.__tg! };
}

describe('boot', () => {
  it('launches once, lands on the resolved route with its data and asks for write access afterwards', async () => {
    const game = gameDto();
    const { tg, client, router, prefetched, calls, record } = setup(
      '8.0',
      'g_AbCdEfGhIj',
      ({ path }) =>
        path === '/api/launch'
          ? { status: 200, body: launchBody({ kind: 'game', game }, true) }
          : { status: 200, body: { prefs: prefs.value, dmAllowed: true } },
    );
    await boot({ tg, client, router, prefetched });
    expect(router.current.value).toEqual({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(prefetched.game?.id).toBe('AbCdEfGhIj');
    expect(session.value?.launchedFrom).toEqual({ kind: 'game', gameId: 'AbCdEfGhIj' });
    expect(
      record.calls.filter((c) => c === 'ready' || c === 'expand' || c === 'disableVerticalSwipes'),
    ).toEqual(['ready', 'expand', 'disableVerticalSwipes']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(record.calls).toContain('requestWriteAccess');
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/api/launch'],
      ['PUT', '/api/me/prefs'],
    ]);
    expect(calls[1]?.body).toEqual({ writeAccess: { allowed: true } });
  });

  it('skips the write-access prompt on old clients and lands on the lobby or groups', async () => {
    const lobby = {
      group: { id: 'GrOuPiDxYz', title: 'Club' },
      isAdmin: false,
      settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
      active: [],
      finished: { items: [], nextCursor: null },
      challenges: [],
      players: [],
    };
    const { tg, client, router, prefetched, calls, record } = setup('6.0', 'l_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'lobby', lobby }, true),
    }));
    await boot({ tg, client, router, prefetched });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(record.calls).not.toContain('requestWriteAccess');
    expect(record.calls).not.toContain('disableVerticalSwipes');
    expect(calls).toHaveLength(1);
  });

  it('shows the reopen screen when the launch is rejected and the error screen when it fails', async () => {
    const expired = setup('8.0', undefined, () => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'stale' } },
    }));
    await boot(expired);
    expect(expired.router.current.value).toEqual({ name: 'reopen' });

    const broken = setup('8.0', undefined, ({ path }) =>
      path === '/api/launch' ? { status: 503 } : { status: 200, body: { ok: true } },
    );
    await boot(broken);
    expect(broken.router.current.value).toEqual({ name: 'error' });
  });

  it('routes a locked launch to the locked screen', async () => {
    const locked = setup('8.0', 'l_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } }),
    }));
    await boot(locked);
    expect(locked.router.current.value).toEqual({
      name: 'locked',
      group: { id: 'GrOuPiDxYz', title: 'Club' },
    });
  });
});
