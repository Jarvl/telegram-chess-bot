# Group Chess 03 — Server Telegram and API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Telegram and HTTP faces on the server core: the outbound Telegram client with pacing and error classification, the card renderer, the grammY bot (commands, callbacks, membership events) behind an idempotent webhook, the Telegram job handlers and the membership ladder, the Hono API (launch authentication, lobby, games, SSE, sharing, preferences, admin, delete-my-data, telemetry), board images for shared positions, the Lichess import, metrics and health, and `main.ts` with the four roles — so the whole server runs end to end against the Bot API.

**Architecture:** `telegram/` (grammY `Api` with the throttler, `classifyTelegramError`, deep links, pure card renderer, DB→view loaders, the membership ladder), `bot/` (grammY handlers that only translate updates into domain calls and jobs; a webhook route that records `update_id` first), `jobs/handlers/telegram.ts` + `lichess.ts` + `sharePhoto.ts` (every outbound message goes through the outbox), `api/` (Hono app: `initData` validation once per launch, HS256 session tokens, DomainError → status mapping, per-user rate limit, routes, SSE on the bus), `images/` (SVG board with vendored cburnett pieces, resvg to PNG, `file_id` cache), `metrics.ts`, `main.ts` (roles by `ROLES`). Nothing in plan 2's domain changes; this plan only calls it.

**Tech Stack:** grammY 1.46 + `@grammyjs/transformer-throttler`, Hono 4.13 + `@hono/node-server` + `@hono/zod-validator` + `hono/jwt` + `hono/streaming`, `@resvg/resvg-js` 2.6, prom-client 15, node:crypto for the `initData` HMAC; vitest integration tests with a fake Bot API HTTP server and the real PostgreSQL.

**Spec:** [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](../specs/2026-09-20-group-chess-technical-design.md) §4.3–§4.4, §5, §6.1, §7.6–§7.8, §9–§12, §14; parent plan [2026-09-20-group-chess.md](2026-09-20-group-chess.md); consumes plans 01 and 02.

## Global Constraints

- The bot never sends messages from an update handler; it writes rows and enqueues jobs. The two synchronous exceptions are `answerCallbackQuery` and the cached membership lookups `getChatMember` / `getChatAdministrators` (spec §4.3, §5.2).
- Webhook: reject a missing or wrong `X-Telegram-Bot-Api-Secret-Token` with 401; `update_id` goes into `telegram_updates` before any effect, a duplicate is acknowledged with 200 and no effects; a failed handler removes the row and returns 500 so Telegram retries; message text is never logged or stored (spec §5.2).
- Direct links only in groups: `https://t.me/<BOT_USERNAME>/<MINI_APP_SHORT_NAME>?startapp=<payload>`; callback data only for `ch/acc`, `ch/dec`, `gm/rem` (spec §5.3).
- Cards are rendered by a pure function from current state at send time and follow the §5.4 table word for word; the challenged player is mentioned once (`@username`, else a `text_mention` entity); provisional ratings carry `?`; `Rated` reads `Casual` for unrated games; "message is not modified" is success; "message to edit not found" sets `card_missing`; finished cards carry exactly `🔁 Rematch` and `🔍 Analyse on Lichess`; the analysis button is omitted while its URL exceeds 2,000 characters (plan 01 ruling).
- Commands: `/play` (reply → direct, else open), `/chess`, `/settings` in groups; `/start` in private; one-line replies only when a command cannot be fulfilled; `/chess` and `/settings` once per group per minute, excess ignored silently; commands with the bot's suffix are accepted, others ignored (spec §5.5).
- Membership ladder exactly as spec §5.6: players of a game always allowed; cached verdict younger than 10 minutes; `getChatMember` (member, administrator, creator, restricted with `is_member`); on failure the bot's own evidence in `group_members`; no evidence means locked. Admin check via `getChatAdministrators`, cached 60 s, on every settings read and write, void, block and unblock.
- DMs (spec §5.7): `dm_allowed` becomes true on `/start`, `write_access_allowed`, the app's prompt result and `allows_write_to_pm` in `initData`; false on 403 "bot was blocked by the user" / "user is deactivated". Turn DM `Your move vs {opponent} · {lastMove} · {timeLeft} left` with `♟ Open game` and `Go to group` (supergroups only); challenge DM; one reminder per turn; game-end DM to both players.
- Outbound pacing: the grammY throttler on one shared `Api`; a 429 reschedules the job at `now() + retry_after` (spec §5.8, §10, §11).
- API (spec §9, §12): `POST /api/launch` validates `initData` with Telegram's recipe (sorted `key=value` pairs joined with `\n`, HMAC-SHA256 keyed by HMAC-SHA256("WebAppData", BOT_TOKEN), constant-time comparison, `auth_date` at most 24 h old, `user` present) and issues an HS256 JWT (`sub`, `iat`, `exp` = 24 h) signed with `SESSION_SECRET`; every other route takes `Authorization: Bearer` (the SSE route takes `?token=`); errors are `{ "error": { "code", "message" } }` with plan 01's status map; bodies validated with the shared zod schemas, capped at 64 KB (webhook 1 MB); `Cache-Control: no-store`; 120 requests per user per minute; 4 open SSE streams per user.
- SSE (spec §6.4, §9): events `state` (full game DTO, `id` = version) and `ping` every 20 s; on connect a `state` is sent when the client's `Last-Event-ID` is older than the current version or absent; `X-Accel-Buffering: no`.
- Authorization matrix (spec §12) enforced route by route; `delete my data` resigns active games (opponent wins, rated as usual), cancels pending challenges, anonymises the user (`telegram_user_id` and `username` null, `first_name` = `Deleted player`, prefs cleared) and hides them from leaderboards and pickers.
- Position images: SVG assembled from squares, last-move and check highlights and the cburnett piece set (CC BY-SA 3.0, credited), rasterised to 1024 × 1024 PNG with resvg; cache keyed by `sha256(placement | side | lastMove | check | orientation | theme)` → Telegram `file_id`; shares limited to one per user per minute (spec §7.7, §7.8).
- Lichess (spec §7.6): `POST /api/import` with form field `pgn` and `Authorization: Bearer LICHESS_TOKEN` when set; one request at a time with 2 s spacing; a 429 pauses 60 s; up to 8 attempts then `lichess_import_status = 'failed'`; the fallback analysis link is on the card from the moment the game ends.
- Metrics in Prometheus format at `/metrics`; `/healthz` (process up) and `/readyz` (database reachable) (spec §14).
- Configuration stays environment-only; new variables in this plan: `TELEGRAM_API_ROOT` (optional, tests and local fakes), `TELEGRAM_POLLING` (`true` for dev long polling), `LICHESS_API_URL` (default `https://lichess.org`), `MINI_APP_DIR` (optional path of the built Mini App to serve under `/app/`).

## Review Focus

1. A webhook retry of an update whose handler already committed must not create a second challenge or a second card → Task 2, test "acknowledges a duplicate update without repeating its effects".
2. A card edit that races the card send (the edit job runs before the send job stored the message id) must be retried, not dropped → Task 3, test "retries an edit for a card that has no message id yet".
3. A forged or replayed `initData` (tampered field, or older than 24 h) must never yield a session → Task 4, tests "rejects tampered init data", "rejects init data older than 24 hours".
4. A spectator who is not a member must not receive the game stream, and a member's fifth simultaneous stream must be refused, never silently dropped → Task 5, tests "refuses the stream to a non-member", "caps open streams at four per user".
5. A shared position must reuse the cached Telegram file when the same position is shared again, so the group never gets a duplicate upload of the same image → Task 6, test "reuses the cached file id for the same position".

---

### Task 1: Telegram client, error classification, deep links and the card renderer

**Files:**
- Create: `apps/server/src/telegram/client.ts`, `apps/server/src/telegram/links.ts`, `apps/server/src/telegram/cards.ts`
- Modify: `apps/server/package.json` (add `grammy`, `@grammyjs/transformer-throttler`)
- Test: `apps/server/test/unit/telegram-client.test.ts`, `apps/server/test/unit/cards.test.ts`

**Interfaces:**
- Consumes: shared `encodeStartParam`, `encodeCallbackData`, `t`, `timePerMoveLabel`, `timeSpanLabel`, `ratedLabel`, `endReasonLabel`, `resultLabel`, `movesLabel`, types; `Config` (plan 2 Task 1).
- Produces: `createTelegramApi(config: Pick<Config, 'BOT_TOKEN'>, options?: { apiRoot?: string }): Api`, `type TelegramApi = Api`, `type TelegramFailure = { kind: 'retry_after'; seconds: number } | { kind: 'not_modified' } | { kind: 'message_gone' } | { kind: 'blocked' } | { kind: 'chat_gone' } | { kind: 'migrated'; newChatId: number } | { kind: 'other'; description: string }`, `classifyTelegramError(error: unknown): TelegramFailure | null`; `miniAppLink(config: Pick<Config, 'BOT_USERNAME' | 'MINI_APP_SHORT_NAME'>, param?: StartParam): string`, `groupMessageLink(telegramChatId: number, messageId: number): string | null`; `type PersonView = { name: string; username: string | null; telegramUserId: number | null }`, `type RenderedMessage = { text: string; entities: MessageEntity[]; reply_markup?: InlineKeyboardMarkup }`, `type ChallengeCardView`, `type GameCardView`, `renderChallengeCard(view): RenderedMessage`, `renderGameCard(view): RenderedMessage`, `renderWelcomeCard(openChessLink: string): RenderedMessage`, `renderShareCaption(view: { sharer: string; moveNumber: number; white: string; black: string; sideToMove: Colour }): string`, `MAX_BUTTON_URL_LENGTH = 2000`.

- [ ] **Step 1: Add the dependencies**

In `apps/server/package.json` add to `dependencies`:

```json
    "@grammyjs/transformer-throttler": "^1.2.1",
    "grammy": "^1.46.0",
```

Run: `pnpm install`
Expected: exit 0.

- [ ] **Step 2: Write the failing tests**

`apps/server/test/unit/telegram-client.test.ts`:

```ts
import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { classifyTelegramError } from '../../src/telegram/client';
import { groupMessageLink, miniAppLink } from '../../src/telegram/links';

const config = { BOT_USERNAME: 'GroupChessBot', MINI_APP_SHORT_NAME: 'chess' };

function grammyError(error_code: number, description: string, parameters: Record<string, number> = {}) {
  return new GrammyError('Call failed', { ok: false, error_code, description, parameters }, 'sendMessage', {});
}

describe('miniAppLink', () => {
  it('builds direct links with and without a payload', () => {
    expect(miniAppLink(config)).toBe('https://t.me/GroupChessBot/chess');
    expect(miniAppLink(config, { kind: 'game', gameId: 'aZ09bY18cX' })).toBe(
      'https://t.me/GroupChessBot/chess?startapp=g_aZ09bY18cX',
    );
  });
});

describe('groupMessageLink', () => {
  it('links to a message in a supergroup and to nothing in a basic group', () => {
    expect(groupMessageLink(-1001234567890, 42)).toBe('https://t.me/c/1234567890/42');
    expect(groupMessageLink(-987654321, 42)).toBeNull();
  });
});

describe('classifyTelegramError', () => {
  it.each([
    ['a 429', grammyError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }), { kind: 'retry_after', seconds: 7 }],
    ['not modified', grammyError(400, 'Bad Request: message is not modified: specified new message content'), { kind: 'not_modified' }],
    ['message gone', grammyError(400, 'Bad Request: message to edit not found'), { kind: 'message_gone' }],
    ['blocked', grammyError(403, 'Forbidden: bot was blocked by the user'), { kind: 'blocked' }],
    ['deactivated', grammyError(403, 'Forbidden: user is deactivated'), { kind: 'blocked' }],
    ['kicked', grammyError(403, 'Forbidden: bot was kicked from the supergroup chat'), { kind: 'chat_gone' }],
    ['chat not found', grammyError(400, 'Bad Request: chat not found'), { kind: 'chat_gone' }],
    ['migrated', grammyError(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: -1001 }), { kind: 'migrated', newChatId: -1001 }],
    ['anything else', grammyError(400, 'Bad Request: wrong file identifier'), { kind: 'other', description: 'Bad Request: wrong file identifier' }],
  ])('classifies %s', (_label, error, expected) => {
    expect(classifyTelegramError(error)).toEqual(expected);
  });

  it('returns null for errors that did not come from Telegram', () => {
    expect(classifyTelegramError(new Error('ECONNRESET'))).toBeNull();
  });
});
```

`apps/server/test/unit/cards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  renderChallengeCard,
  renderGameCard,
  renderShareCaption,
  renderWelcomeCard,
  type ChallengeCardView,
  type GameCardView,
} from '../../src/telegram/cards';

const alice = { name: 'Alice', username: 'alice', telegramUserId: 1 };
const bob = { name: 'Bob', username: 'bob', telegramUserId: 2 };
const bobNoHandle = { name: 'Bob', username: null, telegramUserId: 2 };

const challenge = (over: Partial<ChallengeCardView> = {}): ChallengeCardView => ({
  publicId: 'chal000001',
  status: 'pending',
  challenger: alice,
  opponent: bob,
  timePerMove: 86400,
  rated: true,
  challengerColour: 'random',
  ...over,
});

const game = (over: Partial<GameCardView> = {}): GameCardView => ({
  publicId: 'game000001',
  status: 'active',
  white: alice,
  black: bob,
  timePerMove: 86400,
  rated: true,
  plyCount: 12,
  sideToMove: 'white',
  result: null,
  endReason: null,
  voided: false,
  whiteRating: { before: '1520', after: null },
  blackRating: { before: '1498?', after: null },
  abortedBy: null,
  analysisUrl: null,
  lichessUrl: null,
  openLink: 'https://t.me/GroupChessBot/chess?startapp=g_game000001',
  ...over,
});

describe('renderChallengeCard', () => {
  it('mentions a challenged player with a username by handle', () => {
    const card = renderChallengeCard(challenge());
    expect(card.text).toBe('♟ Alice challenges @bob\n1 day per move · Rated');
    expect(card.entities).toEqual([]);
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Accept', callback_data: 'ch/acc/chal000001' },
          { text: 'Decline', callback_data: 'ch/dec/chal000001' },
        ],
      ],
    });
  });

  it('mentions a challenged player without a username through a text_mention entity', () => {
    const card = renderChallengeCard(challenge({ opponent: bobNoHandle, challengerColour: 'white' }));
    expect(card.text).toBe('♟ Alice challenges Bob\n1 day per move · Rated · Alice plays White');
    expect(card.entities).toEqual([
      { type: 'text_mention', offset: 19, length: 3, user: { id: 2, first_name: 'Bob', is_bot: false } },
    ]);
  });

  it('renders an open challenge with Accept and Cancel', () => {
    const card = renderChallengeCard(challenge({ opponent: null, rated: false }));
    expect(card.text).toBe('♟ Alice is looking for a game\n1 day per move · Casual');
    expect(card.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['Accept', 'Cancel']);
  });

  it.each([
    ['declined', bob, '♟ Alice vs Bob · Declined'],
    ['cancelled', bob, '♟ Alice vs Bob · Challenge withdrawn'],
    ['expired', bob, '♟ Alice vs Bob · Challenge expired'],
    ['cancelled', null, '♟ Alice · Challenge withdrawn'],
    ['expired', null, '♟ Alice · Challenge expired'],
  ] as const)('renders a %s challenge without buttons', (status, opponent, text) => {
    const card = renderChallengeCard(challenge({ status, opponent }));
    expect(card.text).toBe(text);
    expect(card.reply_markup).toBeUndefined();
  });
});

describe('renderGameCard', () => {
  it('renders a running rated game with the move number and the player to move', () => {
    const card = renderGameCard(game());
    expect(card.text).toBe('♟ Alice (1520) vs Bob (1498?)\n1 day per move · Rated · Move 7 · Alice to move');
    expect(card.reply_markup).toEqual({
      inline_keyboard: [[{ text: '♟ Open game', url: 'https://t.me/GroupChessBot/chess?startapp=g_game000001' }]],
    });
  });

  it('renders a running casual game without ratings', () => {
    const card = renderGameCard(game({ rated: false, whiteRating: null, blackRating: null, plyCount: 3, sideToMove: 'black' }));
    expect(card.text).toBe('♟ Alice vs Bob\n1 day per move · Casual · Move 2 · Bob to move');
  });

  it('renders a finished rated game with deltas, Rematch and Analyse', () => {
    const card = renderGameCard(
      game({
        status: 'finished',
        result: '1-0',
        endReason: 'checkmate',
        plyCount: 67,
        whiteRating: { before: '1520', after: '1534' },
        blackRating: { before: '1498', after: '1484' },
        lichessUrl: 'https://lichess.org/abcdefgh',
        analysisUrl: 'https://lichess.org/analysis/pgn/e4',
      }),
    );
    expect(card.text).toBe('♟ Alice (1520 → 1534) vs Bob (1498 → 1484)\nCheckmate · 1-0 · 34 moves · 1 day per move');
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '🔁 Rematch', callback_data: 'gm/rem/game000001' },
          { text: '🔍 Analyse on Lichess', url: 'https://lichess.org/abcdefgh' },
        ],
      ],
    });
  });

  it('falls back to the analysis board and omits an over-long analysis URL', () => {
    const short = renderGameCard(game({ status: 'finished', result: '1/2-1/2', endReason: 'draw_agreement', analysisUrl: 'https://lichess.org/analysis/pgn/e4_e5' }));
    expect(short.reply_markup?.inline_keyboard[0]?.[1]).toEqual({ text: '🔍 Analyse on Lichess', url: 'https://lichess.org/analysis/pgn/e4_e5' });
    expect(short.text).toContain('Draw agreed · ½-½');
    const long = renderGameCard(game({ status: 'finished', result: '1/2-1/2', endReason: 'draw_agreement', analysisUrl: `https://lichess.org/analysis/pgn/${'e4_'.repeat(700)}` }));
    expect(long.reply_markup?.inline_keyboard[0]).toEqual([{ text: '🔁 Rematch', callback_data: 'gm/rem/game000001' }]);
  });

  it('renders aborted games with the reason and a Rematch button', () => {
    const noMove = renderGameCard(game({ status: 'finished', result: '*', endReason: 'timeout_abort' }));
    expect(noMove.text).toBe('♟ Alice vs Bob · Aborted\nno move within 1 day');
    expect(noMove.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['🔁 Rematch']);
    const byPlayer = renderGameCard(game({ status: 'finished', result: '*', endReason: 'abort', abortedBy: 'Bob' }));
    expect(byPlayer.text).toBe('♟ Alice vs Bob · Aborted\naborted by Bob');
  });

  it('renders a voided game with its former result and Analyse when it had moves', () => {
    const card = renderGameCard(game({ status: 'finished', result: '1-0', endReason: 'checkmate', voided: true, plyCount: 40, analysisUrl: 'https://lichess.org/analysis/pgn/e4' }));
    expect(card.text).toBe('♟ Alice vs Bob · Voided by an admin\nwas Checkmate · 1-0');
    expect(card.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['🔍 Analyse on Lichess']);
    const noMoves = renderGameCard(game({ status: 'finished', result: '*', endReason: 'voided', voided: true, plyCount: 0 }));
    expect(noMoves.text).toBe('♟ Alice vs Bob · Voided by an admin');
    expect(noMoves.reply_markup).toBeUndefined();
  });
});

