import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameStore } from '../src/state/game';
import { MoveList } from '../src/ui/game/MoveList';
import { PremoveBar } from '../src/ui/game/PremoveBar';
import { afterPlies } from './support/gameFixtures';
import { renderApp } from './support/render';

afterEach(() => vi.unstubAllGlobals());

const ok = () => ({ status: 200, body: { ok: true } });
const waiting = (premoves: string[]) =>
  new GameStore(afterPlies(1, { viewerRole: 'white', premoves }));

describe('MoveList premove chips', () => {
  it('adds a gap and a chip per premove, numbered on from the real moves', async () => {
    const store = waiting(['g1h3', 'h3g5']);
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    const strip = r.root.querySelector('.move-list')!;
    expect(strip.querySelectorAll('.premove-gap')).toHaveLength(2);
    expect([...strip.querySelectorAll('[data-premove]')].map((b) => b.textContent)).toEqual([
      'Nh3',
      'Ng5',
    ]);
    expect(strip.textContent).toBe('1.f3…2.Nh3…3.Ng5');
    expect(strip.querySelector('[data-premove="2"]')?.getAttribute('aria-current')).toBe('true');
    await r.click('[data-premove="1"]');
    expect(store.shownStep.value).toBe(1);
    await r.click('[data-ply="1"]');
    expect(store.shownStep.value).toBe(0);
    expect(strip.querySelector('[data-ply="1"]')?.getAttribute('aria-current')).toBe('true');
  });

  it('shows chips even before any real move', async () => {
    const store = new GameStore(afterPlies(0, { viewerRole: 'black', premoves: ['e7e5'] }));
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    expect(r.root.querySelector('[data-premove="1"]')?.textContent).toBe('e5');
    expect(r.text()).not.toContain('No moves yet');
  });
});

describe('PremoveBar', () => {
  it('steps through the chain and removes from the viewed premove on', async () => {
    const store = waiting(['g1h3', 'h3g5']);
    const removed: number[] = [];
    const r = renderApp(() => <PremoveBar store={store} onRemove={(k) => removed.push(k)} />, ok);
    await r.flush();
    expect(r.root.querySelector('.premove-label')?.textContent).toBe('Premove 2 of 2');
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="premove-next"]')?.disabled).toBe(
      true,
    );
    await r.click('[data-action="premove-prev"]');
    expect(r.root.querySelector('.premove-label')?.textContent).toBe('Premove 1 of 2');
    await r.click('[data-action="premove-remove"]');
    expect(removed).toEqual([1]);
    await r.click('[data-action="premove-prev"]');
    expect(r.root.querySelector('.premove-label')?.textContent).toBe('Current position');
    expect(r.root.querySelector('[data-action="premove-remove"]')).toBeNull();
    expect(window.__tg!.haptics).toContain('selection');
  });

  it('is hidden with an empty chain and outside premove mode', async () => {
    const r = renderApp(() => <PremoveBar store={waiting([])} onRemove={() => undefined} />, ok);
    await r.flush();
    expect(r.root.querySelector('.premove-bar')).toBeNull();
  });
});
