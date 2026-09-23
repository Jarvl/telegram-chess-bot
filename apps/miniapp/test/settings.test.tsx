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
});