describe('welcome and share', () => {
  it('renders the welcome card with the Open Chess button', () => {
    const card = renderWelcomeCard('https://t.me/GroupChessBot/chess?startapp=l_grp0000001');
    expect(card.text).toBe(
      'Play chess with this group on a real board inside Telegram. The chat only sees results and shared positions. Admins: promote me so everyone here can watch games.',
    );
    expect(card.reply_markup?.inline_keyboard).toEqual([[{ text: '♟ Open Chess', url: 'https://t.me/GroupChessBot/chess?startapp=l_grp0000001' }]]);
  });

  it('renders the share caption', () => {
    expect(renderShareCaption({ sharer: 'Carol', moveNumber: 23, white: 'Alice', black: 'Bob', sideToMove: 'black' })).toBe(
      'Carol shared move 23 · Alice vs Bob · Black to move',
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run apps/server/test/unit/telegram-client.test.ts apps/server/test/unit/cards.test.ts`
Expected: FAIL — both files cannot load their modules under `src/telegram/`.

- [ ] **Step 4: Write the implementation**

`apps/server/src/telegram/client.ts`:

```ts
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Api, GrammyError } from 'grammy';
import type { Config } from '../config';

export type TelegramApi = Api;

/** One outbound client per process; the throttler implements Telegram's published limits (spec §5.8). */
export function createTelegramApi(
  config: Pick<Config, 'BOT_TOKEN'>,
  options: { apiRoot?: string } = {},
): Api {
  const api = new Api(config.BOT_TOKEN, options.apiRoot ? { apiRoot: options.apiRoot } : {});
  api.config.use(apiThrottler());
  return api;
}

export type TelegramFailure =
  | { kind: 'retry_after'; seconds: number }
  | { kind: 'not_modified' }
  | { kind: 'message_gone' }
  | { kind: 'blocked' }
  | { kind: 'chat_gone' }
  | { kind: 'migrated'; newChatId: number }
  | { kind: 'other'; description: string };

/** Maps Bot API failures to the handling table of spec §11. Non-Telegram errors return null. */
export function classifyTelegramError(error: unknown): TelegramFailure | null {
  if (!(error instanceof GrammyError)) return null;
  const description = error.description;
  const parameters = error.parameters;
  if (error.error_code === 429) return { kind: 'retry_after', seconds: parameters.retry_after ?? 5 };
  if (parameters.migrate_to_chat_id !== undefined) {
    return { kind: 'migrated', newChatId: parameters.migrate_to_chat_id };
  }
  if (/message is not modified/i.test(description)) return { kind: 'not_modified' };
  if (/message to edit not found|message can't be edited|message to delete not found|message_id_invalid/i.test(description)) {
    return { kind: 'message_gone' };
  }
  if (/bot was blocked by the user|user is deactivated|bot can't initiate conversation|bots can't send messages to bots/i.test(description)) {
    return { kind: 'blocked' };
  }
  if (/bot was kicked|chat not found|bot is not a member|group chat was deleted|have no rights to send|chat_write_forbidden|need administrator rights/i.test(description)) {
    return { kind: 'chat_gone' };
  }
  return { kind: 'other', description };
}
```

`apps/server/src/telegram/links.ts`:

```ts
import { encodeStartParam, type StartParam } from '@group-chess/shared';
import type { Config } from '../config';

/** The only Mini App button that works inside groups (spec §5.3). */
export function miniAppLink(
  config: Pick<Config, 'BOT_USERNAME' | 'MINI_APP_SHORT_NAME'>,
  param?: StartParam,
): string {
  const base = `https://t.me/${config.BOT_USERNAME}/${config.MINI_APP_SHORT_NAME}`;
  return param ? `${base}?startapp=${encodeStartParam(param)}` : base;
}

/** `https://t.me/c/<supergroup id without -100>/<message id>`; basic groups have no message links (spec §5.7). */
export function groupMessageLink(telegramChatId: number, messageId: number): string | null {
  if (telegramChatId > -1_000_000_000_000) return null;
  return `https://t.me/c/${String(telegramChatId).slice(4)}/${messageId}`;
}
```

`apps/server/src/telegram/cards.ts`:

```ts
import {
  encodeCallbackData,
  endReasonLabel,
  movesLabel,
  ratedLabel,
  resultLabel,
  t,
  timePerMoveLabel,
  timeSpanLabel,
  type ChallengeStatus,
  type Colour,
  type ColourChoice,
  type EndReason,
  type GameResult,
  type GameStatus,
  type MessageKey,
  type MessageParams,
  type TimePerMove,
  type TimePerMoveSeconds,
} from '@group-chess/shared';
import type { InlineKeyboardButton, InlineKeyboardMarkup, MessageEntity } from 'grammy/types';

export const MAX_BUTTON_URL_LENGTH = 2000;

export type PersonView = { name: string; username: string | null; telegramUserId: number | null };

export type RenderedMessage = {
  text: string;
  entities: MessageEntity[];
  reply_markup?: InlineKeyboardMarkup;
};

export type ChallengeCardView = {
  publicId: string;
  status: ChallengeStatus;
  challenger: PersonView;
  opponent: PersonView | null;
  timePerMove: TimePerMove;
  rated: boolean;
  challengerColour: ColourChoice;
};

export type GameCardView = {
  publicId: string;
  status: GameStatus;
  white: PersonView;
  black: PersonView;
  timePerMove: TimePerMove;
  rated: boolean;
  plyCount: number;
  sideToMove: Colour;
  result: GameResult | null;
  endReason: EndReason | null;
  voided: boolean;
  /** Rating labels (`1520`, `1498?`); null for casual games. */
  whiteRating: { before: string; after: string | null } | null;
  blackRating: { before: string; after: string | null } | null;
  abortedBy: string | null;
  analysisUrl: string | null;
  lichessUrl: string | null;
  openLink: string;
};

const MENTION_MARK = '\u0000';

/** Renders a template whose `{opponent}` slot is a mention: `@username`, else a text_mention entity (spec §5.4). */
function withMention(
  key: MessageKey,
  params: MessageParams,
  slot: string,
  person: PersonView,
): { text: string; entities: MessageEntity[] } {
  const rendered = t(key, { ...params, [slot]: MENTION_MARK });
  const offset = rendered.indexOf(MENTION_MARK);
  if (person.username) {
    return { text: rendered.replace(MENTION_MARK, `@${person.username}`), entities: [] };
  }
  const text = rendered.replace(MENTION_MARK, person.name);
  if (person.telegramUserId === null) return { text, entities: [] };
  return {
    text,
    entities: [
      {
        type: 'text_mention',
        offset,
        length: person.name.length,
        user: { id: person.telegramUserId, first_name: person.name, is_bot: false },
      },
    ],
  };
}

function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup | undefined {
  const nonEmpty = rows.filter((row) => row.length > 0);
  return nonEmpty.length > 0 ? { inline_keyboard: nonEmpty } : undefined;
}

function urlButton(text: string, url: string | null): InlineKeyboardButton | null {
  if (!url || url.length > MAX_BUTTON_URL_LENGTH) return null;
  return { text, url };
}

function terms(view: ChallengeCardView): string {
  const base = { timePerMove: timePerMoveLabel(view.timePerMove), rated: ratedLabel(view.rated) };
  if (view.challengerColour === 'random') return t('card.challenge.terms', base);
  return t('card.challenge.terms_colour', {
    ...base,
    challenger: view.challenger.name,
    colour: t(`colour.${view.challengerColour}`),
  });
}

export function renderChallengeCard(view: ChallengeCardView): RenderedMessage {
  const challenger = view.challenger.name;
  if (view.status === 'pending') {
    const line1 = view.opponent
      ? withMention('card.challenge.direct', { challenger }, 'opponent', view.opponent)
      : { text: t('card.challenge.open', { challenger }), entities: [] };
    const accept = {
      text: t('button.accept'),
      callback_data: encodeCallbackData({ action: 'accept_challenge', challengeId: view.publicId }),
    };
    const declineOrCancel = {
      text: t(view.opponent ? 'button.decline' : 'button.cancel'),
      callback_data: encodeCallbackData({ action: 'decline_challenge', challengeId: view.publicId }),
    };
    return {
      text: `${line1.text}\n${terms(view)}`,
      entities: line1.entities,
      reply_markup: keyboard([[accept, declineOrCancel]]),
    };
  }
  const params = { challenger, opponent: view.opponent?.name ?? '' };
  const key: MessageKey = view.opponent
    ? view.status === 'declined'
      ? 'card.challenge.declined'
      : view.status === 'expired'
        ? 'card.challenge.expired'
        : 'card.challenge.withdrawn'
    : view.status === 'expired'
      ? 'card.challenge.open_expired'
      : 'card.challenge.open_withdrawn';
  return { text: t(key, params), entities: [] };
}

export function renderGameCard(view: GameCardView): RenderedMessage {
  const white = view.white.name;
  const black = view.black.name;
  const rematch = {
    text: t('button.rematch'),
    callback_data: encodeCallbackData({ action: 'rematch', gameId: view.publicId }),
  };
  const analyse = urlButton(t('button.analyse'), view.lichessUrl ?? view.analysisUrl);

  if (view.voided) {
    const lines = [t('card.voided.title', { white, black })];
    if (view.result && view.result !== '*' && view.endReason && view.endReason !== 'voided') {
      lines.push(
        t('card.voided.status', { endReason: endReasonLabel(view.endReason), result: resultLabel(view.result) }),
      );
    }
    const buttons = view.plyCount > 0 && analyse ? [analyse] : [];
    return { text: lines.join('\n'), entities: [], reply_markup: keyboard([buttons]) };
  }

  if (view.status === 'active') {
    const title =
      view.rated && view.whiteRating && view.blackRating
        ? t('card.running.title', {
            white,
            black,
            whiteRating: view.whiteRating.before,
            blackRating: view.blackRating.before,
          })
        : t('card.running.title_casual', { white, black });
    const status = t('card.running.status', {
      timePerMove: timePerMoveLabel(view.timePerMove),
      rated: ratedLabel(view.rated),
      moveNumber: Math.floor(view.plyCount / 2) + 1,
      sideToMove: view.sideToMove === 'white' ? white : black,
    });
    return {
      text: `${title}\n${status}`,
      entities: [],
      reply_markup: keyboard([[{ text: t('button.open_game'), url: view.openLink }]]),
    };
  }

  if (view.endReason === 'abort' || view.endReason === 'timeout_abort') {
    const reason =
      view.endReason === 'timeout_abort' && view.timePerMove !== null
        ? t('card.aborted.no_move', { span: timeSpanLabel(view.timePerMove as TimePerMoveSeconds) })
        : view.abortedBy
          ? t('card.aborted.by_player', { name: view.abortedBy })
          : null;
    const lines = [t('card.aborted.title', { white, black })];
    if (reason) lines.push(reason);
    return { text: lines.join('\n'), entities: [], reply_markup: keyboard([[rematch]]) };
  }

  const title =
    view.rated && view.whiteRating && view.blackRating
      ? t('card.finished.title', {
          white,
          whiteBefore: view.whiteRating.before,
          whiteAfter: view.whiteRating.after ?? view.whiteRating.before,
          black,
          blackBefore: view.blackRating.before,
          blackAfter: view.blackRating.after ?? view.blackRating.before,
        })
      : t('card.finished.title_casual', { white, black });
  const status = t('card.finished.status', {
    endReason: view.endReason ? endReasonLabel(view.endReason) : '',
    result: view.result ? resultLabel(view.result) : '',
    moves: movesLabel(Math.ceil(view.plyCount / 2)),
    timePerMove: timePerMoveLabel(view.timePerMove),
  });
  const buttons = analyse ? [rematch, analyse] : [rematch];
  return { text: `${title}\n${status}`, entities: [], reply_markup: keyboard([buttons]) };
}

export function renderWelcomeCard(openChessLink: string): RenderedMessage {
  return {
    text: t('card.welcome'),
    entities: [],
    reply_markup: keyboard([[{ text: t('button.open_chess'), url: openChessLink }]]),
  };
}

export function renderShareCaption(view: {
  sharer: string;
  moveNumber: number;
  white: string;
  black: string;
  sideToMove: Colour;
}): string {
  return t('card.share.caption', {
    sharer: view.sharer,
    moveNumber: view.moveNumber,
    white: view.white,
    black: view.black,
    sideToMove: t(`colour.${view.sideToMove}`),
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/server/test/unit/telegram-client.test.ts apps/server/test/unit/cards.test.ts`
Expected: PASS — 28 tests (client 13, cards 15).

- [ ] **Step 6: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): add the Telegram client, error classification, deep links and the card renderer"
```

---

### Task 2: The bot — commands, callbacks, membership events — behind an idempotent webhook

**Files:**
- Create: `apps/server/src/bot/bot.ts`, `apps/server/src/bot/replies.ts`, `apps/server/src/bot/rateLimit.ts`, `apps/server/src/bot/webhook.ts`, `apps/server/src/domain/groupLifecycle.ts`, `apps/server/test/helpers/config.ts`, `apps/server/test/helpers/fakeTelegram.ts`, `apps/server/test/helpers/updates.ts`
- Modify: `apps/server/src/config.ts` (add `TELEGRAM_API_ROOT`, `TELEGRAM_POLLING`, `LICHESS_API_URL`, `MINI_APP_DIR`), `apps/server/test/unit/config.test.ts` (defaults), `apps/server/package.json` (add `hono`), `packages/shared/src/i18n/en.ts` (add `command.chess`, `command.settings`, `dm.start`)
- Test: `apps/server/test/integration/bot.test.ts`

**Interfaces:**
- Consumes: plan 2 domain (`ensureUser`, `ensureGroup`, `getGroupByChatId`, `settingsOf`, `setBotMembership`, `migrateChatId`, `touchMember`, `markLeft`, `setDmAllowed`, `createChallenge`, `acceptChallenge`, `declineChallenge`, `cancelChallenge`, `createRematch`, `getChallengeByPublicId`, `requireGameByPublicId`, `enqueue`, `DomainError`); Task 1 (`miniAppLink`).
- Produces: `createBot(deps: Deps, config: Config): Promise<Bot>` (initialised, handlers registered, throttler on `bot.api`); `webhookRoutes(bot: Bot, deps: Deps, config: Config): Hono` mounting `POST /telegram/webhook`; `replyFor(error: unknown): { key: MessageKey; params: MessageParams } | null`; `alertFor(deps, error, action): Promise<string | null>`; `class RateLimiter { constructor(limit: number, windowMs: number); allow(key: string, now?: number): boolean }`; `cancelPendingChallengesForGroup(deps, groupId): Promise<number>`; `markBotLeft(deps, telegramChatId): Promise<void>`; test helpers `testConfig(overrides?)`, `class FakeTelegram { static start(); url; calls; callsTo(method); failNext(method, failure); admins; members; memberError; reset(); stop() }`, update builders `tgUser`, `supergroup`, `privateChat`, `commandUpdate`, `callbackUpdate`, `myChatMemberUpdate`, `chatMemberUpdate`, `serviceUpdate`.
- `send_message` job payload: `{ chatId: number; threadId: number | null; text: string; replyToMessageId?: number; buttons?: { text: string; url: string }[] }`. `send_welcome` payload `{ groupId }`, dedup `welcome:<groupPublicId>`.

- [ ] **Step 1: Configuration, catalog and dependency additions**

In `apps/server/src/config.ts`, add inside `ConfigSchema` after `PORT`:

```ts
  /** Bot API base for tests and local fakes; unset means api.telegram.org. */
  TELEGRAM_API_ROOT: z.url().optional(),
  /** `true` runs long polling (dev); otherwise updates arrive on the webhook (spec §4.4). */
  TELEGRAM_POLLING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LICHESS_API_URL: z.url().default('https://lichess.org'),
  /** Directory of the built Mini App to serve under /app/; unset means not served. */
  MINI_APP_DIR: z.string().min(1).optional(),
```

In `apps/server/test/unit/config.test.ts`, extend the first test's assertions:

```ts
    expect(config.TELEGRAM_POLLING).toBe(false);
    expect(config.TELEGRAM_API_ROOT).toBeUndefined();
    expect(config.LICHESS_API_URL).toBe('https://lichess.org');
```

In `packages/shared/src/i18n/en.ts`, add after `'locked.hint'`:

```ts
  'command.chess': 'Play chess with this group on a real board.',
  'command.settings': 'Group chess settings (admins only).',
  'dm.start':
    "Tap Open Chess to see your groups' games. You'll get a message here when it's your move.",
```

In `apps/server/package.json` add to `dependencies`: `"hono": "^4.13.8",` then run `pnpm install`.

- [ ] **Step 2: Write the test helpers**

`apps/server/test/helpers/config.ts`:

```ts
import type { Config } from '../../src/config';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    BOT_TOKEN: '123456:TEST-TOKEN',
    BOT_USERNAME: 'TestChessBot',
    MINI_APP_SHORT_NAME: 'chess',
    PUBLIC_URL: 'https://chess.test',
    WEBHOOK_SECRET: 'w'.repeat(32),
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    SESSION_SECRET: 's'.repeat(32),
    LICHESS_TOKEN: undefined,
    ROLES: ['api', 'bot', 'jobs', 'clock'],
    LOG_LEVEL: 'fatal',
    PORT: 0,
    TELEGRAM_API_ROOT: undefined,
    TELEGRAM_POLLING: false,
    LICHESS_API_URL: 'https://lichess.org',
    MINI_APP_DIR: undefined,
    ...overrides,
  };
}
```

`apps/server/test/helpers/fakeTelegram.ts`:

```ts
import { createServer, type Server } from 'node:http';

export type FakeCall = { method: string; body: Record<string, unknown>; multipart: boolean };
export type FakeFailure = { error_code: number; description: string; parameters?: Record<string, number> };

/** A Bot API stand-in: records every call, answers with plausible results, fails on request. */
export class FakeTelegram {
  calls: FakeCall[] = [];
  admins: number[] = [];
  members = new Map<number, string>();
  memberError: FakeFailure | null = null;
  url = '';
  private failures = new Map<string, FakeFailure[]>();
  private nextMessageId = 100;
  private server: Server;

  private constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const method = req.url?.split('/').pop() ?? '';
        const raw = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] ?? '';
        let body: Record<string, unknown> = {};
        const multipart = contentType.startsWith('multipart/form-data');
        if (multipart) {
          const text = raw.toString('latin1');
          for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) body[match[1]!] = match[2];
          if (/filename="/.test(text)) body.__file = true;
        } else if (raw.length > 0) {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        }
        this.calls.push({ method, body, multipart });
        const { status, json } = this.respond(method, body);
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      });
    });
  }

  static async start(): Promise<FakeTelegram> {
    const fake = new FakeTelegram();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', () => resolve()));
    const address = fake.server.address() as { port: number };
    fake.url = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.calls = [];
    this.failures.clear();
    this.admins = [];
    this.members.clear();
    this.memberError = null;
  }

  failNext(method: string, failure: FakeFailure): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(failure);
    this.failures.set(method, queue);
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private respond(method: string, body: Record<string, unknown>): { status: number; json: unknown } {
    const queued = this.failures.get(method)?.shift();
    if (queued) return { status: queued.error_code, json: { ok: false, ...queued } };
    const ok = (result: unknown) => ({ status: 200, json: { ok: true, result } });
    switch (method) {
      case 'getMe':
        return ok({
          id: 424242,
          is_bot: true,
          first_name: 'Test Chess',
          username: 'TestChessBot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      case 'sendMessage':
      case 'editMessageText':
        return ok({
          message_id: method === 'sendMessage' ? (this.nextMessageId += 1) : Number(body.message_id),
          date: 1,
          chat: { id: Number(body.chat_id), type: 'supergroup', title: 'G' },
          text: String(body.text ?? ''),
        });
      case 'sendPhoto':
        return ok({
          message_id: (this.nextMessageId += 1),
          date: 1,
          chat: { id: Number(body.chat_id), type: 'supergroup', title: 'G' },
          photo: [{ file_id: 'AgACAgIAAxkFake', file_unique_id: 'u1', width: 1024, height: 1024 }],
        });
      case 'getChatMember': {
        if (this.memberError) return { status: this.memberError.error_code, json: { ok: false, ...this.memberError } };
        const userId = Number(body.user_id);
        const status = this.members.get(userId) ?? 'left';
        const user = { id: userId, is_bot: false, first_name: 'Member' };
        return ok(status === 'restricted' ? { status, user, is_member: true } : { status, user });
      }
      case 'getChatAdministrators':
        return ok(this.admins.map((id) => ({ status: 'administrator', user: { id, is_bot: false, first_name: 'Admin' } })));
      default:
        return ok(true);
    }
  }
}
```

`apps/server/test/helpers/updates.ts`:

```ts
import type { Chat, Update, User } from 'grammy/types';

let updateId = 1000;
let messageId = 500;

export const tgUser = (id: number, first_name: string, username?: string): User => ({
  id,
  is_bot: false,
  first_name,
  ...(username ? { username } : {}),
});

export const supergroup = (id: number, title = 'Chess Club'): Chat.SupergroupChat => ({ id, type: 'supergroup', title });

export const privateChat = (user: User): Chat.PrivateChat => ({ id: user.id, type: 'private', first_name: user.first_name });

type ReplyTarget = { from?: User; senderChat?: boolean };

export function commandUpdate(options: {
  chat: Chat.SupergroupChat | Chat.GroupChat | Chat.PrivateChat;
  from: User;
  text: string;
  replyTo?: ReplyTarget;
  threadId?: number;
}): Update {
  const command = options.text.split(' ')[0] ?? options.text;
  const base = { date: 1, chat: options.chat };
  return {
    update_id: (updateId += 1),
    message: {
      ...base,
      message_id: (messageId += 1),
      from: options.from,
      text: options.text,
      entities: [{ type: 'bot_command', offset: 0, length: command.length }],
      ...(options.threadId ? { message_thread_id: options.threadId, is_topic_message: true } : {}),
      ...(options.replyTo
        ? {
            reply_to_message: {
              ...base,
              message_id: (messageId += 1),
              ...(options.replyTo.from ? { from: options.replyTo.from } : {}),
              ...(options.replyTo.senderChat ? { sender_chat: options.chat } : {}),
              text: 'hi',
            },
          }
        : {}),
    },
  } as Update;
}

export function callbackUpdate(options: { from: User; chat: Chat.SupergroupChat; data: string; cardMessageId?: number }): Update {
  return {
    update_id: (updateId += 1),
    callback_query: {
      id: String(updateId),
      from: options.from,
      chat_instance: 'ci',
      data: options.data,
      message: { message_id: options.cardMessageId ?? 1, date: 1, chat: options.chat, text: 'card' },
    },
  } as Update;
}

export function myChatMemberUpdate(options: {
  chat: Chat.SupergroupChat | Chat.PrivateChat;
  from: User;
  oldStatus: 'left' | 'kicked' | 'member' | 'administrator';
  newStatus: 'left' | 'kicked' | 'member' | 'administrator';
  canPin?: boolean;
}): Update {
  const bot = { id: 424242, is_bot: true, first_name: 'Test Chess', username: 'TestChessBot' };
  const member = (status: string) =>
    status === 'administrator'
      ? { status, user: bot, can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: false, can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false, can_change_info: false, can_invite_users: false, can_post_stories: false, can_edit_stories: false, can_delete_stories: false, can_pin_messages: options.canPin ?? false }
      : { status, user: bot };
  return {
    update_id: (updateId += 1),
    my_chat_member: {
      chat: options.chat,
      from: options.from,
      date: 1,
      old_chat_member: member(options.oldStatus),
      new_chat_member: member(options.newStatus),
    },
  } as Update;
}

export function chatMemberUpdate(options: {
  chat: Chat.SupergroupChat;
  from: User;
  user: User;
  newStatus: 'member' | 'left' | 'kicked' | 'administrator';
}): Update {
  return {
    update_id: (updateId += 1),
    chat_member: {
      chat: options.chat,
      from: options.from,
      date: 1,
      old_chat_member: { status: 'left', user: options.user },
      new_chat_member: { status: options.newStatus, user: options.user },
    },
  } as Update;
}

export function serviceUpdate(chat: Chat, from: User, fields: Record<string, unknown>): Update {
  return {
    update_id: (updateId += 1),
    message: { message_id: (messageId += 1), date: 1, chat, from, ...fields },
  } as Update;
}
```

- [ ] **Step 3: Write the failing test**

`apps/server/test/integration/bot.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Bot } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot/bot';
import { webhookRoutes } from '../../src/bot/webhook';
import { challenges, games, groupMembers, groups, jobs, telegramUpdates, users } from '../../src/db/schema';
import { updateGroupSettings } from '../../src/domain/groups';
import { touchMember } from '../../src/domain/members';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertChallenge, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import {
  callbackUpdate,
  chatMemberUpdate,
  commandUpdate,
  myChatMemberUpdate,
  privateChat,
  serviceUpdate,
  supergroup,
  tgUser,
} from '../helpers/updates';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let bot: Bot;
let app: Hono;
const config = testConfig();

const chat = supergroup(-1001000000001);
const alice = tgUser(11, 'Alice', 'alice');
const bob = tgUser(22, 'Bob');
const carol = tgUser(33, 'Carol', 'carol');

beforeAll(async () => {
  fake = await FakeTelegram.start();
  bot = await createBot(deps, { ...config, TELEGRAM_API_ROOT: fake.url });
  app = new Hono().route('/', webhookRoutes(bot, deps, config));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const post = (update: unknown, secret: string | null = config.WEBHOOK_SECRET) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: JSON.stringify(update),
  });
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);
const messagesSent = async () => (await jobRows()).filter((job) => job.kind === 'send_message').map((job) => job.payload);

describe('webhook', () => {
  it('rejects a missing or wrong secret and records nothing', async () => {
    expect((await post(commandUpdate({ chat, from: alice, text: '/play' }), null)).status).toBe(401);
    expect((await post(commandUpdate({ chat, from: alice, text: '/play' }), 'nope')).status).toBe(401);
    expect(await db.select().from(telegramUpdates)).toHaveLength(0);
  });

  it('acknowledges a duplicate update without repeating its effects', async () => {
    const update = commandUpdate({ chat, from: alice, text: '/play', replyTo: { from: bob } });
    expect((await post(update)).status).toBe(200);
    expect((await post(update)).status).toBe(200);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect((await jobRows()).map((job) => job.kind)).toEqual(['send_challenge_card', 'send_dm']);
    expect((await db.select().from(telegramUpdates)).map((row) => row.updateId)).toEqual([update.update_id]);
  });
});

describe('/play', () => {
  it('creates a direct challenge from a reply inside the topic and records both members', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/play@TestChessBot', replyTo: { from: bob }, threadId: 77 }));
    const [challenge] = await db.select().from(challenges);
    const people = await db.select().from(users).orderBy(users.telegramUserId);
    expect(people.map((u) => [u.telegramUserId, u.firstName, u.username])).toEqual([
      [11, 'Alice', 'alice'],
      [22, 'Bob', null],
    ]);
    expect(challenge).toMatchObject({ challengerId: people[0]!.id, opponentId: people[1]!.id, threadId: 77, timePerMove: 86400, rated: true, challengerColour: 'random' });
    expect(await db.select().from(groupMembers)).toHaveLength(2);
    expect((await db.select().from(groups))[0]?.telegramChatId).toBe(chat.id);
  });

  it('creates an open challenge without a reply, or explains when the group forbids them', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/play' }));
    expect((await db.select().from(challenges))[0]?.opponentId).toBeNull();
    const [group] = await db.select().from(groups);
    await updateGroupSettings(db, group!.id, { allowOpenChallenges: false });
    const update = commandUpdate({ chat, from: alice, text: '/play' });
    await post(update);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect(await messagesSent()).toEqual([
      expect.objectContaining({ chatId: chat.id, text: 'Open challenges are off in this group.', replyToMessageId: update.message!.message_id }),
    ]);
  });

  it('replies with one line for a self-challenge, a bot or an anonymous author', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/play', replyTo: { from: alice } }));
    await post(commandUpdate({ chat, from: alice, text: '/play', replyTo: { from: { ...bob, is_bot: true } } }));
    await post(commandUpdate({ chat, from: alice, text: '/play', replyTo: { senderChat: true } }));
    expect((await messagesSent()).map((p) => (p as { text: string }).text)).toEqual([
      "You can't challenge yourself.",
      "Bots don't play here.",
      'Reply to a message from a person to challenge them.',
    ]);
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('ignores commands addressed to another bot', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/play@OtherBot', replyTo: { from: bob } }));
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await jobRows()).toHaveLength(0);
  });
});

describe('/chess, /settings and /start', () => {
  it('posts an Open Chess button once per group per minute', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/chess' }));
    await post(commandUpdate({ chat, from: bob, text: '/chess' }));
    const [group] = await db.select().from(groups);
    const sent = await messagesSent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: chat.id,
      buttons: [{ text: '♟ Open Chess', url: `https://t.me/TestChessBot/chess?startapp=l_${group!.publicId}` }],
    });
  });

  it('posts an Open settings button', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/settings' }));
    const [group] = await db.select().from(groups);
    expect((await messagesSent())[0]).toMatchObject({
      buttons: [{ text: 'Open settings', url: `https://t.me/TestChessBot/chess?startapp=s_${group!.publicId}` }],
    });
  });

  it('marks DMs allowed on /start in private and sends the Open Chess button there', async () => {
    await post(commandUpdate({ chat: privateChat(alice), from: alice, text: '/start' }));
    const [user] = await db.select().from(users);
    expect(user?.dmAllowed).toBe(true);
    expect((await messagesSent())[0]).toMatchObject({ chatId: alice.id, buttons: [{ text: '♟ Open Chess', url: 'https://t.me/TestChessBot/chess' }] });
  });
});

