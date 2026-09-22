import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/bot/rateLimit';

describe('RateLimiter', () => {
  it('allows up to the limit inside the window', () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 1_000)).toBe(true);
    expect(limiter.allow('a', 2_000)).toBe(false);
    expect(limiter.allow('a', 61_000)).toBe(true);
  });

  it('evicts keys whose window has passed', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.allow('a', 0);
    expect(limiter.size).toBe(1);
    limiter.allow('b', 70_000);
    expect(limiter.size).toBe(1);
  });
});
