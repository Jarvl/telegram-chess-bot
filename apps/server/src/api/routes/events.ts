import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { DomainError } from '../../domain/errors';
import { getGameDto, requireGameByPublicId } from '../../domain/games';
import { requireGameAccess } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';

const PING_MS = 20_000;

/** Spec §6.4/§9: `state` snapshots keyed by version, `ping` every 20 s, token in the query string. */
export function eventsRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  api.get('/games/:id/events', async (c) => {
    const user = c.get('user');
    const publicId = publicIdParam(c, 'id');
    const game = await requireGameByPublicId(ctx.deps.db, publicId);
    await requireGameAccess(ctx, game, user);
    if (!ctx.streams.acquire(user.id))
      throw new DomainError('rate_limited', 'too many open streams', { reason: 'streams' });
    const lastEventId = Number(c.req.header('last-event-id') ?? Number.NaN);
    c.header('X-Accel-Buffering', 'no');
    ctx.metrics.sseStreams.inc();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ctx.streams.release(user.id);
      ctx.metrics.sseStreams.dec();
    };
    return streamSSE(
      c,
      async (stream) => {
        let chain = Promise.resolve();
        const send = () => {
          chain = chain
            .then(async () => {
              const dto = await getGameDto(ctx.deps, { gameId: publicId, viewerUserId: user.id });
              await stream.writeSSE({
                event: 'state',
                id: String(dto.version),
                data: JSON.stringify(dto),
              });
            })
            .catch(() => undefined);
          return chain;
        };
        if (!Number.isFinite(lastEventId) || lastEventId < game.version) await send();
        const unsubscribe = ctx.deps.bus.subscribe(publicId, () => void send());
        const ping = setInterval(
          () => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined),
          PING_MS,
        );
        // Hono links the request signal to the stream only on old Bun; link it here too, so a
        // dropped connection releases the slot whether the runtime cancels the body or the signal.
        const onSignalAbort = () => void stream.abort();
        c.req.raw.signal.addEventListener('abort', onSignalAbort, { once: true });
        await new Promise<void>((resolve) => stream.onAbort(resolve));
        c.req.raw.signal.removeEventListener('abort', onSignalAbort);
        clearInterval(ping);
        unsubscribe();
        release();
      },
      async () => {
        release();
      },
    );
  });
}
