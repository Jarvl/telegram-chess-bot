import type { LaunchRoute } from '@group-chess/shared';
import { launch } from './api/launch';
import type { Route } from './router';
import { applyLaunch } from './state/session';
import { applyTheme } from './tg/theme';
import type { AppContextValue, Prefetched } from './ui/context';

/**
 * Maps the launch route to a screen stack and parks its data for that screen's first render.
 * A deep link lands on the screen it names but carries the screens above it, so the BackButton
 * walks up to the group's games and then to the group list instead of dead-ending.
 */
export function routeFor(route: LaunchRoute, prefetched: Prefetched): Route[] {
  switch (route.kind) {
    case 'game':
      prefetched.game = route.game;
      return [
        { name: 'groups' },
        { name: 'lobby', groupId: route.game.group.id },
        { name: 'game', gameId: route.game.id },
      ];
    case 'lobby':
      prefetched.lobby = route.lobby;
      return [{ name: 'groups' }, { name: 'lobby', groupId: route.lobby.group.id }];
    case 'settings':
      prefetched.settings = route.settings;
      return [
        { name: 'groups' },
        { name: 'lobby', groupId: route.settings.group.id },
        { name: 'groupSettings', groupId: route.settings.group.id },
      ];
    case 'groups':
      prefetched.groups = route.groups;
      return [{ name: 'groups' }];
    // A group the viewer cannot enter: there is no lobby to seed underneath it.
    case 'locked':
      return [{ name: 'locked', group: route.group }];
  }
}

/** Spec §6.1 steps 1–4: prepare the client, launch once, land, then ask for write access. */
export async function boot(app: AppContextValue): Promise<void> {
  const { tg, client, router, prefetched } = app;
  applyTheme(tg);
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes();
  tg.onThemeChanged(() => applyTheme(tg));
  tg.onViewportChanged(() => applyTheme(tg));

  const outcome = await launch(client, tg.initData);
  if (outcome.kind === 'expired') {
    router.reset({ name: 'reopen' });
    return;
  }
  if (outcome.kind === 'failed') {
    router.reset({ name: 'error' });
    return;
  }
  applyLaunch(outcome.response, tg.startParam);
  router.reset(routeFor(outcome.response.route, prefetched));

  if (outcome.response.askWriteAccess && tg.supports('writeAccess')) {
    setTimeout(() => {
      void tg.requestWriteAccess().then(async (granted) => {
        if (granted === null) return;
        await client
          .put('/api/me/prefs', { writeAccess: { allowed: granted } })
          .catch(() => undefined);
      });
    }, 0);
  }
}

/** The 401 path of spec §6.1 step 6: one relaunch with the original initData, or the reopen screen. */
export async function relaunch(app: AppContextValue): Promise<string | null> {
  const outcome = await launch(app.client, app.tg.initData);
  if (outcome.kind === 'ok') return outcome.response.token;
  app.router.reset({ name: 'reopen' });
  return null;
}
