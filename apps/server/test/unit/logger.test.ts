import { BotError, type Context } from 'grammy';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger';

describe('createLogger', () => {
  it('drops bound query parameters from error messages and stacks', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (line: string) => void lines.push(line) });
    const error = new Error(
      'Failed query: select 1 where a = $1\nparams: Alice Example,alice_handle: relation missing',
    );
    log.error({ err: error, userId: 7 }, 'boom');
    const out = lines.join('\n');
    expect(out).toContain('Failed query: select 1 where a = $1');
    expect(out).toContain('"userId":7');
    expect(out).not.toContain('Alice');
    expect(out).not.toContain('alice_handle');
  });

  it('keeps the bot token, the update and bound values out of a failed handler', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (line: string) => void lines.push(line) });
    // The shape grammY and Drizzle produce when an insert fails inside a handler.
    class DrizzleQueryError extends Error {}
    const query = Object.assign(
      new DrizzleQueryError(
        'Failed query: insert into "tips" values ($1)\nparams: 256228126,charge-secret',
      ),
      {
        query: 'insert into "tips" values ($1)',
        params: [256228126, 'charge-secret'],
        cause: new Error('relation "tips" does not exist'),
      },
    );
    const ctx = {
      update: {
        update_id: 1,
        message: { from: { first_name: 'Alice', username: 'alice_handle' } },
      },
      api: { token: '123456:SECRET-TOKEN', raw: {}, config: {} },
      me: { username: 'TestChessBot' },
    };
    log.error(
      { err: new BotError(query, ctx as unknown as Context), updateId: 1 },
      'update handler failed',
    );
    const out = lines.join('\n');
    expect(out).toContain('Error in middleware');
    expect(out).toContain('"type":"DrizzleQueryError"');
    expect(out).toContain('relation \\"tips\\" does not exist');
    expect(out).toContain('"updateId":1');
    for (const secret of ['SECRET-TOKEN', 'Alice', 'alice_handle', 'charge-secret', '256228126'])
      expect(out).not.toContain(secret);
  });
});
