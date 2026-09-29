import { describe, expect, it } from 'vitest';
import { Avatar, GroupAvatar } from '../src/ui/Avatar';
import { renderApp } from './support/render';

describe('Avatar', () => {
  it('draws a coloured initial for a person and the goat mark for the bot', async () => {
    const r = renderApp(
      () => (
        <>
          <Avatar player={{ id: '7', name: '@maya', isBot: false }} size={40} />
          <Avatar player={{ id: '9', name: 'Stockfish', isBot: true }} size={34} />
          <GroupAvatar group={{ id: 'GrOuPiDxYz', title: 'Friday Chess Club' }} size={56} />
        </>
      ),
      () => ({ status: 200, body: {} }),
    );
    await r.flush();
    const [person, bot, group] = [...r.root.querySelectorAll('.avatar')] as HTMLElement[];
    expect(person!.textContent).toBe('M');
    // happy-dom may keep the hex or serialise it as rgb(); either is the palette's red.
    expect(person!.getAttribute('style')).toMatch(/#e17076|rgb\(225, 112, 118\)/);
    expect(bot!.tagName).toBe('IMG');
    expect(bot!.getAttribute('src')).toMatch(/goat-mark/);
    expect(group!.className).toContain('group');
    expect(group!.textContent).toBe('FC');
  });
});
