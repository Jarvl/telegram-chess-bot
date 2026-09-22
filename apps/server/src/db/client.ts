import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => undefined });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return { db, close: () => client.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/** The database's clock; inside a transaction this is the transaction start time. */
export async function dbNow(tx: DbOrTx): Promise<Date> {
  const rows = await tx.execute(sql`select extract(epoch from now()) * 1000 as ms`);
  return new Date(Number(rows[0]?.ms));
}
