import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const DEFAULT_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
const MIGRATION_LOCK = 72_648_101;

/**
 * Applies pending migrations under a session advisory lock so concurrent replicas serialise
 * (spec §4.4). A dedicated single connection keeps the lock and the migrator in one session.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = DEFAULT_FOLDER,
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const db = drizzle(client, { casing: 'snake_case' });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
