import { Chess } from 'chess.js';
import { Hono } from 'hono';
import { DomainError } from '../../domain/errors';
import { IMAGE_SIZE, renderBoardJpeg, renderBoardSvg, THUMB_SIZE } from '../../images/board';
import { verifyBoardImage } from '../../images/signedUrl';
import type { ApiContext, ApiEnv } from '../context';

const WIDTH_BY_FILE: Record<string, number> = { 'board.jpg': IMAGE_SIZE, 'thumb.jpg': THUMB_SIZE };

/** Share-sheet photos, drawn on request from the signed URL (see `boardImagePath`). */
export function boardImageRoutes(ctx: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.get('/board-images/:payload/:signature/:file', (c) => {
    const width = WIDTH_BY_FILE[c.req.param('file')];
    const board = verifyBoardImage(
      ctx.config.SESSION_SECRET,
      c.req.param('payload'),
      c.req.param('signature'),
    );
    if (width === undefined || !board) throw new DomainError('not_found', 'unknown image');
    const svg = renderBoardSvg({ ...board, check: new Chess(board.fen).inCheck() });
    c.header('Content-Type', 'image/jpeg');
    // The URL names the image exactly, so it never changes.
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(new Uint8Array(renderBoardJpeg(svg, width)));
  });
  return app;
}
