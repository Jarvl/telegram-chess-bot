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
});
