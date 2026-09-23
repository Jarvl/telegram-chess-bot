import { describe, expect, it } from 'vitest';
import { confirmDialog, infoDialog } from '../src/ui/dialog';
import { renderApp } from './support/render';

const mount = (version: string) =>
  renderApp(
    () => null,
    () => ({ status: 200, body: {} }),
    { version },
  );

describe('confirmDialog', () => {
  it('asks through Telegram’s native popup from 6.2', async () => {
    const r = mount('6.2');
    await r.flush();
    const answer = confirmDialog('Resign this game?', { confirmLabel: 'Resign', danger: true });
    expect(window.__tg!.popups.at(-1)).toEqual({
      message: 'Resign this game?',
      buttons: [
        { id: 'cancel', type: 'cancel' },
        { id: 'confirm', type: 'destructive', text: 'Resign' },
      ],
    });
    expect(document.querySelector('.dialog')).toBeNull();
    window.__tg!.answerPopup('confirm');
    expect(await answer).toBe(true);
  });

  it('treats a dismissed popup as no', async () => {
    const r = mount('8.0');
    await r.flush();
    const answer = confirmDialog('Abort this game?');
    window.__tg!.answerPopup('');
    expect(await answer).toBe(false);
  });

  it('falls back to the in-page sheet below 6.2', async () => {
    const r = mount('6.1');
    await r.flush();
    const answer = confirmDialog('Delete your data?', { confirmLabel: 'Delete', danger: true });
    await r.flush();
    expect(document.querySelector('.dialog p')?.textContent).toBe('Delete your data?');
    await r.click('[data-dialog="confirm"]');
    expect(await answer).toBe(true);
  });
});

describe('infoDialog', () => {
  it('shows a titled message with a single OK', async () => {
    const r = mount('8.0');
    await r.flush();
    const done = infoDialog('Pieces by …', 'About Chess Goat');
    expect(window.__tg!.popups.at(-1)).toEqual({
      title: 'About Chess Goat',
      message: 'Pieces by …',
      buttons: [{ id: 'confirm', type: 'ok' }],
    });
    window.__tg!.answerPopup('confirm');
    await done;
  });

  it('shows the same in the page below 6.2, without a cancel button', async () => {
    const r = mount('6.1');
    await r.flush();
    void infoDialog('Pieces by …', 'About Chess Goat');
    await r.flush();
    expect(document.querySelector('.dialog strong')?.textContent).toBe('About Chess Goat');
    expect(document.querySelector('[data-dialog="cancel"]')).toBeNull();
    expect(document.querySelector('[data-dialog="confirm"]')?.textContent).toBe('OK');
  });
});
