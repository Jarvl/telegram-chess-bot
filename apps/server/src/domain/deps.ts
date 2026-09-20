import type { Bus } from '../bus/bus';
import type { Db } from '../db/client';
import type { Logger } from '../logger';

export type Deps = { db: Db; bus: Bus; log: Logger };