describe('callbacks', () => {
  async function pendingChallenge() {
    const group = await insertGroup(db, { telegramChatId: chat.id });
    const a = await insertUser(db, { telegramUserId: alice.id, firstName: 'Alice', username: 'alice' });
    const b = await insertUser(db, { telegramUserId: bob.id, firstName: 'Bob' });
    await touchMember(db, group.id, a.id);
    await touchMember(db, group.id, b.id);
    const challenge = await insertChallenge(db, group.id, a.id, b.id, { messageId: 900 });
    return { group, a, b, challenge };
  }

  it('lets the challenged player accept silently and tells anyone else who may', async () => {
    const { challenge } = await pendingChallenge();
    await post(callbackUpdate({ from: carol, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({ text: 'Only Bob can accept this challenge.', show_alert: true });
    expect(await db.select().from(games)).toHaveLength(0);
    await post(callbackUpdate({ from: bob, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).not.toHaveProperty('text');
    const [game] = await db.select().from(games);
    expect(game?.cardMessageId).toBe(900);
  });

  it('reports a challenge that someone else already accepted', async () => {
    const { challenge } = await pendingChallenge();
    await db.update(challenges).set({ status: 'accepted' }).where(eq(challenges.id, challenge.id));
    await post(callbackUpdate({ from: bob, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({ text: 'Someone accepted first.' });
  });

  it('treats Decline as a withdrawal for the challenger and a decline for the opponent', async () => {
    const first = await pendingChallenge();
    await post(callbackUpdate({ from: alice, chat, data: `ch/dec/${first.challenge.publicId}` }));
    expect((await db.select().from(challenges).where(eq(challenges.id, first.challenge.id)))[0]?.status).toBe('cancelled');
    const second = await insertChallenge(db, first.group.id, first.a.id, first.b.id);
    await post(callbackUpdate({ from: bob, chat, data: `ch/dec/${second.publicId}` }));
    expect((await db.select().from(challenges).where(eq(challenges.id, second.id)))[0]?.status).toBe('declined');
  });

  it('creates a reversed rematch for a player and refuses a spectator', async () => {
    const { group, a, b } = await pendingChallenge();
    const game = await insertGame(db, group.id, a.id, b.id, { status: 'finished', result: '1-0', endReason: 'checkmate', finishedAt: new Date() });
    await post(callbackUpdate({ from: carol, chat, data: `gm/rem/${game.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({ text: 'Only the players can ask for a rematch.' });
    await post(callbackUpdate({ from: bob, chat, data: `gm/rem/${game.publicId}` }));
    const rematch = (await db.select().from(challenges)).find((row) => row.challengerId === b.id);
    expect(rematch).toMatchObject({ opponentId: a.id, challengerColour: 'white' });
  });
});

describe('membership events', () => {
  it('welcomes the bot when it is added and marks it admin-capable', async () => {
    await post(myChatMemberUpdate({ chat, from: alice, oldStatus: 'left', newStatus: 'administrator', canPin: true }));
    const [group] = await db.select().from(groups);
    expect(group).toMatchObject({ botStatus: 'administrator', botIsAdmin: true, botCanPin: true });
    expect((await jobRows()).map((job) => [job.kind, job.dedupKey])).toEqual([['send_welcome', `welcome:${group!.publicId}`]]);
  });

  it('cancels pending challenges when the bot is removed', async () => {
    const group = await insertGroup(db, { telegramChatId: chat.id });
    const a = await insertUser(db);
    const b = await insertUser(db);
    await insertChallenge(db, group.id, a.id, b.id);
    await post(myChatMemberUpdate({ chat, from: alice, oldStatus: 'member', newStatus: 'kicked' }));
    expect((await db.select().from(groups))[0]?.botStatus).toBe('left');
    expect((await db.select().from(challenges))[0]?.status).toBe('cancelled');
  });

  it('records joins and leaves from chat_member and service messages', async () => {
    await insertGroup(db, { telegramChatId: chat.id });
    await post(chatMemberUpdate({ chat, from: alice, user: bob, newStatus: 'member' }));
    let [member] = await db.select().from(groupMembers);
    expect(member?.status).toBe('member');
    expect(member?.verifiedAt).not.toBeNull();
    await post(serviceUpdate(chat, bob, { left_chat_member: bob }));
    [member] = await db.select().from(groupMembers);
    expect(member?.status).toBe('left');
    await post(serviceUpdate(chat, alice, { new_chat_members: [carol] }));
    expect(await db.select().from(groupMembers)).toHaveLength(2);
  });

  it('follows a supergroup migration and a private write-access grant', async () => {
    const basic = { id: -12345, type: 'group' as const, title: 'Old' };
    await insertGroup(db, { telegramChatId: basic.id, type: 'group' });
    await post(serviceUpdate(basic, alice, { migrate_to_chat_id: -1009999 }));
    expect((await db.select().from(groups))[0]?.telegramChatId).toBe(-1009999);
    await post(serviceUpdate(privateChat(bob), bob, { write_access_allowed: { from_request: true } }));
    expect((await db.select().from(users))[0]?.dmAllowed).toBe(true);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/bot.test.ts`
Expected: FAIL — cannot load `../../src/bot/bot`.

- [ ] **Step 5: Write the implementation**

`apps/server/src/bot/rateLimit.ts`:

```ts
/** Sliding-window limiter kept in memory; one process at v1 (spec §4.3), so no table is needed. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
```

`apps/server/src/bot/replies.ts`:

```ts
import { t, type MessageKey, type MessageParams } from '@group-chess/shared';
import type { Deps } from '../domain/deps';
import { isDomainError } from '../domain/errors';
import { getUserById } from '../domain/users';

/** The one-line command replies of spec §5.5, chosen from a DomainError's reason. */
export function replyFor(error: unknown): { key: MessageKey; params: MessageParams } | null {
  if (!isDomainError(error)) return null;
  const name = String(error.details.name ?? '');
  const count = Number(error.details.count ?? 0);
  switch (error.details.reason) {
    case 'self':
      return { key: 'reply.self', params: {} };
    case 'blocked':
    case 'opponent_gone':
      return { key: 'reply.blocked', params: {} };
    case 'pending_limit':
      return { key: 'reply.pending_limit', params: { count } };
    case 'active_limit':
      return { key: 'reply.active_limit', params: { name, count } };
    case 'pair_limit':
      return { key: 'reply.pair_limit', params: { name, count } };
    case 'open_disabled':
      return { key: 'reply.open_disabled', params: {} };
    default:
      return null;
  }
}

/** Private toasts for callback taps (spec §11); null means "answer silently, rethrow". */
export async function alertFor(
  deps: Deps,
  error: unknown,
  action: 'accept_challenge' | 'decline_challenge' | 'rematch',
): Promise<string | null> {
  if (!isDomainError(error)) return null;
  switch (error.details.reason) {
    case 'not_your_challenge': {
      const opponentId = error.details.opponentId;
      const opponent = typeof opponentId === 'number' ? await getUserById(deps.db, opponentId) : null;
      return t('alert.not_your_challenge', { name: opponent?.firstName ?? 'the challenged player' });
    }
    case 'own_challenge':
      return t('alert.own_challenge');
    case 'accepted_first':
      return t('alert.accepted_first');
    case 'challenge_gone':
      return t('alert.challenge_gone');
    default: {
      const reply = replyFor(error);
      if (reply) return t(reply.key, reply.params);
      if (action === 'rematch' && error.code === 'forbidden') return t('alert.only_players_rematch');
      if (error.code === 'not_found' || error.code === 'expired' || error.code === 'stale_state') {
        return t('alert.challenge_gone');
      }
      return null;
    }
  }
}
```

`apps/server/src/domain/groupLifecycle.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import { challenges } from '../db/schema';
import type { Deps } from './deps';
import { getGroupByChatId, setBotMembership } from './groups';

/** Spec §5.8: the bot left, so pending challenges end and no card is edited. */
export async function cancelPendingChallengesForGroup(deps: Deps, groupId: number): Promise<number> {
  const rows = await deps.db
    .update(challenges)
    .set({ status: 'cancelled', resolvedAt: sql`now()` })
    .where(and(eq(challenges.groupId, groupId), eq(challenges.status, 'pending')))
    .returning({ id: challenges.id });
  return rows.length;
}

export async function markBotLeft(deps: Deps, telegramChatId: number): Promise<void> {
  const group = await getGroupByChatId(deps.db, telegramChatId);
  if (!group) return;
  await setBotMembership(deps.db, group.id, { botStatus: 'left', botIsAdmin: false, botCanPin: false });
  await cancelPendingChallengesForGroup(deps, group.id);
}
```

`apps/server/src/bot/bot.ts`:

```ts
import { decodeCallbackData, t, type GroupSettings, type MessageKey, type MessageParams } from '@group-chess/shared';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, type Context } from 'grammy';
import type { Chat, User } from 'grammy/types';
import type { Config } from '../config';
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  createRematch,
  declineChallenge,
  getChallengeByPublicId,
} from '../domain/challenges';
import type { Deps } from '../domain/deps';
import { DomainError } from '../domain/errors';
import { requireGameByPublicId } from '../domain/games';
import { cancelPendingChallengesForGroup } from '../domain/groupLifecycle';
import {
  ensureGroup,
  getGroupByChatId,
  migrateChatId,
  setBotMembership,
  settingsOf,
  type TelegramChatInfo,
} from '../domain/groups';
import { markLeft, touchMember } from '../domain/members';
import { ensureUser, setDmAllowed, type TelegramUserInfo } from '../domain/users';
import { enqueue } from '../jobs/queue';
import { miniAppLink } from '../telegram/links';
import { RateLimiter } from './rateLimit';
import { alertFor, replyFor } from './replies';

type GroupChat = Chat.GroupChat | Chat.SupergroupChat;

const userInfo = (user: User): TelegramUserInfo => ({
  telegramUserId: user.id,
  firstName: user.first_name,
  username: user.username ?? null,
  languageCode: user.language_code ?? null,
});

const chatInfo = (chat: GroupChat): TelegramChatInfo => ({
  telegramChatId: chat.id,
  title: chat.title,
  type: chat.type,
  isForum: chat.type === 'supergroup' && chat.is_forum === true,
});

/** Cards go to the topic the challenge was made in, or to the configured fixed topic (spec §5.8). */
function cardThread(settings: GroupSettings, originThread: number | null): number | null {
  return settings.cardTopicMode === 'fixed' ? settings.fixedTopicId : originThread;
}

function isGroupChat(chat: Chat): chat is GroupChat {
  return chat.type === 'group' || chat.type === 'supergroup';
}

export async function createBot(deps: Deps, config: Config): Promise<Bot> {
  const bot = new Bot(
    config.BOT_TOKEN,
    config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : {},
  );
  bot.api.config.use(apiThrottler());
  await bot.init();
  const linkLimiter = new RateLimiter(1, 60_000);

  const sendLine = (chatId: number, threadId: number | null, key: MessageKey, params: MessageParams, extra: { replyToMessageId?: number; buttons?: { text: string; url: string }[] } = {}) =>
    enqueue(deps.db, { kind: 'send_message', payload: { chatId, threadId, text: t(key, params), ...extra } });

  const groupOnly = bot.chatType(['group', 'supergroup']);

  groupOnly.command('play', async (ctx) => {
    const from = ctx.from;
    if (!from || from.is_bot || ctx.msg.sender_chat) return;
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    const user = await ensureUser(deps.db, userInfo(from));
    await touchMember(deps.db, group.id, user.id);
    const threadId = ctx.msg.is_topic_message ? (ctx.msg.message_thread_id ?? null) : null;
    const reply = (key: MessageKey, params: MessageParams = {}) =>
      sendLine(ctx.chat.id, threadId, key, params, { replyToMessageId: ctx.msg.message_id });
    const target = ctx.msg.reply_to_message;
    let opponentId: number | null = null;
    if (target) {
      if (target.sender_chat || !target.from) return reply('reply.anonymous');
      if (target.from.is_bot) return reply('reply.bot');
      if (target.from.id === from.id) return reply('reply.self');
      const opponent = await ensureUser(deps.db, userInfo(target.from));
      await touchMember(deps.db, group.id, opponent.id);
      opponentId = opponent.id;
    }
    const settings = settingsOf(group);
    try {
      await createChallenge(deps, {
        groupId: group.id,
        challengerId: user.id,
        opponentId,
        timePerMove: settings.defaultTimePerMove,
        colour: 'random',
        rated: settings.ratedDefault,
        threadId: cardThread(settings, threadId),
      });
    } catch (error) {
      const line = replyFor(error);
      if (!line) throw error;
      await reply(line.key, line.params);
    }
  });

  const linkCommand = (kind: 'lobby' | 'settings') => async (ctx: Context & { chat: GroupChat; msg: NonNullable<Context['msg']> }) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (!linkLimiter.allow(`${kind}:${ctx.chat.id}`)) return;
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await touchMember(deps.db, group.id, user.id);
    const threadId = ctx.msg.is_topic_message ? (ctx.msg.message_thread_id ?? null) : null;
    await sendLine(ctx.chat.id, threadId, kind === 'lobby' ? 'command.chess' : 'command.settings', {}, {
      buttons: [
        {
          text: t(kind === 'lobby' ? 'button.open_chess' : 'button.open_settings'),
          url: miniAppLink(config, { kind, groupId: group.publicId }),
        },
      ],
    });
  };
  groupOnly.command('chess', linkCommand('lobby'));
  groupOnly.command('settings', linkCommand('settings'));

  bot.chatType('private').command('start', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await setDmAllowed(deps.db, user.id, true);
    await sendLine(ctx.chat.id, null, 'dm.start', {}, {
      buttons: [{ text: t('button.open_chess'), url: miniAppLink(config) }],
    });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) return ctx.answerCallbackQuery();
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    const chat = ctx.callbackQuery.message?.chat;
    if (chat && isGroupChat(chat)) {
      const group = await getGroupByChatId(deps.db, chat.id);
      if (group) await touchMember(deps.db, group.id, user.id);
    }
    try {
      if (data.action === 'rematch') {
        const game = await requireGameByPublicId(deps.db, data.gameId);
        await createRematch(deps, { gameId: game.id, userId: user.id });
      } else {
        const challenge = await getChallengeByPublicId(deps.db, data.challengeId);
        if (!challenge) throw new DomainError('not_found', 'challenge not found');
        if (data.action === 'accept_challenge') {
          await acceptChallenge(deps, { challengeId: challenge.id, userId: user.id });
        } else if (challenge.challengerId === user.id) {
          await cancelChallenge(deps, { challengeId: challenge.id, userId: user.id });
        } else {
          await declineChallenge(deps, { challengeId: challenge.id, userId: user.id });
        }
      }
      await ctx.answerCallbackQuery();
    } catch (error) {
      const text = await alertFor(deps, error, data.action);
      if (text === null) throw error;
      await ctx.answerCallbackQuery({ text, show_alert: true });
    }
  });

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const status = update.new_chat_member.status;
    if (update.chat.type === 'private') {
      const user = await ensureUser(deps.db, userInfo(update.from));
      await setDmAllowed(deps.db, user.id, status === 'member');
      return;
    }
    if (!isGroupChat(update.chat)) return;
    const group = await ensureGroup(deps.db, chatInfo(update.chat));
    if (status === 'member' || status === 'administrator') {
      const member = update.new_chat_member;
      const canPin = member.status === 'administrator' && member.can_pin_messages === true;
      await setBotMembership(deps.db, group.id, { botStatus: status, botIsAdmin: status === 'administrator', botCanPin: canPin });
      if (!update.from.is_bot) {
        const adder = await ensureUser(deps.db, userInfo(update.from));
        await touchMember(deps.db, group.id, adder.id);
      }
      const old = update.old_chat_member.status;
      if (old === 'left' || old === 'kicked') {
        await enqueue(deps.db, { kind: 'send_welcome', payload: { groupId: group.id }, dedupKey: `welcome:${group.publicId}` });
      }
    } else if (status === 'left' || status === 'kicked') {
      await setBotMembership(deps.db, group.id, { botStatus: 'left', botIsAdmin: false, botCanPin: false });
      await cancelPendingChallengesForGroup(deps, group.id);
    }
  });

  bot.on('chat_member', async (ctx) => {
    const update = ctx.chatMember;
    if (!isGroupChat(update.chat)) return;
    const group = await getGroupByChatId(deps.db, update.chat.id);
    const target = update.new_chat_member.user;
    if (!group || target.is_bot) return;
    const user = await ensureUser(deps.db, userInfo(target));
    const member = update.new_chat_member;
    const present =
      member.status === 'member' ||
      member.status === 'administrator' ||
      member.status === 'creator' ||
      (member.status === 'restricted' && member.is_member);
    if (present) await touchMember(deps.db, group.id, user.id, { verified: true });
    else await markLeft(deps.db, group.id, user.id);
  });

  groupOnly.on('message:new_chat_members', async (ctx) => {
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    for (const joined of ctx.msg.new_chat_members) {
      if (joined.is_bot) continue;
      const user = await ensureUser(deps.db, userInfo(joined));
      await touchMember(deps.db, group.id, user.id);
    }
  });

  groupOnly.on('message:left_chat_member', async (ctx) => {
    const left = ctx.msg.left_chat_member;
    const group = await getGroupByChatId(deps.db, ctx.chat.id);
    if (!group || left.is_bot) return;
    const user = await ensureUser(deps.db, userInfo(left));
    await markLeft(deps.db, group.id, user.id);
  });

  groupOnly.on('message:migrate_to_chat_id', async (ctx) => {
    await migrateChatId(deps.db, ctx.chat.id, ctx.msg.migrate_to_chat_id);
  });

  bot.chatType('private').on('message:write_access_allowed', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await setDmAllowed(deps.db, user.id, true);
  });

  return bot;
}
```

`apps/server/src/bot/webhook.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { Hono } from 'hono';
import type { Config } from '../config';
import { telegramUpdates } from '../db/schema';
import type { Deps } from '../domain/deps';

const MAX_UPDATE_BYTES = 1_048_576;

/** Spec §5.2: secret header, update_id idempotency, 500 on failure so Telegram retries. */
export function webhookRoutes(bot: Bot, deps: Deps, config: Config): Hono {
  const app = new Hono();
  app.post('/telegram/webhook', async (c) => {
    if (c.req.header('x-telegram-bot-api-secret-token') !== config.WEBHOOK_SECRET) return c.body(null, 401);
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPDATE_BYTES) return c.body(null, 413);
    let update: Update;
    try {
      update = (await c.req.json()) as Update;
    } catch {
      return c.body(null, 400);
    }
    if (typeof update?.update_id !== 'number') return c.body(null, 400);
    const inserted = await deps.db
      .insert(telegramUpdates)
      .values({ updateId: update.update_id })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdates.updateId });
    if (inserted.length === 0) return c.body(null, 200);
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      await deps.db.delete(telegramUpdates).where(eq(telegramUpdates.updateId, update.update_id));
      deps.log.error({ err: error, updateId: update.update_id }, 'update handler failed');
      return c.body(null, 500);
    }
    return c.body(null, 200);
  });
  return app;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/bot.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 7: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): add the bot handlers behind an idempotent webhook"
```

---

### Task 3: Telegram job handlers and the membership ladder

**Files:**
- Create: `apps/server/src/telegram/views.ts`, `apps/server/src/telegram/membership.ts`, `apps/server/src/jobs/handlers/telegram.ts`
- Modify: `apps/server/src/jobs/handlers/index.ts` (export `telegramJobHandlers` alongside `coreJobHandlers`)
- Test: `apps/server/test/integration/telegram-handlers.test.ts`, `apps/server/test/integration/membership.test.ts`

**Interfaces:**
- Consumes: Task 1 (`classifyTelegramError`, cards, links), Task 2 (`markBotLeft`, helpers), plan 2 domain (`getChallengeById`, `setChallengeMessage`, `requireGameById`, `listMoves`, `requireGroup`, `getUserById`, `setDmAllowed`, `getPlayerRating`, `getMember`, `touchMember`, `markLeft`, `migrateChatId`, `dbNow`), shared `formatTimeLeft`, labels.
- Produces: views — `personView(user: UserRow): PersonView`, `challengeCardView(tx, challenge): Promise<ChallengeCardView>`, `gameCardView(tx, game, config): Promise<GameCardView>`; membership — `class Membership { constructor(deps: Deps, api: TelegramApi); verify(group: GroupRow, user: UserRow): Promise<boolean>; isAdmin(group: GroupRow, user: UserRow): Promise<boolean>; invalidateAdmins(groupId: number): void; clearCaches(): void }`; handlers — `type TelegramHandlerContext = { deps: Deps; api: TelegramApi; config: Config }`, `telegramJobHandlers(ctx): JobHandlers` for kinds `send_challenge_card`, `edit_card`, `send_dm`, `send_welcome`, `send_message`; `telegramFailureOutcome(failure): JobResult | 'throw'`.
- `send_dm` payload: `{ userId: number; template: 'turn' | 'challenge' | 'reminder' | 'game_end'; gameId?: number; challengeId?: number }`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/integration/telegram-handlers.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, groups, jobs, users } from '../../src/db/schema';
import { enqueue } from '../../src/jobs/queue';
import { telegramJobHandlers } from '../../src/jobs/handlers/telegram';
import { JobWorker } from '../../src/jobs/worker';
import { createTelegramApi } from '../../src/telegram/client';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertChallenge, insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;
const CHAT = -1001000000002;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

beforeAll(async () => {
  fake = await FakeTelegram.start();
  const config = testConfig({ TELEGRAM_API_ROOT: fake.url });
  const api = createTelegramApi(config, { apiRoot: fake.url });
  worker = new JobWorker({ db, log: deps.log, handlers: telegramJobHandlers({ deps, api, config }), workerId: 't' });
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

async function people() {
  const group = await insertGroup(db, { telegramChatId: CHAT, botStatus: 'administrator', botIsAdmin: true, botCanPin: true });
  const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice', username: 'alice', dmAllowed: true });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
  return { group, alice, bob };
}
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);

describe('send_challenge_card', () => {
  it('posts the card to the topic and stores the message id', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, { threadId: 5 });
    await enqueue(db, { kind: 'send_challenge_card', payload: { challengeId: challenge.id }, dedupKey: `card:send:${challenge.publicId}` });
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body).toMatchObject({ chat_id: CHAT, message_thread_id: 5, text: '♟ Alice challenges Bob\n1 day per move · Rated' });
    expect((call?.body.entities as unknown[])[0]).toMatchObject({ type: 'text_mention', offset: 19, length: 3 });
    expect((await db.select().from(challenges))[0]?.messageId).toBe(101);
  });

  it('hands the message id to a game accepted before the card was sent', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, { status: 'accepted', gameId: game.id });
    await enqueue(db, { kind: 'send_challenge_card', payload: { challengeId: challenge.id } });
    await worker.runOnce();
    expect((await db.select().from(games))[0]?.cardMessageId).toBe(101);
    expect((await jobRows()).filter((job) => job.doneAt === null).map((job) => job.dedupKey)).toEqual([`card:g:${game.publicId}`]);
  });
});

describe('edit_card', () => {
  it('edits the running card in place', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { cardMessageId: 900, cardThreadId: 5, fen: AFTER_E4, plyCount: 1 });
    await enqueue(db, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
    await worker.runOnce();
    const [call] = fake.callsTo('editMessageText');
    expect(call?.body).toMatchObject({ chat_id: CHAT, message_id: 900, text: '♟ Alice (1500?) vs Bob (1500?)\n1 day per move · Rated · Move 1 · Bob to move' });
  });

  it('retries an edit for a card that has no message id yet', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    await enqueue(db, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
    await worker.runOnce();
    const [job] = await jobRows();
    expect(job).toMatchObject({ attempts: 1, doneAt: null });
    expect(job?.lastError).toMatch(/no message id/);
    expect(fake.callsTo('editMessageText')).toHaveLength(0);
  });

  it('treats "not modified" as done, marks a vanished card missing and waits out a 429', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { cardMessageId: 900 });
    const run = async () => {
      await enqueue(db, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
      await worker.runOnce();
      return (await jobRows()).at(-1)!;
    };
    fake.failNext('editMessageText', { error_code: 400, description: 'Bad Request: message is not modified: same' });
    expect((await run()).doneAt).not.toBeNull();
    fake.failNext('editMessageText', { error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } });
    const waiting = await run();
    expect(waiting.doneAt).toBeNull();
    expect(waiting.lastError).toMatch(/429/);
    await db.delete(jobs);
    fake.failNext('editMessageText', { error_code: 400, description: 'Bad Request: message to edit not found' });
    expect((await run()).doneAt).not.toBeNull();
    expect((await db.select().from(games))[0]?.cardMissing).toBe(true);
  });

  it('renders the challenge card when the challenge is still pending', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, { messageId: 700, status: 'declined' });
    await enqueue(db, { kind: 'edit_card', payload: { challengeId: challenge.id }, dedupKey: `card:ch:${challenge.publicId}` });
    await worker.runOnce();
    expect(fake.callsTo('editMessageText')[0]?.body).toMatchObject({ message_id: 700, text: '♟ Alice vs Bob · Declined' });
  });
});

describe('send_dm', () => {
  it('sends the turn DM with both buttons and skips users who declined DMs', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { cardMessageId: 900, fen: AFTER_E4, plyCount: 1 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await enqueue(db, { kind: 'send_dm', payload: { userId: bob.id, template: 'turn', gameId: game.id } });
    await enqueue(db, { kind: 'send_dm', payload: { userId: alice.id, template: 'turn', gameId: game.id } });
    await worker.runOnce();
    const sent = fake.callsTo('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ chat_id: 11, text: 'Your move vs Bob · 1. e4 · 23 h left' });
    expect(sent[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '♟ Open game', url: `https://t.me/TestChessBot/chess?startapp=g_${game.publicId}` }],
        [{ text: 'Go to group', url: 'https://t.me/c/1000000002/900' }],
      ],
    });
  });

  it('sends the challenge DM and turns DMs off when the user blocked the bot', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, bob.id, alice.id);
    await enqueue(db, { kind: 'send_dm', payload: { userId: alice.id, template: 'challenge', challengeId: challenge.id } });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({ chat_id: 11, text: 'Bob challenges you · 1 day per move · Rated' });
    fake.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    await enqueue(db, { kind: 'send_dm', payload: { userId: alice.id, template: 'challenge', challengeId: challenge.id } });
    await worker.runOnce();
    expect((await db.select().from(users).where(eq(users.id, alice.id)))[0]?.dmAllowed).toBe(false);
    expect((await jobRows()).every((job) => job.doneAt !== null)).toBe(true);
  });

  it('sends the game-end DM with the rating change and the analysis link', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished', result: '1-0', endReason: 'resignation', finishedAt: new Date(), plyCount: 1, fen: AFTER_E4,
      whiteRatingBefore: 1500, whiteRatingAfter: 1534.4, whiteRdBefore: 350, whiteRdAfter: 290,
      blackRatingBefore: 1500, blackRatingAfter: 1465.6, blackRdBefore: 350, blackRdAfter: 290,
    });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await enqueue(db, { kind: 'send_dm', payload: { userId: alice.id, template: 'game_end', gameId: game.id } });
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body.text).toBe('1-0 vs Bob · Resignation · 1500? → 1534?');
    expect((call?.body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.flat().map((b) => b.text)).toEqual(['♟ Open game', '🔍 Analyse on Lichess']);
  });
});

