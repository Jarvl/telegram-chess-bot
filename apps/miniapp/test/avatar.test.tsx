import { signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { Avatar, GroupAvatar } from '../src/ui/Avatar';
import {
  AVATAR_PALETTE,
  avatarColour,
  groupColour,
  groupInitials,
  personInitial,
} from '../src/ui/avatarPalette';
import { renderApp } from './support/render';

describe('avatar helpers', () => {
  it("picks Telegram's palette by user id modulo 7", () => {
    expect(avatarColour('7')).toBe('#e17076');
    expect(avatarColour('1')).toBe('#faa774');
    expect(avatarColour('13')).toBe('#ee7aae');
  });

  it('stays in the palette for ids beyond 2^53', () => {
    const colour = avatarColour('9223372036854775807');
    expect(AVATAR_PALETTE).toContain(colour);
    expect(avatarColour('9223372036854775807')).toBe(colour);
  });

  it('colours a group by its public id, the same every time', () => {
    expect(AVATAR_PALETTE).toContain(groupColour('GrOuPiDxYz'));
    expect(groupColour('GrOuPiDxYz')).toBe(groupColour('GrOuPiDxYz'));
  });

  it("takes a person's first character, skipping the @ of a username", () => {
    expect(personInitial('@mayachess')).toBe('M');
    expect(personInitial('tom')).toBe('T');
    expect(personInitial('🦄 Unicorn')).toBe('🦄');
    expect(personInitial('@')).toBe('?');
    expect(personInitial('')).toBe('?');
  });

  it('keeps a flag emoji (a regional-indicator pair) whole, not split in two', () => {
    expect(personInitial('🇺🇦 Oleh')).toBe('🇺🇦');
  });

  it('keeps a ZWJ family emoji whole, not split into its parts', () => {
    expect(personInitial('👨‍👩‍👧‍👦 The Smiths')).toBe('👨‍👩‍👧‍👦');
  });

  it('takes up to two initials from a group title', () => {
    expect(groupInitials('Friday Chess Club')).toBe('FC');
    expect(groupInitials('Family')).toBe('F');
    expect(groupInitials('office blitz')).toBe('OB');
    expect(groupInitials('   ')).toBe('?');
  });

  it('keeps a leading flag emoji whole in group initials too', () => {
    expect(groupInitials('🇺🇦 Kyiv Chess')).toBe('🇺🇦K');
  });
});

describe('Avatar', () => {
  it('draws a coloured initial for a person and the goat mark for the bot', async () => {
    const r = renderApp(
      () => (
        <>
          <Avatar player={{ id: '7', name: '@maya', isBot: false, photoUrl: null }} size={40} />
          <Avatar player={{ id: '9', name: 'Stockfish', isBot: true, photoUrl: null }} size={34} />
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

  const maya = (photoUrl: string | null) => ({ id: '7', name: '@maya', isBot: false, photoUrl });
  const noFetch = () => ({ status: 200, body: {} });

  it('lays the photo over the initial', async () => {
    const r = renderApp(() => <Avatar player={maya('/api/avatars/x.jpg')} size={40} />, noFetch);
    await r.flush();
    const photo = r.root.querySelector('span.avatar img.photo') as HTMLImageElement;
    expect(photo.getAttribute('src')).toBe('/api/avatars/x.jpg');
    expect(photo.getAttribute('alt')).toBe('');
    expect(r.root.querySelector('span.avatar')!.textContent).toBe('M');
  });

  it('falls back to the initial when the photo fails', async () => {
    const r = renderApp(() => <Avatar player={maya('/api/avatars/x.jpg')} size={40} />, noFetch);
    await r.flush();
    r.root.querySelector('img.photo')!.dispatchEvent(new Event('error'));
    await r.flush();
    expect(r.root.querySelector('img.photo')).toBeNull();
    expect(r.root.querySelector('span.avatar')!.textContent).toBe('M');
  });

  it('shows a new photo after an earlier one failed', async () => {
    const url = signal('/a.jpg');
    // Read inside a component, so the signal re-renders it; renderApp calls `ui` outside one.
    const Host = () => <Avatar player={maya(url.value)} size={40} />;
    const r = renderApp(() => <Host />, noFetch);
    await r.flush();
    r.root.querySelector('img.photo')!.dispatchEvent(new Event('error'));
    await r.flush();
    url.value = '/b.jpg';
    await r.flush();
    expect(r.root.querySelector('img.photo')?.getAttribute('src')).toBe('/b.jpg');
  });

  it("draws exactly today's avatar without a photo", async () => {
    const r = renderApp(() => <Avatar player={maya(null)} size={40} />, noFetch);
    await r.flush();
    const avatar = r.root.querySelector('span.avatar')!;
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('M');
    expect(avatar.getAttribute('style')).toMatch(/#e17076|rgb\(225, 112, 118\)/);
  });

  it("keeps the bot's mark even with a photo url", async () => {
    const r = renderApp(
      () => (
        <Avatar
          player={{ id: '9', name: 'Stockfish', isBot: true, photoUrl: '/x.jpg' }}
          size={34}
        />
      ),
      noFetch,
    );
    await r.flush();
    expect(r.root.querySelector('img.avatar.bot')?.getAttribute('src')).toMatch(/goat-mark/);
    expect(r.root.querySelector('img.photo')).toBeNull();
  });
});
