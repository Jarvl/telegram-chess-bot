import { describe, expect, it, vi } from 'vitest';
import { GameCard } from '../src/ui/GameCard';
import { AFTER_E4 } from './support/gameFixtures';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const mount = (game: ReturnType<typeof gameSummary>, context?: string) => {
  const opened: string[] = [];
  const r = renderApp(
    () => <GameCard game={game} context={context} onOpen={(id) => opened.push(id)} />,
    () => ({ status: 200, body: {} }),
  );
  return { r, opened };
};

describe('GameCard', () => {
  it('shows the opponent, the group, the terms and a gold pill on your move', async () => {
    const { r, opened } = mount(gameSummary({ fen: AFTER_E4, lastMove: 'e2e4' }), 'Chess Club');
    await r.flush();
    const card = r.root.querySelector<HTMLElement>('[data-game="GameAaaaaa"]')!;
    expect(card.className).not.toContain('dim');
    expect(card.querySelector('.name')!.textContent).toBe('Bob');
    expect(card.querySelector('.rating')!.textContent).toBe('1500?');
    expect(r.text()).toContain('Chess Club');
    expect(r.text()).toContain('1 day per move · Rated');
    expect(card.querySelector('.pill')!.className).toBe('pill yours');
    expect(card.querySelectorAll('.mini-board .lm')).toHaveLength(2);
    await r.click('[data-game="GameAaaaaa"]');
    expect(opened).toEqual(['GameAaaaaa']);
  });

  it('dims a game that is waiting on someone else', async () => {
    const { r } = mount(gameSummary({ yourTurn: false, sideToMove: 'black' }));
    await r.flush();
    expect(r.root.querySelector('.game-card')!.className).toContain('dim');
  });

  it('turns the board for black and names both sides for a spectator', async () => {
    const asBlack = mount(
      gameSummary({ white: playerRef('2', 'Bob'), black: playerRef('1', 'Alice') }),
    );
    await asBlack.r.flush();
    expect(asBlack.r.root.querySelector('[data-square]')!.getAttribute('data-square')).toBe('h1');

    const watching = mount(
      gameSummary({
        white: playerRef('3', 'Carol'),
        black: playerRef('4', 'Dan'),
        yourTurn: false,
      }),
    );
    await watching.r.flush();
    expect(watching.r.root.querySelector('.name')!.textContent).toBe('Carol vs Dan');
    expect(watching.r.root.querySelector('.tag')!.textContent).toBe('Watching');
  });

  it('shows the bot with its level instead of a rating', async () => {
    const { r } = mount(
      gameSummary({ black: playerRef('9', 'Stockfish', { isBot: true }), engineLevel: 'club' }),
    );
    await r.flush();
    expect(r.root.querySelector('.rating')!.textContent).toBe('Club');
    expect(r.root.querySelector('img.avatar.bot')).not.toBeNull();
  });

  it('ticks every live row from one interval and stops it when they go', async () => {
    // Only setInterval/clearInterval/Date are faked: setTimeout stays real so renderApp's
    // flush() (which polls via real setTimeout) still drains Preact's deferred effects.
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    try {
      const deadlineAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
      const gameA = gameSummary({ id: 'GameAaaaaa', deadlineAt });
      const gameB = gameSummary({ id: 'GameBbbbbb', deadlineAt });
      const r = renderApp(
        () => (
          <>
            <GameCard game={gameA} onOpen={() => {}} />
            <GameCard game={gameB} onOpen={() => {}} />
          </>
        ),
        () => ({ status: 200, body: {} }),
      );
      await r.flush();
      expect(vi.getTimerCount()).toBe(1);

      const before = Array.from(r.root.querySelectorAll('.pill')).map((el) => el.textContent);
      vi.advanceTimersByTime(1_000);
      await r.flush();
      const after = Array.from(r.root.querySelectorAll('.pill')).map((el) => el.textContent);
      expect(after).not.toEqual(before);

      renderApp(
        () => null,
        () => ({ status: 200, body: {} }),
      );
      await r.flush();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
