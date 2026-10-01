import { describe, expect, it } from 'vitest';
import { canDelete, DM_DELETE_WINDOW_MS, resultRecipients } from '../../src/domain/dmRules';

describe('canDelete', () => {
  const sentAt = new Date('2026-09-29T00:00:00Z');
  const after = (ms: number) => new Date(sentAt.getTime() + ms);

  it('uses a 47 hour window', () => {
    expect(DM_DELETE_WINDOW_MS).toBe(47 * 60 * 60 * 1000);
  });

  it('deletes just under 47 hours', () => {
    expect(canDelete(sentAt, after(DM_DELETE_WINDOW_MS - 60_000))).toBe(true);
  });

  it('stubs at 47 hours', () => {
    expect(canDelete(sentAt, after(DM_DELETE_WINDOW_MS))).toBe(false);
  });
});

describe('resultRecipients', () => {
  it('tells the player who did not end the game', () => {
    expect(resultRecipients('checkmate', 'white')).toEqual(['black']);
    expect(resultRecipients('draw_agreement', 'black')).toEqual(['white']);
    expect(resultRecipients('resignation', 'black')).toEqual(['white']);
  });

  it('tells both players when nobody ended it', () => {
    expect(resultRecipients('timeout', null)).toEqual(['white', 'black']);
  });

  it('tells nobody about an abort or a void', () => {
    expect(resultRecipients('abort', 'white')).toEqual([]);
    expect(resultRecipients('timeout_abort', null)).toEqual([]);
    expect(resultRecipients('voided', null)).toEqual([]);
  });
});
