import type { GroupRef, LobbyDto } from '@group-chess/shared';
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { Tg } from './tg/webapp';

export type Route =
  | { name: 'loading' }
  | { name: 'error' }
  | { name: 'reopen' }
  | { name: 'locked'; group: GroupRef }
  | { name: 'games' }
  | { name: 'groups' }
  | { name: 'lobby'; groupId: string }
  | { name: 'leaderboard'; groupId: string }
  | { name: 'newGame'; groupId: string; defaults?: LobbyDto['settings'] }
  | { name: 'game'; gameId: string }
  | { name: 'player'; groupId: string; userId: string }
  | { name: 'settings' }
  | { name: 'groupSettings'; groupId: string };

/** The bottom bar's sections; each keeps its own back stack. */
export type TabName = 'games' | 'groups' | 'settings';

export const TABS: readonly TabName[] = ['games', 'groups', 'settings'];

const TAB_ROOT: Record<TabName, Route> = {
  games: { name: 'games' },
  groups: { name: 'groups' },
  settings: { name: 'settings' },
};

/** Screens with no tab bar: before a session, and New game, whose MainButton owns the bottom. */
const TABLESS: ReadonlySet<Route['name']> = new Set([
  'loading',
  'error',
  'reopen',
  'locked',
  'newGame',
]);

type Stacks = Record<TabName, Route[]>;

/**
 * A tabbed in-memory router (Telegram owns the URL fragment). Tabs carry lateral movement and
 * never deepen a stack; the BackButton carries depth only, so it stays a single tap from the
 * way out (nav spec, superseding technical design §6.1 step 5).
 *
 * `closeFromRoot` is set for a launch that came from a chat link: there the BackButton also
 * shows at the root, where it closes, so "back to the chat I came from" keeps costing one tap.
 */
export class Router {
  readonly tab: Signal<TabName> = signal('games');
  readonly stacks: Signal<Stacks> = signal({ games: [], groups: [], settings: [] });
  readonly stack: ReadonlySignal<Route[]>;
  readonly current: ReadonlySignal<Route>;
  readonly showTabs: ReadonlySignal<boolean>;

  constructor(
    private readonly tg: Tg,
    private readonly options: { closeFromRoot: boolean } = { closeFromRoot: false },
  ) {
    this.stack = computed(() => this.stacks.value[this.tab.value]);
    this.current = computed(() => this.stack.value.at(-1) ?? { name: 'loading' });
    this.showTabs = computed(() => !TABLESS.has(this.current.value.name));
    this.sync();
  }

  /** Where a launch lands: one screen in one tab, so back never becomes the way home. */
  land(tab: TabName, route: Route): void {
    this.tab.value = tab;
    this.write(tab, [route]);
  }

  /** A lateral move: another tab resumes where it was left, the active one returns to its root. */
  select(tab: TabName): void {
    const kept = this.stacks.value[tab];
    const next = tab === this.tab.value || kept.length === 0 ? [TAB_ROOT[tab]] : kept;
    this.tab.value = tab;
    this.write(tab, next);
  }

  push(route: Route): void {
    this.write(this.tab.value, [...this.stack.value, route]);
  }

  replace(route: Route): void {
    this.write(this.tab.value, [...this.stack.value.slice(0, -1), route]);
  }

  /** Pops one level within the active tab; false at its root, where the caller may close. */
  back(): boolean {
    if (this.stack.value.length <= 1) return false;
    this.write(this.tab.value, this.stack.value.slice(0, -1));
    return true;
  }

  private write(tab: TabName, stack: Route[]): void {
    this.stacks.value = { ...this.stacks.value, [tab]: stack };
    this.sync();
  }

  private sync(): void {
    const visible = this.stack.value.length > 1 || this.options.closeFromRoot;
    this.tg.setBackButton(visible, () => {
      if (!this.back()) this.tg.close();
    });
  }
}
