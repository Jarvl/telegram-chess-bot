import { describe, expect, it } from 'vitest';
import { ENGINE_LEVELS, EngineLevelSchema } from '../src';

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
