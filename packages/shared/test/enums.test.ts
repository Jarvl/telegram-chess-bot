import { describe, expect, it } from 'vitest';
import {
  ENGINE_LEVELS,
  EngineLevelSchema,
  MOVE_CONFIRMATIONS,
  MoveConfirmationsSchema,
} from '../src';

describe('engine levels', () => {
  it('lists the four levels weakest first', () => {
    expect(ENGINE_LEVELS).toEqual(['beginner', 'casual', 'club', 'strong']);
  });

  it('accepts a known level and refuses anything else', () => {
    expect(EngineLevelSchema.safeParse('club').success).toBe(true);
    expect(EngineLevelSchema.safeParse('grandmaster').success).toBe(false);
    expect(EngineLevelSchema.safeParse(1600).success).toBe(false);
  });
});

describe('move confirmations', () => {
  it('lists the three settings, most confirming first', () => {
    expect(MOVE_CONFIRMATIONS).toEqual(['always', 'people', 'never']);
  });

  it('accepts a known setting and refuses anything else', () => {
    expect(MoveConfirmationsSchema.safeParse('people').success).toBe(true);
    expect(MoveConfirmationsSchema.safeParse('sometimes').success).toBe(false);
    expect(MoveConfirmationsSchema.safeParse(true).success).toBe(false);
  });
});