describe('send_welcome and send_message', () => {
  it('posts and pins the welcome card and stores its id', async () => {
    const { group } = await people();
    await enqueue(db, { kind: 'send_welcome', payload: { groupId: group.id } });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '♟ Open Chess', url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}` }]],
    });
    expect(fake.callsTo('pinChatMessage')[0]?.body).toMatchObject({ chat_id: CHAT, message_id: 101, disable_notification: true });
    expect((await db.select().from(groups))[0]?.welcomeMessageId).toBe(101);
  });

  it('sends a one-line reply in the thread and marks the group left when the bot was kicked', async () => {
    await people();
    await enqueue(db, { kind: 'send_message', payload: { chatId: CHAT, threadId: 5, text: 'Nope.', replyToMessageId: 44 } });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({ chat_id: CHAT, message_thread_id: 5, text: 'Nope.', reply_parameters: { message_id: 44, allow_sending_without_reply: true } });
    fake.failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' });
    await enqueue(db, { kind: 'send_message', payload: { chatId: CHAT, threadId: null, text: 'Hi' } });
    await worker.runOnce();
    expect((await db.select().from(groups))[0]?.botStatus).toBe('left');
  });
});
```

`apps/server/test/integration/membership.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { groupMembers } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { createTelegramApi } from '../../src/telegram/client';
import { Membership } from '../../src/telegram/membership';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let membership: Membership;

beforeAll(async () => {
  fake = await FakeTelegram.start();
  membership = new Membership(deps, createTelegramApi(testConfig(), { apiRoot: fake.url }));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
  membership.clearCaches();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

describe('Membership.verify', () => {
  it('asks Telegram, records the verdict and serves it from the cache afterwards', async () => {
    const group = await insertGroup(db);
    const user = await insertUser(db, { telegramUserId: 11 });
    fake.members.set(11, 'member');
    expect(await membership.verify(group, user)).toBe(true);
    expect(await membership.verify(group, user)).toBe(true);
    expect(fake.callsTo('getChatMember')).toHaveLength(1);
    expect((await db.select().from(groupMembers))[0]?.verifiedAt).not.toBeNull();
  });

  it('marks a user who left and refuses them', async () => {
    const group = await insertGroup(db);
    const user = await insertUser(db, { telegramUserId: 11 });
    await touchMember(db, group.id, user.id);
    fake.members.set(11, 'kicked');
    expect(await membership.verify(group, user)).toBe(false);
    expect((await db.select().from(groupMembers))[0]?.status).toBe('left');
  });

  it('falls back to the bot’s own evidence when Telegram cannot answer', async () => {
    const group = await insertGroup(db);
    const seen = await insertUser(db, { telegramUserId: 11 });
    const stranger = await insertUser(db, { telegramUserId: 12 });
    await touchMember(db, group.id, seen.id);
    fake.memberError = { error_code: 400, description: 'Bad Request: user not found' };
    expect(await membership.verify(group, seen)).toBe(true);
    expect(await membership.verify(group, stranger)).toBe(false);
  });

  it('accepts restricted members who are still in the group', async () => {
    const group = await insertGroup(db);
    const user = await insertUser(db, { telegramUserId: 11 });
    fake.members.set(11, 'restricted');
    expect(await membership.verify(group, user)).toBe(true);
  });
});

describe('Membership.isAdmin', () => {
  it('uses getChatAdministrators and caches the list for a minute', async () => {
    const group = await insertGroup(db);
    const admin = await insertUser(db, { telegramUserId: 11 });
    const member = await insertUser(db, { telegramUserId: 12 });
    fake.admins = [11];
    expect(await membership.isAdmin(group, admin)).toBe(true);
    expect(await membership.isAdmin(group, member)).toBe(false);
    expect(fake.callsTo('getChatAdministrators')).toHaveLength(1);
    membership.invalidateAdmins(group.id);
    await membership.isAdmin(group, member);
    expect(fake.callsTo('getChatAdministrators')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project server apps/server/test/integration/telegram-handlers.test.ts apps/server/test/integration/membership.test.ts`
Expected: FAIL — cannot load `../../src/jobs/handlers/telegram` and `../../src/telegram/membership`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/telegram/views.ts`:

```ts
import { analysisUrl, ratingLabel, isProvisional, sideToMove, type TimePerMove } from '@group-chess/shared';
import type { Config } from '../config';
import type { DbOrTx } from '../db/client';
import type { ChallengeRow, GameRow, UserRow } from '../db/schema';
import { listMoves } from '../domain/games';
import { getPlayerRating } from '../domain/ratings';
import { displayName, requireUser } from '../domain/users';
import type { ChallengeCardView, GameCardView, PersonView } from './cards';
import { miniAppLink } from './links';

export function personView(user: UserRow): PersonView {
  return {
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    telegramUserId: user.deletedAt ? null : user.telegramUserId,
  };
}

export async function challengeCardView(tx: DbOrTx, challenge: ChallengeRow): Promise<ChallengeCardView> {
  const challenger = await requireUser(tx, challenge.challengerId);
  const opponent = challenge.opponentId === null ? null : await requireUser(tx, challenge.opponentId);
  return {
    publicId: challenge.publicId,
    status: challenge.status,
    challenger: personView(challenger),
    opponent: opponent ? personView(opponent) : null,
    timePerMove: challenge.timePerMove as TimePerMove,
    rated: challenge.rated,
    challengerColour: challenge.challengerColour,
  };
}

async function ratingView(
  tx: DbOrTx,
  game: GameRow,
  userId: number,
  before: number | null,
  after: number | null,
  rdBefore: number | null,
  rdAfter: number | null,
): Promise<{ before: string; after: string | null } | null> {
  if (!game.rated) return null;
  if (game.status === 'finished' && before !== null && after !== null && rdBefore !== null && rdAfter !== null) {
    return { before: ratingLabel(before, isProvisional(rdBefore)), after: ratingLabel(after, isProvisional(rdAfter)) };
  }
  const current = await getPlayerRating(tx, game.groupId, userId);
  return { before: ratingLabel(current?.rating ?? 1500, isProvisional(current?.rd ?? 350)), after: null };
}

export async function gameCardView(tx: DbOrTx, game: GameRow, config: Config): Promise<GameCardView> {
  const [white, black] = await Promise.all([requireUser(tx, game.whiteId), requireUser(tx, game.blackId)]);
  const moves = game.status === 'finished' && game.plyCount > 0 ? await listMoves(tx, game.id) : [];
  return {
    publicId: game.publicId,
    status: game.status,
    white: personView(white),
    black: personView(black),
    timePerMove: game.timePerMove as TimePerMove,
    rated: game.rated,
    plyCount: game.plyCount,
    sideToMove: sideToMove(game.fen),
    result: game.result,
    endReason: game.endReason,
    voided: game.voidedAt !== null,
    whiteRating: await ratingView(tx, game, game.whiteId, game.whiteRatingBefore, game.whiteRatingAfter, game.whiteRdBefore, game.whiteRdAfter),
    blackRating: await ratingView(tx, game, game.blackId, game.blackRatingBefore, game.blackRatingAfter, game.blackRdBefore, game.blackRdAfter),
    abortedBy: null,
    analysisUrl: moves.length > 0 ? analysisUrl(moves.map((move) => move.san)) : null,
    lichessUrl: game.lichessUrl,
    openLink: miniAppLink(config, { kind: 'game', gameId: game.publicId }),
  };
}
```

`apps/server/src/telegram/membership.ts`:

```ts
import type { GroupRow, UserRow } from '../db/schema';
import type { Deps } from '../domain/deps';
import { getMember, markLeft, touchMember } from '../domain/members';
import type { TelegramApi } from './client';

const VERDICT_TTL_MS = 10 * 60_000;
const ADMIN_TTL_MS = 60_000;

/** The verification ladder of spec §5.6 and the admin check used on every settings request. */
export class Membership {
  private readonly admins = new Map<number, { until: number; ids: Set<number> }>();

  constructor(
    private readonly deps: Deps,
    private readonly api: TelegramApi,
  ) {}

  clearCaches(): void {
    this.admins.clear();
  }

  invalidateAdmins(groupId: number): void {
    this.admins.delete(groupId);
  }

  async verify(group: GroupRow, user: UserRow): Promise<boolean> {
    if (user.deletedAt || user.telegramUserId === null) return false;
    const member = await getMember(this.deps.db, group.id, user.id);
    if (member?.verifiedAt && Date.now() - member.verifiedAt.getTime() < VERDICT_TTL_MS) {
      return member.status === 'member';
    }
    try {
      const result = await this.api.getChatMember(group.telegramChatId, user.telegramUserId);
      const present =
        result.status === 'member' ||
        result.status === 'administrator' ||
        result.status === 'creator' ||
        (result.status === 'restricted' && result.is_member);
      if (present) {
        await touchMember(this.deps.db, group.id, user.id, { verified: true });
        return true;
      }
      await markLeft(this.deps.db, group.id, user.id);
      return false;
    } catch (error) {
      this.deps.log.debug({ err: error, groupId: group.id }, 'getChatMember failed; using own evidence');
      return member?.status === 'member';
    }
  }

  async isAdmin(group: GroupRow, user: UserRow): Promise<boolean> {
    if (user.telegramUserId === null) return false;
    const cached = this.admins.get(group.id);
    if (cached && cached.until > Date.now()) return cached.ids.has(user.telegramUserId);
    try {
      const admins = await this.api.getChatAdministrators(group.telegramChatId);
      const ids = new Set(admins.map((admin) => admin.user.id));
      this.admins.set(group.id, { until: Date.now() + ADMIN_TTL_MS, ids });
      return ids.has(user.telegramUserId);
    } catch (error) {
      this.deps.log.warn({ err: error, groupId: group.id }, 'getChatAdministrators failed');
      return false;
    }
  }
}
```

`apps/server/src/jobs/handlers/telegram.ts`:

```ts
import {
  endReasonLabel,
  formatTimeLeft,
  isProvisional,
  ratedLabel,
  ratingLabel,
  resultLabel,
  sideToMove,
  t,
  timePerMoveLabel,
  type TimePerMove,
} from '@group-chess/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { InlineKeyboardButton } from 'grammy/types';
import { z } from 'zod';
import type { Config } from '../../config';
import { dbNow } from '../../db/client';
import { games, groups, type GameRow, type UserRow } from '../../db/schema';
import { getChallengeById, setChallengeMessage } from '../../domain/challenges';
import type { Deps } from '../../domain/deps';
import { listMoves, requireGameById } from '../../domain/games';
import { markBotLeft } from '../../domain/groupLifecycle';
import { migrateChatId, requireGroup } from '../../domain/groups';
import { getUserById, requireUser, setDmAllowed } from '../../domain/users';
import { renderChallengeCard, renderGameCard, renderWelcomeCard, type RenderedMessage } from '../../telegram/cards';
import { classifyTelegramError, type TelegramApi, type TelegramFailure } from '../../telegram/client';
import { groupMessageLink, miniAppLink } from '../../telegram/links';
import { challengeCardView, gameCardView } from '../../telegram/views';
import { enqueue } from '../queue';
import type { JobHandler, JobHandlers, JobResult } from '../types';

export type TelegramHandlerContext = { deps: Deps; api: TelegramApi; config: Config };

type CallResult<T> = { ok: true; value: T } | { ok: false; failure: TelegramFailure };

/** Runs one Bot API call and applies the chat-level consequences of spec §11. */
async function call<T>(ctx: TelegramHandlerContext, chatId: number | null, fn: () => Promise<T>): Promise<CallResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const failure = classifyTelegramError(error);
    if (!failure) throw error;
    if (chatId !== null && failure.kind === 'chat_gone') await markBotLeft(ctx.deps, chatId);
    if (chatId !== null && failure.kind === 'migrated') await migrateChatId(ctx.deps.db, chatId, failure.newChatId);
    return { ok: false, failure };
  }
}

/** Job outcome for a failure; `'throw'` means count an attempt and back off. */
export function telegramFailureOutcome(failure: TelegramFailure): JobResult | 'throw' {
  switch (failure.kind) {
    case 'retry_after':
      return { outcome: 'retry', delayMs: failure.seconds * 1000, error: `telegram 429: retry after ${failure.seconds}s` };
    case 'migrated':
      return { outcome: 'retry', delayMs: 1000, error: 'chat migrated' };
    case 'not_modified':
    case 'message_gone':
    case 'blocked':
    case 'chat_gone':
      return { outcome: 'done' };
    case 'other':
      return 'throw';
  }
}

function settle(result: CallResult<unknown>): JobResult {
  if (result.ok) return { outcome: 'done' };
  const outcome = telegramFailureOutcome(result.failure);
  if (outcome === 'throw') throw new Error(`telegram: ${(result.failure as { description: string }).description}`);
  return outcome;
}

const gameCardPayload = z.object({ gameId: z.number().int() });
const challengePayload = z.object({ challengeId: z.number().int() });
const cardPayload = z.union([gameCardPayload, challengePayload]);
const dmPayload = z.object({
  userId: z.number().int(),
  template: z.enum(['turn', 'challenge', 'reminder', 'game_end']),
  gameId: z.number().int().optional(),
  challengeId: z.number().int().optional(),
});
const messagePayload = z.object({
  chatId: z.number().int(),
  threadId: z.number().int().nullable().optional(),
  text: z.string().min(1),
  replyToMessageId: z.number().int().optional(),
  buttons: z.array(z.object({ text: z.string(), url: z.string() })).optional(),
});

function editGameCardJob(game: Pick<GameRow, 'id' | 'publicId'>) {
  return { kind: 'edit_card' as const, payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` };
}

async function editMessage(ctx: TelegramHandlerContext, chatId: number, messageId: number, rendered: RenderedMessage) {
  return call(ctx, chatId, () =>
    ctx.api.editMessageText(chatId, messageId, rendered.text, {
      entities: rendered.entities,
      reply_markup: rendered.reply_markup,
    }),
  );
}

async function editGameCard(ctx: TelegramHandlerContext, gameId: number): Promise<JobResult> {
  const game = await requireGameById(ctx.deps.db, gameId);
  if (game.cardMissing) return { outcome: 'done' };
  if (game.cardMessageId === null) throw new Error(`game ${game.id} has no message id yet`);
  const group = await requireGroup(ctx.deps.db, game.groupId);
  if (group.botStatus === 'left') return { outcome: 'done' };
  const rendered = renderGameCard(await gameCardView(ctx.deps.db, game, ctx.config));
  const result = await editMessage(ctx, group.telegramChatId, game.cardMessageId, rendered);
  if (!result.ok && result.failure.kind === 'message_gone') {
    await ctx.deps.db.update(games).set({ cardMissing: true }).where(eq(games.id, game.id));
  }
  return settle(result);
}

const sendChallengeCard = (ctx: TelegramHandlerContext): JobHandler => async ({ job }) => {
  const { challengeId } = challengePayload.parse(job.payload);
  const challenge = await getChallengeById(ctx.deps.db, challengeId);
  if (!challenge || challenge.messageId !== null) return { outcome: 'done' };
  const group = await requireGroup(ctx.deps.db, challenge.groupId);
  if (group.botStatus === 'left') return { outcome: 'done' };
  const rendered = renderChallengeCard(await challengeCardView(ctx.deps.db, challenge));
  const result = await call(ctx, group.telegramChatId, () =>
    ctx.api.sendMessage(group.telegramChatId, rendered.text, {
      entities: rendered.entities,
      reply_markup: rendered.reply_markup,
      message_thread_id: challenge.threadId ?? undefined,
    }),
  );
  if (!result.ok) return settle(result);
  const messageId = result.value.message_id;
  await ctx.deps.db.transaction(async (tx) => {
    await setChallengeMessage(tx, challenge.id, messageId);
    if (challenge.gameId !== null) {
      await tx
        .update(games)
        .set({ cardMessageId: messageId, cardThreadId: challenge.threadId })
        .where(and(eq(games.id, challenge.gameId), isNull(games.cardMessageId)));
      const [game] = await tx.select({ id: games.id, publicId: games.publicId }).from(games).where(eq(games.id, challenge.gameId));
      if (game) await enqueue(tx, editGameCardJob(game));
    } else if (challenge.status !== 'pending') {
      await enqueue(tx, { kind: 'edit_card', payload: { challengeId: challenge.id }, dedupKey: `card:ch:${challenge.publicId}` });
    }
  });
  return { outcome: 'done' };
};

const editCard = (ctx: TelegramHandlerContext): JobHandler => async ({ job }) => {
  const payload = cardPayload.parse(job.payload);
  if ('gameId' in payload) return editGameCard(ctx, payload.gameId);
  const challenge = await getChallengeById(ctx.deps.db, payload.challengeId);
  if (!challenge) return { outcome: 'done' };
  if (challenge.gameId !== null) return editGameCard(ctx, challenge.gameId);
  if (challenge.messageId === null) throw new Error(`challenge ${challenge.id} has no message id yet`);
  const group = await requireGroup(ctx.deps.db, challenge.groupId);
  if (group.botStatus === 'left') return { outcome: 'done' };
  const rendered = renderChallengeCard(await challengeCardView(ctx.deps.db, challenge));
  return settle(await editMessage(ctx, group.telegramChatId, challenge.messageId, rendered));
};

function moveLabel(ply: number, san: string): string {
  const number = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${number}. ${san}` : `${number}... ${san}`;
}

async function dmContent(
  ctx: TelegramHandlerContext,
  user: UserRow,
  payload: z.infer<typeof dmPayload>,
): Promise<{ text: string; buttons: InlineKeyboardButton[][] } | null> {
  const { config, deps } = ctx;
  if (payload.template === 'challenge') {
    if (payload.challengeId === undefined) return null;
    const challenge = await getChallengeById(deps.db, payload.challengeId);
    if (!challenge || challenge.status !== 'pending') return null;
    const challenger = await requireUser(deps.db, challenge.challengerId);
    const group = await requireGroup(deps.db, challenge.groupId);
    return {
      text: t('dm.challenge', {
        challenger: challenger.firstName,
        timePerMove: timePerMoveLabel(challenge.timePerMove as TimePerMove),
        rated: ratedLabel(challenge.rated),
      }),
      buttons: [[{ text: t('button.open'), url: miniAppLink(config, { kind: 'lobby', groupId: group.publicId }) }]],
    };
  }
  if (payload.gameId === undefined) return null;
  const game = await requireGameById(deps.db, payload.gameId);
  const opponentId = game.whiteId === user.id ? game.blackId : game.whiteId;
  const opponent = await requireUser(deps.db, opponentId);
  const group = await requireGroup(deps.db, game.groupId);
  const openGame: InlineKeyboardButton = { text: t('button.open_game'), url: miniAppLink(config, { kind: 'game', gameId: game.publicId }) };
  const groupLink = game.cardMessageId !== null ? groupMessageLink(group.telegramChatId, game.cardMessageId) : null;
  const goToGroup: InlineKeyboardButton[] = groupLink ? [{ text: t('button.go_to_group'), url: groupLink }] : [];

  if (payload.template === 'game_end') {
    if (game.status !== 'finished' || !game.result || !game.endReason) return null;
    const isWhite = game.whiteId === user.id;
    const before = isWhite ? game.whiteRatingBefore : game.blackRatingBefore;
    const after = isWhite ? game.whiteRatingAfter : game.blackRatingAfter;
    const rdBefore = isWhite ? game.whiteRdBefore : game.blackRdBefore;
    const rdAfter = isWhite ? game.whiteRdAfter : game.blackRdAfter;
    const params = { result: resultLabel(game.result), opponent: opponent.firstName, endReason: endReasonLabel(game.endReason) };
    const text =
      game.rated && before !== null && after !== null && rdBefore !== null && rdAfter !== null
        ? t('dm.game_end.rating', { ...params, before: ratingLabel(before, isProvisional(rdBefore)), after: ratingLabel(after, isProvisional(rdAfter)) })
        : t('dm.game_end', params);
    const moves = game.plyCount > 0 ? await listMoves(deps.db, game.id) : [];
    const analysis = game.lichessUrl ?? (moves.length > 0 ? (await import('@group-chess/shared')).analysisUrl(moves.map((m) => m.san)) : null);
    const buttons: InlineKeyboardButton[][] = [[openGame]];
    if (analysis && analysis.length <= 2000) buttons.push([{ text: t('button.analyse'), url: analysis }]);
    return { text, buttons };
  }

  if (game.status !== 'active') return null;
  const toMove = sideToMove(game.fen) === 'white' ? game.whiteId : game.blackId;
  if (toMove !== user.id) return null;
  const now = await dbNow(deps.db);
  const timeLeft = game.deadlineAt ? formatTimeLeft(game.deadlineAt.getTime() - now.getTime()) : null;
  if (payload.template === 'reminder') {
    if (!timeLeft) return null;
    return { text: t('dm.reminder', { timeLeft, opponent: opponent.firstName }), buttons: [[openGame], goToGroup] };
  }
  const last = (await listMoves(deps.db, game.id)).at(-1);
  const lastMove = last ? moveLabel(last.ply, last.san) : null;
  const key = lastMove ? (timeLeft ? 'dm.turn' : 'dm.turn.no_clock') : timeLeft ? 'dm.turn.first' : 'dm.turn.first_no_clock';
  return {
    text: t(key, { opponent: opponent.firstName, lastMove: lastMove ?? '', timeLeft: timeLeft ?? '' }),
    buttons: [[openGame], goToGroup],
  };
}

const sendDm = (ctx: TelegramHandlerContext): JobHandler => async ({ job }) => {
  const payload = dmPayload.parse(job.payload);
  const user = await getUserById(ctx.deps.db, payload.userId);
  if (!user || !user.dmAllowed || user.deletedAt || user.telegramUserId === null) return { outcome: 'done' };
  const content = await dmContent(ctx, user, payload);
  if (!content) return { outcome: 'done' };
  const chatId = user.telegramUserId;
  const result = await call(ctx, null, () =>
    ctx.api.sendMessage(chatId, content.text, { reply_markup: { inline_keyboard: content.buttons.filter((row) => row.length > 0) } }),
  );
  if (!result.ok && result.failure.kind === 'blocked') await setDmAllowed(ctx.deps.db, user.id, false);
  return settle(result);
};

const sendWelcome = (ctx: TelegramHandlerContext): JobHandler => async ({ job }) => {
  const { groupId } = z.object({ groupId: z.number().int() }).parse(job.payload);
  const group = await requireGroup(ctx.deps.db, groupId);
  if (group.botStatus === 'left') return { outcome: 'done' };
  const rendered = renderWelcomeCard(miniAppLink(ctx.config, { kind: 'lobby', groupId: group.publicId }));
  const result = await call(ctx, group.telegramChatId, () =>
    ctx.api.sendMessage(group.telegramChatId, rendered.text, { reply_markup: rendered.reply_markup }),
  );
  if (!result.ok) return settle(result);
  await ctx.deps.db.update(groups).set({ welcomeMessageId: result.value.message_id }).where(eq(groups.id, group.id));
  if (group.botCanPin) {
    await call(ctx, group.telegramChatId, () =>
      ctx.api.pinChatMessage(group.telegramChatId, result.value.message_id, { disable_notification: true }),
    );
  }
  return { outcome: 'done' };
};

const sendMessage = (ctx: TelegramHandlerContext): JobHandler => async ({ job }) => {
  const payload = messagePayload.parse(job.payload);
  const result = await call(ctx, payload.chatId, () =>
    ctx.api.sendMessage(payload.chatId, payload.text, {
      message_thread_id: payload.threadId ?? undefined,
      reply_parameters: payload.replyToMessageId ? { message_id: payload.replyToMessageId, allow_sending_without_reply: true } : undefined,
      reply_markup: payload.buttons ? { inline_keyboard: [payload.buttons] } : undefined,
    }),
  );
  return settle(result);
};

export function telegramJobHandlers(ctx: TelegramHandlerContext): JobHandlers {
  return {
    send_challenge_card: sendChallengeCard(ctx),
    edit_card: editCard(ctx),
    send_dm: sendDm(ctx),
    send_welcome: sendWelcome(ctx),
    send_message: sendMessage(ctx),
  };
}
```

In `apps/server/src/jobs/handlers/index.ts` add `export { telegramJobHandlers } from './telegram';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project server apps/server/test/integration/telegram-handlers.test.ts apps/server/test/integration/membership.test.ts`
Expected: PASS — 16 tests (handlers 11, membership 5).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add the Telegram job handlers and the membership ladder"
```

---

### Task 4: The API — launch authentication, sessions, error mapping, lobby queries, account routes, health and metrics

**Files:**
- Create: `apps/server/src/api/initData.ts`, `apps/server/src/api/session.ts`, `apps/server/src/api/context.ts`, `apps/server/src/api/validate.ts`, `apps/server/src/api/middleware.ts`, `apps/server/src/api/streams.ts`, `apps/server/src/api/launchRoute.ts`, `apps/server/src/api/routes/launch.ts`, `apps/server/src/api/routes/me.ts`, `apps/server/src/api/routes/health.ts`, `apps/server/src/api/app.ts`, `apps/server/src/domain/summaries.ts`, `apps/server/src/domain/lobby.ts`, `apps/server/src/domain/admin.ts`, `apps/server/src/domain/account.ts`, `apps/server/src/metrics.ts`, `apps/server/test/helpers/initData.ts`, `apps/server/test/helpers/api.ts`
- Modify: `apps/server/package.json` (add `@hono/node-server`, `@hono/zod-validator`, `prom-client`), `packages/shared/src/protocol/errors.ts` (add the `internal` code → 500), `packages/shared/test/protocol/errors.test.ts` (one row)
- Test: `apps/server/test/unit/initData.test.ts`, `apps/server/test/unit/session.test.ts`, `apps/server/test/integration/api-auth.test.ts`

**Interfaces:**
- Consumes: plan 2 domain, Task 3 `Membership`, Task 2 `RateLimiter`, shared schemas (`LaunchRequestSchema`, `LaunchResponse`, `LobbyDto`, `GameSummary`, `ChallengeDto`, `MeGroupsDto`, `PlayerPageDto`, `FinishedPageDto`, `GroupSettingsDto`, `PrefsUpdateRequestSchema`, `TelemetryRequestSchema`, `apiErrorBody`, `HTTP_STATUS_BY_ERROR_CODE`).
- Produces: `validateInitData(raw, botToken, { now?, maxAgeSeconds? }): ParsedInitData`, `initDataHash(params: URLSearchParams, botToken): string`, `INIT_DATA_MAX_AGE_SECONDS = 86400`; `issueSessionToken(secret, userId, now?): Promise<string>`, `verifySessionToken(secret, token): Promise<number>`, `SESSION_TTL_SECONDS = 86400`; `type ApiContext = { deps; config; membership: Membership; metrics: Metrics; streams: StreamGate }`, `type ApiEnv = { Variables: { user: UserRow } }`; `validate(target, schema)`; `requireSession(ctx)`, `userRateLimit(ctx)`; `class StreamGate { constructor(max = 4); acquire(userId): boolean; release(userId): void; count(userId): number }`; `resolveLaunchRoute(ctx, user, param): Promise<LaunchRoute>`; `createApiApp(ctx): Hono<ApiEnv>` (mounts `/api/launch`, `/api/me/*`, `/api/telemetry`, `/healthz`, `/readyz`, `/metrics`; Task 5 adds the rest through `registerGameRoutes`); summaries — `gameSummaryRows(tx, where, orderBy, limit)`, `toGameSummary(row, viewerId): GameSummary`, `challengeToDto(...)`; lobby — `buildLobby(deps, group, viewer, { isAdmin }): Promise<LobbyDto>`, `listFinished(deps, groupId, viewerId, cursor: string | null): Promise<FinishedPageDto>`, `meGroups(deps, userId): Promise<MeGroupsDto>`, `playerPage(deps, groupId, viewerId, userId): Promise<PlayerPageDto>`, `pendingChallenges(tx, groupId, viewerId): Promise<ChallengeDto[]>`; admin — `groupSettingsDto(tx, group): Promise<GroupSettingsDto>`; account — `deleteMyData(deps, userId): Promise<void>`; `class Metrics` with `webhookUpdates{type}`, `movesTotal`, `telegramCalls{method,status}`, `telegram429`, `jobsFailed{kind}`, `sseStreams` (gauge), `lichessImports{outcome}`, `gamesFinished{end_reason}`, `miniappLoadErrors`, `miniappMoveFailures`, `render(): Promise<string>`, `contentType`; test helpers `signInitData(botToken, { user, authDate?, startParam?, queryId? }): string`, `startTestApi(): Promise<TestApi>` with `{ app, fake, config, ctx, deps, sessionFor(user), request(method, path, { token?, body? }), stop() }`.

- [ ] **Step 1: Dependencies and the `internal` error code**

Add to `apps/server/package.json` `dependencies`: `"@hono/node-server": "^2.1.1", "@hono/zod-validator": "^0.9.1", "prom-client": "^15.1.3",` and run `pnpm install`.

In `packages/shared/src/protocol/errors.ts` append `'internal'` to `ERROR_CODES` and `internal: 500` to `HTTP_STATUS_BY_ERROR_CODE` (an unhandled server error is not one of the ten domain outcomes; the app treats it like a network failure). In `packages/shared/test/protocol/errors.test.ts` add the row `['internal', 500],` to the status table.

- [ ] **Step 2: Write the failing unit tests**

`apps/server/test/helpers/initData.ts`:

```ts
import { createHmac } from 'node:crypto';

/** Signs Mini App init data the way Telegram does, independently of the server's validator. */
export function signInitData(
  botToken: string,
  fields: { user: Record<string, unknown>; authDate?: number; startParam?: string; queryId?: string },
): string {
  const params = new URLSearchParams();
  if (fields.queryId) params.set('query_id', fields.queryId);
  params.set('user', JSON.stringify(fields.user));
  params.set('auth_date', String(fields.authDate ?? Math.floor(Date.now() / 1000)));
  if (fields.startParam) params.set('start_param', fields.startParam);
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}
```

`apps/server/test/unit/initData.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateInitData } from '../../src/api/initData';
import { signInitData } from '../helpers/initData';

/** The worked example from Telegram's Mini Apps documentation. */
const DOC_TOKEN = '5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8';
const DOC_INIT_DATA =
  'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2';
const DOC_TIME = new Date(1662771648 * 1000 + 60_000);

describe('validateInitData', () => {
  it('accepts the documented example and parses the user', () => {
    const parsed = validateInitData(DOC_INIT_DATA, DOC_TOKEN, { now: DOC_TIME });
    expect(parsed.user).toMatchObject({ id: 279058397, first_name: 'Vladislav', username: 'vdkfrost' });
    expect(parsed.queryId).toBe('AAHdF6IQAAAAAN0XohDhrOrc');
    expect(parsed.startParam).toBeNull();
    expect(parsed.authDate.toISOString()).toBe('2022-09-10T01:00:48.000Z');
  });

  it('agrees with the documented hash when the same payload is signed by the test helper', () => {
    const signed = signInitData(DOC_TOKEN, {
      queryId: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: { id: 279058397, first_name: 'Vladislav', last_name: 'Kibenko', username: 'vdkfrost', language_code: 'ru', is_premium: true },
      authDate: 1662771648,
    });
    expect(new URLSearchParams(signed).get('hash')).toBe('c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2');
  });

  it('rejects tampered init data', () => {
    const tampered = DOC_INIT_DATA.replace('Vladislav', 'Vladislaw');
    expect(() => validateInitData(tampered, DOC_TOKEN, { now: DOC_TIME })).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('rejects init data older than 24 hours', () => {
    const later = new Date(DOC_TIME.getTime() + 25 * 3_600_000);
    expect(() => validateInitData(DOC_INIT_DATA, DOC_TOKEN, { now: later })).toThrow(expect.objectContaining({ code: 'unauthorized', details: { reason: 'expired' } }));
  });

  it('rejects data without a hash, with a bad token, or with a malformed user', () => {
    expect(() => validateInitData('auth_date=1&user=%7B%7D', DOC_TOKEN)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => validateInitData(DOC_INIT_DATA, '1:other', { now: DOC_TIME })).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    const noId = signInitData(DOC_TOKEN, { user: { first_name: 'X' } });
    expect(() => validateInitData(noId, DOC_TOKEN)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('returns the start_param when present', () => {
    const signed = signInitData(DOC_TOKEN, { user: { id: 7, first_name: 'Ann' }, startParam: 'g_aZ09bY18cX' });
    expect(validateInitData(signed, DOC_TOKEN).startParam).toBe('g_aZ09bY18cX');
  });
});
```

`apps/server/test/unit/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { issueSessionToken, verifySessionToken } from '../../src/api/session';

const secret = 's'.repeat(32);

describe('session tokens', () => {
  it('round-trips the user id', async () => {
    const token = await issueSessionToken(secret, 42);
    expect(await verifySessionToken(secret, token)).toBe(42);
  });

  it('rejects another secret, garbage and an expired token', async () => {
    const token = await issueSessionToken(secret, 42);
    await expect(verifySessionToken('x'.repeat(32), token)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(verifySessionToken(secret, 'not-a-token')).rejects.toMatchObject({ code: 'unauthorized' });
    const old = await issueSessionToken(secret, 42, new Date(Date.now() - 25 * 3_600_000));
    await expect(verifySessionToken(secret, old)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
```

- [ ] **Step 3: Run the unit tests to verify they fail**

Run: `pnpm vitest run apps/server/test/unit/initData.test.ts apps/server/test/unit/session.test.ts`
Expected: FAIL — cannot load `../../src/api/initData` / `../../src/api/session`.

- [ ] **Step 4: Write the API foundation**

`apps/server/src/api/initData.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain/errors';

export const INIT_DATA_MAX_AGE_SECONDS = 86_400;

const InitDataUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  allows_write_to_pm: z.boolean().optional(),
  is_bot: z.boolean().optional(),
});

export type InitDataUser = z.infer<typeof InitDataUserSchema>;

export type ParsedInitData = {
  user: InitDataUser;
  authDate: Date;
  startParam: string | null;
  queryId: string | null;
};

/** Telegram's recipe: sorted `key=value` pairs joined by `\n`, keyed by HMAC-SHA256("WebAppData", token). */
export function initDataHash(params: URLSearchParams, botToken: string): string {
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

export function validateInitData(
  raw: string,
  botToken: string,
  options: { now?: Date; maxAgeSeconds?: number } = {},
): ParsedInitData {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new DomainError('unauthorized', 'init data has no hash');
  const expected = initDataHash(params, botToken);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) {
    throw new DomainError('unauthorized', 'init data signature mismatch');
  }
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) throw new DomainError('unauthorized', 'init data has no auth_date');
  const now = options.now ?? new Date();
  if (now.getTime() / 1000 - authDate > (options.maxAgeSeconds ?? INIT_DATA_MAX_AGE_SECONDS)) {
    throw new DomainError('unauthorized', 'init data expired', { reason: 'expired' });
  }
  const rawUser = params.get('user');
  if (!rawUser) throw new DomainError('unauthorized', 'init data has no user');
  const user = InitDataUserSchema.safeParse((() => {
    try {
      return JSON.parse(rawUser) as unknown;
    } catch {
      return null;
    }
  })());
  if (!user.success) throw new DomainError('unauthorized', 'init data user is malformed');
  return {
    user: user.data,
    authDate: new Date(authDate * 1000),
    startParam: params.get('start_param'),
    queryId: params.get('query_id'),
  };
}
```

`apps/server/src/api/session.ts`:

```ts
import { sign, verify } from 'hono/jwt';
import { DomainError } from '../domain/errors';

export const SESSION_TTL_SECONDS = 86_400;

/** HS256 JWT with `sub`, `iat`, `exp` (spec D12, §12). */
export async function issueSessionToken(secret: string, userId: number, now: Date = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return sign({ sub: String(userId), iat, exp: iat + SESSION_TTL_SECONDS }, secret, 'HS256');
}

export async function verifySessionToken(secret: string, token: string): Promise<number> {
  try {
    const payload = await verify(token, secret, 'HS256');
    const userId = typeof payload.sub === 'string' ? Number(payload.sub) : Number.NaN;
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('bad subject');
    return userId;
  } catch {
    throw new DomainError('unauthorized', 'invalid session');
  }
}
```

`apps/server/src/metrics.ts`:

```ts
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/** Spec §14, the subset that the code paths of plans 2–3 can report. */
export class Metrics {
  readonly registry = new Registry();
  readonly contentType = this.registry.contentType;
  readonly webhookUpdates = this.counter('webhook_updates_total', 'Telegram updates received', ['type']);
  readonly movesTotal = this.counter('moves_total', 'Moves accepted');
  readonly telegramCalls = this.counter('telegram_api_calls_total', 'Bot API calls', ['method', 'status']);
  readonly telegram429 = this.counter('telegram_429_total', 'Bot API rate limit responses');
  readonly jobsFailed = this.counter('jobs_failed_total', 'Jobs that exhausted their attempts', ['kind']);
  readonly sseStreams = new Gauge({ name: 'sse_streams', help: 'Open game streams', registers: [this.registry] });
  readonly lichessImports = this.counter('lichess_imports_total', 'Lichess imports', ['outcome']);
  readonly gamesFinished = this.counter('games_finished_total', 'Games finished', ['end_reason']);
  readonly miniappLoadErrors = this.counter('miniapp_load_errors_total', 'Mini App launch failures');
  readonly miniappMoveFailures = this.counter('miniapp_move_failures_total', 'Mini App moves that ended in Retry');

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  private counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
```

`apps/server/src/api/streams.ts`:

```ts
/** Spec §7.8: at most four open SSE streams per user. */
export class StreamGate {
  private readonly open = new Map<number, number>();

  constructor(private readonly max = 4) {}

  count(userId: number): number {
    return this.open.get(userId) ?? 0;
  }

  acquire(userId: number): boolean {
    const current = this.count(userId);
    if (current >= this.max) return false;
    this.open.set(userId, current + 1);
    return true;
  }

  release(userId: number): void {
    const current = this.count(userId);
    if (current <= 1) this.open.delete(userId);
    else this.open.set(userId, current - 1);
  }
}
```

`apps/server/src/api/context.ts`:

```ts
import type { Config } from '../config';
import type { UserRow } from '../db/schema';
import type { Deps } from '../domain/deps';
import type { Metrics } from '../metrics';
import type { Membership } from '../telegram/membership';
import type { StreamGate } from './streams';

export type ApiContext = {
  deps: Deps;
  config: Config;
  membership: Membership;
  metrics: Metrics;
  streams: StreamGate;
};

export type ApiEnv = { Variables: { user: UserRow } };
```

`apps/server/src/api/validate.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { DomainError } from '../domain/errors';

/** Shared-schema validation; failures become the spec's `validation` error body. */
export function validate<T extends ZodType>(target: 'json' | 'query' | 'param', schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new DomainError('validation', 'invalid request', {
        issues: result.error.issues.map((issue) => issue.path.join('.')),
      });
    }
  });
}
```

`apps/server/src/api/middleware.ts`:

```ts
import { PublicIdSchema } from '@group-chess/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { RateLimiter } from '../bot/rateLimit';
import { DomainError } from '../domain/errors';
import { getUserById } from '../domain/users';
import type { ApiContext, ApiEnv } from './context';
import { verifySessionToken } from './session';

/** Bearer token everywhere; the SSE route may pass it as `?token=` (spec §9). */
export function requireSession(ctx: ApiContext): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const queryToken = c.req.path.endsWith('/events') ? (c.req.query('token') ?? null) : null;
    const token = bearer ?? queryToken;
    if (!token) throw new DomainError('unauthorized', 'missing session');
    const userId = await verifySessionToken(ctx.config.SESSION_SECRET, token);
    const user = await getUserById(ctx.deps.db, userId);
    if (!user || user.deletedAt) throw new DomainError('unauthorized', 'unknown session');
    c.set('user', user);
    await next();
  };
}

/** Spec §7.8: 120 API requests per user per minute. */
export function userRateLimit(limit = 120, windowMs = 60_000): MiddlewareHandler<ApiEnv> {
  const limiter = new RateLimiter(limit, windowMs);
  return async (c, next) => {
    if (!limiter.allow(String(c.get('user').id))) throw new DomainError('rate_limited', 'too many requests');
    await next();
  };
}

export function publicIdParam(c: Context, name: string): string {
  const value = c.req.param(name);
  const parsed = PublicIdSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('not_found', `unknown ${name}`);
  return parsed.data;
}
```

`apps/server/src/domain/summaries.ts`:

```ts
import { sideToMove, type ChallengeDto, type GameSummary, type TimePerMove } from '@group-chess/shared';
import { and, eq, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client';
import { challenges, games, ratings, users, type ChallengeRow, type GameRow, type RatingRow, type UserRow } from '../db/schema';
import { toPlayerRef } from './players';

export const whiteUser = alias(users, 'white_user');
export const blackUser = alias(users, 'black_user');
export const whiteRating = alias(ratings, 'white_rating');
export const blackRating = alias(ratings, 'black_rating');

export type GameSummaryRow = {
  game: GameRow;
  white: UserRow;
  black: UserRow;
  whiteRating: RatingRow | null;
  blackRating: RatingRow | null;
};

/** Games with both players and their current ratings in one query. */
export async function gameSummaryRows(
  tx: DbOrTx,
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
): Promise<GameSummaryRow[]> {
  return tx
    .select({ game: games, white: whiteUser, black: blackUser, whiteRating, blackRating })
    .from(games)
    .innerJoin(whiteUser, eq(whiteUser.id, games.whiteId))
    .innerJoin(blackUser, eq(blackUser.id, games.blackId))
    .leftJoin(whiteRating, and(eq(whiteRating.groupId, games.groupId), eq(whiteRating.userId, games.whiteId)))
    .leftJoin(blackRating, and(eq(blackRating.groupId, games.groupId), eq(blackRating.userId, games.blackId)))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit);
}

export function toGameSummary(row: GameSummaryRow, viewerId: number | null): GameSummary {
  const { game } = row;
  const side = sideToMove(game.fen);
  const toMove = side === 'white' ? game.whiteId : game.blackId;
  return {
    id: game.publicId,
    white: toPlayerRef(row.white, row.whiteRating),
    black: toPlayerRef(row.black, row.blackRating),
    status: game.status,
    timePerMove: game.timePerMove as TimePerMove,
    rated: game.rated,
    plyCount: game.plyCount,
    sideToMove: side,
    yourTurn: game.status === 'active' && viewerId !== null && toMove === viewerId,
    deadlineAt: game.status === 'active' && game.deadlineAt ? game.deadlineAt.toISOString() : null,
    lastMoveAt: game.lastMoveAt ? game.lastMoveAt.toISOString() : null,
    startedAt: game.startedAt.toISOString(),
    finishedAt: game.finishedAt ? game.finishedAt.toISOString() : null,
    result: game.result,
    endReason: game.endReason,
    voided: game.voidedAt !== null,
  };
}

export const challengerUser = alias(users, 'challenger_user');
export const opponentUser = alias(users, 'opponent_user');
export const challengerRating = alias(ratings, 'challenger_rating');
export const opponentRating = alias(ratings, 'opponent_rating');

export type ChallengeDtoRow = {
  challenge: ChallengeRow;
  challenger: UserRow;
  opponent: UserRow | null;
  challengerRating: RatingRow | null;
  opponentRating: RatingRow | null;
};

export async function challengeDtoRows(tx: DbOrTx, where: SQL | undefined, limit: number): Promise<ChallengeDtoRow[]> {
  return tx
    .select({ challenge: challenges, challenger: challengerUser, opponent: opponentUser, challengerRating, opponentRating })
    .from(challenges)
    .innerJoin(challengerUser, eq(challengerUser.id, challenges.challengerId))
    .leftJoin(opponentUser, eq(opponentUser.id, challenges.opponentId))
    .leftJoin(challengerRating, and(eq(challengerRating.groupId, challenges.groupId), eq(challengerRating.userId, challenges.challengerId)))
    .leftJoin(opponentRating, and(eq(opponentRating.groupId, challenges.groupId), eq(opponentRating.userId, challenges.opponentId)))
    .where(where)
    .orderBy(challenges.createdAt)
    .limit(limit);
}

export function challengeToDto(row: ChallengeDtoRow, viewerId: number): ChallengeDto {
  const { challenge } = row;
  const pending = challenge.status === 'pending';
  return {
    id: challenge.publicId,
    challenger: toPlayerRef(row.challenger, row.challengerRating),
    opponent: row.opponent ? toPlayerRef(row.opponent, row.opponentRating) : null,
    timePerMove: challenge.timePerMove as TimePerMove,
    challengerColour: challenge.challengerColour,
    rated: challenge.rated,
    status: challenge.status,
    createdAt: challenge.createdAt.toISOString(),
    expiresAt: challenge.expiresAt.toISOString(),
    viewer: {
      canAccept: pending && (challenge.opponentId === viewerId || (challenge.opponentId === null && challenge.challengerId !== viewerId)),
      canDecline: pending && challenge.opponentId === viewerId,
      canCancel: pending && challenge.challengerId === viewerId,
    },
  };
}
```

`apps/server/src/domain/lobby.ts`:

```ts
import {
  freshPlayerState,
  type FinishedPageDto,
  type LeaderboardEntry,
  type LobbyDto,
  type MeGroupsDto,
  type PlayerPageDto,
  type WinDrawLoss,
} from '@group-chess/shared';
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { games, groupMembers, groups, ratings, users, type GroupRow, type UserRow } from '../db/schema';
import type { Deps } from './deps';
import { settingsOf } from './groups';
import { toPlayerRef } from './players';
import { getLeaderboard } from './ratings';
import { challengeDtoRows, challengeToDto, gameSummaryRows, toGameSummary } from './summaries';
import { challenges } from '../db/schema';

const PAGE_SIZE = 20;

function encodeCursor(finishedAt: Date, id: number): string {
  return Buffer.from(`${finishedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { finishedAt: Date; id: number } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const finishedAt = new Date(iso ?? '');
  if (Number.isNaN(finishedAt.getTime()) || !Number.isInteger(Number(id))) return null;
  return { finishedAt, id: Number(id) };
}

/** Active games of a group, the viewer's own turn first, then most recently moved (PRD §8.2). */
export async function activeGames(tx: DbOrTx, groupId: number, viewerId: number) {
  const rows = await gameSummaryRows(tx, and(eq(games.groupId, groupId), eq(games.status, 'active')), [desc(games.lastMoveAt), desc(games.startedAt)], 200);
  return rows
    .map((row) => toGameSummary(row, viewerId))
    .sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn));
}

