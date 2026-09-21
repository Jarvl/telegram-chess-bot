import type { GroupRef, LobbyDto } from '@group-chess/shared';
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { Tg } from './tg/webapp';

export type LobbyTab = 'active' | 'finished' | 'players';

export type Route =
  | { name: 'loading' }
  | { name: 'error' }
  | { name: 'reopen' }
  | { name: 'locked'; group: GroupRef }
  | { name: 'groups' }
  | { name: 'lobby'; groupId: string }
  | { name: 'newGame'; groupId: string; defaults?: LobbyDto['settings'] }
  | { name: 'game'; gameId: string }
  | { name: 'player'; groupId: string; userId: string }
  | { name: 'settings' }
  | { name: 'groupSettings'; groupId: string };

/**
 * An in-memory route stack (Telegram owns the URL fragment) bound to the BackButton (spec §6.1
 * step 5): the button shows below the root, or at the root when the app should close from there.
 */
export class Router {
  readonly stack: Signal<Route[]> = signal([]);
  readonly current: ReadonlySignal<Route>;

  constructor(
    private readonly tg: Tg,
    private readonly options: { closeWhenEmpty: boolean },
  ) {
    this.current = computed(() => this.stack.value.at(-1) ?? { name: 'loading' });
    this.sync();
  }

  reset(route: Route): void {
    this.stack.value = [route];
    this.sync();
  }

  push(route: Route): void {
    this.stack.value = [...this.stack.value, route];
    this.sync();
  }

  replace(route: Route): void {
    this.stack.value = [...this.stack.value.slice(0, -1), route];
    this.sync();
  }

  /** Pops one level; false at the root, where the caller (or the BackButton) may close the app. */
  back(): boolean {
    if (this.stack.value.length <= 1) return false;
    this.stack.value = this.stack.value.slice(0, -1);
    this.sync();
    return true;
  }

  private sync(): void {
    const depth = this.stack.value.length;
    const visible = depth > 1 || (depth === 1 && this.options.closeWhenEmpty);
    this.tg.setBackButton(visible, () => {
      if (!this.back() && this.options.closeWhenEmpty) this.tg.close();
    });
  }
}
