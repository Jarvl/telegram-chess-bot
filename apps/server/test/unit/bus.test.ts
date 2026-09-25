import { describe, expect, it } from 'vitest';
import { LocalBus } from '../../src/bus/bus';

describe('LocalBus', () => {
  it('delivers a publish to every subscriber of that game only', () => {
    const bus = new LocalBus();
    const seen: string[] = [];
    bus.subscribe('game-a', () => seen.push('a1'));
    bus.subscribe('game-a', () => seen.push('a2'));
    bus.subscribe('game-b', () => seen.push('b'));
    bus.publish('game-a');
    expect(seen).toEqual(['a1', 'a2']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new LocalBus();
    let calls = 0;
    const off = bus.subscribe('game-a', () => (calls += 1));
    bus.publish('game-a');
    off();
    bus.publish('game-a');
    expect(calls).toBe(1);
  });

  it('leaves newer subscribers alone when a stale unsubscribe runs twice', () => {
    const bus = new LocalBus();
    let later = 0;
    const off = bus.subscribe('g', () => undefined);
    off();
    bus.subscribe('g', () => (later += 1));
    off();
    bus.publish('g');
    expect(later).toBe(1);
  });

  it('keeps a throwing listener from blocking the others', () => {
    const bus = new LocalBus();
    const seen: string[] = [];
    bus.subscribe('g', () => {
      throw new Error('boom');
    });
    bus.subscribe('g', () => seen.push('ok'));
    expect(() => bus.publish('g')).not.toThrow();
    expect(seen).toEqual(['ok']);
  });

  it('hands the audience to every listener so each can decide whether it is meant', () => {
    const bus = new LocalBus();
    const seen: unknown[] = [];
    bus.subscribe('g', (audience) => seen.push(audience));
    bus.publish('g', { userId: 7 });
    bus.publish('g');
    expect(seen).toEqual([{ userId: 7 }, undefined]);
  });
});