export async function listFinished(deps: Deps, groupId: number, viewerId: number, cursor: string | null): Promise<FinishedPageDto> {
  const after = cursor ? decodeCursor(cursor) : null;
  const conditions = [eq(games.groupId, groupId), eq(games.status, 'finished')];
  if (after) {
    conditions.push(
      or(lt(games.finishedAt, after.finishedAt), and(eq(games.finishedAt, after.finishedAt), lt(games.id, after.id)))!,
    );
  }
  const rows = await gameSummaryRows(deps.db, and(...conditions), [desc(games.finishedAt), desc(games.id)], PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map((row) => toGameSummary(row, viewerId)),
    nextCursor: rows.length > PAGE_SIZE && last?.game.finishedAt ? encodeCursor(last.game.finishedAt, last.game.id) : null,
  };
}

export async function pendingChallenges(tx: DbOrTx, groupId: number, viewerId: number) {
  const rows = await challengeDtoRows(tx, and(eq(challenges.groupId, groupId), eq(challenges.status, 'pending')), 50);
  return rows.map((row) => challengeToDto(row, viewerId));
}

export async function buildLobby(deps: Deps, group: GroupRow, viewer: UserRow, options: { isAdmin: boolean }): Promise<LobbyDto> {
  const settings = settingsOf(group);
  const [active, finished, pending, players] = await Promise.all([
    activeGames(deps.db, group.id, viewer.id),
    listFinished(deps, group.id, viewer.id, null),
    pendingChallenges(deps.db, group.id, viewer.id),
    getLeaderboard(deps.db, group.id, settings.leaderboardMinGames),
  ]);
  return {
    group: { id: group.publicId, title: group.title },
    isAdmin: options.isAdmin,
    settings: {
      defaultTimePerMove: settings.defaultTimePerMove,
      ratedDefault: settings.ratedDefault,
      allowOpenChallenges: settings.allowOpenChallenges,
    },
    active,
    finished,
    challenges: pending,
    players,
  };
}

/** Groups where the user is a known member and the bot is still present (spec §9 `GET /me/groups`). */
export async function meGroups(deps: Deps, userId: number): Promise<MeGroupsDto> {
  const memberOf = await deps.db
    .select({ group: groups })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.status, 'member'), isNull(groupMembers.blockedAt), ne(groups.botStatus, 'left')))
    .orderBy(groups.title);
  if (memberOf.length === 0) return { groups: [] };
  const active = await deps.db
    .select({ groupId: games.groupId, fen: games.fen, whiteId: games.whiteId, blackId: games.blackId })
    .from(games)
    .where(and(eq(games.status, 'active'), or(eq(games.whiteId, userId), eq(games.blackId, userId)), inArray(games.groupId, memberOf.map((row) => row.group.id))));
  return {
    groups: memberOf.map(({ group }) => {
      const mine = active.filter((game) => game.groupId === group.id);
      const yourMove = mine.filter((game) => (game.fen.split(' ')[1] === 'b' ? game.blackId : game.whiteId) === userId).length;
      return { id: group.publicId, title: group.title, activeGames: mine.length, yourMove };
    }),
  };
}

export async function playerPage(deps: Deps, groupId: number, viewerId: number, userId: number): Promise<PlayerPageDto> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new (await import('./errors')).DomainError('not_found', 'player not found');
  const [rating] = await deps.db.select().from(ratings).where(and(eq(ratings.groupId, groupId), eq(ratings.userId, userId))).limit(1);
  const state = rating ?? { ...freshPlayerState(), gamesPlayed: 0, wins: 0, draws: 0, losses: 0 };
  const player: LeaderboardEntry = {
    ...toPlayerRef(user, rating ?? null),
    gamesPlayed: state.gamesPlayed,
    record: { wins: state.wins, draws: state.draws, losses: state.losses },
  };
  const between = await deps.db
    .select({ result: games.result, whiteId: games.whiteId })
    .from(games)
    .where(and(eq(games.groupId, groupId), eq(games.status, 'finished'), isNull(games.voidedAt), or(and(eq(games.whiteId, viewerId), eq(games.blackId, userId)), and(eq(games.whiteId, userId), eq(games.blackId, viewerId)))));
  const headToHead: WinDrawLoss = { wins: 0, draws: 0, losses: 0 };
  for (const game of between) {
    if (game.result === '1/2-1/2') headToHead.draws += 1;
    else if (game.result === '1-0' || game.result === '0-1') {
      const viewerWon = (game.result === '1-0') === (game.whiteId === viewerId);
      if (viewerWon) headToHead.wins += 1;
      else headToHead.losses += 1;
    }
  }
  const recent = await gameSummaryRows(deps.db, and(eq(games.groupId, groupId), or(eq(games.whiteId, userId), eq(games.blackId, userId))), [desc(games.startedAt)], 10);
  return { player, headToHead, recentGames: recent.map((row) => toGameSummary(row, viewerId)) };
}

export const sqlNow = sql`now()`;
```

`apps/server/src/domain/admin.ts`:

```ts
import type { GroupSettingsDto } from '@group-chess/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { groupMembers, ratings, users, type GroupRow } from '../db/schema';
import { settingsOf } from './groups';
import { toPlayerRef } from './players';

export async function groupSettingsDto(tx: DbOrTx, group: GroupRow): Promise<GroupSettingsDto> {
  const blocked = await tx
    .select({ user: users, rating: ratings })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(ratings, and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, users.id)))
    .where(and(eq(groupMembers.groupId, group.id), isNotNull(groupMembers.blockedAt)))
    .orderBy(users.firstName);
  return {
    group: { id: group.publicId, title: group.title },
    settings: settingsOf(group),
    blocked: blocked.map((row) => toPlayerRef(row.user, row.rating)),
    botIsAdmin: group.botIsAdmin,
    isForum: group.isForum,
  };
}
```

`apps/server/src/domain/account.ts`:

```ts
import { and, eq, or, sql } from 'drizzle-orm';
import { dbNow } from '../db/client';
import { challenges, games, groupMembers, users } from '../db/schema';
import type { Deps } from './deps';
import { colourOf } from './gameDto';
import { finishGame } from './games';
import { enqueue } from '../jobs/queue';

/** Spec §12 "Delete my data": immediate and irreversible; opponents' histories stay consistent. */
export async function deleteMyData(deps: Deps, userId: number): Promise<void> {
  const finished = await deps.db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const active = await tx
      .select()
      .from(games)
      .where(and(eq(games.status, 'active'), or(eq(games.whiteId, userId), eq(games.blackId, userId))))
      .for('update');
    const publicIds: string[] = [];
    for (const game of active) {
      const colour = colourOf(game, userId);
      if (!colour) continue;
      await finishGame(tx, game, { result: colour === 'white' ? '0-1' : '1-0', endReason: 'resignation' }, now);
      publicIds.push(game.publicId);
    }
    const pending = await tx
      .select()
      .from(challenges)
      .where(and(eq(challenges.status, 'pending'), or(eq(challenges.challengerId, userId), eq(challenges.opponentId, userId))))
      .for('update');
    for (const challenge of pending) {
      await tx
        .update(challenges)
        .set({ status: challenge.challengerId === userId ? 'cancelled' : 'declined', resolvedAt: sql`now()` })
        .where(eq(challenges.id, challenge.id));
      await enqueue(tx, { kind: 'edit_card', payload: { challengeId: challenge.id }, dedupKey: `card:ch:${challenge.publicId}` });
    }
    await tx
      .update(users)
      .set({ telegramUserId: null, username: null, firstName: 'Deleted player', prefs: {}, dmAllowed: false, writeAccessAskedAt: null, deletedAt: now })
      .where(eq(users.id, userId));
    await tx.update(groupMembers).set({ status: 'left' }).where(eq(groupMembers.userId, userId));
    return publicIds;
  });
  for (const publicId of finished) deps.bus.publish(publicId);
}
```

`apps/server/src/api/launchRoute.ts`:

```ts
import type { LaunchRoute, StartParam } from '@group-chess/shared';
import type { UserRow } from '../db/schema';
import { groupSettingsDto } from '../domain/admin';
import { colourOf } from '../domain/gameDto';
import { loadGameDto, requireGameByPublicId } from '../domain/games';
import { requireGroup, requireGroupByPublicId } from '../domain/groups';
import { buildLobby, meGroups } from '../domain/lobby';
import type { ApiContext } from './context';

/** Spec §5.3/§6.1: where a launch lands, with that screen's data; no membership evidence means locked. */
export async function resolveLaunchRoute(ctx: ApiContext, user: UserRow, param: StartParam | null): Promise<LaunchRoute> {
  const { db } = ctx.deps;
  if (!param) return { kind: 'groups', groups: await meGroups(ctx.deps, user.id) };
  if (param.kind === 'game') {
    const game = await requireGameByPublicId(db, param.gameId);
    const group = await requireGroup(db, game.groupId);
    if (!colourOf(game, user.id) && !(await ctx.membership.verify(group, user))) {
      return { kind: 'locked', group: { id: group.publicId, title: group.title } };
    }
    return { kind: 'game', game: await loadGameDto(db, game, user.id) };
  }
  const group = await requireGroupByPublicId(db, param.groupId);
  if (!(await ctx.membership.verify(group, user))) return { kind: 'locked', group: { id: group.publicId, title: group.title } };
  const isAdmin = await ctx.membership.isAdmin(group, user);
  if (param.kind === 'settings' && isAdmin) return { kind: 'settings', settings: await groupSettingsDto(db, group) };
  return { kind: 'lobby', lobby: await buildLobby(ctx.deps, group, user, { isAdmin }) };
}
```

`apps/server/src/api/routes/launch.ts`:

```ts
import { decodeStartParam, LaunchRequestSchema, type LaunchResponse } from '@group-chess/shared';
import { Hono } from 'hono';
import { dbNow } from '../../db/client';
import { DomainError } from '../../domain/errors';
import { displayName, ensureUser, prefsOf, setDmAllowed } from '../../domain/users';
import type { ApiContext, ApiEnv } from '../context';
import { validateInitData } from '../initData';
import { resolveLaunchRoute } from '../launchRoute';
import { issueSessionToken } from '../session';
import { validate } from '../validate';

export function launchRoutes(ctx: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.post('/launch', validate('json', LaunchRequestSchema), async (c) => {
    const { initData } = c.req.valid('json');
    const parsed = validateInitData(initData, ctx.config.BOT_TOKEN);
    if (parsed.user.is_bot) throw new DomainError('unauthorized', 'bots cannot launch the app');
    let user = await ensureUser(ctx.deps.db, {
      telegramUserId: parsed.user.id,
      firstName: parsed.user.first_name,
      username: parsed.user.username ?? null,
      languageCode: parsed.user.language_code ?? null,
    });
    if (parsed.user.allows_write_to_pm === true && !user.dmAllowed) {
      await setDmAllowed(ctx.deps.db, user.id, true);
      user = { ...user, dmAllowed: true };
    }
    const token = await issueSessionToken(ctx.config.SESSION_SECRET, user.id);
    const route = await resolveLaunchRoute(ctx, user, decodeStartParam(parsed.startParam));
    const response: LaunchResponse = {
      token,
      user: { id: String(user.id), name: displayName(user), username: user.username },
      prefs: prefsOf(user),
      askWriteAccess: user.writeAccessAskedAt === null && !user.dmAllowed,
      route,
      serverTime: (await dbNow(ctx.deps.db)).toISOString(),
      bot: { username: ctx.config.BOT_USERNAME, miniAppShortName: ctx.config.MINI_APP_SHORT_NAME },
    };
    return c.json(response);
  });
  return app;
}
```

`apps/server/src/api/routes/me.ts`:

```ts
import { PrefsUpdateRequestSchema, TelemetryRequestSchema, type OkDto, type Prefs } from '@group-chess/shared';
import { Hono } from 'hono';
import { RateLimiter } from '../../bot/rateLimit';
import { deleteMyData } from '../../domain/account';
import { DomainError } from '../../domain/errors';
import { meGroups } from '../../domain/lobby';
import { prefsOf, recordWriteAccess, requireUser, updatePrefs } from '../../domain/users';
import type { ApiContext, ApiEnv } from '../context';
import { validate } from '../validate';

const OK: OkDto = { ok: true };

export function meRoutes(ctx: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const telemetryLimiter = new RateLimiter(10, 60_000);

  app.get('/me/groups', async (c) => c.json(await meGroups(ctx.deps, c.get('user').id)));

  app.put('/me/prefs', validate('json', PrefsUpdateRequestSchema), async (c) => {
    const user = c.get('user');
    const body = c.req.valid('json');
    let prefs: Prefs = prefsOf(user);
    if (body.prefs) prefs = await updatePrefs(ctx.deps.db, user.id, body.prefs);
    if (body.writeAccess) await recordWriteAccess(ctx.deps.db, user.id, body.writeAccess.allowed);
    const fresh = await requireUser(ctx.deps.db, user.id);
    return c.json({ prefs, dmAllowed: fresh.dmAllowed });
  });

  app.delete('/me', async (c) => {
    await deleteMyData(ctx.deps, c.get('user').id);
    return c.json(OK);
  });

  app.post('/telemetry', validate('json', TelemetryRequestSchema), async (c) => {
    const user = c.get('user');
    if (!telemetryLimiter.allow(`telemetry:${user.id}`)) throw new DomainError('rate_limited', 'too much telemetry');
    for (const event of c.req.valid('json').events) {
      if (event.kind === 'launch_failed') ctx.metrics.miniappLoadErrors.inc();
      if (event.kind === 'move_retry') ctx.metrics.miniappMoveFailures.inc();
      ctx.deps.log.info({ kind: event.kind, code: event.code, durationMs: event.durationMs, userId: user.id }, 'client telemetry');
    }
    return c.json(OK);
  });

  return app;
}
```

`apps/server/src/api/routes/health.ts`:

```ts
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
```

`apps/server/src/api/app.ts`:

```ts
import { apiErrorBody, HTTP_STATUS_BY_ERROR_CODE } from '@group-chess/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { StatusCode } from 'hono/utils/http-status';
import { isDomainError } from '../domain/errors';
import type { ApiContext, ApiEnv } from './context';
import { requireSession, userRateLimit } from './middleware';
import { healthRoutes } from './routes/health';
import { launchRoutes } from './routes/launch';
import { meRoutes } from './routes/me';

export type RegisterRoutes = (api: Hono<ApiEnv>, ctx: ApiContext) => void;

/** The HTTP app: health and metrics at the root, everything else under /api behind a session. */
export function createApiApp(ctx: ApiContext, extra: RegisterRoutes[] = []): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.onError((error, c) => {
    if (isDomainError(error)) {
      const status = HTTP_STATUS_BY_ERROR_CODE[error.code] as StatusCode;
      c.status(status as 400);
      return c.json(apiErrorBody(error.code, error.message));
    }
    ctx.deps.log.error({ err: error, path: c.req.path }, 'unhandled request error');
    c.status(500);
    return c.json(apiErrorBody('internal', 'internal error'));
  });

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.route('/', healthRoutes(ctx));

  const api = new Hono<ApiEnv>();
  api.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  api.route('/', launchRoutes(ctx));
  api.use('*', requireSession(ctx));
  api.use('*', userRateLimit());
  api.route('/', meRoutes(ctx));
  for (const register of extra) register(api, ctx);
  app.route('/api', api);
  return app;
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm vitest run apps/server/test/unit/initData.test.ts apps/server/test/unit/session.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Write the integration test helper and the failing integration test**

`apps/server/test/helpers/api.ts`:

```ts
import type { Hono } from 'hono';
import { createApiApp, type RegisterRoutes } from '../../src/api/app';
import type { ApiContext, ApiEnv } from '../../src/api/context';
import { issueSessionToken } from '../../src/api/session';
import { StreamGate } from '../../src/api/streams';
import type { Config } from '../../src/config';
import type { Db } from '../../src/db/client';
import type { UserRow } from '../../src/db/schema';
import type { Deps } from '../../src/domain/deps';
import { Metrics } from '../../src/metrics';
import { createTelegramApi } from '../../src/telegram/client';
import { Membership } from '../../src/telegram/membership';
import { testConfig } from './config';
import { testDeps } from './db';
import { FakeTelegram } from './fakeTelegram';

export type TestApi = {
  app: Hono<ApiEnv>;
  fake: FakeTelegram;
  config: Config;
  ctx: ApiContext;
  deps: Deps;
  sessionFor(user: Pick<UserRow, 'id'>): Promise<string>;
  request(method: string, path: string, options?: { token?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
  stop(): Promise<void>;
};

export async function startTestApi(db: Db, extra: RegisterRoutes[] = []): Promise<TestApi> {
  const fake = await FakeTelegram.start();
  const config = testConfig({ TELEGRAM_API_ROOT: fake.url });
  const deps = testDeps(db);
  const membership = new Membership(deps, createTelegramApi(config, { apiRoot: fake.url }));
  const ctx: ApiContext = { deps, config, membership, metrics: new Metrics(), streams: new StreamGate() };
  const app = createApiApp(ctx, extra);
  return {
    app,
    fake,
    config,
    ctx,
    deps,
    sessionFor: (user) => issueSessionToken(config.SESSION_SECRET, user.id),
    request: (method, path, options = {}) =>
      app.request(path, {
        method,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      }),
    stop: () => fake.stop(),
  };
}
```

`apps/server/test/integration/api-auth.test.ts`:

