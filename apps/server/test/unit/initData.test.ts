import { describe, expect, it } from 'vitest';
import { validateInitData } from '../../src/api/initData';
import { signInitData } from '../helpers/initData';

/** The worked example from Telegram's Mini Apps documentation. */
const DOC_TOKEN = '5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8';
const DOC_INIT_DATA =
  'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2';
const DOC_TIME = new Date(1662771648 * 1000 + 60_000);

describe('validateInitData', () => {
  it('accepts the documented example and parses the user', () => {
    const parsed = validateInitData(DOC_INIT_DATA, DOC_TOKEN, { now: DOC_TIME });
    expect(parsed.user).toMatchObject({
      id: 279058397,
      first_name: 'Vladislav',
      username: 'vdkfrost',
    });
    expect(parsed.queryId).toBe('AAHdF6IQAAAAAN0XohDhrOrc');
    expect(parsed.startParam).toBeNull();
    expect(parsed.authDate.toISOString()).toBe('2022-09-10T01:00:48.000Z');
  });

  it('agrees with the documented hash when the same payload is signed by the test helper', () => {
    const signed = signInitData(DOC_TOKEN, {
      queryId: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: {
        id: 279058397,
        first_name: 'Vladislav',
        last_name: 'Kibenko',
        username: 'vdkfrost',
        language_code: 'ru',
        is_premium: true,
      },
      authDate: 1662771648,
    });
    expect(new URLSearchParams(signed).get('hash')).toBe(
      'c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2',
    );
  });

  it('rejects tampered init data', () => {
    const tampered = DOC_INIT_DATA.replace('Vladislav', 'Vladislaw');
    expect(() => validateInitData(tampered, DOC_TOKEN, { now: DOC_TIME })).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
  });

  it('rejects init data older than 24 hours', () => {
    const later = new Date(DOC_TIME.getTime() + 25 * 3_600_000);
    expect(() => validateInitData(DOC_INIT_DATA, DOC_TOKEN, { now: later })).toThrow(
      expect.objectContaining({ code: 'unauthorized', details: { reason: 'expired' } }),
    );
  });

  it('rejects data without a hash, with a bad token, or with a malformed user', () => {
    expect(() => validateInitData('auth_date=1&user=%7B%7D', DOC_TOKEN)).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
    expect(() => validateInitData(DOC_INIT_DATA, '1:other', { now: DOC_TIME })).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
    const noId = signInitData(DOC_TOKEN, { user: { first_name: 'X' } });
    expect(() => validateInitData(noId, DOC_TOKEN)).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
  });

  it('returns the start_param when present', () => {
    const signed = signInitData(DOC_TOKEN, {
      user: { id: 7, first_name: 'Ann' },
      startParam: 'g_aZ09bY18cX',
    });
    expect(validateInitData(signed, DOC_TOKEN).startParam).toBe('g_aZ09bY18cX');
  });
});
