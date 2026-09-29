# Telegram Profile Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each player's Telegram profile photo in every person avatar of the Mini App, with the coloured initial as the fallback.

**Architecture:** A `fetch_user_photo` job, queued from `ensureUser` at most daily, pulls the 160×160 JPEG through the Bot API into a `user_photos` table and mirrors its hash onto `users.photo_hash`. `toPlayerRef` turns that hash into `PlayerRef.photoUrl` (`/api/avatars/<hash>.jpg`), served without a session with an immutable cache header. `Avatar` layers the photo over the existing initial.

**Tech Stack:** TypeScript, Drizzle ORM on PostgreSQL (postgres.js), grammY `Api`, Hono, zod, Preact, Vitest (happy-dom for the Mini App), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-telegram-profile-photos-design.md`

## Global Constraints

- Photo refresh interval: 24 hours (`checked_at` older than 86 400 s queues a fetch).
- Size fetched: the smallest `PhotoSize` of the newest photo (Telegram's 160×160).
- Accept a download only if it is under 64 KB (`65_536` bytes) and starts with `FF D8 FF`.
- Hash: lowercase hex SHA-256 of the bytes, 64 characters.
- Avatar URL: `/api/avatars/<hash>.jpg`; response `Content-Type: image/jpeg`, `Cache-Control: public, max-age=31536000, immutable`.
- Job kind `fetch_user_photo`, payload `{ userId: number }`, dedup key `photo:<userId>`.
- `photoUrl` is null for the engine user and for deleted users, always.
- No in-app photo toggle; Telegram's privacy setting is the only control.
- The bot token never appears in a stored value, a log line or a response.
- The share and result images (`apps/server/src/images/*`, `jobs/handlers/sharePhoto.ts`) are not touched.
- `user_photos.hash` is indexed, **not unique** (spec, as amended with this plan): two users can have byte-identical photos. The route serves any row with that hash.

## Review Focus

1. A user who **removes** their photo after having one — expect the row to go all-null, `photo_hash` null, and the old URL to 404 (Task 3 test `clears a photo the user removed`).
2. Two users with **byte-identical** photos — expect both stored and both served (Task 1 test `stores the same bytes for two users`).
3. The **file download itself fails** (the file endpoint answers 404/500) after `getFile` succeeded — expect the attempt to count and the old photo to stay (Task 3 test `keeps the old photo when the download fails`).
4. An avatar whose image errored and then receives a **new `photoUrl`** on re-render — expect the new photo to show, not stay hidden (Task 6 test `shows a new photo after an earlier one failed`).
5. Existing integration tests that **count every pending job** now see extra `fetch_user_photo` rows from `ensureUser` — expect those assertions to filter by kind, never to disable the queueing (Task 4 Step 5).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/db/schema.ts` (modify) | `bytea` custom type, `userPhotos` table, `users.photoHash`. |
| `apps/server/drizzle/0006_*.sql` (generated) | Migration for the above. |
| `apps/server/src/domain/photos.ts` (create) | All reads and writes of photo state; the refresh rule; `avatarUrl`. |
| `apps/server/src/jobs/handlers/userPhoto.ts` (create) | The `fetch_user_photo` handler and the file download. |
| `apps/server/src/api/routes/avatars.ts` (create) | `GET /avatars/:file`. |
| `apps/server/src/domain/players.ts` (modify) | `photoUrl` on `toPlayerRef`. |
| `apps/server/src/domain/users.ts`, `domain/account.ts` (modify) | Queue on `ensureUser`; wipe on Delete my data. |
| `packages/shared/src/protocol/dto.ts` (modify) | `PlayerRefSchema.photoUrl`. |
| `apps/miniapp/src/ui/Avatar.tsx`, `styles.css` (modify) | Photo over the initial. |
| `apps/server/test/helpers/fakeTelegram.ts` (modify) | `getUserProfilePhotos`, `getFile`, file download. |
| `apps/server/test/fixtures/avatar.jpg` (create) + `test/helpers/photos.ts` (create) | A real, tiny JPEG and its loader. |

---

### Task 1: Photo storage — schema, migration, domain functions

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0006_<generated>.sql` (+ `meta/` snapshot and journal, generated)
- Create: `apps/server/src/domain/photos.ts`
- Create: `apps/server/test/fixtures/avatar.jpg`, `apps/server/test/helpers/photos.ts`
- Test: `apps/server/test/integration/photos.test.ts`

**Interfaces:**
- Produces (schema): `userPhotos` table with columns `userId` (bigint number, PK, references `users.id`), `fileUniqueId: text | null`, `hash: text | null` (plain index `user_photos_hash`), `bytes: Buffer | null` (bytea), `checkedAt: timestamptz not null default now()`; `UserPhotoRow` type; `users.photoHash: text | null`.
- Produces (`domain/photos.ts`):
  - `PHOTO_REFRESH_SECONDS = 86_400`
  - `photoHash(bytes: Buffer): string`
  - `avatarUrl(hash: string): string` → `` `/api/avatars/${hash}.jpg` ``
  - `getPhotoRow(tx: DbOrTx, userId: number): Promise<UserPhotoRow | null>`
  - `storePhoto(tx: DbOrTx, userId: number, photo: { fileUniqueId: string; bytes: Buffer } | null): Promise<void>` — upserts the row (all-null when `photo` is null), sets `checkedAt = now()`, and sets `users.photoHash` to the new hash or null, in the caller's transaction.
  - `touchPhoto(tx: DbOrTx, userId: number): Promise<void>` — bumps `checkedAt` only.
  - `deletePhoto(tx: DbOrTx, userId: number): Promise<void>` — deletes the row and nulls `users.photoHash`.
  - `getPhotoBytes(tx: DbOrTx, hash: string): Promise<Buffer | null>` — first row with that hash.
- Produces (test helper `test/helpers/photos.ts`): `FIXTURE_JPEG: Buffer` (read from `test/fixtures/avatar.jpg`), `OTHER_JPEG: Buffer` (the fixture with one extra byte appended after the end marker, so it hashes differently but still starts `FF D8 FF`).

- [ ] **Step 1: Create the fixture JPEG**

A real, decodable 16×16 JPEG under 2 KB, so the browser in the E2E task can render it. On macOS, one way: render any 16×16 PNG (for example with `@resvg/resvg-js` from a one-line SVG) and convert with `sips -s format jpeg in.png --out apps/server/test/fixtures/avatar.jpg`. Check: `xxd -l 3 apps/server/test/fixtures/avatar.jpg` prints `ffd8ff`.

- [ ] **Step 2: Write the failing tests** in `test/integration/photos.test.ts` (same `openTestDb`/`truncateAll` pattern as `share-photo.test.ts`):

```ts
it('stores a photo and mirrors its hash onto the user', async () => {
  const user = await insertUser(db);
  await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
  const row = await getPhotoRow(db, user.id);
  expect(row?.fileUniqueId).toBe('u-1');
  expect(row?.hash).toBe(photoHash(FIXTURE_JPEG));
  expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(Buffer.compare(row!.bytes!, FIXTURE_JPEG)).toBe(0);
  expect((await requireUser(db, user.id)).photoHash).toBe(row?.hash);
});
it('records "no photo" as an all-null row and a null hash', async () => { /* storePhoto(db, id, null) after a real one → fileUniqueId, hash, bytes null; users.photoHash null; checkedAt set */ });
it('stores the same bytes for two users', async () => { /* both storePhoto calls succeed; getPhotoBytes(hash) returns FIXTURE_JPEG */ });
it('touches checked_at without changing the photo', async () => { /* set checkedAt back 2 days via sql, touchPhoto, checkedAt > before, hash unchanged */ });
it('deletes the photo and clears the hash', async () => { /* deletePhoto → getPhotoRow null, users.photoHash null, getPhotoBytes(hash) null */ });
it('builds the avatar url from a hash', () => {
  expect(avatarUrl('a'.repeat(64))).toBe(`/api/avatars/${'a'.repeat(64)}.jpg`);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run apps/server/test/integration/photos.test.ts`
Expected: FAIL — `../../src/domain/photos` cannot be resolved.

- [ ] **Step 4: Add the schema.** drizzle-orm 0.45 has no `bytea` builder, so declare one beside `id`/`tz`:

```ts
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
```

Add `photoHash: text()` to `users`, and `userPhotos` as in Interfaces with `index('user_photos_hash').on(t.hash)`. Export `UserPhotoRow = typeof userPhotos.$inferSelect` beside the other row types. Add `userPhotos` to `truncateAll` in `test/helpers/db.ts` if it lists tables explicitly.

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @group-chess/server db:generate`
Expected: a new `apps/server/drizzle/0006_*.sql` containing `CREATE TABLE "user_photos"`, `"bytes" bytea`, `CREATE INDEX "user_photos_hash"` (not `UNIQUE`), and `ALTER TABLE "users" ADD COLUMN "photo_hash" text`. Rename the file to `0006_user_photos.sql` and update its `tag` in `meta/_journal.json`, matching how `0005_game_result_photo.sql` is named.

- [ ] **Step 6: Implement `domain/photos.ts`** with the Interfaces signatures. `storePhoto` uses `insert … onConflictDoUpdate({ target: userPhotos.userId })`, then `update(users).set({ photoHash })`.

- [ ] **Step 7: Run to verify they pass**

Run: `pnpm vitest run apps/server/test/integration/photos.test.ts apps/server/test/integration/migrate-reset.test.ts apps/server/test/integration/db.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/src/domain/photos.ts apps/server/test
git commit -m "Store Telegram profile photos in user_photos"
```

---

### Task 2: `PlayerRef.photoUrl`

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts` (`PlayerRefSchema`)
- Modify: `apps/server/src/domain/players.ts`
- Modify: every `PlayerRef` literal in tests: `packages/shared/test/protocol/dto.test.ts`, `apps/server/test/integration/api-games.test.ts`, `api-auth.test.ts`, `apps/miniapp/test/support/gameFixtures.ts`, `summaryFixtures.ts`, and `yourMove`, `avatar`, `stream`, `groupSettings`, `newGame`, `gameCard`, `pill`, `game` tests under `apps/miniapp/test/`
- Test: `packages/shared/test/protocol/dto.test.ts`, `apps/server/test/unit/players.test.ts` (create), `apps/server/test/integration/api-games.test.ts`

**Interfaces:**
- Consumes: `avatarUrl(hash)` from Task 1; `users.photoHash`.
- Produces: `PlayerRef.photoUrl: string | null` (required key); `toPlayerRef(user: Pick<UserRow, 'id' | 'firstName' | 'username' | 'deletedAt' | 'isEngine' | 'photoHash'>, rating)`.

- [ ] **Step 1: Write the failing tests**

In `dto.test.ts`: `PlayerRefSchema` parses a ref with `photoUrl: '/api/avatars/<64 hex>.jpg'` and with `photoUrl: null`, and **rejects** one without the key.

New unit test `apps/server/test/unit/players.test.ts` for `toPlayerRef`, with `HASH = 'a'.repeat(64)`:
- a user with `photoHash: HASH` → `photoUrl` `/api/avatars/${HASH}.jpg`;
- `photoHash: null` → null;
- `isEngine: true, photoHash: HASH` → null;
- `deletedAt: new Date(), photoHash: HASH` → null.

In `api-games.test.ts`, test `carries each player's photo url`: `storePhoto` for white; `GET` the game; `white.photoUrl` equals `avatarUrl(photoHash(FIXTURE_JPEG))`, `black.photoUrl` is null. This proves the column reaches the DTO through a real query; `toPlayerRef` is the single builder for every other DTO.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/shared/test/protocol/dto.test.ts apps/server/test/unit/players.test.ts apps/server/test/integration/api-games.test.ts`
Expected: FAIL — `photoUrl` missing from the parsed objects.

- [ ] **Step 3: Implement.** `photoUrl: z.string().nullable()` in `PlayerRefSchema`, with a doc comment ("The player's Telegram photo on this server; null without one, and always for the bot and deleted players."). In `toPlayerRef`: `photoUrl: user.photoHash && !user.isEngine && !user.deletedAt ? avatarUrl(user.photoHash) : null`.

- [ ] **Step 4: Fix the fallout.** Run `pnpm typecheck`. Every caller that selects partial user columns fails on the new `Pick` key: add `photoHash` to that select. Every test literal fails on the missing key: add `photoUrl: null`.

- [ ] **Step 5: Run to verify**

Run: `pnpm typecheck && pnpm vitest run packages/shared apps/server/test/integration/api-games.test.ts apps/miniapp`
Expected: typecheck clean; all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared apps/server/src/domain apps/server/test apps/miniapp/test
git commit -m "Carry each player's photo url on PlayerRef"
```

---

### Task 3: The `fetch_user_photo` job

**Files:**
- Create: `apps/server/src/jobs/handlers/userPhoto.ts`
- Modify: `apps/server/src/jobs/types.ts` (`JOB_KINDS`), `apps/server/src/jobs/handlers/index.ts`, `apps/server/src/main.ts` (worker handlers)
- Modify: `apps/server/test/helpers/fakeTelegram.ts`
- Test: `apps/server/test/integration/user-photo.test.ts`

**Interfaces:**
- Consumes: `storePhoto`, `touchPhoto`, `getPhotoRow` (Task 1); `TelegramHandlerContext` from `jobs/handlers/telegram.ts`.
- Produces: `userPhotoJobHandlers(ctx: TelegramHandlerContext): JobHandlers` with `fetch_user_photo`; `MAX_PHOTO_BYTES = 65_536`; `downloadTelegramFile(config: Pick<Config, 'BOT_TOKEN' | 'TELEGRAM_API_ROOT'>, filePath: string): Promise<Buffer>` — GETs `${TELEGRAM_API_ROOT ?? 'https://api.telegram.org'}/file/bot${BOT_TOKEN}/${filePath}`, throws on a non-2xx status. Error messages name the status, never the URL.
- Produces (fake): `fake.photos: Map<number, { fileUniqueId: string; bytes: Buffer }>` keyed by Telegram user id (cleared by `reset()`); `fake.fileStatus: number | null` (when set, the file download answers that status); `fake.onFile: (() => Promise<unknown>) | null` (awaited before a download is answered); file downloads are recorded as calls with `method: 'file'`. `reset()` clears all three.

- [ ] **Step 1: Teach the fake.**
  - `getUserProfilePhotos`: for a user in `photos`, `{ total_count: 1, photos: [[{ file_id: 'small-<id>', file_unique_id: <fileUniqueId>, width: 160, height: 160 }, { file_id: 'big-<id>', file_unique_id: '<fileUniqueId>-big', width: 640, height: 640 }]] }`; otherwise `{ total_count: 0, photos: [] }`.
  - `getFile`: `{ file_id, file_unique_id: 'f', file_size, file_path: 'photos/<id>.jpg' }`, with `<id>` taken from the `file_id`.
  - Before the JSON handling: a `GET` whose URL contains `/file/bot` is recorded as `{ method: 'file', body: { path }, multipart: false }` and answered with the `photos` bytes for that id (`content-type: image/jpeg`), or `fileStatus`, or 404.

- [ ] **Step 2: Write the failing tests** in `user-photo.test.ts`, with a `JobWorker` built from `userPhotoJobHandlers` (pattern: `share-photo.test.ts` `beforeAll`). A helper `fetchFor(user)` enqueues `{ kind: 'fetch_user_photo', payload: { userId: user.id } }` and calls `worker.runOnce()`.
  - `stores the newest photo's small size` — `fake.photos.set(tg, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG })` → row has `fileUniqueId: 'u-1'`, bytes equal the fixture; `getFile` called with `file_id: 'small-<tg>'`.
  - `records no photo without downloading` — empty → all-null row, `users.photoHash` null, `fake.callsTo('getFile')` empty.
  - `only touches checked_at when the photo is unchanged` — store `u-1`, age `checkedAt` 2 days, fetch again → `getFile` not called, `checkedAt` newer, hash same.
  - `replaces a changed photo` — second fetch with `{ fileUniqueId: 'u-2', bytes: OTHER_JPEG }` → hash is `photoHash(OTHER_JPEG)`.
  - `clears a photo the user removed` — had `u-1`, now absent → all-null row, `photoHash` null, `getPhotoBytes(oldHash)` null.
  - `refuses a download that is not a JPEG` — bytes `Buffer.from('<svg/>')` → job not done (`attempts` 1, `lastError` set), old photo kept.
  - `refuses a download of 64 KB or more` — `Buffer.concat([FIXTURE_JPEG, Buffer.alloc(65_536)])` → same as above.
  - `keeps the old photo when the download fails` — `fake.fileStatus = 500` → attempt counted, old photo kept.
  - `waits out a 429` — `fake.failNext('getUserProfilePhotos', { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } })` → job pending, `attempts` 0, `runAt` about 3 s ahead.
  - `treats a 400 as no photo` — `failNext('getUserProfilePhotos', { error_code: 400, description: 'Bad Request: user not found' })` → all-null row, job done.
  - `writes nothing for a deleted user` — `deletedAt` set before the run → no row, no Bot API call.
  - `writes nothing if the user is deleted while the photo downloads` — set `fake.onFile = () => db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.id))` → after the run, no `user_photos` row and `photoHash` null.
  - `never logs the bot token` — capture `deps.log` output across the 500 case; it does not contain `testConfig().BOT_TOKEN`.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run apps/server/test/integration/user-photo.test.ts`
Expected: FAIL — `userPhotoJobHandlers` not exported.

- [ ] **Step 4: Implement the handler** in the order spec §"What the job does" gives: load the user (no Telegram id, `isEngine` or `deletedAt` → done); `ctx.api.getUserProfilePhotos(tgId, { limit: 1 })`; smallest size is `photos[0]?.[0]`. Catch `GrammyError` yourself rather than going through `call`, because the outcome needs the status code: `429` → `{ outcome: 'retry', delayMs: retry_after * 1000 }`; `400` → `storePhoto(null)`; anything else rethrows (normal attempt and backoff). Validate the download (length `< MAX_PHOTO_BYTES`, first three bytes `FF D8 FF`) and throw `Error('photo download rejected: …')` otherwise. Do the final write in `ctx.deps.db.transaction`, re-reading the user `for('update')` and skipping the write when `deletedAt` is set. Add `'fetch_user_photo'` to `JOB_KINDS`, export from `handlers/index.ts`, and spread `...userPhotoJobHandlers({ deps, api, config })` into the worker's handlers in `main.ts`.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run apps/server/test/integration/user-photo.test.ts apps/server/test/integration/jobs.test.ts apps/server/test/integration/main.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/jobs apps/server/src/main.ts apps/server/test
git commit -m "Fetch Telegram profile photos in a background job"
```

---

### Task 4: Queue refreshes from `ensureUser`

**Files:**
- Modify: `apps/server/src/domain/photos.ts`, `apps/server/src/domain/users.ts`
- Test: `apps/server/test/integration/users-groups.test.ts` (where `ensureUser` is already tested)

**Interfaces:**
- Consumes: `getPhotoRow`, `PHOTO_REFRESH_SECONDS` (Task 1); `enqueue`.
- Produces: `queuePhotoRefresh(tx: DbOrTx, user: Pick<UserRow, 'id' | 'isEngine' | 'deletedAt'>): Promise<void>` in `domain/photos.ts` — enqueues `fetch_user_photo` with dedup key `photo:<id>` when the user is neither the engine nor deleted and has no row or a row older than `PHOTO_REFRESH_SECONDS`. `ensureUser` calls it after its upsert.

- [ ] **Step 1: Write the failing tests** (`describe('photo refresh')`), counting only `jobs` rows with `kind = 'fetch_user_photo'`:
  - `queues one fetch for a new user, however often they are seen` — `ensureUser` three times → exactly one pending job, payload `{ userId }`, `dedupKey: 'photo:<id>'`.
  - `queues nothing within a day of the last check` — `storePhoto(null)`, then `ensureUser` → none pending.
  - `queues again after a day` — `storePhoto(null)`, age `checkedAt` by 25 h, `ensureUser` → one pending.
  - `never queues the engine user` — `queuePhotoRefresh` on an `isEngine` row → none.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/server/test/integration/users-groups.test.ts`
Expected: FAIL — no `fetch_user_photo` jobs.

- [ ] **Step 3: Implement** `queuePhotoRefresh` and call it at the end of `ensureUser`.

- [ ] **Step 4: Run the whole server suite**

Run: `pnpm vitest run apps/server`
Expected: the new tests PASS. Some existing tests may now fail because they assert on *all* pending jobs or on the exact job list.

- [ ] **Step 5: Fix only the assertions.** In each failing test, narrow the job query or expectation to the kinds that test is about (for example `where(eq(jobs.kind, 'send_dm'))`). Do not skip `queuePhotoRefresh` in tests or add a flag to disable it. Re-run `pnpm vitest run apps/server`; expected all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain apps/server/test
git commit -m "Refresh a user's photo at most daily when the bot sees them"
```

---

### Task 5: The avatar route and Delete my data

**Files:**
- Create: `apps/server/src/api/routes/avatars.ts`
- Modify: `apps/server/src/api/app.ts` (register before `requireSession`), `apps/server/src/domain/account.ts`, `docs/PRD.md` §7.12
- Test: `apps/server/test/integration/api-avatars.test.ts`, and the existing Delete my data test (in `users-groups.test.ts` or `api-auth.test.ts`, wherever `deleteMyData` is asserted)

**Interfaces:**
- Consumes: `getPhotoBytes`, `deletePhoto` (Task 1).
- Produces: `avatarRoutes(ctx: ApiContext): Hono<ApiEnv>` exposing `GET /avatars/:file`. It accepts only `file` matching `/^([0-9a-f]{64})\.jpg$/` (any other name → `DomainError('not_found')`), and answers `c.body(bytes, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' })`.

- [ ] **Step 1: Write the failing tests** in `api-avatars.test.ts` (use `startTestApi`):
  - `serves a stored photo without a session` — `request('GET', '/api/avatars/<hash>.jpg')` with no token → 200, `content-type` `image/jpeg`, `cache-control` `public, max-age=31536000, immutable`, `x-content-type-options` `nosniff`, body equals `FIXTURE_JPEG`.
  - `404s an unknown hash` — 64 zeros → 404.
  - `404s a malformed name` — `'ABC.jpg'`, `'<hash>.png'`, `'<hash>'`, `'<HASH-uppercased>.jpg'` → each 404.

  In the Delete my data test, add `removes the photo`: `storePhoto`, `deleteMyData` → `getPhotoRow` null, `photoHash` null, and `GET /api/avatars/<hash>.jpg` → 404.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/server/test/integration/api-avatars.test.ts`
Expected: FAIL — 401 (the route does not exist, so the session middleware answers).

- [ ] **Step 3: Implement** `avatarRoutes`, and mount it in `createApiApp` with `api.route('/', avatarRoutes(ctx))` directly after `api.route('/', launchRoutes(ctx))`. In `deleteMyData`'s transaction, call `deletePhoto(tx, userId)` beside the `users` update. In PRD §7.12, add "profile photo (a small copy, refreshed at most daily)" to the list of what is stored per user.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run apps/server/test/integration/api-avatars.test.ts apps/server/test/integration/api-auth.test.ts apps/server/test/integration/users-groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api apps/server/src/domain/account.ts apps/server/test docs/PRD.md
git commit -m "Serve avatars from /api/avatars and remove them on Delete my data"
```

---

### Task 6: Photo in the Mini App `Avatar`

**Files:**
- Modify: `apps/miniapp/src/ui/Avatar.tsx`, `apps/miniapp/src/styles.css`
- Test: `apps/miniapp/test/avatar.test.tsx`

**Interfaces:**
- Consumes: `PlayerRef.photoUrl` (Task 2).
- Produces: `Avatar(props: { player: Pick<PlayerRef, 'id' | 'name' | 'isBot' | 'photoUrl'>; size: Size })`. Markup: the existing `span.avatar` (initial and background unchanged) containing, when `photoUrl` is set and the image has not errored, `<img class="photo" src={photoUrl} alt="" loading="lazy" decoding="async" width={size} height={size}>`.

- [ ] **Step 1: Write the failing tests**
  - `lays the photo over the initial` — `photoUrl: '/api/avatars/x.jpg'` → `span.avatar img.photo` has that `src` and `alt=""`; the span's text is still the initial.
  - `falls back to the initial when the photo fails` — dispatch `new Event('error')` on the img → no `img.photo`; the initial remains.
  - `shows a new photo after an earlier one failed` — error on `/a.jpg`, re-render with `/b.jpg` → `img.photo` with `src` `/b.jpg`.
  - `draws exactly today's avatar without a photo` — `photoUrl: null` → no `img`; same text and background as before.
  - `keeps the bot's mark even with a photo url` — `isBot: true, photoUrl: '/x.jpg'` → `img.avatar.bot` with the brand mark, no `img.photo`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/miniapp/test/avatar.test.tsx`
Expected: FAIL — no `img.photo`.

- [ ] **Step 3: Implement.** Keep the failure in state keyed by URL (for example `const [failed, setFailed] = useState<string | null>(null)`, and render the img when `photoUrl && failed !== photoUrl`), so a new URL resets it. Callers that pass a narrower `Pick` get a type error; they all pass full `PlayerRef`s today, so nothing else should change. CSS: `.avatar { position: relative; overflow: hidden; }` and `.avatar .photo { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run apps/miniapp && pnpm typecheck && pnpm build && pnpm check:budget`
Expected: all PASS; the bundle stays inside its budget.

- [ ] **Step 5: Commit**

```bash
git add apps/miniapp
git commit -m "Show players' Telegram photos in the Mini App avatar"
```

---

### Task 7: End-to-end check and docs

**Files:**
- Modify: `apps/server/test/e2e/harness.ts` (`SeedRequest` gains `alicePhoto?: boolean`), `apps/miniapp/e2e/support.ts` (`seed` options gain `alicePhoto?: boolean`), `apps/miniapp/e2e/screens.spec.ts`
- Modify: `docs/testing.md` (counts)

**Interfaces:**
- Consumes: `storePhoto` (Task 1), `FIXTURE_JPEG` (Task 1 helper).

- [ ] **Step 1: Write the failing test** in `screens.spec.ts`: `shows a player's Telegram photo on the game screen` — `seed('opening', {}, { alicePhoto: true })`, open the game as Bob, then `await expect(page.locator('.player-bar[data-colour="white"] img.photo')).toBeVisible()` and assert the image decoded (`naturalWidth > 0` via `evaluate`). Also assert Bob's bar (`data-colour="black"`) has no `img.photo`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm e2e -- screens.spec.ts`
Expected: FAIL — no `img.photo`.

- [ ] **Step 3: Implement.** When `alicePhoto` is set, the harness calls `storePhoto(db, alice, { fileUniqueId: 'e2e', bytes: FIXTURE_JPEG })` after inserting the users. That row's `checkedAt` is now, so Alice's own launch does not queue a fetch that would overwrite it; also set `fake.photos` for Alice to the same bytes so any fetch agrees.

- [ ] **Step 4: Run to verify**

Run: `pnpm e2e`
Expected: all specs PASS, including the existing screen-width checks.

- [ ] **Step 5: Docs.** Update the counts in `docs/testing.md`'s "What runs where" table from the output of `pnpm test` and `pnpm e2e`.

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all clean and PASS (with `TEST_DATABASE_URL` set, so the integration projects run).

- [ ] **Step 7: Commit**

```bash
git add apps/server/test/e2e apps/miniapp/e2e docs
git commit -m "E2E check for profile photos; update testing counts"
```
