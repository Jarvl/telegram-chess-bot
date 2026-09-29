import { describe, expect, it } from 'vitest';
import {
  AVATAR_PALETTE,
  avatarColour,
  groupColour,
  groupInitials,
  personInitial,
} from '../src/avatar';

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
