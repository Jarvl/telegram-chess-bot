import { beforeEach, describe, expect, it } from 'vitest';
import { themeVariables } from '../src/tg/theme';
import type { TelegramWebApp } from '../src/tg/types';
import { createTg, FEATURE_MIN_VERSION, versionAtLeast } from '../src/tg/webapp';
import { installFakeWebApp, type FakeWebAppOptions } from './support/fakeWebApp';

const raw = () => (window as unknown as { Telegram: { WebApp: TelegramWebApp } }).Telegram.WebApp;
const tgFor = (options: Partial<FakeWebAppOptions> & { version: string }) => {
  installFakeWebApp({ initData: 'user=%7B%22id%22%3A1%7D&hash=x', ...options });
  return createTg(raw());
};

beforeEach(() => {
  delete window.__tg;
});

describe('versionAtLeast', () => {
  it('compares numerically, so 7.10 is newer than 7.9', () => {
    expect(versionAtLeast('7.10', '7.9')).toBe(true);
    expect(versionAtLeast('7.9', '7.10')).toBe(false);
    expect(versionAtLeast('8.0', '8.0')).toBe(true);
    expect(versionAtLeast('6.0', '6.1')).toBe(false);
  });
});

describe('createTg', () => {
  it('gates every capability by the client version', () => {
    const old = tgFor({ version: '6.0' });
    const fresh = tgFor({ version: '8.0' });
    for (const feature of Object.keys(
      FEATURE_MIN_VERSION,
    ) as (keyof typeof FEATURE_MIN_VERSION)[]) {
      expect(old.supports(feature)).toBe(false);
      expect(fresh.supports(feature)).toBe(true);
    }
  });

  it('disables vertical swipes only from 7.7', () => {
    expect(tgFor({ version: '7.6' }).disableVerticalSwipes()).toBe(false);
    expect(window.__tg!.calls).not.toContain('disableVerticalSwipes');
    expect(tgFor({ version: '7.7' }).disableVerticalSwipes()).toBe(true);
    expect(window.__tg!.calls).toContain('disableVerticalSwipes');
  });

  it('binds one handler at a time to the main button', () => {
    const tg = tgFor({ version: '8.0' });
    let first = 0;
    let second = 0;
    tg.setMainButton({ text: 'One', onClick: () => (first += 1) });
    tg.setMainButton({ text: 'Two', onClick: () => (second += 1), progress: true });
    window.__tg!.clickMain();
    expect([first, second]).toEqual([0, 1]);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Two', visible: true, progress: true });
    tg.setMainButton(null);
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('offers the secondary button only from 7.10', () => {
    expect(
      tgFor({ version: '7.9' }).setSecondaryButton({ text: 'Cancel', onClick: () => {} }),
    ).toBe(false);
    const tg = tgFor({ version: '7.10' });
    let clicks = 0;
    expect(tg.setSecondaryButton({ text: 'Cancel', onClick: () => (clicks += 1) })).toBe(true);
    window.__tg!.clickSecondary();
    expect(clicks).toBe(1);
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
  });

  it('skips haptics below 6.1 and forwards them from 6.1', () => {
    tgFor({ version: '6.0' }).haptic('light');
    expect(window.__tg!.haptics).toEqual([]);
    const tg = tgFor({ version: '6.1' });
    tg.haptic('medium');
    tg.hapticNotify('warning');
    expect(window.__tg!.haptics).toEqual(['impact:medium', 'notification:warning']);
  });

  it('answers null for write access below 6.9 and the client answer from 6.9', async () => {
    expect(await tgFor({ version: '6.8', writeAccess: true }).requestWriteAccess()).toBeNull();
    expect(await tgFor({ version: '6.9', writeAccess: true }).requestWriteAccess()).toBe(true);
    expect(await tgFor({ version: '6.9', writeAccess: false }).requestWriteAccess()).toBe(false);
  });

  it('downloads files only from 8.0', () => {
    expect(tgFor({ version: '7.11' }).downloadFile('https://x/g.pgn', 'g.pgn')).toBe(false);
    expect(window.__tg!.downloads).toEqual([]);
    expect(tgFor({ version: '8.0' }).downloadFile('https://x/g.pgn', 'g.pgn')).toBe(true);
    expect(window.__tg!.downloads).toEqual([{ url: 'https://x/g.pgn', file_name: 'g.pgn' }]);
  });

  it('shows and hides the back button with a single handler', () => {
    const tg = tgFor({ version: '8.0' });
    let backs = 0;
    tg.setBackButton(true, () => (backs += 1));
    tg.setBackButton(true, () => (backs += 10));
    window.__tg!.clickBack();
    expect(backs).toBe(10);
    tg.setBackButton(false, () => undefined);
    expect(window.__tg!.backButton.visible).toBe(false);
  });

  it('reports viewport changes', () => {
    const tg = tgFor({ version: '8.0', stableHeight: 700 });
    const seen: number[] = [];
    const off = tg.onViewportChanged((height) => seen.push(height));
    window.__tg!.setStableHeight(640);
    off();
    window.__tg!.setStableHeight(600);
    expect(seen).toEqual([640]);
  });

  it('is a null client outside Telegram', () => {
    const tg = createTg(null);
    expect(tg.available).toBe(false);
    expect(tg.supports('haptics')).toBe(false);
    expect(tg.setMainButton({ text: 'x', onClick: () => undefined })).toBe(false);
    expect(tg.initData).toBe('');
  });
});

describe('themeVariables', () => {
  it('takes Telegram colours and falls back per scheme', () => {
    const dark = themeVariables({ bg_color: '#101010' }, 'dark');
    expect(dark['--bg']).toBe('#101010');
    expect(dark['--text']).toBe('#ffffff');
    const light = themeVariables({}, 'light');
    expect(light['--bg']).toBe('#ffffff');
    expect(light['--button']).toBe('#2481cc');
  });
});
