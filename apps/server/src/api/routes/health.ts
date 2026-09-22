import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ApiContext } from '../context';

export function healthRoutes(ctx: ApiContext): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  app.get('/readyz', async (c) => {
    try {
      await ctx.deps.db.execute(sql`select 1`);
      return c.text('ok');
    } catch {
      return c.text('database unavailable', 503);
    }
  });
  app.get('/metrics', async (c) => {
    c.header('Content-Type', ctx.metrics.contentType);
    return c.body(await ctx.metrics.render());
  });
  return app;
}
