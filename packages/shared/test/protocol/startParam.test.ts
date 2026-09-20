import { describe, expect, it } from 'vitest';
import { decodeStartParam, encodeStartParam, type StartParam } from '../../src/protocol/startParam';

describe('start param codec', () => {
  it('encodes a game link payload', () => {
    expect(encodeStartParam({ kind: 'game', gameId: 'aZ09bY18cX' })).toBe('g_aZ09bY18cX');
  });

  it('encodes lobby and settings payloads', () => {
    expect(encodeStartParam({ kind: 'lobby', groupId: 'aZ09bY18cX' })).toBe('l_aZ09bY18cX');
    expect(encodeStartParam({ kind: 'settings', groupId: 'aZ09bY18cX' })).toBe('s_aZ09bY18cX');
  });

  it('decodes what it encodes', () => {
    const params: StartParam[] = [
      { kind: 'game', gameId: 'aZ09bY18cX' },
      { kind: 'lobby', groupId: 'grp0000001' },
      { kind: 'settings', groupId: 'grp0000001' },
    ];
    for (const param of params) {
      expect(decodeStartParam(encodeStartParam(param))).toEqual(param);
    }
  });

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['an unknown prefix', 'x_aZ09bY18cX'],
    ['an upper-case prefix', 'G_aZ09bY18cX'],
    ['a short id', 'g_aZ09bY18c'],
    ['a long id', 'g_aZ09bY18cXX'],
    ['path characters', 'g_../../etc'],
    ['a missing underscore', 'gaZ09bY18cX'],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeStartParam(raw)).toBeNull();
  });
});