```ts
import { LaunchResponseSchema, LobbyDtoSchema } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, users } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertChallenge, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import { signInitData } from '../helpers/initData';

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.membership.clearCaches();
});
afterAll(async () => {
  await api.stop();
  await close();
});

const alice = { id: 11, first_name: 'Alice', username: 'alice' };
const launch = (fields: Parameters<typeof signInitData>[1]) =>
  api.request('POST', '/api/launch', { body: { initData: signInitData(api.config.BOT_TOKEN, fields) } });

describe('POST /api/launch', () => {
  it('creates the user, issues a session and lands on the groups screen', async () => {
    const res = await launch({ user: alice });
    expect(res.status).toBe(200);
    const body = LaunchResponseSchema.parse(await res.json());
    expect(body.route.kind).toBe('groups');
    expect(body.user).toEqual({ id: expect.any(String), name: 'Alice', username: 'alice' });
    expect(body.askWriteAccess).toBe(true);
    expect(body.bot).toEqual({ username: 'TestChessBot', miniAppShortName: 'chess' });
    const me = await api.request('GET', '/api/me/groups', { token: body.token });
    expect(me.status).toBe(200);
  });

  it('marks DMs allowed when init data says the user allows messages', async () => {
    await launch({ user: { ...alice, allows_write_to_pm: true } });
    expect((await db.select().from(users))[0]?.dmAllowed).toBe(true);
  });

  it('rejects tampered or stale init data with 401 and the error body', async () => {
    const good = signInitData(api.config.BOT_TOKEN, { user: alice });
    const res = await api.request('POST', '/api/launch', { body: { initData: good.replace('Alice', 'Alicf') } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    const stale = signInitData(api.config.BOT_TOKEN, { user: alice, authDate: Math.floor(Date.now() / 1000) - 90_000 });
    expect((await api.request('POST', '/api/launch', { body: { initData: stale } })).status).toBe(401);
  });

  it('opens a game link for a player, locks it for a stranger and shows it to a member', async () => {
    const group = await insertGroup(db);
    const white = await insertUser(db, { telegramUserId: 11 });
    const black = await insertUser(db, { telegramUserId: 22 });
    const game = await insertGame(db, group.id, white.id, black.id);
    const asPlayer = LaunchResponseSchema.parse(await (await launch({ user: alice, startParam: `g_${game.publicId}` })).json());
    expect(asPlayer.route).toMatchObject({ kind: 'game', game: { id: game.publicId, viewerRole: 'white' } });
    const stranger = { id: 33, first_name: 'Sam' };
    const locked = LaunchResponseSchema.parse(await (await launch({ user: stranger, startParam: `g_${game.publicId}` })).json());
    expect(locked.route).toEqual({ kind: 'locked', group: { id: group.publicId, title: group.title } });
    api.fake.members.set(33, 'member');
    const asMember = LaunchResponseSchema.parse(await (await launch({ user: stranger, startParam: `g_${game.publicId}` })).json());
    expect(asMember.route).toMatchObject({ kind: 'game', game: { viewerRole: 'spectator' } });
  });

  it('opens the lobby for a member and the settings for an admin', async () => {
    const group = await insertGroup(db);
    api.fake.members.set(11, 'member');
    const lobby = LaunchResponseSchema.parse(await (await launch({ user: alice, startParam: `l_${group.publicId}` })).json());
    expect(lobby.route.kind).toBe('lobby');
    if (lobby.route.kind === 'lobby') expect(LobbyDtoSchema.parse(lobby.route.lobby).isAdmin).toBe(false);
    const notAdmin = LaunchResponseSchema.parse(await (await launch({ user: alice, startParam: `s_${group.publicId}` })).json());
    expect(notAdmin.route.kind).toBe('lobby');
    api.fake.admins = [11];
    api.ctx.membership.invalidateAdmins(group.id);
    const admin = LaunchResponseSchema.parse(await (await launch({ user: alice, startParam: `s_${group.publicId}` })).json());
    expect(admin.route).toMatchObject({ kind: 'settings', settings: { group: { id: group.publicId }, botIsAdmin: false } });
  });
});

describe('sessions and limits', () => {
  it('refuses requests without a valid session', async () => {
    expect((await api.request('GET', '/api/me/groups')).status).toBe(401);
    expect((await api.request('GET', '/api/me/groups', { token: 'garbage' })).status).toBe(401);
  });

  it('limits a user to 120 requests per minute', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    let last = 0;
    for (let i = 0; i < 121; i += 1) last = (await api.request('GET', '/api/me/groups', { token })).status;
    expect(last).toBe(429);
  });

  it('rejects a body over 64 KB', async () => {
    const res = await api.request('POST', '/api/launch', { body: { initData: 'x'.repeat(70_000) } });
    expect(res.status).toBe(413);
  });
});

describe('me routes', () => {
  it('merges preferences and records the write-access answer', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    const res = await api.request('PUT', '/api/me/prefs', { token, body: { prefs: { confirmMoves: false }, writeAccess: { allowed: true } } });
    expect(await res.json()).toMatchObject({ prefs: { confirmMoves: false, closeAfterMove: true }, dmAllowed: true });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.writeAccessAskedAt).not.toBeNull();
  });

  it('deletes my data: resigns games, cancels challenges, anonymises, and ends the session', async () => {
    const group = await insertGroup(db);
    const me = await insertUser(db, { telegramUserId: 11, firstName: 'Alice', username: 'alice' });
    const other = await insertUser(db, { telegramUserId: 22 });
    await touchMember(db, group.id, me.id);
    const game = await insertGame(db, group.id, me.id, other.id, { fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2', plyCount: 2 });
    await insertChallenge(db, group.id, me.id, other.id);
    const token = await api.sessionFor(me);
    expect((await api.request('DELETE', '/api/me', { token })).status).toBe(200);
    expect((await db.select().from(games).where(eq(games.id, game.id)))[0]).toMatchObject({ status: 'finished', result: '0-1', endReason: 'resignation' });
    expect((await db.select().from(challenges))[0]?.status).toBe('cancelled');
    const [row] = await db.select().from(users).where(eq(users.id, me.id));
    expect(row).toMatchObject({ telegramUserId: null, username: null, firstName: 'Deleted player', dmAllowed: false });
    expect(row?.deletedAt).not.toBeNull();
    expect((await api.request('GET', '/api/me/groups', { token })).status).toBe(401);
  });

  it('accepts telemetry and counts it', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    const res = await api.request('POST', '/api/telemetry', { token, body: { events: [{ kind: 'launch_failed', code: 'script' }] } });
    expect(res.status).toBe(200);
    expect(await api.ctx.metrics.render()).toContain('miniapp_load_errors_total 1');
  });
});

describe('health', () => {
  it('serves healthz, readyz and metrics', async () => {
    expect((await api.request('GET', '/healthz')).status).toBe(200);
    expect((await api.request('GET', '/readyz')).status).toBe(200);
    const metrics = await api.request('GET', '/metrics');
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('process_cpu_user_seconds_total');
  });
});
```

- [ ] **Step 7: Run the integration test**

Run: `pnpm vitest run --project server apps/server/test/integration/api-auth.test.ts`
Expected: PASS — 12 tests. (It fails first only if a helper was written before the routes; the routes above are the implementation.)

- [ ] **Step 8: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(server): add the API foundation with init data validation, sessions, lobby queries and account routes"
```

---

### Task 5: The API — groups, challenges, games, the SSE stream, sharing, PGN and admin routes

**Files:**
- Create: `apps/server/src/api/access.ts`, `apps/server/src/api/routes/groups.ts`, `apps/server/src/api/routes/challenges.ts`, `apps/server/src/api/routes/games.ts`, `apps/server/src/api/routes/events.ts`, `apps/server/src/api/routes/admin.ts`, `apps/server/src/api/routes/index.ts`, `apps/server/src/domain/sharing.ts`, `apps/server/src/domain/pgn.ts`
- Modify: `apps/server/src/domain/admin.ts` (add `adminUpdateSettings`, `adminBlock`, `adminUnblock`), `apps/server/test/helpers/api.ts` (default `extra` to `gameRoutes`)
- Test: `apps/server/test/integration/api-games.test.ts`

**Interfaces:**
- Consumes: Task 4 (`ApiContext`, `validate`, `publicIdParam`, summaries, lobby), plan 2 domain (games, draws, challenges, ratings, members, void), shared schemas.
- Produces: `requireMember(ctx, group, user)`, `requireGameAccess(ctx, game, user): Promise<GroupRow>`, `requireAdmin(ctx, group, user)`; `gameRoutes: RegisterRoutes[]` (`groupsRoutes`, `challengeRoutes`, `gamesRoutes`, `eventsRoutes`, `adminRoutes`); `sharePosition(deps, { gameId, userId, ply }): Promise<{ shareId: number }>`; `buildGamePgn(tx, game): Promise<string>`; `adminUpdateSettings(deps, group, adminId, patch): Promise<GroupSettingsDto>`, `adminBlock(deps, group, adminId, userId)`, `adminUnblock(deps, group, adminId, userId)`.
- Route table (all under `/api`, session required): `GET /groups/:g`, `GET /groups/:g/players`, `GET /groups/:g/leaderboard`, `GET /groups/:g/players/:u`, `GET /groups/:g/finished?cursor=`, `POST /groups/:g/challenges`, `POST /challenges/:c/accept|decline|cancel`, `GET /games/:id`, `GET /games/:id/events`, `POST /games/:id/moves`, `POST /games/:id/draw/offer|accept|decline|claim`, `POST /games/:id/resign|abort|share|rematch`, `GET /games/:id/pgn`, `GET|PUT /groups/:g/settings`, `POST /games/:id/void`, `POST /groups/:g/blocks`, `DELETE /groups/:g/blocks/:u`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/api-games.test.ts`:

```ts
import { ChallengeDtoSchema, GameDtoSchema, LobbyDtoSchema, PlayerPageDtoSchema } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminActions, games, groupMembers, jobs, shares } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.membership.clearCaches();
});
afterAll(async () => {
  await api.stop();
  await close();
});

async function world() {
  const group = await insertGroup(db, { telegramChatId: -1001000000003 });
  const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice' });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
  const carol = await insertUser(db, { telegramUserId: 33, firstName: 'Carol' });
  const dave = await insertUser(db, { telegramUserId: 44, firstName: 'Dave' });
  for (const user of [alice, bob, carol]) await touchMember(db, group.id, user.id, { verified: true });
  const tokens = { alice: await api.sessionFor(alice), bob: await api.sessionFor(bob), carol: await api.sessionFor(carol), dave: await api.sessionFor(dave) };
  return { group, alice, bob, carol, dave, tokens };
}

const move = (token: string, gameId: string, uci: string, expectedPly: number) =>
  api.request('POST', `/api/games/${gameId}/moves`, { token, body: { uci, expectedPly, clientMoveId: `m-${uci}-${expectedPly}-${Math.random()}` } });

describe('challenges and lobby', () => {
  it('creates, accepts and lists a game through the API', async () => {
    const { group, alice, bob, tokens } = await world();
    const created = await api.request('POST', `/api/groups/${group.publicId}/challenges`, { token: tokens.alice, body: { opponentId: String(bob.id), timePerMove: 3600, colour: 'white', rated: true } });
    expect(created.status).toBe(200);
    const challenge = ChallengeDtoSchema.parse(await created.json());
    expect(challenge.viewer).toEqual({ canAccept: false, canDecline: false, canCancel: true });
    const accepted = await api.request('POST', `/api/challenges/${challenge.id}/accept`, { token: tokens.bob });
    expect(accepted.status).toBe(200);
    const game = GameDtoSchema.parse(await accepted.json());
    expect(game.white.id).toBe(String(alice.id));
    const lobby = LobbyDtoSchema.parse(await (await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.alice })).json());
    expect(lobby.active.map((g) => [g.id, g.yourTurn])).toEqual([[game.id, true]]);
    expect(lobby.challenges).toEqual([]);
  });

  it('refuses the lobby to a non-member and lists known players for the picker', async () => {
    const { group, tokens } = await world();
    expect((await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.dave })).status).toBe(403);
    const players = await (await api.request('GET', `/api/groups/${group.publicId}/players`, { token: tokens.alice })).json();
    expect((players as { players: { name: string }[] }).players.map((p) => p.name).sort()).toEqual(['Bob', 'Carol']);
  });

  it('pages finished games and serves a player page', async () => {
    const { group, alice, bob, tokens } = await world();
    for (let i = 0; i < 25; i += 1) {
      await insertGame(db, group.id, alice.id, bob.id, { status: 'finished', result: '1-0', endReason: 'resignation', finishedAt: new Date(Date.UTC(2026, 0, 1 + i)) });
    }
    const first = await (await api.request('GET', `/api/groups/${group.publicId}/finished`, { token: tokens.alice })).json() as { items: unknown[]; nextCursor: string | null };
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await (await api.request('GET', `/api/groups/${group.publicId}/finished?cursor=${first.nextCursor}`, { token: tokens.alice })).json() as { items: unknown[]; nextCursor: string | null };
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const page = PlayerPageDtoSchema.parse(await (await api.request('GET', `/api/groups/${group.publicId}/players/${bob.id}`, { token: tokens.alice })).json());
    expect(page.headToHead).toEqual({ wins: 25, draws: 0, losses: 0 });
    expect(page.recentGames).toHaveLength(10);
  });
});

describe('games', () => {
  it('plays moves and maps domain errors to statuses', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const ok = await move(tokens.alice, game.publicId, 'e2e4', 0);
    expect(ok.status).toBe(200);
    expect(GameDtoSchema.parse(await ok.json()).plyCount).toBe(1);
    const stale = await move(tokens.bob, game.publicId, 'e7e5', 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'stale_state' } });
    expect((await move(tokens.bob, game.publicId, 'e7e9', 1)).status).toBe(400);
    expect((await move(tokens.bob, game.publicId, 'e7e6', 1)).status).toBe(200);
    expect((await move(tokens.carol, game.publicId, 'd2d4', 2)).status).toBe(403);
    expect((await move(tokens.alice, game.publicId, 'e4e6', 2)).status).toBe(422);
  });

  it('offers, declines and accepts draws, resigns and aborts', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    expect((await api.request('POST', `/api/games/${game.publicId}/draw/offer`, { token: tokens.alice })).status).toBe(200);
    expect((await api.request('POST', `/api/games/${game.publicId}/draw/decline`, { token: tokens.bob })).status).toBe(200);
    expect((await api.request('POST', `/api/games/${game.publicId}/abort`, { token: tokens.bob })).status).toBe(200);
    const second = await insertGame(db, group.id, alice.id, bob.id, { fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2', plyCount: 2 });
    const resigned = GameDtoSchema.parse(await (await api.request('POST', `/api/games/${second.publicId}/resign`, { token: tokens.alice })).json());
    expect(resigned).toMatchObject({ status: 'finished', result: '0-1', endReason: 'resignation' });
    expect(resigned.analysisUrl).toBeUndefined();
  });

  it('shares a position once a minute and serves the PGN', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id, { fen: AFTER_E4, plyCount: 1 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    expect((await api.request('POST', `/api/games/${game.publicId}/share`, { token: tokens.carol, body: { ply: 1 } })).status).toBe(200);
    expect((await api.request('POST', `/api/games/${game.publicId}/share`, { token: tokens.carol, body: { ply: 0 } })).status).toBe(429);
    expect((await api.request('POST', `/api/games/${game.publicId}/share`, { token: tokens.alice, body: { ply: 5 } })).status).toBe(400);
    expect((await api.request('POST', `/api/games/${game.publicId}/share`, { token: tokens.dave, body: { ply: 1 } })).status).toBe(403);
    expect(await db.select().from(shares)).toHaveLength(1);
    expect((await db.select().from(jobs)).map((job) => job.kind)).toEqual(['send_share_photo']);
    const pgn = await api.request('GET', `/api/games/${game.publicId}/pgn`, { token: tokens.carol });
    expect(pgn.headers.get('content-type')).toContain('application/x-chess-pgn');
    const text = await pgn.text();
    expect(text).toContain('[Event "Group Chess"]');
    expect(text).toContain(`[Site "${group.title}"]`);
    expect(text).toContain('1. e4 *');
    expect((await api.request('GET', `/api/games/${game.publicId}/pgn`, { token: tokens.dave })).status).toBe(403);
  });

  it('creates a rematch through the API', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id, { status: 'finished', result: '1-0', endReason: 'checkmate', finishedAt: new Date() });
    const res = await api.request('POST', `/api/games/${game.publicId}/rematch`, { token: tokens.bob });
    expect(res.status).toBe(200);
    expect(ChallengeDtoSchema.parse(await res.json())).toMatchObject({ challengerColour: 'white', challenger: { id: String(bob.id) } });
  });
});

describe('GET /api/games/:id/events', () => {
  const readChunk = async (res: Response) => {
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(value);
  };

  it('sends the state on connect and again after a move', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const controller = new AbortController();
    const res = await api.request('GET', `/api/games/${game.publicId}/events?token=${tokens.carol}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('event: state');
    expect(first).toContain('id: 0');
    await move(tokens.alice, game.publicId, 'e2e4', 0);
    let received = '';
    while (!received.includes('id: 1')) received += decoder.decode((await reader.read()).value);
    expect(received).toContain('"plyCount":1');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.ctx.streams.count(Number(tokens.carol.length) || 0)).toBe(0);
  });

  it('refuses the stream to a non-member and caps open streams at four per user', async () => {
    const { group, alice, bob, carol, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    expect((await api.request('GET', `/api/games/${game.publicId}/events?token=${tokens.dave}`)).status).toBe(403);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    for (const controller of controllers) {
      const res = await api.request('GET', `/api/games/${game.publicId}/events?token=${tokens.carol}`, { signal: controller.signal });
      expect(res.status).toBe(200);
      await readChunk(res);
    }
    const fifth = await api.request('GET', `/api/games/${game.publicId}/events?token=${tokens.carol}`);
    expect(fifth.status).toBe(429);
    for (const controller of controllers) controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.ctx.streams.count(carol.id)).toBe(0);
  });
});

describe('admin routes', () => {
  it('guards settings, blocks and voids behind the admin check and audits them', async () => {
    const { group, alice, bob, carol, tokens } = await world();
    expect((await api.request('GET', `/api/groups/${group.publicId}/settings`, { token: tokens.carol })).status).toBe(403);
    api.fake.admins = [33];
    api.ctx.membership.invalidateAdmins(group.id);
    expect((await api.request('GET', `/api/groups/${group.publicId}/settings`, { token: tokens.carol })).status).toBe(200);
    const updated = await api.request('PUT', `/api/groups/${group.publicId}/settings`, { token: tokens.carol, body: { maxActiveGamesPerUser: 3 } });
    expect((await updated.json() as { settings: { maxActiveGamesPerUser: number } }).settings.maxActiveGamesPerUser).toBe(3);
    expect((await api.request('PUT', `/api/groups/${group.publicId}/settings`, { token: tokens.carol, body: { cardTopicMode: 'fixed' } })).status).toBe(400);
    expect((await api.request('POST', `/api/groups/${group.publicId}/blocks`, { token: tokens.carol, body: { userId: String(bob.id) } })).status).toBe(200);
    expect((await db.select().from(groupMembers).where(eq(groupMembers.userId, bob.id)))[0]?.blockedAt).not.toBeNull();
    expect((await api.request('DELETE', `/api/groups/${group.publicId}/blocks/${bob.id}`, { token: tokens.carol })).status).toBe(200);
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const voided = GameDtoSchema.parse(await (await api.request('POST', `/api/games/${game.publicId}/void`, { token: tokens.carol })).json());
    expect(voided).toMatchObject({ voided: true, endReason: 'voided' });
    expect((await db.select().from(adminActions).orderBy(adminActions.id)).map((row) => row.action)).toEqual(['settings', 'block', 'unblock', 'void']);
    expect((await api.request('POST', `/api/games/${game.publicId}/void`, { token: tokens.alice })).status).toBe(403);
  });
});

describe('unknown ids', () => {
  it('answers 404 for a well-formed unknown id and for a malformed one', async () => {
    const { tokens } = await world();
    expect((await api.request('GET', '/api/games/zzzzzzzzzz', { token: tokens.alice })).status).toBe(404);
    expect((await api.request('GET', '/api/games/not-an-id', { token: tokens.alice })).status).toBe(404);
    const [row] = await db.execute(sql`select 1 as one`);
    expect(row?.one).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/api-games.test.ts`
Expected: FAIL — the routes do not exist yet (404s / cannot load `../../src/api/routes/index` once the helper imports it).

- [ ] **Step 3: Write the implementation**

`apps/server/src/api/access.ts`:

```ts
import type { GameRow, GroupRow, UserRow } from '../db/schema';
import { DomainError } from '../domain/errors';
import { colourOf } from '../domain/gameDto';
import { requireGroup } from '../domain/groups';
import type { ApiContext } from './context';

/** Spec §12 authorization matrix, membership half. */
export async function requireMember(ctx: ApiContext, group: GroupRow, user: UserRow): Promise<void> {
  if (!(await ctx.membership.verify(group, user))) {
    throw new DomainError('forbidden', 'not a member of this group', { reason: 'locked' });
  }
}

/** The two players always; otherwise a verified member of the game's group. */
export async function requireGameAccess(ctx: ApiContext, game: GameRow, user: UserRow): Promise<GroupRow> {
  const group = await requireGroup(ctx.deps.db, game.groupId);
  if (colourOf(game, user.id)) return group;
  await requireMember(ctx, group, user);
  return group;
}

export async function requireAdmin(ctx: ApiContext, group: GroupRow, user: UserRow): Promise<void> {
  if (!(await ctx.membership.isAdmin(group, user))) {
    throw new DomainError('forbidden', 'group administrators only');
  }
}
```

`apps/server/src/domain/sharing.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import { shares } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGameByPublicId } from './games';
import { enqueue } from '../jobs/queue';

/** PRD §7.6 / spec §7.8: one shared position per user per minute; the photo itself is a job. */
export async function sharePosition(deps: Deps, input: { gameId: string; userId: number; ply: number }): Promise<{ shareId: number }> {
  return deps.db.transaction(async (tx) => {
    const game = await requireGameByPublicId(tx, input.gameId);
    if (input.ply > game.plyCount) throw new DomainError('validation', 'ply is beyond the game', { plyCount: game.plyCount });
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shares)
      .where(and(eq(shares.userId, input.userId), sql`${shares.createdAt} > now() - interval '1 minute'`));
    if ((recent?.n ?? 0) > 0) throw new DomainError('rate_limited', 'one shared position per minute', { reason: 'share' });
    const [share] = await tx.insert(shares).values({ gameId: game.id, userId: input.userId, ply: input.ply }).returning({ id: shares.id });
    if (!share) throw new Error('share insert returned no row');
    await enqueue(tx, { kind: 'send_share_photo', payload: { shareId: share.id } });
    return { shareId: share.id };
  });
}
```

`apps/server/src/domain/pgn.ts`:

```ts
import { buildPgn, type TimePerMove } from '@group-chess/shared';
import type { DbOrTx } from '../db/client';
import type { GameRow } from '../db/schema';
import { listMoves } from './games';
import { requireGroup } from './groups';
import { displayName, requireUser } from './users';

/** Spec §7.6 headers and movetext from the moves table. */
export async function buildGamePgn(tx: DbOrTx, game: GameRow): Promise<string> {
  const [group, white, black, moves] = await Promise.all([
    requireGroup(tx, game.groupId),
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
    listMoves(tx, game.id),
  ]);
  return buildPgn(
    {
      site: group.title,
      date: game.startedAt,
      white: displayName(white),
      black: displayName(black),
      result: game.result ?? '*',
      whiteElo: game.rated ? (game.whiteRatingBefore ?? null) : null,
      blackElo: game.rated ? (game.blackRatingBefore ?? null) : null,
      timePerMove: game.timePerMove as TimePerMove,
      endReason: game.endReason,
    },
    moves.map((move) => move.san),
  );
}
```

Append to `apps/server/src/domain/admin.ts`:

```ts
import { GroupSettingsSchema, type GroupSettings } from '@group-chess/shared';
import { adminActions } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGroup, updateGroupSettings } from './groups';
import { blockUser, unblockUser } from './members';

/** Settings write with the cross-field rule and an audit row (spec §7.11, §12). */
export async function adminUpdateSettings(deps: Deps, group: GroupRow, adminId: number, patch: Partial<GroupSettings>): Promise<GroupSettingsDto> {
  const merged = GroupSettingsSchema.parse({ ...settingsOf(group), ...patch });
  if (merged.cardTopicMode === 'fixed' && merged.fixedTopicId === null) {
    throw new DomainError('validation', 'a fixed topic needs a topic id', { issues: ['fixedTopicId'] });
  }
  await deps.db.transaction(async (tx) => {
    await updateGroupSettings(tx, group.id, merged);
    await tx.insert(adminActions).values({ groupId: group.id, adminUserId: adminId, action: 'settings', details: patch as Record<string, unknown> });
  });
  return groupSettingsDto(deps.db, await requireGroup(deps.db, group.id));
}

export async function adminBlock(deps: Deps, group: GroupRow, adminId: number, userId: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await blockUser(tx, group.id, userId, adminId);
    await tx.insert(adminActions).values({ groupId: group.id, adminUserId: adminId, action: 'block', targetUserId: userId });
  });
}

export async function adminUnblock(deps: Deps, group: GroupRow, adminId: number, userId: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await unblockUser(tx, group.id, userId);
    await tx.insert(adminActions).values({ groupId: group.id, adminUserId: adminId, action: 'unblock', targetUserId: userId });
  });
}
```

(Merge the new imports with the existing ones at the top of the file; `GroupRow` and `settingsOf` are already imported there.)

`apps/server/src/api/routes/groups.ts`:

```ts
import { ChallengeRequestSchema, FinishedQuerySchema, UserIdSchema, type PlayersPickerDto } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { challenges } from '../../db/schema';
import { createChallenge } from '../../domain/challenges';
import { requireGroupByPublicId, settingsOf } from '../../domain/groups';
import { buildLobby, listFinished, playerPage } from '../../domain/lobby';
import { listKnownPlayers } from '../../domain/members';
import { getLeaderboard } from '../../domain/ratings';
import { challengeDtoRows, challengeToDto } from '../../domain/summaries';
import { requireMember } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';
import { validate } from '../validate';

export function groupsRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  const memberGroup = async (c: Parameters<Parameters<typeof api.get>[1]>[0]) => {
    const group = await requireGroupByPublicId(db, publicIdParam(c, 'g'));
    await requireMember(ctx, group, c.get('user'));
    return group;
  };

  api.get('/groups/:g', async (c) => {
    const group = await memberGroup(c);
    const isAdmin = await ctx.membership.isAdmin(group, c.get('user'));
    return c.json(await buildLobby(ctx.deps, group, c.get('user'), { isAdmin }));
  });

  api.get('/groups/:g/players', async (c) => {
    const group = await memberGroup(c);
    const body: PlayersPickerDto = { players: await listKnownPlayers(db, group.id, { excludeUserId: c.get('user').id }) };
    return c.json(body);
  });

  api.get('/groups/:g/leaderboard', async (c) => {
    const group = await memberGroup(c);
    return c.json({ players: await getLeaderboard(db, group.id, settingsOf(group).leaderboardMinGames) });
  });

  api.get('/groups/:g/players/:u', async (c) => {
    const group = await memberGroup(c);
    const userId = UserIdSchema.parse(c.req.param('u'));
    return c.json(await playerPage(ctx.deps, group.id, c.get('user').id, Number(userId)));
  });

  api.get('/groups/:g/finished', validate('query', FinishedQuerySchema), async (c) => {
    const group = await memberGroup(c);
    return c.json(await listFinished(ctx.deps, group.id, c.get('user').id, c.req.valid('query').cursor ?? null));
  });

  api.post('/groups/:g/challenges', validate('json', ChallengeRequestSchema), async (c) => {
    const group = await memberGroup(c);
    const body = c.req.valid('json');
    const settings = settingsOf(group);
    const challenge = await createChallenge(ctx.deps, {
      groupId: group.id,
      challengerId: c.get('user').id,
      opponentId: body.opponentId === null ? null : Number(body.opponentId),
      timePerMove: body.timePerMove,
      colour: body.colour,
      rated: body.rated,
      threadId: settings.cardTopicMode === 'fixed' ? settings.fixedTopicId : null,
    });
    const [row] = await challengeDtoRows(db, eq(challenges.id, challenge.id), 1);
    return c.json(challengeToDto(row!, c.get('user').id));
  });
}
```

`apps/server/src/api/routes/challenges.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { challenges } from '../../db/schema';
import { acceptChallenge, cancelChallenge, declineChallenge, getChallengeByPublicId } from '../../domain/challenges';
import { DomainError } from '../../domain/errors';
import { loadGameDto } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { requireMember } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';

export function challengeRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  const load = async (c: Parameters<Parameters<typeof api.post>[1]>[0]) => {
    const challenge = await getChallengeByPublicId(db, publicIdParam(c, 'c'));
    if (!challenge) throw new DomainError('not_found', 'challenge not found');
    await requireMember(ctx, await requireGroup(db, challenge.groupId), c.get('user'));
    return challenge;
  };

  api.post('/challenges/:c/accept', async (c) => {
    const challenge = await load(c);
    const { game } = await acceptChallenge(ctx.deps, { challengeId: challenge.id, userId: c.get('user').id });
    return c.json(await loadGameDto(db, game, c.get('user').id));
  });

  api.post('/challenges/:c/decline', async (c) => {
    const challenge = await load(c);
    await declineChallenge(ctx.deps, { challengeId: challenge.id, userId: c.get('user').id });
    return c.json({ ok: true });
  });

  api.post('/challenges/:c/cancel', async (c) => {
    const challenge = await load(c);
    await cancelChallenge(ctx.deps, { challengeId: challenge.id, userId: c.get('user').id });
    return c.json({ ok: true });
  });

  void challenges;
  void eq;
}
```

`apps/server/src/api/routes/games.ts`:

```ts
import { MoveRequestSchema, ShareRequestSchema } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { challenges } from '../../db/schema';
import { createRematch } from '../../domain/challenges';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../domain/draws';
import { abortGame, loadGameDto, playMove, requireGameByPublicId, resign } from '../../domain/games';
import { buildGamePgn } from '../../domain/pgn';
import { sharePosition } from '../../domain/sharing';
import { challengeDtoRows, challengeToDto } from '../../domain/summaries';
import { requireGameAccess } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';
import { validate } from '../validate';

