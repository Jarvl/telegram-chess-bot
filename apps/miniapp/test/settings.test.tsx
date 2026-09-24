import { describe, expect, it } from 'vitest';
import { prefs } from '../src/state/session';
import { Settings } from '../src/ui/screens/Settings';
import { renderApp } from './support/render';

describe('Settings', () => {
  it('saves a toggled preference and keeps the returned prefs', async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      }),
    );
    await r.click('[data-pref="closeAfterMove"]');
    expect(r.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/api/me/prefs',
      body: { prefs: { closeAfterMove: false } },
    });
    expect(window.__tg!.haptics).toContain('selection');
    expect(prefs.value.closeAfterMove).toBe(false);
    expect(r.root.querySelector('[data-pref="closeAfterMove"]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('has no move confirmation toggle', () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    expect(r.root.querySelector('[data-pref]')).not.toBeNull();
    expect(r.root.querySelector('[data-pref="confirmMoves"]')).toBeNull();
  });

  it('deletes my data after confirmation and closes the app', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    await r.click('[data-action="delete"]');
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(r.calls).toHaveLength(0);
    await r.click('[data-action="delete"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(r.calls[0]).toMatchObject({ method: 'DELETE', path: '/api/me' });
    expect(window.__tg!.closed).toBe(true);
  });

  it('asks for permission to message when notifications go on and the bot cannot write yet', async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: {
          prefs: { ...prefs.value, ...((body as { prefs?: object }).prefs ?? {}) },
          dmAllowed: false,
        },
      }),
      { writeAccess: true },
    );
    await r.click('[data-pref="notifications"]'); // off: nothing to ask
    expect(window.__tg!.calls).not.toContain('requestWriteAccess');
    await r.click('[data-pref="notifications"]'); // on again
    expect(window.__tg!.calls).toContain('requestWriteAccess');
    const writeAccessCall = r.calls.find(
      (c) =>
        c.method === 'PUT' &&
        c.path === '/api/me/prefs' &&
        typeof c.body === 'object' &&
        c.body !== null &&
        'writeAccess' in c.body,
    );
    expect(writeAccessCall).toMatchObject({
      body: { writeAccess: { allowed: true } },
    });
  });

  it('links to the author, the source and the licences', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    await r.flush();
    expect(r.root.querySelector('img.banner-img')?.getAttribute('src')).toMatch(/goat-banner/);
    await r.click('[data-action="author"]');
    await r.click('[data-action="source"]');
    expect(window.__tg!.links).toEqual([
      'https://t.me/Jarvl',
      'https://github.com/Jarvl/telegram-chess-bot',
    ]);
    await r.click('[data-action="about"]');
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      title: 'About Chess Goat',
      message: expect.stringContaining('Chess Goat is free software'),
    });
  });

  it('confirms deletion in the page on clients without popups', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
      { version: '6.1' },
    );
    await r.click('[data-action="delete"]');
    await r.click('[data-dialog="confirm"]');
    expect(r.calls[0]).toMatchObject({ method: 'DELETE', path: '/api/me' });
  });
});
