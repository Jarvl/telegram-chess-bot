import { describe, expect, it } from 'vitest';
import {
  ChallengeRequestSchema,
  GroupSettingsUpdateRequestSchema,
  LaunchRequestSchema,
  MoveRequestSchema,
  PrefsUpdateRequestSchema,
  TelemetryRequestSchema,
} from '../../src/protocol/requests';

describe('MoveRequestSchema', () => {
  const valid = { uci: 'e7e8q', expectedPly: 0, clientMoveId: 'abcdefgh' };

  it('accepts a promotion move with a client move id', () => {
    expect(MoveRequestSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['an off-board square', { ...valid, uci: 'e7e9' }],
    ['a fractional ply', { ...valid, expectedPly: 1.5 }],
    ['a short client move id', { ...valid, clientMoveId: 'abc' }],
    ['a client move id with a space', { ...valid, clientMoveId: 'abcd efgh' }],
  ])('rejects %s', (_label, body) => {
    expect(MoveRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('ChallengeRequestSchema', () => {
  it('accepts an open challenge', () => {
    const body = { opponentId: null, timePerMove: 86400, colour: 'random', rated: true };
    expect(ChallengeRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a time control that is not offered', () => {
    const body = { opponentId: '7', timePerMove: 7200, colour: 'white', rated: false };
    expect(ChallengeRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an unknown colour', () => {
    const body = { opponentId: '7', timePerMove: 3600, colour: 'pink', rated: false };
    expect(ChallengeRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('TelemetryRequestSchema', () => {
  it('accepts one event', () => {
    const body = { events: [{ kind: 'sse_failed', durationMs: 30000 }] };
    expect(TelemetryRequestSchema.safeParse(body).success).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(TelemetryRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects more than ten events', () => {
    const events = Array.from({ length: 11 }, () => ({ kind: 'move_retry' }));
    expect(TelemetryRequestSchema.safeParse({ events }).success).toBe(false);
  });
});

describe('PrefsUpdateRequestSchema', () => {
  it('accepts a partial preferences update', () => {
    expect(PrefsUpdateRequestSchema.parse({ prefs: { closeAfterMove: false } })).toEqual({
      prefs: { closeAfterMove: false },
    });
  });

  it('accepts a write-access prompt result on its own', () => {
    expect(PrefsUpdateRequestSchema.parse({ writeAccess: { allowed: true } })).toEqual({
      writeAccess: { allowed: true },
    });
  });
});

describe('GroupSettingsUpdateRequestSchema', () => {
  it('accepts a single field', () => {
    expect(GroupSettingsUpdateRequestSchema.parse({ leaderboardMinGames: 3 })).toEqual({
      leaderboardMinGames: 3,
    });
  });

  it('still enforces the range of each field', () => {
    expect(GroupSettingsUpdateRequestSchema.safeParse({ leaderboardMinGames: -1 }).success).toBe(
      false,
    );
  });
});

describe('LaunchRequestSchema', () => {
  it('rejects empty init data', () => {
    expect(LaunchRequestSchema.safeParse({ initData: '' }).success).toBe(false);
  });
});
