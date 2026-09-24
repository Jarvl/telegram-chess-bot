import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { serverNow } from '../state/session';

const now = signal(serverNow());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The server's `now`, re-read once a second while any mounted caller is active. Every row of a
 * list shares one interval, and it stops when the last ticking row goes away.
 */
export function useNow(active: boolean): Date {
  // The shared ticker may have gone idle (its last subscriber unmounted) and left `now` stale.
  // Refresh it synchronously, before this render reads it below, rather than showing a stale
  // value for one frame until the effect further down (which only runs after paint) catches up.
  if (active && subscribers === 0) now.value = serverNow();
  useEffect(() => {
    if (!active) return;
    subscribers += 1;
    if (subscribers === 1) {
      now.value = serverNow();
      timer = setInterval(() => (now.value = serverNow()), 1_000);
    }
    return () => {
      subscribers -= 1;
      if (subscribers === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [active]);
  // Peek when inactive: reading `.value` would subscribe every caller (including finished games,
  // which never show a clock) to each tick, re-rendering their whole row for no visible change.
  return active ? now.value : now.peek();
}
