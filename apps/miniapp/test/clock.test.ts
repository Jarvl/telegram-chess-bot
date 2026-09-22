import { describe, expect, it } from 'vitest';
import { clockLabel, isUrgent, remainingMs } from '../src/state/clock';

const now = new Date('2026-09-20T10:00:00.000Z');

describe('clock', () => {
  it('measures the remaining time against the server clock and never goes negative', () => {
    expect(remainingMs('2026-09-20T11:30:00.000Z', now)).toBe(90 * 60_000);
    expect(remainingMs('2026-09-20T09:00:00.000Z', now)).toBe(0);
    expect(remainingMs(null, now)).toBeNull();
  });

  it('labels the ticking side, the waiting side and games without a clock', () => {
    expect(clockLabel(90 * 60_000, 86400, true)).toBe('1:30:00');
    expect(clockLabel(0, 86400, true)).toBe('0:00');
    expect(clockLabel(null, 86400, false)).toBe('1d 0:00');
    expect(clockLabel(null, 3600, false)).toBe('1:00:00');
    expect(clockLabel(null, null, true)).toBe('No clock');
  });

  it('flags the last tenth of the budget or the last hour as urgent', () => {
    expect(isUrgent(2 * 3_600_000, 86400)).toBe(true);
    expect(isUrgent(10 * 3_600_000, 86400)).toBe(false);
    expect(isUrgent(30 * 60_000, 3600)).toBe(true);
    expect(isUrgent(null, 86400)).toBe(false);
  });
});
