import { describe, expect, it } from 'vitest';
import { issueSessionToken, verifySessionToken } from '../../src/api/session';

const secret = 's'.repeat(32);

describe('session tokens', () => {
  it('round-trips the user id', async () => {
    const token = await issueSessionToken(secret, 42);
    expect(await verifySessionToken(secret, token)).toBe(42);
  });

  it('rejects another secret, garbage and an expired token', async () => {
    const token = await issueSessionToken(secret, 42);
    await expect(verifySessionToken('x'.repeat(32), token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(verifySessionToken(secret, 'not-a-token')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const old = await issueSessionToken(secret, 42, new Date(Date.now() - 25 * 3_600_000));
    await expect(verifySessionToken(secret, old)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
