import type { RegisterRoutes } from '../app';
import { adminRoutes } from './admin';
import { challengeRoutes } from './challenges';
import { eventsRoutes } from './events';
import { gamesRoutes } from './games';
import { groupsRoutes } from './groups';

/** Everything behind a session besides the account routes. */
export const gameRoutes: RegisterRoutes[] = [
  groupsRoutes,
  challengeRoutes,
  gamesRoutes,
  eventsRoutes,
  adminRoutes,
];
