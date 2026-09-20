import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const valid = {
  BOT_TOKEN: '123456:abc',
  BOT_USERNAME: 'GroupChessBot',
  MINI_APP_SHORT_NAME: 'chess',
  PUBLIC_URL: 'https://chess.example.com',
  WEBHOOK_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgres://postgres@localhost:5432/group_chess',
  SESSION_SECRET: 's'.repeat(32),
};

describe('loadConfig', () => {
  it('parses a complete environment and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.ROLES).toEqual(['api', 'bot', 'jobs', 'clock']);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PORT).toBe(3000);
    expect(config.LICHESS_TOKEN).toBeUndefined();
  });

  it('parses a subset of roles and a numeric port', () => {
    const config = loadConfig({ ...valid, ROLES: 'jobs, clock', PORT: '8080' });
    expect(config.ROLES).toEqual(['jobs', 'clock']);
    expect(config.PORT).toBe(8080);
  });

  it('names the missing variable', () => {
    const { BOT_TOKEN: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/BOT_TOKEN/);
  });

  it('rejects an unknown role', () => {
    expect(() => loadConfig({ ...valid, ROLES: 'api,cron' })).toThrow(/ROLES/);
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
});
