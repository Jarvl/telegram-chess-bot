import { readFileSync } from 'node:fs';

/** A real 16×16 JPEG, so a browser can decode it too (the E2E harness serves it). */
export const FIXTURE_JPEG: Buffer = readFileSync(
  new URL('../fixtures/avatar.jpg', import.meta.url),
);

/** Still a JPEG by its magic bytes, but one byte longer, so it hashes differently. */
export const OTHER_JPEG: Buffer = Buffer.concat([FIXTURE_JPEG, Buffer.from([0])]);
