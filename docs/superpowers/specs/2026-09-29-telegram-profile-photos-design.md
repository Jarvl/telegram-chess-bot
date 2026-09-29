# Telegram profile photos

Status: accepted for planning, 2026-09-29. Replaces the coloured-initial-only avatar of the
[redesign spec](./2026-09-22-chess-goat-redesign-design.md) §3.1 with the player's own Telegram
profile photo, keeping the initial as the fallback. Amends PRD §7.12 (what is stored per user).

## Why

Players recognise each other by face in Telegram. The Mini App draws everyone as a coloured circle
with an initial, so two players in a game, on the leaderboard or in the opponent picker look like
strangers. Showing each person's Telegram photo makes the app feel like part of the group they
already know.

## Scope

- **In:** every person avatar in the Mini App — game player bars, game cards, challenge rows,
  leaderboard, player page, new-game picker, group settings (members and blocked users). They all
  render through the one `Avatar` component and receive players through the one `toPlayerRef`.
- **Out:** the share and result images. They are being reworked in a separate PR, which can read
  the photos this spec stores (see [Later](#later)). Group avatars (`GroupAvatar`) and the bot's
  Chess Goat mark (`BotMark`) are unchanged.

## Behaviour

- A player with a Telegram profile photo the bot can see is shown with that photo.
- A player without one — no photo, or one hidden from bots by their Telegram privacy setting —
  is shown exactly as today: the coloured circle with their initial.
- **Telegram's privacy setting is the only control.** There is no in-app toggle. Group members can
  already see each other's photos in Telegram, so the app exposes nothing new.
- While a photo loads, the initial shows. If it fails to load, the initial stays.
- A changed photo appears after the next refresh: at most about a day after the player next
  interacts with the bot, and then on the next screen load.
- The bot is always the Chess Goat mark. A deleted player is always the initial of
  "Deleted player".

## Storage

Photos are kept in PostgreSQL, the only store every process (web and jobs) shares. They are small:
Telegram's 160×160 JPEG is about 5–15 KB.

### `user_photos`

| Column | Type | Notes |
|---|---|---|
| `user_id` | bigint, primary key, references `users.id` | One row per user once checked. |
| `file_unique_id` | text, nullable | Telegram's stable id for the photo. |
| `hash` | text, nullable, indexed (not unique) | Lowercase hex SHA-256 of `bytes`. Two users can have byte-identical photos, so a unique index would fail the second one's fetch. |
| `bytes` | bytea, nullable | The 160×160 JPEG. |
| `checked_at` | timestamptz, not null | When Telegram was last asked. |

`file_unique_id`, `hash` and `bytes` are all set or all null. **All null means "checked, no
photo"**: the row still exists so the check is not repeated on every interaction.

### `users.photo_hash`

A nullable text column on `users`, equal to `user_photos.hash` for the current photo, null
otherwise. It exists so `toPlayerRef` can build a photo URL from the user row that every caller
(summaries, lobby, ratings, game DTO, members, admin) already selects, without joining
`user_photos` into six queries. The fetch job writes both in one transaction; they never disagree.

Both arrive in Drizzle migration `0006`.

## Fetching and refreshing

### When a fetch is queued

`ensureUser` already runs on app launch, button taps, commands, challenge mentions and member
updates. After its upsert it queues a `fetch_user_photo` job when:

- the user is not the engine user and not deleted, and
- the user has no `user_photos` row, or its `checked_at` is more than 24 hours old.

The job carries `{ userId }` and dedup key `photo:<userId>`, so a burst of taps queues one job.
The check is one primary-key read inside the caller's transaction.

### What the job does

`fetch_user_photo` is a new entry in `JOB_KINDS`, handled on the jobs worker:

1. Load the user. If it is deleted, the engine user, or has no Telegram id, finish without writing.
2. `getUserProfilePhotos(telegramUserId, { limit: 1 })`.
3. **No photo:** upsert the row with nulls and `checked_at = now()`; set `users.photo_hash` to
   null. Done.
4. **Same photo:** the smallest size's `file_unique_id` equals the stored one. Bump `checked_at`
   only. Done — no download.
5. **New photo:** `getFile` on the smallest size (160×160), then download it from the Bot API's
   file endpoint, under `TELEGRAM_API_ROOT` when set. Accept it only if it is under 64 KB and
   starts with the JPEG magic bytes `FF D8 FF`; otherwise fail the attempt and keep the old photo.
6. In one transaction: re-check the user is not deleted; upsert `user_photos` with the new
   `file_unique_id`, `hash`, `bytes` and `checked_at`; set `users.photo_hash` to the new hash.

### Errors

- **429:** retried through the existing `call` helper's backoff, like other Telegram jobs.
- **400** (user not found, and similar): treated as "no photo" — step 3.
- **Anything else** (network, 5xx, a rejected download): the job's normal attempt-and-backoff. The
  previous photo, if any, stays in place.

A failed attempt leaves `checked_at` alone, so a user whose fetch keeps failing is queued again on
their next interaction once the failed job is finished; the dedup key stops a second job while one
is pending.

The bot token appears only in the server's own request to the file endpoint. It is never stored,
logged or sent to a client.

## Serving

### `GET /api/avatars/:hash.jpg`

- Registered in the `/api` app **before** `requireSession`, beside the launch routes: an `<img>`
  cannot send the bearer token. Staying under `/api` means the Vite dev proxy and the deployed
  routing already cover it.
- `:hash` must be 64 lowercase hex characters; anything else is 404.
- Looks up `user_photos.bytes` by `hash`. Missing is 404.
- Responds `200` with `Content-Type: image/jpeg` and
  `Cache-Control: public, max-age=31536000, immutable`. The URL changes whenever the photo does, so
  a year-long cache is safe. The global `X-Content-Type-Options: nosniff` already applies.
- No session means no per-user rate limit. The hash cannot be guessed, and the lookup is an indexed
  read; any row with the hash will do, since the bytes are identical.
- The Mini App's CSP already allows `img-src 'self'`; it does not change.

### `PlayerRef.photoUrl`

`PlayerRefSchema` gains `photoUrl: z.string().nullable()`. `toPlayerRef` sets it to
`/api/avatars/<photo_hash>.jpg`, or null when `photo_hash` is null, the user is the engine, or the
user is deleted. Every DTO that embeds a `PlayerRef` (game, summaries, lobby, leaderboard,
members, admin) carries it with no per-route work.

## Mini App

`Avatar` keeps the coloured-initial span exactly as it is. When `player.photoUrl` is set and the
player is not the bot, an `<img>` fills the circle on top of the initial:

- `src={photoUrl}`, `alt=""` (the name is always shown beside it), `loading="lazy"`,
  `decoding="async"`, `width`/`height` equal to the size.
- The initial shows underneath while the image loads, so the circle is never empty.
- `onError` hides the image for the life of that element and leaves the initial. No retry.
- Styled as `.avatar .photo`: absolutely positioned, `inset: 0`, `border-radius: 50%`,
  `object-fit: cover`. The existing colour ring on player bars and the dimming on finished game
  cards apply unchanged.

`BotMark` and `GroupAvatar` do not change.

## Delete my data

`deleteMyData`, in its existing transaction, deletes the user's `user_photos` row and sets
`users.photo_hash` to null alongside the rest of the anonymisation. The job's re-check in step 6
means a fetch already running cannot bring the photo back. The old avatar URL returns 404 from then
on; a copy already in a client's HTTP cache may linger until that cache evicts it.

PRD §7.12's list of what is stored per user gains "profile photo (a small copy, refreshed at most
daily)".

## Testing

Red–green at each layer, on the existing harnesses.

**Server integration** (real PostgreSQL and `FakeTelegram`). The fake learns `getUserProfilePhotos`
and `getFile`, and serves `/file/bot<token>/<path>` with a small fixture JPEG. Cases:

- The first interaction queues exactly one `fetch_user_photo`; more interactions within 24 hours
  queue none; one after 24 hours queues another. The engine user and deleted users are never
  queued.
- A fetch stores `bytes`, `hash`, `file_unique_id` and `users.photo_hash`.
- An empty photo list writes the all-null row and a null `photo_hash`, and never calls `getFile`.
- A matching `file_unique_id` bumps `checked_at` and never calls `getFile`.
- A new `file_unique_id` replaces the bytes and the hash.
- A non-JPEG or oversized download is refused and the old photo is kept. A 429 is retried. A 400
  counts as no photo.
- Delete my data removes the row and the hash. A job queued before the deletion writes nothing.
- The route returns the bytes with `image/jpeg` and the immutable header, without a session. An
  unknown or malformed hash is 404.
- A game DTO and a leaderboard entry carry `photoUrl` for a player with a photo, and null for the
  bot and for a deleted player.

**Shared unit:** `PlayerRefSchema` accepts a string or null `photoUrl`, and rejects its absence.

**Mini App unit** (`avatar.test.tsx`, happy-dom):

- With `photoUrl`, the image renders over the initial.
- An `error` event hides the image and leaves the initial.
- Without `photoUrl`, the output matches today's.
- The bot shows the mark even when a `photoUrl` is present.

Test fixtures that build a `PlayerRef` gain `photoUrl: null`.

**End-to-end:** one assertion in `screens.spec.ts` that the game screen's player bar shows an
`<img>` for a seeded player with a photo, proving the chain from the database through the route to
the rendered avatar.

`docs/testing.md` counts are updated.

## Later

The share and result image rework can embed a player's photo by reading `user_photos.bytes`
through `users.photo_hash` and passing it to Satori as a data URI. The snapshot cache already keys
on the rendered SVG, so a new photo becomes a new cached image with no cache changes. If it needs
more than 160×160, the fetch job can store a larger size too; that is for that PR to decide.
