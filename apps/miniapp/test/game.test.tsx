import type { MoveConfirmations } from '@group-chess/shared';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs, session } from '../src/state/session';
import { createTg } from '../src/tg/webapp';
import { Game } from '../src/ui/screens/Game';
import { FakeEventSource } from './support/fakeEventSource';
import type { FakeResponse, FakeRoute } from './support/fakeFetch';
import { afterPlies, gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';
import { stubAdapter, type StubAdapter } from './support/stubAdapter';

let adapter: StubAdapter;
vi.mock('../src/board/adapter', async () => {
  const actual =
    await vi.importActual<typeof import('../src/board/adapter')>('../src/board/adapter');
  return { ...actual, createBoardAdapter: () => adapter };
});

const GAME = 'AbCdEfGhIj';
const okRoute =
  (initial: ReturnType<typeof gameDto>, onMove?: FakeRoute): FakeRoute =>
  (call) => {
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves` && onMove)
      return onMove(call);
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves`)
      return { status: 200, body: afterPlies(1) };
    if (call.method === 'GET' && call.path === `/api/games/${GAME}`)
      return { status: 200, body: initial };
    if (call.method === 'POST' && /\/(draw\/\w+|resign|abort)$/.test(call.path))
      return { status: 200, body: initial };
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/pgn-link`)
      return { status: 200, body: { url: `/api/games/${GAME}/pgn?token=scoped-link` } };
    return { status: 200, body: { ok: true } };
  };

const wantPrefs: { closeAfterMove: boolean; moveConfirmations: MoveConfirmations } = {
  closeAfterMove: false,
  // The flows below predate move confirmations; the describe block for them sets its own.
  moveConfirmations: 'never',
};

function mount(
  initial: ReturnType<typeof gameDto>,
  route: FakeRoute = okRoute(initial),
  version = '8.0',
) {
  const r = renderApp(
    (app) => {
      app.prefetched.game = initial;
      return <Game gameId={GAME} />;
    },
    route,
    { version },
  );
  // renderApp resets the preferences; the screen reads them when a move is dropped.
  prefs.value = { ...prefs.value, ...wantPrefs };
  return r;
}

beforeEach(() => {
  adapter = stubAdapter();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  wantPrefs.closeAfterMove = false;
  wantPrefs.moveConfirmations = 'never';
});
afterEach(async () => {
  // Preact flushes effects on animation frames; run the faked ones before real timers return,
  // otherwise its effect queue stays scheduled forever and later tests never run their effects.
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Game', () => {
  it('renders the players, clocks and moves from the launch data and opens the stream', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'black' }));
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/games/${GAME}/events?token=jwt`);
    expect(r.text()).toContain('Alice');
    expect(r.text()).toContain('Bob');
    expect(r.text()).toContain('1d 0:00');
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(2);
    expect(adapter.positions.at(-1)).toMatchObject({
      orientation: 'black',
      lastMove: ['e7', 'e5'],
    });
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'none' });
  });

  it('sends a move as soon as it is dropped and applies the response', async () => {
    const r = mount(gameDto());
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    adapter.drop('e2', 'e4');
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/api/games/${GAME}/moves`);
    expect(post?.body).toMatchObject({ uci: 'e2e4', expectedPly: 0 });
    expect((post?.body as { clientMoveId: string }).clientMoveId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
    expect(window.__tg!.haptics).toContain('impact:light');
    // Showing the Telegram main button resizes the viewport, and with it the board.
    expect(window.__tg!.calls).not.toContain('MainButton.show');
    expect(r.root.querySelector('.board-veil')).toBeNull();
  });

  it('greys the board under a spinner only once a send is slow', async () => {
    vi.useFakeTimers();
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(900);
    expect(r.root.querySelector('.board-veil')).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    const veil = r.root.querySelector('.board-wrap .board-veil');
    expect(veil?.getAttribute('aria-label')).toBe('Sending…');
    expect(veil?.querySelector('.spinner')).not.toBeNull();
    expect(window.__tg!.calls).not.toContain('MainButton.show');
    answer({ status: 200, body: afterPlies(1) });
    await vi.advanceTimersByTimeAsync(100);
    expect(r.root.querySelector('.board-veil')).toBeNull();
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
  });

  it('buzzes a warning when a state arriving over the stream puts the viewer in check', async () => {
    // Black rook a2, white king e1: no check with Black to move …
    const quiet = gameDto({ fen: '4k3/8/8/8/8/8/r7/4K3 b - - 0 1', plyCount: 9, version: 9 });
    const r = mount(quiet);
    await r.flush();
    // … then the rook slides to e2 and White is in check.
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ fen: '4k3/8/8/8/8/8/4r3/4K3 w - - 0 1', plyCount: 10, version: 10 }),
      '10',
    );
    await r.flush();
    expect(window.__tg!.haptics).toContain('notification:warning');
    expect(adapter.positions.at(-1)?.check).toBe(true);
  });

  it('snaps back silently on a stale rejection and reloads the state', async () => {
    const r = mount(
      gameDto(),
      okRoute(afterPlies(1, { viewerRole: 'white' }), () => ({
        status: 409,
        body: { error: { code: 'stale_state', message: 'the position has changed' } },
      })),
    );
    await r.flush();
    const before = adapter.positions.length;
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(adapter.positions.length).toBeGreaterThan(before);
    expect(r.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', `/api/games/${GAME}/moves`],
      ['GET', `/api/games/${GAME}`],
    ]);
    expect(r.text()).not.toContain('position has changed');
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('retries with the same client move id after a network failure', async () => {
    vi.useFakeTimers();
    let failures = 0;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => {
        failures += 1;
        if (failures === 1) throw new TypeError('Failed to fetch');
        return { status: 200, body: afterPlies(1) };
      }),
    );
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Retry', visible: true });
    const first = r.calls.find((c) => c.method === 'POST')?.body as { clientMoveId: string };
    await vi.advanceTimersByTimeAsync(1_000);
    const posts = r.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/moves'));
    expect(posts).toHaveLength(2);
    expect((posts[1]?.body as { clientMoveId: string }).clientMoveId).toBe(first.clientMoveId);
    expect(r.calls.some((c) => c.path === '/api/telemetry')).toBe(true);
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('closes after a move when launched from a game link and the setting is on', async () => {
    vi.useFakeTimers();
    wantPrefs.closeAfterMove = true;
    const r = mount(gameDto());
    session.value = { ...session.value!, launchedFrom: { kind: 'game', gameId: GAME } };
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(window.__tg!.closed).toBe(true);
    void r;
  });

  it('shows the promotion chooser and sends the chosen piece', async () => {
    const r = mount(gameDto({ fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', plyCount: 6, version: 6 }));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(r.root.querySelector('.promotion')).not.toBeNull();
    await r.click('[data-promote="n"]');
    expect(r.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      uci: 'e7e8n',
      expectedPly: 6,
    });
  });

  it('offers, accepts and declines draws and shows the opponent’s offer', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    await r.click('[data-action="offer-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/offer`);
    FakeEventSource.instances[0]!.send(
      'state',
      afterPlies(2, { viewerRole: 'white', version: 3, drawOffer: { by: 'black', atPly: 2 } }),
      '3',
    );
    await r.flush();
    expect(r.text()).toContain('Bob offers a draw');
    await r.click('[data-action="accept-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/accept`);
    await r.click('[data-action="decline-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/decline`);
  });

  it('shows the result, rematch, analysis and PGN for a finished game, with the PGN link fallback', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'black',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      lichessUrl: 'https://lichess.org/abcd1234',
      black: { ...gameDto().black, ratingAfter: 1662, provisionalAfter: true },
    });
    const r = mount(finished, okRoute(finished), '7.0');
    await r.flush();
    expect(r.root.querySelector('.result-title')?.textContent).toBe('You won');
    expect(r.root.querySelector('.result-detail')?.textContent).toBe(
      'Checkmate · 0-1 · 1500? → 1662?',
    );
    expect(r.root.querySelector('.toolbar button')?.getAttribute('data-action')).toBe('rematch');
    expect(FakeEventSource.instances).toHaveLength(0);
    await r.click('[data-action="analyse"]');
    expect(window.__tg!.links).toContain('https://lichess.org/abcd1234');
    await r.click('[data-action="pgn"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/pgn-link`);
    expect(window.__tg!.links.at(-1)).toContain(`/api/games/${GAME}/pgn?token=scoped-link`);
    expect(window.__tg!.links.at(-1)).not.toContain('jwt');
    expect(window.__tg!.downloads).toEqual([]);
    await r.click('[data-action="rematch"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/rematch`);
    await r.click('[data-ply="2"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['e7', 'e5']);
    await r.click('[data-action="latest"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['d8', 'h4']);
  });

  it('starts a fresh bot game on rematch when the finished game was against the engine', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'black',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      engineLevel: 'club',
    });
    const nextGame = gameDto({ id: 'NextGameA1', engineLevel: 'club' });
    const route: FakeRoute = (call) => {
      if (call.method === 'POST' && call.path === `/api/groups/${finished.group.id}/engine-games`)
        return { status: 200, body: nextGame };
      return okRoute(finished)(call);
    };
    const r = mount(finished, route, '7.0');
    await r.flush();
    await r.click('[data-action="rematch"]');
    const post = r.calls.at(-1);
    expect(post?.path).toBe(`/api/groups/${finished.group.id}/engine-games`);
    expect(post?.body).toEqual({ level: 'club', colour: 'random' });
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'NextGameA1' });
  });

  it('lets spectators flip and share the viewed position', async () => {
    const r = mount(afterPlies(3, { viewerRole: 'spectator' }));
    await r.flush();
    expect(adapter.viewOnly).toBe(true);
    await r.click('[data-action="flip"]');
    expect(adapter.positions.at(-1)?.orientation).toBe('black');
    await r.click('[data-ply="1"]');
    await r.click('[data-action="share"]');
    expect(r.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/games/${GAME}/share`,
      body: { ply: 1 },
    });
    expect(document.querySelector('.toast')?.textContent).toBe('Shared to the group');
  });

  it('marks your bar and clock gold on your move, and names the waiting side', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    const mine = r.root.querySelector('.player-bar[data-colour="white"]')!;
    const theirs = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(mine.className).toContain('yours');
    expect(mine.querySelector('.sub')?.textContent).toBe('Your move');
    expect(mine.querySelector('.clock')?.className).toContain('yours');
    expect(theirs.className).not.toContain('yours');
    expect(theirs.querySelector('.sub')?.textContent).toBe('Black · Chess Club');
    expect(theirs.querySelector('.avatar')?.textContent).toBe('B');
  });

  it('shows the bot as the goat with its level', async () => {
    const bot = { ...gameDto().black, name: 'Stockfish', isBot: true };
    const r = mount(
      gameDto({ black: bot, engineLevel: 'club', timePerMove: null, deadlineAt: null }),
    );
    await r.flush();
    const bar = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(bar.querySelector('img.avatar.bot')).not.toBeNull();
    expect(bar.querySelector('.rating')?.textContent).toBe('Club');
  });
});

describe('Game with move confirmations', () => {
  beforeEach(() => {
    wantPrefs.moveConfirmations = 'people';
  });
  const posts = (r: ReturnType<typeof mount>) =>
    r.calls.filter((c) => c.method === 'POST' && c.path === `/api/games/${GAME}/moves`);

  it('holds a move against a person for Confirm move, then sends it once', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
    expect(r.root.querySelector('[data-action="resign"]')?.hasAttribute('disabled')).toBe(true);
    // Review Focus 2: two taps before the screen re-renders still send one move.
    window.__tg!.clickMain();
    window.__tg!.clickMain();
    await r.flush();
    expect(posts(r)).toHaveLength(1);
    expect(posts(r)[0]?.body).toMatchObject({ uci: 'e2e4', expectedPly: 0 });
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('keeps the bar up with a spinner while a confirmed move sends', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({
      text: 'Sending…',
      visible: true,
      progress: true,
    });
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
    answer({ status: 200, body: afterPlies(1) });
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('puts the piece back on Cancel and sends nothing', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.clickSecondary();
    await r.flush();
    expect(adapter.restored).toBe(restored + 1);
    expect(adapter.positions.at(-1)?.fen).toBe(gameDto().fen);
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('holds the waiting move on the board through a snapshot, and locks the move strip', async () => {
    const r = mount(afterPlies(2));
    await r.flush();
    adapter.drop('b1', 'c3');
    await r.flush();
    const before = adapter.positions.length;
    // Review Focus 3: a draw offer bumps the version but is no new ply.
    FakeEventSource.instances[0]!.send(
      'state',
      afterPlies(2, { version: 3, drawOffer: { by: 'black', atPly: 2 } }),
      '3',
    );
    await r.flush();
    expect(adapter.positions).toHaveLength(before);
    expect(r.text()).toContain('Bob offers a draw');
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(r.root.querySelector<HTMLButtonElement>('.move-list [data-ply="1"]')?.disabled).toBe(
      true,
    );
  });

  it('holds a promotion for Confirm move once the piece is picked', async () => {
    const r = mount(gameDto({ fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', plyCount: 6, version: 6 }));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    await r.click('[data-promote="q"]');
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    window.__tg!.clickMain();
    await r.flush();
    expect(posts(r)[0]?.body).toMatchObject({ uci: 'e7e8q', expectedPly: 6 });
  });

  it('sends on drop against the bot under the default', async () => {
    const r = mount(gameDto({ engineLevel: 'casual' }));
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
    expect(window.__tg!.calls).not.toContain('MainButton.show');
  });

  it('holds a move against the bot when the setting is Always', async () => {
    wantPrefs.moveConfirmations = 'always';
    const r = mount(gameDto({ engineLevel: 'casual' }));
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
  });

  it('reads the setting at each drop, so a change mid-game applies to the next move', async () => {
    // Review Focus 5.
    const r = mount(gameDto());
    await r.flush();
    prefs.value = { ...prefs.value, moveConfirmations: 'never' };
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
  });

  it('puts Cancel in the action row below 7.10', async () => {
    const r = mount(gameDto(), okRoute(gameDto()), '7.0');
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(r.root.querySelector('[data-action="confirm-move"]')).toBeNull();
    await r.click('.toolbar [data-action="cancel-move"]');
    expect(posts(r)).toHaveLength(0);
    expect(r.root.querySelector('[data-action="cancel-move"]')).toBeNull();
  });

  it('puts both Confirm move and Cancel first in the action row without Telegram buttons', async () => {
    const initial = gameDto();
    const r = renderApp(
      (app) => {
        app.prefetched.game = initial;
        return <Game gameId={GAME} />;
      },
      okRoute(initial),
      { tg: createTg(null) },
    );
    prefs.value = { ...prefs.value, ...wantPrefs };
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const toolbar = r.root.querySelector('.toolbar')!;
    expect(toolbar.children[0]?.getAttribute('data-action')).toBe('confirm-move');
    expect(toolbar.children[1]?.getAttribute('data-action')).toBe('cancel-move');
    await r.click('[data-action="confirm-move"]');
    expect(
      r.calls.filter((c) => c.method === 'POST' && c.path === `/api/games/${GAME}/moves`),
    ).toHaveLength(1);
  });

  it('hides the tab bar while a move waits and brings it back once the move is sent', async () => {
    const r = mount(gameDto());
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(true);
    window.__tg!.clickMain();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('brings the tab bar back on Cancel', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickSecondary();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('keeps the tab bar hidden through a network retry of a confirmed move', async () => {
    vi.useFakeTimers();
    let failures = 0;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => {
        failures += 1;
        if (failures === 1) throw new TypeError('Failed to fetch');
        return { status: 200, body: afterPlies(1) };
      }),
    );
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100);
    window.__tg!.clickMain();
    await vi.advanceTimersByTimeAsync(100);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Retry', visible: true });
    expect(r.app.router.suppressTabs.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('drops a waiting move when the screen goes away, without asking and without sending', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(false);
    render(null, r.root);
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    window.__tg!.clickMain(); // the handler is gone with the screen
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(window.__tg!.calls).not.toContain('enableClosingConfirmation');
  });

  it('drops a waiting move when Telegram minimises the app', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.emit('deactivated');
    await r.flush();
    expect(adapter.restored).toBe(restored + 1);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('lets a confirmed move land when the app is minimised while it sends', async () => {
    // Review Focus 4.
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.emit('deactivated');
    answer({ status: 200, body: afterPlies(1) });
    await r.flush();
    expect(adapter.restored).toBe(restored);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
  });

  it('keeps a waiting move through a draw offer, and drops it when the game ends under it', async () => {
    // Review Focus 3: only a new ply or status cancels.
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const before = adapter.positions.length;
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ version: 1, drawOffer: { by: 'black', atPly: 0 } }),
      '1',
    );
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ version: 2, status: 'finished', result: '*', endReason: 'abort' }),
      '2',
    );
    await r.flush();
    expect(adapter.positions.length).toBeGreaterThan(before);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
