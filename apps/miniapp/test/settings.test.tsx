import { describe, expect, it } from 'vitest';
import { t } from '@group-chess/shared';
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

  it('shows Move confirmations first in the card, with the current choice', () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    const row = r.root.querySelector('.card [data-pref="moveConfirmations"]');
    expect(row?.textContent).toContain('Move confirmations');
    expect(row?.textContent).toContain('Only against people');
    expect(r.root.querySelector('.card')?.firstElementChild).toBe(row);
    expect(r.root.querySelector('[data-pref="confirmMoves"]')).toBeNull();
  });

  it("saves a choice picked in Telegram's popup", async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      }),
    );
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      title: 'Move confirmations',
      message:
        'Ask before a move is sent. With "Only against people", moves against the bot send on drop.',
      buttons: [
        { id: 'always', text: 'Always' },
        { id: 'people', text: '✓ Only against people' },
        { id: 'never', text: 'Never' },
      ],
    });
    window.__tg!.answerPopup('never');
    await r.flush();
    expect(r.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/api/me/prefs',
      body: { prefs: { moveConfirmations: 'never' } },
    });
    expect(window.__tg!.haptics).toContain('selection');
    expect(prefs.value.moveConfirmations).toBe('never');
    expect(r.root.querySelector('[data-pref="moveConfirmations"]')?.textContent).toContain('Never');
  });

  it('changes nothing when the popup is dismissed or the current choice is picked', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('');
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('people');
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(window.__tg!.haptics).not.toContain('selection');
    expect(prefs.value.moveConfirmations).toBe('people');
  });

  it('reverts the choice and says so when the save fails', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } }),
    );
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('always');
    await r.flush();
    expect(prefs.value.moveConfirmations).toBe('people');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
  });

  it('offers the choices in the page on clients without popups', async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      }),
      { version: '6.1' },
    );
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    await r.click('[data-choice="always"]');
    expect(r.calls[0]).toMatchObject({ body: { prefs: { moveConfirmations: 'always' } } });
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