export function gamesRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  type Ctx = Parameters<Parameters<typeof api.get>[1]>[0];
  const accessible = async (c: Ctx) => {
    const game = await requireGameByPublicId(db, publicIdParam(c, 'id'));
    await requireGameAccess(ctx, game, c.get('user'));
    return game;
  };
  const gameId = (c: Ctx) => publicIdParam(c, 'id');
  const userId = (c: Ctx) => c.get('user').id;

  api.get('/games/:id', async (c) => c.json(await loadGameDto(db, await accessible(c), userId(c))));

  api.post('/games/:id/moves', validate('json', MoveRequestSchema), async (c) => {
    const dto = await playMove(ctx.deps, { gameId: gameId(c), userId: userId(c), ...c.req.valid('json') });
    ctx.metrics.movesTotal.inc();
    if (dto.status === 'finished' && dto.endReason) ctx.metrics.gamesFinished.inc({ end_reason: dto.endReason });
    return c.json(dto);
  });

  api.post('/games/:id/draw/offer', async (c) => c.json(await offerDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })));
  api.post('/games/:id/draw/accept', async (c) => c.json(await acceptDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })));
  api.post('/games/:id/draw/decline', async (c) => c.json(await declineDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })));
  api.post('/games/:id/draw/claim', async (c) => c.json(await claimDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })));
  api.post('/games/:id/resign', async (c) => c.json(await resign(ctx.deps, { gameId: gameId(c), userId: userId(c) })));
  api.post('/games/:id/abort', async (c) => c.json(await abortGame(ctx.deps, { gameId: gameId(c), userId: userId(c) })));

  api.post('/games/:id/share', validate('json', ShareRequestSchema), async (c) => {
    const game = await accessible(c);
    await sharePosition(ctx.deps, { gameId: game.publicId, userId: userId(c), ply: c.req.valid('json').ply });
    return c.json({ ok: true });
  });

  api.post('/games/:id/rematch', async (c) => {
    const game = await accessible(c);
    const challenge = await createRematch(ctx.deps, { gameId: game.id, userId: userId(c) });
    const [row] = await challengeDtoRows(db, eq(challenges.id, challenge.id), 1);
    return c.json(challengeToDto(row!, userId(c)));
  });

  api.get('/games/:id/pgn', async (c) => {
    const game = await accessible(c);
    c.header('Content-Type', 'application/x-chess-pgn; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${game.publicId}.pgn"`);
    return c.body(await buildGamePgn(db, game));
  });
}
```

`apps/server/src/api/routes/events.ts`:

```ts
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
    if (!ctx.streams.acquire(user.id)) throw new DomainError('rate_limited', 'too many open streams', { reason: 'streams' });
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
              await stream.writeSSE({ event: 'state', id: String(dto.version), data: JSON.stringify(dto) });
            })
            .catch(() => undefined);
          return chain;
        };
        if (!Number.isFinite(lastEventId) || lastEventId < game.version) await send();
        const unsubscribe = ctx.deps.bus.subscribe(publicId, () => void send());
        const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined), PING_MS);
        await new Promise<void>((resolve) => stream.onAbort(resolve));
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
```

`apps/server/src/api/routes/admin.ts`:

```ts
import { BlockRequestSchema, GroupSettingsUpdateRequestSchema, UserIdSchema } from '@group-chess/shared';
import type { Hono } from 'hono';
import { adminBlock, adminUnblock, adminUpdateSettings, groupSettingsDto } from '../../domain/admin';
import { requireGameByPublicId, voidGame } from '../../domain/games';
import { requireGroup, requireGroupByPublicId } from '../../domain/groups';
import { requireAdmin } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';
import { validate } from '../validate';

/** Spec §7.11/§12: every read and write re-checks admin rights through the cached ladder. */
export function adminRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  type Ctx = Parameters<Parameters<typeof api.get>[1]>[0];
  const adminGroup = async (c: Ctx) => {
    const group = await requireGroupByPublicId(db, publicIdParam(c, 'g'));
    await requireAdmin(ctx, group, c.get('user'));
    return group;
  };

  api.get('/groups/:g/settings', async (c) => c.json(await groupSettingsDto(db, await adminGroup(c))));

  api.put('/groups/:g/settings', validate('json', GroupSettingsUpdateRequestSchema), async (c) => {
    const group = await adminGroup(c);
    return c.json(await adminUpdateSettings(ctx.deps, group, c.get('user').id, c.req.valid('json')));
  });

  api.post('/groups/:g/blocks', validate('json', BlockRequestSchema), async (c) => {
    const group = await adminGroup(c);
    await adminBlock(ctx.deps, group, c.get('user').id, Number(c.req.valid('json').userId));
    return c.json({ ok: true });
  });

  api.delete('/groups/:g/blocks/:u', async (c) => {
    const group = await adminGroup(c);
    await adminUnblock(ctx.deps, group, c.get('user').id, Number(UserIdSchema.parse(c.req.param('u'))));
    return c.json({ ok: true });
  });

  api.post('/games/:id/void', async (c) => {
    const game = await requireGameByPublicId(db, publicIdParam(c, 'id'));
    const group = await requireGroup(db, game.groupId);
    await requireAdmin(ctx, group, c.get('user'));
    return c.json(await voidGame(ctx.deps, { gameId: game.publicId, adminUserId: c.get('user').id }));
  });
}
```

`apps/server/src/api/routes/index.ts`:

```ts
import type { RegisterRoutes } from '../app';
import { adminRoutes } from './admin';
import { challengeRoutes } from './challenges';
import { eventsRoutes } from './events';
import { gamesRoutes } from './games';
import { groupsRoutes } from './groups';

/** Everything behind a session besides the account routes. */
export const gameRoutes: RegisterRoutes[] = [groupsRoutes, challengeRoutes, gamesRoutes, eventsRoutes, adminRoutes];
```

In `apps/server/test/helpers/api.ts` import `gameRoutes` from `../../src/api/routes/index` and change the signature to `startTestApi(db: Db, extra: RegisterRoutes[] = gameRoutes)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/api-games.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add the game, group, stream, sharing, PGN and admin routes"
```

---
### Task 6: Board images, the share photo job, the Lichess import, metrics wiring, static Mini App serving and `main.ts`

**Files:**
- Create: `scripts/vendor-pieces.mjs`, `apps/server/src/images/pieces.ts` (generated), `apps/server/src/images/ATTRIBUTION.md`, `apps/server/src/images/board.ts`, `apps/server/src/images/cache.ts`, `apps/server/src/jobs/handlers/sharePhoto.ts`, `apps/server/src/jobs/handlers/lichess.ts`, `apps/server/src/api/staticApp.ts`, `apps/server/src/main.ts`, `apps/server/src/index.ts`
- Modify: `apps/server/package.json` (add `@resvg/resvg-js`, `chess.js`, `start` and `dev` scripts), `apps/server/src/jobs/handlers/telegram.ts` (export `call` and `settle`), `apps/server/src/jobs/handlers/index.ts` (re-export the new factories), `apps/server/src/jobs/worker.ts` (optional `onFailed` hook), `apps/server/src/telegram/client.ts` (`instrumentTelegramApi`), `apps/server/src/api/app.ts` (`Cache-Control` only when the handler set none), `.env.example`
- Test: `apps/server/test/unit/board.test.ts`, `apps/server/test/unit/staticApp.test.ts`, `apps/server/test/integration/share-photo.test.ts`, `apps/server/test/integration/lichess.test.ts`, `apps/server/test/integration/main.test.ts`

**Interfaces:**
- Consumes: Task 3 `TelegramHandlerContext`, `call`, `settle`; Task 5 `buildGamePgn`, `gameRoutes`; Task 4 `createApiApp`, `ApiContext`, `StreamGate`, `Metrics`; Task 2 `createBot`, `webhookRoutes`; plan 2 `JobWorker`, `coreJobHandlers`, `ensurePruneScheduled`, `startScanners`, `runMigrations`, `createDb`; shared `INITIAL_FEN`, `sideToMove`, `t`.
- Produces: `parsePlacement(fen)`, `renderBoardSvg({ fen, lastMove, check, orientation }): string`, `renderBoardPng(svg): Buffer`, `BOARD_THEME`, `IMAGE_SIZE = 1024`; `boardImageKey(input, theme?)`, `getCachedFileId(tx, key)`, `storeFileId(tx, key, fileId)`; `positionAtPly(moves, ply)`, `sharePhotoJobHandlers(ctx: TelegramHandlerContext): JobHandlers`; `class LichessPacer`, `lichessJobHandlers(ctx: { deps; config; metrics?; fetch?; spacingMs?; pauseMs? }): JobHandlers`; `staticAppRoutes(dir, mountPath = '/app'): Hono`; `instrumentTelegramApi(api, metrics)`; `WorkerOptions.onFailed?(job, error)`; `startServer(config): Promise<{ port; app; stop() }>`, `ALLOWED_UPDATES`.

**Rulings recorded in this task** (each with its cost if wrong):
- Coordinate labels are omitted from the shared image. The spec asks for labels "drawn as paths"; that means sixteen hand-authored glyph paths with no PRD requirement behind them, and a shared position reads fine without them. Cost if wrong: a follow-up adds the glyphs to `renderBoardSvg` and every cache key changes once (the theme string is bumped).
- The cburnett set is taken from lichess's mirror and used under CC BY-SA 3.0 as the spec says; lila's own `COPYING.md` lists that directory as GPLv2+, and the author multi-licenses the set on Wikimedia Commons (GFDL, BSD, GPLv2+, CC BY-SA 3.0). The attribution file states both. Cost if wrong: the attribution file names a different licence from the same allow-list.
- The pieces are vendored as a generated TypeScript module rather than runtime asset files, so the server has no asset path to get wrong under `tsx`, `tsc` or Docker. Cost if wrong: a 30 KB module in the tree instead of twelve SVG files.
- The server calls `setWebhook` itself at boot in webhook mode (idempotent, with the secret and the §5.1 `allowed_updates`) and `deleteWebhook` before long polling. Cost if wrong: an operator who wants to manage the webhook by hand sets `TELEGRAM_POLLING` or removes one line.
- Static files are served by a small handler in `api/staticApp.ts` instead of `@hono/node-server`'s `serveStatic`, because the cache rules (`immutable` for `assets/`, `no-store` for `index.html`, SPA fallback) are the whole point and are easier to own than to configure. Cost if wrong: forty lines to delete.

- [ ] **Step 1: Add the dependencies and vendor the piece set**

In `apps/server/package.json` add to `dependencies`:

```json
    "@resvg/resvg-js": "^2.6.2",
    "chess.js": "^1.4.0",
```

and to `scripts`:

```json
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
```

Run: `pnpm install`
Expected: exit 0.

`scripts/vendor-pieces.mjs`:

```js
#!/usr/bin/env node
// Downloads the cburnett piece set (Colin M.L. Burnett) from lichess's mirror and writes it as a
// TypeScript module so the server needs no asset path at runtime. Run once; commit the output.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett';
const PIECES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/server/src/images/pieces.ts',
);

function inner(svg) {
  const open = svg.match(/<svg\b[^>]*>/);
  if (!open || !/viewBox="0 0 45 45"/.test(open[0])) throw new Error('unexpected piece svg');
  return svg
    .slice(open.index + open[0].length)
    .replace(/<\/svg>\s*$/, '')
    .trim();
}

const entries = [];
for (const piece of PIECES) {
  const response = await fetch(`${SOURCE}/${piece}.svg`);
  if (!response.ok) throw new Error(`${piece}: HTTP ${response.status}`);
  entries.push(`  ${piece}: ${JSON.stringify(inner(await response.text()))},`);
}
const header = `// Generated by scripts/vendor-pieces.mjs — do not edit by hand.
// cburnett chess pieces by Colin M.L. Burnett, used under CC BY-SA 3.0 (see ATTRIBUTION.md).
// Each entry is the content of a 45 × 45 SVG without its outer <svg> element.
`;
await mkdir(dirname(target), { recursive: true });
await writeFile(
  target,
  `${header}\nexport const PIECE_VIEWBOX = 45;\n\nexport const PIECES = {\n${entries.join('\n')}\n} as const;\n\nexport type PieceCode = keyof typeof PIECES;\n`,
);
console.log(`wrote ${target}`);
```

`apps/server/src/images/ATTRIBUTION.md`:

```markdown
# Piece set attribution

The chess piece glyphs embedded in `pieces.ts` are the **cburnett** set by
[Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett), copied from the files that
lichess.org ships under `public/piece/cburnett` and regenerated with `scripts/vendor-pieces.mjs`.

The author multi-licenses the set on Wikimedia Commons (GFDL, BSD, GPLv2+ and CC BY-SA 3.0);
lichess redistributes its copy under GPLv2+. This project uses the glyphs under the
[Creative Commons Attribution-ShareAlike 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
terms, as the technical design requires. The only change is that each standalone SVG file was
turned into an inline fragment. Shared position images carry this credit, and the Mini App's
About screen repeats it.
```

Run: `node scripts/vendor-pieces.mjs && pnpm prettier --write apps/server/src/images/pieces.ts`
Expected: `wrote …/apps/server/src/images/pieces.ts`; the file exports twelve entries and typechecks.

- [ ] **Step 2: Write the failing unit tests for the board renderer, the cache key and the static handler**

`apps/server/test/unit/board.test.ts`:

```ts
import { INITIAL_FEN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { parsePlacement, renderBoardPng, renderBoardSvg } from '../../src/images/board';
import { boardImageKey } from '../../src/images/cache';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
/** Fool's mate: the white king on e1 is in check from h4. */
const CHECK = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
const white = { lastMove: null, check: false, orientation: 'white' as const };

describe('parsePlacement', () => {
  it('reads the initial position into files and ranks', () => {
    const pieces = parsePlacement(INITIAL_FEN);
    expect(pieces).toHaveLength(32);
    expect(pieces).toContainEqual({ file: 4, rank: 0, piece: 'wK' });
    expect(pieces).toContainEqual({ file: 3, rank: 7, piece: 'bQ' });
  });
});

describe('renderBoardSvg', () => {
  it('draws 64 squares with a dark a1 and 32 pieces for the initial position', () => {
    const svg = renderBoardSvg({ fen: INITIAL_FEN, ...white });
    expect(svg.match(/<rect /g)).toHaveLength(64);
    expect(svg).toContain('<rect x="0" y="700" width="100" height="100" fill="#b58863"/>');
    expect(svg.match(/<g class="piece /g)).toHaveLength(32);
    expect(svg).toContain('class="piece wK" transform="translate(400 700)');
  });

  it('highlights the last move squares and the checked king', () => {
    const svg = renderBoardSvg({ fen: CHECK, lastMove: 'd8h4', check: true, orientation: 'white' });
    expect(svg).toContain('<rect class="last-move" x="300" y="0"');
    expect(svg).toContain('<rect class="last-move" x="700" y="400"');
    expect(svg).toContain('<rect class="check" x="400" y="700"');
  });

  it('puts the sharer colour at the bottom', () => {
    const svg = renderBoardSvg({ fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'black' });
    expect(svg).toContain('class="piece wK" transform="translate(300 0)');
    expect(svg).toContain('<rect class="last-move" x="300" y="300"');
  });
});

describe('renderBoardPng', () => {
  it('rasterises to a 1024 × 1024 PNG', () => {
    const png = renderBoardPng(renderBoardSvg({ fen: INITIAL_FEN, ...white }));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });
});

describe('boardImageKey', () => {
  it('ignores the move counters and changes with orientation, highlight and check', () => {
    const base = { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' as const };
    const sameBoard = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 5 9';
    expect(boardImageKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(boardImageKey(base)).toBe(boardImageKey({ ...base, fen: sameBoard }));
    expect(boardImageKey(base)).not.toBe(boardImageKey({ ...base, orientation: 'black' }));
    expect(boardImageKey(base)).not.toBe(boardImageKey({ ...base, lastMove: null }));
    expect(boardImageKey(base)).not.toBe(boardImageKey({ ...base, check: true }));
    expect(boardImageKey(base)).not.toBe(boardImageKey(base, 'blue'));
  });
});
```

`apps/server/test/unit/staticApp.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { staticAppRoutes } from '../../src/api/staticApp';

let app: Hono;

beforeAll(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'static-'));
  const dir = join(parent, 'dist');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Group Chess</title>');
  await writeFile(join(dir, 'assets', 'app-1a2b3c.js'), 'console.log(1)');
  await writeFile(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(parent, 'secret.txt'), 'nope');
  app = new Hono();
  app.route('/app', staticAppRoutes(dir));
});

describe('staticAppRoutes', () => {
  it('serves index.html uncached at the mount root', async () => {
    const response = await app.request('/app/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Group Chess');
  });

  it('serves hashed assets as immutable', async () => {
    const response = await app.request('/app/assets/app-1a2b3c.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves other files with a short cache', async () => {
    const response = await app.request('/app/favicon.svg');
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('falls back to index.html for client-side routes', async () => {
    const response = await app.request('/app/g/AbCdEfGhIj');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Group Chess');
  });

  it('answers 404 for a missing asset or file instead of falling back', async () => {
    expect((await app.request('/app/assets/missing.js')).status).toBe(404);
    expect((await app.request('/app/robots.txt')).status).toBe(404);
  });

  it('never leaves the directory', async () => {
    const response = await app.request('/app/%2e%2e/secret.txt');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('nope');
  });
});
```

- [ ] **Step 3: Run the unit tests to verify they fail**

Run: `pnpm vitest run apps/server/test/unit/board.test.ts apps/server/test/unit/staticApp.test.ts`
Expected: FAIL — `Cannot find module '../../src/images/board'` and `'../../src/api/staticApp'`.

- [ ] **Step 4: Write the board renderer, the cache and the static handler**

`apps/server/src/images/board.ts`:

```ts
import { sideToMove, type Colour } from '@group-chess/shared';
import { Resvg } from '@resvg/resvg-js';
import { PIECE_VIEWBOX, PIECES, type PieceCode } from './pieces';

export const BOARD_THEME = 'brown';
export const IMAGE_SIZE = 1024;
const SQUARE = 100;
const LIGHT = '#f0d9b5';
const DARK = '#b58863';
const LAST_MOVE = 'rgba(155, 199, 0, 0.41)';
const FILES = 'abcdefgh';
const CHECK_GRADIENT =
  '<defs><radialGradient id="check" r="0.5">' +
  '<stop offset="0%" stop-color="#ff0000" stop-opacity="1"/>' +
  '<stop offset="25%" stop-color="#e70000" stop-opacity="1"/>' +
  '<stop offset="89%" stop-color="#a90000" stop-opacity="0"/>' +
  '<stop offset="100%" stop-color="#9e0000" stop-opacity="0"/>' +
  '</radialGradient></defs>';

export type BoardRenderInput = {
  fen: string;
  /** UCI of the move that produced the position, or null for the initial position. */
  lastMove: string | null;
  check: boolean;
  /** The colour at the bottom of the image. */
  orientation: Colour;
};

export type PlacedPiece = { file: number; rank: number; piece: PieceCode };

/** The placement field of a FEN as pieces with 0-based file (a = 0) and rank (first rank = 0). */
export function parsePlacement(fen: string): PlacedPiece[] {
  const rows = (fen.split(' ')[0] ?? '').split('/');
  const pieces: PlacedPiece[] = [];
  rows.forEach((row, index) => {
    let file = 0;
    for (const ch of row) {
      const skip = Number(ch);
      if (Number.isInteger(skip) && skip > 0) {
        file += skip;
        continue;
      }
      const colour = ch === ch.toUpperCase() ? 'w' : 'b';
      pieces.push({ file, rank: 7 - index, piece: `${colour}${ch.toUpperCase()}` as PieceCode });
      file += 1;
    }
  });
  return pieces;
}

function squareIndex(square: string): { file: number; rank: number } | null {
  const file = FILES.indexOf(square[0] ?? '');
  const rank = Number(square[1]) - 1;
  if (file < 0 || !(rank >= 0 && rank <= 7)) return null;
  return { file, rank };
}

/** Pixel origin of a square for the given orientation. */
function origin(file: number, rank: number, orientation: Colour): { x: number; y: number } {
  const column = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank;
  return { x: column * SQUARE, y: row * SQUARE };
}

const rect = (cls: string | null, x: number, y: number, fill: string): string =>
  `<rect ${cls ? `class="${cls}" ` : ''}x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="${fill}"/>`;

/** Spec §7.7: squares, last-move and check highlights, cburnett glyphs; no text, so no fonts. */
export function renderBoardSvg(input: BoardRenderInput): string {
  const pieces = parsePlacement(input.fen);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${8 * SQUARE} ${8 * SQUARE}" width="${IMAGE_SIZE}" height="${IMAGE_SIZE}">`,
    CHECK_GRADIENT,
  ];
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const { x, y } = origin(file, rank, input.orientation);
      parts.push(rect(null, x, y, (file + rank) % 2 === 1 ? LIGHT : DARK));
    }
  }
  if (input.lastMove) {
    for (const square of [input.lastMove.slice(0, 2), input.lastMove.slice(2, 4)]) {
      const at = squareIndex(square);
      if (!at) continue;
      const { x, y } = origin(at.file, at.rank, input.orientation);
      parts.push(rect('last-move', x, y, LAST_MOVE));
    }
  }
  if (input.check) {
    const kingCode: PieceCode = sideToMove(input.fen) === 'white' ? 'wK' : 'bK';
    const king = pieces.find((placed) => placed.piece === kingCode);
    if (king) {
      const { x, y } = origin(king.file, king.rank, input.orientation);
      parts.push(rect('check', x, y, 'url(#check)'));
    }
  }
  const scale = (SQUARE / PIECE_VIEWBOX).toFixed(4);
  for (const placed of pieces) {
    const { x, y } = origin(placed.file, placed.rank, input.orientation);
    parts.push(
      `<g class="piece ${placed.piece}" transform="translate(${x} ${y}) scale(${scale})">${PIECES[placed.piece]}</g>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

/** 1024 × 1024 PNG (spec §7.7). */
export function renderBoardPng(svg: string): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: IMAGE_SIZE } }).render().asPng();
}
```

`apps/server/src/images/cache.ts`:

```ts
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { boardImages } from '../db/schema';
import { BOARD_THEME, type BoardRenderInput } from './board';

/** `sha256(placement | side | lastMove | check | orientation | theme)` (spec §7.7). */
export function boardImageKey(input: BoardRenderInput, theme: string = BOARD_THEME): string {
  const [placement = '', side = 'w'] = input.fen.split(' ');
  const material = [placement, side, input.lastMove ?? '', input.check ? '1' : '0', input.orientation, theme];
  return createHash('sha256').update(material.join('|')).digest('hex');
}

export async function getCachedFileId(tx: DbOrTx, key: string): Promise<string | null> {
  const [row] = await tx
    .select({ fileId: boardImages.telegramFileId })
    .from(boardImages)
    .where(eq(boardImages.key, key));
  return row?.fileId ?? null;
}

export async function storeFileId(tx: DbOrTx, key: string, fileId: string): Promise<void> {
  await tx.insert(boardImages).values({ key, telegramFileId: fileId }).onConflictDoNothing();
}
```

`apps/server/src/api/staticApp.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300';

async function fileAt(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Serves the built Mini App under `mountPath` (spec §4.4): hashed files in `assets/` are immutable
 * for a year, `index.html` is never cached, other files get five minutes, and paths without an
 * extension fall back to `index.html` so client-side routes survive a reload.
 */
export function staticAppRoutes(dir: string, mountPath = '/app'): Hono {
  const root = resolve(dir);
  const app = new Hono();
  app.get('/*', async (c) => {
    let relative: string;
    try {
      const path = c.req.path.startsWith(mountPath) ? c.req.path.slice(mountPath.length) : c.req.path;
      relative = normalize(`/${decodeURIComponent(path)}`).split(sep).join('/');
    } catch {
      return c.notFound();
    }
    const target = join(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return c.notFound();
    const isIndex = relative === '/' || relative === '/index.html';
    let body = isIndex ? null : await fileAt(target);
    let type = TYPES[extname(target)] ?? 'application/octet-stream';
    let cache = relative.startsWith('/assets/') ? IMMUTABLE : SHORT;
    if (!body) {
      if (!isIndex && extname(relative) !== '') return c.notFound();
      body = await fileAt(join(root, 'index.html'));
      if (!body) return c.notFound();
      type = TYPES['.html']!;
      cache = 'no-store';
    }
    c.header('Content-Type', type);
    c.header('Cache-Control', cache);
    return c.body(body);
  });
  return app;
}
```

In `apps/server/src/api/app.ts` change the header middleware so a handler's own cache policy survives:

```ts
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm vitest run apps/server/test/unit/board.test.ts apps/server/test/unit/staticApp.test.ts`
Expected: PASS — 12 tests (board 6, static 6).

- [ ] **Step 6: Write the failing integration tests for the share photo and the Lichess import**

`apps/server/test/integration/share-photo.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boardImages, jobs, shares } from '../../src/db/schema';
import { sharePhotoJobHandlers } from '../../src/jobs/handlers/sharePhoto';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import { createTelegramApi } from '../../src/telegram/client';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;
const CHAT = -1001000000005;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_C5 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

beforeAll(async () => {
  fake = await FakeTelegram.start();
  const config = testConfig({ TELEGRAM_API_ROOT: fake.url });
  const api = createTelegramApi(config, { apiRoot: fake.url });
  worker = new JobWorker({ db, log: deps.log, handlers: sharePhotoJobHandlers({ deps, api, config }), workerId: 's' });
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

async function table(botStatus: 'administrator' | 'left' = 'administrator') {
  const group = await insertGroup(db, { telegramChatId: CHAT, botStatus });
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const carol = await insertUser(db, { firstName: 'Carol' });
  const game = await insertGame(db, group.id, alice.id, bob.id, { fen: AFTER_E4_C5, plyCount: 2, cardThreadId: 7 });
  await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
  await insertMove(db, game.id, 2, 'c7c5', 'c5', AFTER_E4_C5);
  return { group, alice, bob, carol, game };
}

async function share(gameId: number, userId: number, ply: number) {
  const [row] = await db.insert(shares).values({ gameId, userId, ply }).returning();
  await enqueue(db, { kind: 'send_share_photo', payload: { shareId: row!.id } });
  return row!;
}

const pendingJobs = () => db.select().from(jobs).where(sql`${jobs.doneAt} is null`);

describe('send_share_photo', () => {
  it('uploads the rendered board with caption, topic and button, then stores the message and file ids', async () => {
    const { alice, game } = await table();
    const row = await share(game.id, alice.id, 2);
    await worker.runOnce();
    const [call] = fake.callsTo('sendPhoto');
    expect(call?.multipart).toBe(true);
    expect(call?.body.__file).toBe(true);
    expect(call?.body.chat_id).toBe(String(CHAT));
    expect(call?.body.message_thread_id).toBe('7');
    expect(call?.body.caption).toBe('Alice shared move 1 · Alice vs Bob · White to move');
    const markup = JSON.parse(String(call?.body.reply_markup)) as { inline_keyboard: { text: string; url: string }[][] };
    expect(markup.inline_keyboard[0]?.[0]).toEqual({
      text: '♟ Open game',
      url: `https://t.me/TestChessBot/chess?startapp=g_${game.publicId}`,
    });
    const [stored] = await db.select().from(shares);
    expect(stored?.id).toBe(row.id);
    expect(stored?.messageId).toBe(101);
    expect(await db.select().from(boardImages)).toMatchObject([{ telegramFileId: 'AgACAgIAAxkFake' }]);
    expect(await pendingJobs()).toHaveLength(0);
  });

  it('reuses the cached file id for the same position', async () => {
    const { alice, carol, game } = await table();
    await share(game.id, alice.id, 2);
    await worker.runOnce();
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    const calls = fake.callsTo('sendPhoto');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.multipart).toBe(false);
    expect(calls[1]?.body.photo).toBe('AgACAgIAAxkFake');
    expect(calls[1]?.body.caption).toBe('Carol shared move 1 · Alice vs Bob · White to move');
    expect(await db.select().from(boardImages)).toHaveLength(1);
    expect((await db.select().from(shares)).map((row) => row.messageId)).toEqual([101, 102]);
  });

  it('renders from the black side when Black shares, which is a different image', async () => {
    const { alice, bob, game } = await table();
    await share(game.id, alice.id, 2);
    await worker.runOnce();
    await share(game.id, bob.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto').map((call) => call.multipart)).toEqual([true, true]);
    expect(await db.select().from(boardImages)).toHaveLength(2);
  });

  it('shares the initial position and an earlier ply', async () => {
    const { carol, game } = await table();
    await share(game.id, carol.id, 0);
    await share(game.id, carol.id, 1);
    await worker.runOnce();
    const captions = fake.callsTo('sendPhoto').map((call) => call.body.caption);
    expect(captions).toEqual([
      'Carol shared move 1 · Alice vs Bob · White to move',
      'Carol shared move 1 · Alice vs Bob · Black to move',
    ]);
  });

  it('delays the photo on a 429 without counting an attempt', async () => {
    const { alice, game } = await table();
    await share(game.id, alice.id, 2);
    fake.failNext('sendPhoto', { error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } });
    await worker.runOnce();
    const [job] = await pendingJobs();
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toContain('retry after 7');
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 5_000);
    expect(await db.select().from(boardImages)).toHaveLength(0);
  });

  it('does nothing once the share was sent or when the bot has left', async () => {
    const { alice, game } = await table('left');
    await share(game.id, alice.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')).toHaveLength(0);
    expect(await pendingJobs()).toHaveLength(0);
  });
});
```

`apps/server/test/integration/lichess.test.ts`:

```ts
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { games, jobs } from '../../src/db/schema';
import { lichessJobHandlers } from '../../src/jobs/handlers/lichess';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

