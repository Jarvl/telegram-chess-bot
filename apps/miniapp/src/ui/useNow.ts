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
  return now.value;
}
