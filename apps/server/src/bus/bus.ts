/** In-process publish/subscribe of game changes to SSE streams (spec §4.2). Keys are public game ids. */
export interface Bus {
  publish(gameId: string): void;
  subscribe(gameId: string, listener: () => void): () => void;
}

export class LocalBus implements Bus {
  private readonly listeners = new Map<string, Set<() => void>>();

  publish(gameId: string): void {
    const set = this.listeners.get(gameId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener();
      } catch {
        // A failing subscriber must never break the publisher or its siblings.
      }
    }
  }

  subscribe(gameId: string, listener: () => void): () => void {
    let set = this.listeners.get(gameId);
    if (!set) {
      set = new Set();
      this.listeners.set(gameId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      // Only remove the set this closure owns; a stale second call must not evict newer subscribers.
      if (set.size === 0 && this.listeners.get(gameId) === set) this.listeners.delete(gameId);
    };
  }
}