class FakeLichess {
  requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  url = '';
  private queue: number[] = [];
  private readonly server: Server;

  private constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        this.requests.push({ headers: req.headers, body });
        const status = this.queue.shift() ?? 200;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(
          status === 200
            ? JSON.stringify({ id: 'abcd1234', url: 'https://lichess.org/abcd1234' })
            : JSON.stringify({ error: 'no' }),
        );
      });
    });
  }

  static async start(): Promise<FakeLichess> {
    const fake = new FakeLichess();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', () => resolve()));
    fake.url = `http://127.0.0.1:${(fake.server.address() as { port: number }).port}`;
    return fake;
  }

  failNext(status: number): void {
    this.queue.push(status);
  }

  reset(): void {
    this.requests = [];
    this.queue = [];
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const { db, close } = openTestDb();
const deps = testDeps(db);
let lichess: FakeLichess;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_C5 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

const workerWith = (options: { spacingMs?: number; pauseMs?: number; token?: string } = {}) =>
  new JobWorker({
    db,
    log: deps.log,
    workerId: 'l',
    handlers: lichessJobHandlers({
      deps,
      config: testConfig({ LICHESS_API_URL: lichess.url, LICHESS_TOKEN: options.token }),
      spacingMs: options.spacingMs ?? 0,
      pauseMs: options.pauseMs,
    }),
  });

beforeAll(async () => {
  lichess = await FakeLichess.start();
});
beforeEach(async () => {
  await truncateAll(db);
  lichess.reset();
});
afterAll(async () => {
  await lichess.stop();
  await close();
});

async function finishedGame() {
  const group = await insertGroup(db, { title: 'Chess Club' });
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const game = await insertGame(db, group.id, alice.id, bob.id, {
    fen: AFTER_E4_C5,
    plyCount: 2,
    status: 'finished',
    result: '1-0',
    endReason: 'resignation',
    finishedAt: new Date(),
    lichessImportStatus: 'pending',
  });
  await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
  await insertMove(db, game.id, 2, 'c7c5', 'c5', AFTER_E4_C5);
  return game;
}

const importJob = (gameId: number, publicId: string) =>
  enqueue(db, { kind: 'lichess_import', payload: { gameId }, dedupKey: `lichess:${publicId}` });
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);
const gameRow = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('lichess_import', () => {
  it('posts the PGN with the bearer token, stores the url and re-edits the card', async () => {
    const game = await finishedGame();
    await importJob(game.id, game.publicId);
    await workerWith({ token: 'tok' }).runOnce();
    const [request] = lichess.requests;
    expect(request?.headers.authorization).toBe('Bearer tok');
    expect(request?.headers['content-type']).toContain('application/x-www-form-urlencoded');
    const pgn = new URLSearchParams(request?.body).get('pgn') ?? '';
    expect(pgn).toContain('[Event "Group Chess"]');
    expect(pgn).toContain('[Site "Chess Club"]');
    expect(pgn).toContain('1. e4 c5 1-0');
    const after = await gameRow(game.id);
    expect(after.lichessUrl).toBe('https://lichess.org/abcd1234');
    expect(after.lichessImportStatus).toBe('done');
    const pending = (await jobRows()).filter((job) => job.doneAt === null);
    expect(pending.map((job) => [job.kind, job.dedupKey])).toEqual([['edit_card', `card:g:${game.publicId}`]]);
  });

  it('sends no authorization header without a token', async () => {
    const game = await finishedGame();
    await importJob(game.id, game.publicId);
    await workerWith().runOnce();
    expect(lichess.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('pauses a minute after a 429 without counting an attempt, and holds other imports meanwhile', async () => {
    const first = await finishedGame();
    const second = await finishedGame();
    await importJob(first.id, first.publicId);
    lichess.failNext(429);
    const worker = workerWith();
    await worker.runOnce();
    const [job] = await jobRows();
    expect(job?.attempts).toBe(0);
    expect(job?.doneAt).toBeNull();
    expect(job?.lastError).toBe('lichess 429');
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect((await gameRow(first.id)).lichessImportStatus).toBe('pending');

    await importJob(second.id, second.publicId);
    await worker.runOnce();
    expect(lichess.requests).toHaveLength(1);
    const held = (await jobRows()).find((row) => row.dedupKey === `lichess:${second.publicId}`);
    expect(held?.lastError).toBe('lichess pacing');
    expect(held?.doneAt).toBeNull();
  });

  it('keeps one request in flight and spaces the next one', async () => {
    const first = await finishedGame();
    const second = await finishedGame();
    await importJob(first.id, first.publicId);
    await importJob(second.id, second.publicId);
    await workerWith({ spacingMs: 400 }).runOnce();
    expect(lichess.requests).toHaveLength(1);
    const rows = await jobRows();
    expect(rows[0]?.doneAt).not.toBeNull();
    expect(rows[1]?.doneAt).toBeNull();
    expect(rows[1]?.lastError).toBe('lichess pacing');
    expect(rows[1]!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('retries a server error with backoff before the last attempt', async () => {
    const game = await finishedGame();
    await importJob(game.id, game.publicId);
    lichess.failNext(500);
    await workerWith().runOnce();
    const [job] = await jobRows();
    expect(job?.attempts).toBe(1);
    expect(job?.doneAt).toBeNull();
    expect(job?.lastError).toBe('lichess HTTP 500');
    expect((await gameRow(game.id)).lichessImportStatus).toBe('pending');
  });

  it('marks the game failed on the eighth failure so the card keeps the fallback link', async () => {
    const game = await finishedGame();
    await db.insert(jobs).values({ kind: 'lichess_import', payload: { gameId: game.id }, attempts: 7, maxAttempts: 8 });
    lichess.failNext(503);
    await workerWith().runOnce();
    const [job] = await jobRows();
    expect(job?.failedAt).not.toBeNull();
    expect(job?.lastError).toBe('lichess HTTP 503');
    expect((await gameRow(game.id)).lichessImportStatus).toBe('failed');
  });

  it('skips a game that is not waiting for an import', async () => {
    const game = await finishedGame();
    await db.update(games).set({ lichessImportStatus: 'done', lichessUrl: 'https://lichess.org/x' }).where(eq(games.id, game.id));
    await importJob(game.id, game.publicId);
    await workerWith().runOnce();
    expect(lichess.requests).toHaveLength(0);
    expect((await jobRows())[0]?.doneAt).not.toBeNull();
    expect(await db.select().from(jobs).where(sql`${jobs.kind} = 'edit_card'`)).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run the integration tests to verify they fail**

Run: `pnpm vitest run --project server apps/server/test/integration/share-photo.test.ts apps/server/test/integration/lichess.test.ts`
Expected: FAIL — `Cannot find module '../../src/jobs/handlers/sharePhoto'` and `'../../src/jobs/handlers/lichess'`.

- [ ] **Step 8: Write the share photo and Lichess handlers**

In `apps/server/src/jobs/handlers/telegram.ts` add `export` to `call` and to `settle` (their bodies do not change).

`apps/server/src/jobs/handlers/sharePhoto.ts`:

```ts
import { INITIAL_FEN, sideToMove, t, type Colour } from '@group-chess/shared';
import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { z } from 'zod';
import { shares, type MoveRow } from '../../db/schema';
import { listMoves, requireGameById } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { displayName, requireUser } from '../../domain/users';
import { renderBoardPng, renderBoardSvg, type BoardRenderInput } from '../../images/board';
import { boardImageKey, getCachedFileId, storeFileId } from '../../images/cache';
import { renderShareCaption } from '../../telegram/cards';
import { miniAppLink } from '../../telegram/links';
import type { JobHandler, JobHandlers } from '../types';
import { call, settle, type TelegramHandlerContext } from './telegram';

const payloadSchema = z.object({ shareId: z.number().int() });

/** The position after `ply` (0 = the initial position) and the move that produced it. */
export function positionAtPly(
  moves: Pick<MoveRow, 'ply' | 'uci' | 'fenAfter'>[],
  ply: number,
): { fen: string; lastMove: string | null } {
  if (ply === 0) return { fen: INITIAL_FEN, lastMove: null };
  const move = moves.find((row) => row.ply === ply);
  if (!move) throw new Error(`no move at ply ${ply}`);
  return { fen: move.fenAfter, lastMove: move.uci };
}

/** Spec §7.7: render or reuse, then `sendPhoto` to the game's topic with the share caption. */
const sendSharePhoto =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const { shareId } = payloadSchema.parse(job.payload);
    const [share] = await ctx.deps.db.select().from(shares).where(eq(shares.id, shareId));
    if (!share || share.messageId !== null) return { outcome: 'done' };
    const game = await requireGameById(ctx.deps.db, share.gameId);
    const group = await requireGroup(ctx.deps.db, game.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const [sharer, white, black, moves] = await Promise.all([
      requireUser(ctx.deps.db, share.userId),
      requireUser(ctx.deps.db, game.whiteId),
      requireUser(ctx.deps.db, game.blackId),
      listMoves(ctx.deps.db, game.id),
    ]);
    const position = positionAtPly(moves, share.ply);
    const orientation: Colour = share.userId === game.blackId ? 'black' : 'white';
    const input: BoardRenderInput = { ...position, check: new Chess(position.fen).inCheck(), orientation };
    const key = boardImageKey(input);
    const cached = await getCachedFileId(ctx.deps.db, key);
    const caption = renderShareCaption({
      sharer: displayName(sharer),
      moveNumber: Math.max(1, Math.ceil(share.ply / 2)),
      white: displayName(white),
      black: displayName(black),
      sideToMove: sideToMove(position.fen),
    });
    const photo = cached ?? new InputFile(renderBoardPng(renderBoardSvg(input)), 'board.png');
    const result = await call(ctx, group.telegramChatId, () =>
      ctx.api.sendPhoto(group.telegramChatId, photo, {
        caption,
        message_thread_id: game.cardThreadId ?? undefined,
        reply_markup: {
          inline_keyboard: [
            [{ text: t('button.open_game'), url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }) }],
          ],
        },
      }),
    );
    if (!result.ok) return settle(result);
    const largest = result.value.photo.at(-1);
    if (!cached && largest) await storeFileId(ctx.deps.db, key, largest.file_id);
    await ctx.deps.db.update(shares).set({ messageId: result.value.message_id }).where(eq(shares.id, share.id));
    return { outcome: 'done' };
  };

export function sharePhotoJobHandlers(ctx: TelegramHandlerContext): JobHandlers {
  return { send_share_photo: sendSharePhoto(ctx) };
}
```

`apps/server/src/jobs/handlers/lichess.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config';
import { games } from '../../db/schema';
import type { Deps } from '../../domain/deps';
import { requireGameById } from '../../domain/games';
import { buildGamePgn } from '../../domain/pgn';
import type { Metrics } from '../../metrics';
import { enqueue } from '../queue';
import type { JobHandler, JobHandlers, JobResult } from '../types';

export type LichessHandlerContext = {
  deps: Deps;
  config: Pick<Config, 'LICHESS_API_URL' | 'LICHESS_TOKEN'>;
  metrics?: Metrics;
  fetch?: typeof fetch;
  /** Gap between requests; 2 s in production. */
  spacingMs?: number;
  /** Pause after a 429; 60 s in production. */
  pauseMs?: number;
};

const DEFAULT_SPACING_MS = 2_000;
const DEFAULT_PAUSE_MS = 60_000;

/** "Only make one request at a time", spaced out, with a pause after a 429 (spec §7.6). Per process. */
export class LichessPacer {
  private inFlight = false;
  private notBefore = 0;

  constructor(private readonly spacingMs: number) {}

  /** Milliseconds until the next request may start; 0 means now. */
  wait(now = Date.now()): number {
    if (this.inFlight) return Math.max(this.spacingMs, 1_000);
    return Math.max(0, this.notBefore - now);
  }

  begin(): void {
    this.inFlight = true;
  }

  end(now = Date.now()): void {
    this.inFlight = false;
    this.notBefore = Math.max(this.notBefore, now + this.spacingMs);
  }

  pause(ms: number, now = Date.now()): void {
    this.notBefore = Math.max(this.notBefore, now + ms);
  }
}

const payloadSchema = z.object({ gameId: z.number().int() });
const importResponse = z.object({ url: z.url() });

/** Counts an attempt; on the last one the game is marked failed so the card keeps the fallback link. */
async function failed(
  ctx: LichessHandlerContext,
  job: { attempts: number; maxAttempts: number },
  gameId: number,
  error: string,
): Promise<JobResult> {
  if (job.attempts + 1 >= job.maxAttempts) {
    await ctx.deps.db.update(games).set({ lichessImportStatus: 'failed' }).where(eq(games.id, gameId));
    ctx.metrics?.lichessImports.inc({ outcome: 'failed' });
    return { outcome: 'fail', error };
  }
  throw new Error(error);
}

const lichessImport =
  (ctx: LichessHandlerContext, pacer: LichessPacer): JobHandler =>
  async ({ job, log }) => {
    const { gameId } = payloadSchema.parse(job.payload);
    const game = await requireGameById(ctx.deps.db, gameId);
    if (game.lichessImportStatus !== 'pending' || game.lichessUrl !== null) return { outcome: 'done' };
    const wait = pacer.wait();
    if (wait > 0) return { outcome: 'retry', delayMs: wait, error: 'lichess pacing' };
    const pgn = await buildGamePgn(ctx.deps.db, game);
    const pauseMs = ctx.pauseMs ?? DEFAULT_PAUSE_MS;
    const doFetch = ctx.fetch ?? fetch;
    pacer.begin();
    let response: Response;
    try {
      response = await doFetch(`${ctx.config.LICHESS_API_URL}/api/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          ...(ctx.config.LICHESS_TOKEN ? { authorization: `Bearer ${ctx.config.LICHESS_TOKEN}` } : {}),
        },
        body: new URLSearchParams({ pgn }).toString(),
      });
    } catch (error) {
      pacer.end();
      const message = error instanceof Error ? error.message : String(error);
      return failed(ctx, job, game.id, `lichess unreachable: ${message}`);
    }
    pacer.end();
    if (response.status === 429) {
      pacer.pause(pauseMs);
      ctx.metrics?.lichessImports.inc({ outcome: 'rate_limited' });
      return { outcome: 'retry', delayMs: pauseMs, error: 'lichess 429' };
    }
    if (!response.ok) return failed(ctx, job, game.id, `lichess HTTP ${response.status}`);
    const parsed = importResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return failed(ctx, job, game.id, 'lichess response without a url');
    await ctx.deps.db.transaction(async (tx) => {
      await tx
        .update(games)
        .set({ lichessUrl: parsed.data.url, lichessImportStatus: 'done' })
        .where(eq(games.id, game.id));
      await enqueue(tx, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
    });
    ctx.metrics?.lichessImports.inc({ outcome: 'done' });
    log.info({ gameId: game.id }, 'lichess import done');
    return { outcome: 'done' };
  };

export function lichessJobHandlers(ctx: LichessHandlerContext): JobHandlers {
  const pacer = new LichessPacer(ctx.spacingMs ?? DEFAULT_SPACING_MS);
  return { lichess_import: lichessImport(ctx, pacer) };
}
```

Replace `apps/server/src/jobs/handlers/index.ts` with:

```ts
import type { Deps } from '../../domain/deps';
import type { JobHandlers } from '../types';
import { ensurePruneScheduled, pruneHandler } from './prune';
import { rebuildRatingsHandler } from './rebuildRatings';

export { ensurePruneScheduled };
export { lichessJobHandlers, LichessPacer, type LichessHandlerContext } from './lichess';
export { sharePhotoJobHandlers } from './sharePhoto';
export { telegramJobHandlers, type TelegramHandlerContext } from './telegram';

/** Handlers that need no Telegram or Lichess client; `main.ts` merges the others in. */
export function coreJobHandlers(deps: Deps): JobHandlers {
  return {
    rebuild_ratings: rebuildRatingsHandler(deps),
    prune: pruneHandler(deps),
  };
}
```

- [ ] **Step 9: Run the integration tests to verify they pass**

Run: `pnpm vitest run --project server apps/server/test/integration/share-photo.test.ts apps/server/test/integration/lichess.test.ts`
Expected: PASS — 13 tests (share photo 6, lichess 7).

- [ ] **Step 10: Write the failing smoke test for `startServer`**

`apps/server/test/integration/main.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/main';
import { testConfig } from '../helpers/config';
import { openTestDb, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';

const { db, close } = openTestDb();
let fake: FakeTelegram;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  await truncateAll(db);
  fake = await FakeTelegram.start();
  const dir = await mkdtemp(join(tmpdir(), 'miniapp-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Group Chess</title>');
  await writeFile(join(dir, 'assets', 'app-1a2b3c.js'), 'console.log(1)');
  server = await startServer(testConfig({ TELEGRAM_API_ROOT: fake.url, PORT: 0, MINI_APP_DIR: dir }));
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.stop();
  await fake.stop();
  await close();
});

describe('startServer', () => {
  it('answers the health probes', async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');
    expect(await (await fetch(`${base}/readyz`)).text()).toBe('ok');
  });

  it('registers the webhook with the secret and the allowed updates', () => {
    const [call] = fake.callsTo('setWebhook');
    expect(call?.body).toMatchObject({ url: 'https://chess.test/telegram/webhook', secret_token: 'w'.repeat(32) });
    expect(call?.body.allowed_updates).toEqual(['message', 'callback_query', 'my_chat_member', 'chat_member']);
  });

  it('exposes Prometheus metrics including the Telegram call counters', async () => {
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('process_cpu_seconds_total');
    expect(text).toMatch(/telegram_api_calls_total\{method="setWebhook",status="ok"\} 1/);
  });

  it('serves the Mini App with immutable assets and an uncached index', async () => {
    const index = await fetch(`${base}/app/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(await index.text()).toContain('Group Chess');
    const asset = await fetch(`${base}/app/assets/app-1a2b3c.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    const route = await fetch(`${base}/app/g/AbCdEfGhIj`);
    expect(route.headers.get('cache-control')).toBe('no-store');
    expect(await route.text()).toContain('Group Chess');
  });

  it('mounts the webhook behind the secret header and the API behind a session', async () => {
    const webhook = await fetch(`${base}/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"update_id":1}',
    });
    expect(webhook.status).toBe(401);
    const me = await fetch(`${base}/api/me`);
    expect(me.status).toBe(401);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(await me.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });
});
```

- [ ] **Step 11: Run the smoke test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/main.test.ts`
Expected: FAIL — `Cannot find module '../../src/main'`.

- [ ] **Step 12: Wire the metrics, write `main.ts` and `index.ts`**

In `apps/server/src/jobs/worker.ts` add to `WorkerOptions`:

```ts
  /** Called when a job is failed permanently (explicit `fail` or exhausted attempts). */
  onFailed?: (job: JobRow, error: string) => void;
```

and call it in `process()`: in the `case 'fail'` branch after the update, `this.options.onFailed?.(job, outcome.error);`, and in the `case 'error'` branch inside the `if (attempts >= job.maxAttempts)` block after the update, `this.options.onFailed?.(job, outcome.error);`.

Append to `apps/server/src/telegram/client.ts` (and add `import type { Metrics } from '../metrics';` at the top):

```ts
/** Counts every Bot API call by method and status, and every 429 (spec §14). */
export function instrumentTelegramApi(api: Api, metrics: Metrics): void {
  api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    metrics.telegramCalls.inc({ method, status: response.ok ? 'ok' : String(response.error_code) });
    if (!response.ok && response.error_code === 429) metrics.telegram429.inc();
    return response;
  });
}
```

`apps/server/src/main.ts`:

```ts
import { serve, type ServerType } from '@hono/node-server';
import type { Bot } from 'grammy';
import type { Hono } from 'hono';
import { createApiApp } from './api/app';
import type { ApiContext, ApiEnv } from './api/context';
import { gameRoutes } from './api/routes/index';
import { staticAppRoutes } from './api/staticApp';
import { StreamGate } from './api/streams';
import { createBot } from './bot/bot';
import { webhookRoutes } from './bot/webhook';
import { LocalBus } from './bus/bus';
import { startScanners } from './clock/scanners';
import type { Config, Role } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import type { Deps } from './domain/deps';
import {
  coreJobHandlers,
  ensurePruneScheduled,
  lichessJobHandlers,
  sharePhotoJobHandlers,
  telegramJobHandlers,
} from './jobs/handlers';
import { JobWorker } from './jobs/worker';
import { createLogger } from './logger';
import { Metrics } from './metrics';
import { createTelegramApi, instrumentTelegramApi } from './telegram/client';
import { Membership } from './telegram/membership';

/** Spec §5.1 step 4; `chat_member` only arrives where the bot is an administrator. */
export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member', 'chat_member'] as const;

export type RunningServer = { port: number; app: Hono<ApiEnv>; stop(): Promise<void> };

function listen(app: Hono<ApiEnv>, port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => resolve(server));
  });
}

/**
 * Boots the roles in `config.ROLES` (spec §4.2, §4.4): migrations first, then the HTTP app (health,
 * metrics, API when `api`, webhook when `bot`, the Mini App when `MINI_APP_DIR`), the job worker
 * when `jobs`, the scanners when `clock`, and finally the webhook registration or long polling.
 */
export async function startServer(config: Config): Promise<RunningServer> {
  const log = createLogger(config.LOG_LEVEL);
  const has = (role: Role): boolean => config.ROLES.includes(role);
  await runMigrations(config.DATABASE_URL);
  const { db, close } = createDb(config.DATABASE_URL);
  const deps: Deps = { db, bus: new LocalBus(), log };
  const metrics = new Metrics();

  const bot: Bot | null = has('bot') ? await createBot(deps, config) : null;
  const api = bot ? bot.api : createTelegramApi(config, { apiRoot: config.TELEGRAM_API_ROOT });
  instrumentTelegramApi(api, metrics);
  const membership = new Membership(deps, api);
  const apiCtx: ApiContext = { deps, config, membership, metrics, streams: new StreamGate() };

  const app = createApiApp(apiCtx, has('api') ? gameRoutes : []);
  if (bot && !config.TELEGRAM_POLLING) app.route('/', webhookRoutes(bot, deps, config));
  if (config.MINI_APP_DIR) app.route('/app', staticAppRoutes(config.MINI_APP_DIR));
  const server = await listen(app, config.PORT);
  const port = (server.address() as { port: number }).port;

  let worker: JobWorker | null = null;
  if (has('jobs')) {
    await ensurePruneScheduled(db);
    worker = new JobWorker({
      db,
      log,
      handlers: {
        ...coreJobHandlers(deps),
        ...telegramJobHandlers({ deps, api, config }),
        ...sharePhotoJobHandlers({ deps, api, config }),
        ...lichessJobHandlers({ deps, config, metrics }),
      },
      workerId: `${process.pid}`,
      onFailed: (job) => metrics.jobsFailed.inc({ kind: job.kind }),
    });
    worker.start();
  }
  const scanners = has('clock') ? startScanners(deps) : null;

  let polling: Promise<void> | null = null;
  if (bot) {
    if (config.TELEGRAM_POLLING) {
      await api.deleteWebhook();
      polling = bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
      polling.catch((error: unknown) => log.error({ err: error }, 'long polling stopped'));
    } else {
      await api.setWebhook(`${config.PUBLIC_URL.replace(/\/$/, '')}/telegram/webhook`, {
        secret_token: config.WEBHOOK_SECRET,
        allowed_updates: [...ALLOWED_UPDATES],
      });
    }
  }
  log.info({ port, roles: config.ROLES, polling: polling !== null }, 'server started');

  return {
    port,
    app,
    async stop() {
      if (bot && polling) {
        await bot.stop();
        await polling.catch(() => undefined);
      }
      await scanners?.stop();
      await worker?.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await close();
      log.info('server stopped');
    },
  };
}
```

`apps/server/src/index.ts`:

```ts
import { loadConfig } from './config';
import { startServer } from './main';

const server = await startServer(loadConfig());

const shutdown = (): void => {
  server.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
```

Append to `.env.example`:

```
# Optional (plan 03):
# TELEGRAM_POLLING=true                 # dev only: long polling instead of the webhook
# TELEGRAM_API_ROOT=http://127.0.0.1:8081   # a local Bot API server or a test fake
# LICHESS_API_URL=https://lichess.org
# MINI_APP_DIR=apps/miniapp/dist        # serve the built Mini App under /app/
```

- [ ] **Step 13: Run the smoke test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/main.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 14: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(server): add board images, the share photo and Lichess jobs, metrics wiring and main"
```

---

## Self-review

**Spec coverage (plan 03 scope).** §4.3–§4.4 roles, config, static serving, migrations at boot → Task 2 (config), Task 6 (`main.ts`, `staticApp.ts`). §5.1 webhook registration and `allowed_updates` → Task 6. §5.2 webhook idempotency and secret → Task 2. §5.3 links and callback data → Task 1. §5.4 cards → Task 1 (renderer), Task 3 (send/edit jobs). §5.5 commands → Task 2. §5.6 membership ladder → Task 3. §5.7 DMs → Task 3. §5.8 pacing and 429 → Tasks 1, 3, 6. §6.4 SSE → Task 5. §7.6 Lichess import and fallback link → Tasks 1, 6. §7.7 images and cache → Task 6. §7.8 limits (share, command, API, SSE) → Tasks 2, 4, 5. §9 API surface and errors → Tasks 4, 5. §11 Telegram error table → Tasks 1, 3. §12 authorization matrix, delete-my-data, no message text in logs → Tasks 4, 5, 2. §14 metrics and health → Tasks 4, 6. Not in this plan by design: the Mini App itself (plan 04) and Docker, CI end-to-end and release (plan 05).

**Placeholder scan.** Every file named in a task carries its full content or an exact edit instruction; no step says "similar to" or "add appropriate handling". The generated `pieces.ts` is produced by a script whose output shape is spelled out.

**Type consistency across tasks.** `TelegramHandlerContext = { deps; api; config }` is defined in Task 3 and consumed unchanged by Task 6's `sharePhotoJobHandlers`; `call`/`settle` gain `export` in Task 6 with no signature change. `ApiContext` (Task 4) is what `main.ts` builds. `RegisterRoutes[]`/`gameRoutes` (Tasks 4–5) are what `createApiApp` takes in Task 6. `JobHandlers` from plan 2 is the return type of every handler factory. `FakeTelegram` (Task 2) already answers `sendPhoto` with a `photo` array and flags multipart uploads, which Task 6's tests rely on. `testConfig` (Task 2) carries the four new variables that Task 6 reads.

**Review Focus mapping.** 1 → Task 2 "acknowledges a duplicate update without repeating its effects"; 2 → Task 3 "retries an edit for a card that has no message id yet"; 3 → Task 4 "rejects tampered init data", "rejects init data older than 24 hours"; 4 → Task 5 "refuses the stream to a non-member", "caps open streams at four per user"; 5 → Task 6 "reuses the cached file id for the same position".

**Known limits carried forward.** Lichess pacing is per process, so two `jobs` replicas may overlap requests (spec §7.6 tolerates this; the 429 handling covers it). The `api` role gates only the game routes; health, launch and account routes are on every process because the webhook process needs the HTTP server anyway. Coordinate labels are omitted (ruling above).
