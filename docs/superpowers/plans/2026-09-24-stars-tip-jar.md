# Telegram Stars Tip Jar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voluntary one-off tip in Telegram Stars from the Mini App's Settings screen: invoice endpoint, bot payment handling, a `tips` table, `/paysupport`, and the Support card.

**Architecture:** The Mini App posts the amount to `POST /api/tips`; the server mints a Stars invoice link with `createInvoiceLink` (currency `XTR`) and the app opens it with `WebApp.openInvoice`. The bot approves `pre_checkout_query` inline in the webhook handler, records `successful_payment` in `tips` (unique on Telegram's charge id) and queues a thank-you DM through the existing `send_message` job; `refunded_payment` marks the row refunded. Refunds themselves are manual (a documented `curl`).

**Tech Stack:** TypeScript, pnpm workspaces; server: Hono, grammY 1.46, drizzle-orm on PostgreSQL, vitest; shared: zod 4; Mini App: Preact + signals, happy-dom vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-stars-tip-jar-design.md`

## Global Constraints

- Currency is `XTR`; `provider_token` is the empty string `""`.
- An amount is a whole number of Stars from 1 to 10,000 (`TIP_MIN_STARS = 1`, `TIP_MAX_STARS = 10_000`). Presets are exactly ★100, ★250, ★500.
- The invoice payload is exactly `tip:v1:<n>`, `n` without leading zeros.
- Invoice title "Tip Chess Goat"; description "A one-off tip to @Jarvl for hosting and development. Nothing is unlocked."; price label "Tip".
- `POST /api/tips` allows 10 invoices per user per minute.
- No Prometheus metric for tips. No new API error code: a Bot API failure is the existing `internal` (500).
- `deleteMyData` never touches `tips`.
- The Support card needs Bot API 6.1 (`invoice` feature); below it, or in a plain browser, the card is not rendered.
- The prototype's "≈ $x" estimate is not shown.
- CSS tokens are this repo's names: `--acc`, `--acc-ink`, `--acc-soft`, `--acc-text`, `--move`, `--page`, `--card`, `--text`, `--hint`, `--destructive` (the spec's `--destr` is `--destructive` here).
- Row ids follow the repo convention `id()` (bigint identity), not `serial`; `tips.user_id` is therefore bigint.
- Integration tests on this machine need `export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test` (the documented passwordless URL fails here). Without it only unit projects run.
- Bundle budget unchanged: initial JS ≤ 120 KB gzipped, CSS ≤ 25 KB gzipped.
- Comments cite "tip jar spec §N" the way existing code cites "spec §N".

## Review Focus

1. **A double tap on a preset before the first re-render** must open one invoice, not two — pinned in Task 7 ("ignores a second tap while a tip is in flight").
2. **Pasting "1,000" or " 250 " into the custom field** should keep the digits and be valid — pinned in Task 7 ("keeps only digits from pasted text").
3. **A payer the bot has never seen** (first contact is the payment itself) must still get a row and a DM — pinned in Task 4 (Alice is not pre-inserted in the payment tests).
4. **A refund after the payer deleted their data** must still mark the tip refunded — pinned in Task 4 ("marks a tip refunded even after the payer deleted their data").
5. **Look-alike payloads** (`tip:v1:0100`, `tip:v1:10001`, `tip:v2:100`, `tip:v1:100 `) must be refused at pre-checkout — pinned in Task 2's `parseTipPayload` table.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/protocol/requests.ts` | `TIP_MIN_STARS`, `TIP_MAX_STARS`, `TipRequestSchema` |
| `packages/shared/src/protocol/dto.ts` | `TipInvoiceDtoSchema` |
| `packages/shared/src/i18n/en.ts` | Every new string, and the Delete confirmation clause |
| `apps/server/src/db/schema.ts`, `apps/server/drizzle/0003_tips.sql` | The `tips` table |
| `apps/server/src/telegram/tips.ts` | Payload format, pre-checkout decision, `createTipInvoiceLink` |
| `apps/server/src/api/routes/tips.ts` | `POST /api/tips` |
| `apps/server/src/api/context.ts`, `apps/server/src/main.ts` | `ApiContext.api`, `ApiContext.tipLimiter`, `ALLOWED_UPDATES`, `BOT_COMMANDS` |
| `apps/server/src/bot/userInfo.ts` | grammY `User` → `TelegramUserInfo` (moved out of `bot.ts` so `payments.ts` can share it) |
| `apps/server/src/bot/payments.ts` | `pre_checkout_query`, `successful_payment`, `refunded_payment`, `/paysupport` |
| `apps/miniapp/src/tg/types.ts`, `apps/miniapp/src/tg/webapp.ts` | `openInvoice` and the `invoice` feature |
| `apps/miniapp/src/ui/SupportCard.tsx` | The Support card |
| `apps/miniapp/src/ui/screens/Settings.tsx`, `apps/miniapp/src/styles.css` | Placing and styling the card |
| `docs/operations.md` | BotFather checklist and refund runbook |

---

### Task 1: Shared protocol and copy

**Files:**
- Modify: `packages/shared/src/protocol/requests.ts` (append after `FinishedQuerySchema`)
- Modify: `packages/shared/src/protocol/dto.ts` (append after `OkDtoSchema`, line ~325)
- Modify: `packages/shared/src/i18n/en.ts`
- Test: `packages/shared/test/protocol/requests.test.ts`, `packages/shared/test/protocol/dto.test.ts`

**Interfaces:**
- Produces: `TIP_MIN_STARS: 1`, `TIP_MAX_STARS: 10_000`, `TipRequestSchema` (`{ stars: number }`), `type TipRequest`, `TipInvoiceDtoSchema` (`{ url: string }`), `type TipInvoiceDto`; message keys `invoice.tip.title`, `invoice.tip.description`, `invoice.tip.label`, `payment.tip_invalid`, `dm.tip_thanks` (`{stars}`), `dm.paysupport`, `command.paysupport.description`, `app.settings.support.title`, `app.settings.support.body_lead`, `app.settings.support.body`, `app.settings.support.choose`, `app.settings.support.placeholder`, `app.settings.support.amount_label`, `app.settings.support.tip`, `app.settings.support.hint`, `app.settings.support.hint_ok`, `app.settings.support.hint_bad`, `app.settings.support.thanks`, `app.settings.support.failed`. All exported from `@group-chess/shared`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/protocol/requests.test.ts` (add `TipRequestSchema`, `TIP_MAX_STARS`, `TIP_MIN_STARS` to its import from `'../../src/protocol/requests'`):

```ts
describe('TipRequestSchema', () => {
  it.each([TIP_MIN_STARS, 250, TIP_MAX_STARS])('accepts %s stars', (stars) => {
    expect(TipRequestSchema.parse({ stars })).toEqual({ stars });
  });

  it.each([
    ['zero', 0],
    ['a negative amount', -5],
    ['too many', 10_001],
    ['a fraction', 2.5],
    ['a numeric string', '100'],
    ['nothing', undefined],
  ])('rejects %s', (_label, stars) => {
    expect(TipRequestSchema.safeParse({ stars }).success).toBe(false);
  });
});
```

Append to `packages/shared/test/protocol/dto.test.ts` (add `TipInvoiceDtoSchema` to its import from `'../../src/protocol/dto'`):

```ts
describe('TipInvoiceDtoSchema', () => {
  it('carries the invoice link', () => {
    expect(TipInvoiceDtoSchema.parse({ url: 'https://t.me/$abc' })).toEqual({
      url: 'https://t.me/$abc',
    });
  });

  it('rejects an empty link', () => {
    expect(TipInvoiceDtoSchema.safeParse({ url: '' }).success).toBe(false);
  });
});
```

Append inside the existing `describe('t', …)` block in `packages/shared/test/i18n.test.ts`:

```ts
  it('renders the tip thank-you with its amount', () => {
    expect(t('dm.tip_thanks', { stars: 250 })).toBe(
      'Thank you for the ★250 tip! It helps keep Chess Goat running.',
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/shared`
Expected: FAIL — `TipRequestSchema` / `TipInvoiceDtoSchema` are not exported; `dm.tip_thanks` is not a key (type error at typecheck, and the string assertion fails at run time).

- [ ] **Step 3: Implement**

Append to `packages/shared/src/protocol/requests.ts`:

```ts
/** Tip jar spec §2.1: whole Stars, one invoice per tap. */
export const TIP_MIN_STARS = 1;
export const TIP_MAX_STARS = 10_000;

export const TipRequestSchema = z.object({
  stars: z.number().int().min(TIP_MIN_STARS).max(TIP_MAX_STARS),
});

export type TipRequest = z.infer<typeof TipRequestSchema>;
```

Append to `packages/shared/src/protocol/dto.ts`, after `OkDto`:

```ts
/** Tip jar spec §2.1: the invoice link the Mini App hands to `WebApp.openInvoice`. */
export const TipInvoiceDtoSchema = z.object({ url: z.string().min(1) });

export type TipInvoiceDto = z.infer<typeof TipInvoiceDtoSchema>;
```

In `packages/shared/src/i18n/en.ts`:

After `'command.start.description': 'Allow move notifications',` add:

```ts
  'command.paysupport.description': 'Help with a tip or a refund',
  'dm.paysupport':
    'Tips unlock nothing in Chess Goat; they only support its hosting and development. For a refund within 30 days of a tip, message @Jarvl.',
  'dm.tip_thanks': 'Thank you for the ★{stars} tip! It helps keep Chess Goat running.',
  'payment.tip_invalid': 'This tip link is no longer valid.',
  'invoice.tip.title': 'Tip Chess Goat',
  'invoice.tip.description':
    'A one-off tip to @Jarvl for hosting and development. Nothing is unlocked.',
  'invoice.tip.label': 'Tip',
```

Replace the `'app.settings.delete_confirm'` value with:

```ts
  'app.settings.delete_confirm':
    'Delete your data? Running games are resigned and your name is removed from past games. Records of any tips you sent are kept as payment records. This cannot be undone.',
```

After `'app.settings.about_title': 'About Chess Goat',` add:

```ts
  'app.settings.support.title': 'Support Chess Goat',
  'app.settings.support.body_lead': 'Chess Goat is maintained by',
  'app.settings.support.body':
    'and will always be free without ads. A tip in Telegram Stars shows your appreciation and helps cover the cost of the server.',
  'app.settings.support.choose': 'Choose amount',
  'app.settings.support.placeholder': 'Any amount',
  'app.settings.support.amount_label': 'Tip amount in Stars',
  'app.settings.support.tip': 'Tip',
  'app.settings.support.hint': 'Any whole number from 1 to 10,000',
  'app.settings.support.hint_ok': 'Telegram shows the exact total before you pay',
  'app.settings.support.hint_bad': 'Enter between 1 and 10,000 Stars',
  'app.settings.support.thanks': 'Thank you for supporting Chess Goat',
  'app.settings.support.failed': "The payment didn't go through",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/shared && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): tip request and invoice schemas, and the tip jar copy"
```

---

### Task 2: The `tips` table and the tip payload

**Files:**
- Modify: `apps/server/src/db/schema.ts` (after `adminActions`, and add `TipRow` with the other row types)
- Create: `apps/server/drizzle/0003_tips.sql` + `apps/server/drizzle/meta/0003_snapshot.json` + journal entry (generated)
- Modify: `apps/server/test/helpers/db.ts` (`truncateAll`)
- Create: `apps/server/src/telegram/tips.ts`
- Test: `apps/server/test/unit/tips.test.ts`, `apps/server/test/integration/db.test.ts`

**Interfaces:**
- Consumes: `TIP_MIN_STARS`, `TIP_MAX_STARS`, `t`, keys `invoice.tip.*` (Task 1).
- Produces:
  - `tips` drizzle table: `id`, `userId: number | null`, `telegramUserId: number`, `stars: number`, `telegramPaymentChargeId: string`, `paidAt: Date`, `refundedAt: Date | null`; `type TipRow`.
  - `tipPayload(stars: number): string`
  - `parseTipPayload(payload: string): number | null`
  - `tipCheckoutAccepted(query: { invoice_payload: string; total_amount: number; currency: string }): boolean`
  - `createTipInvoiceLink(api: Api, stars: number): Promise<string>`

- [ ] **Step 1: Write the failing unit test**

Create `apps/server/test/unit/tips.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseTipPayload, tipCheckoutAccepted, tipPayload } from '../../src/telegram/tips';

describe('tip payload', () => {
  it('round-trips an amount', () => {
    expect(tipPayload(250)).toBe('tip:v1:250');
    expect(parseTipPayload(tipPayload(250))).toBe(250);
  });

  it.each(['tip:v1:1', 'tip:v1:10000'])('accepts %s', (payload) => {
    expect(parseTipPayload(payload)).not.toBeNull();
  });

  it.each([
    ['zero', 'tip:v1:0'],
    ['a leading zero', 'tip:v1:0100'],
    ['over the maximum', 'tip:v1:10001'],
    ['another version', 'tip:v2:100'],
    ['another prefix', 'donation:v1:100'],
    ['trailing text', 'tip:v1:100 '],
    ['a fraction', 'tip:v1:2.5'],
    ['nothing', ''],
  ])('rejects %s', (_label, payload) => {
    expect(parseTipPayload(payload)).toBeNull();
  });
});

describe('tipCheckoutAccepted', () => {
  const query = { invoice_payload: 'tip:v1:250', total_amount: 250, currency: 'XTR' };

  it('approves a matching Stars tip', () => {
    expect(tipCheckoutAccepted(query)).toBe(true);
  });

  it.each([
    ['an amount that differs from the payload', { ...query, total_amount: 100 }],
    ['another currency', { ...query, currency: 'USD' }],
    ['a forged payload', { ...query, invoice_payload: 'tip:v1:0250' }],
  ])('refuses %s', (_label, bad) => {
    expect(tipCheckoutAccepted(bad)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/unit/tips.test.ts`
Expected: FAIL — cannot resolve `../../src/telegram/tips`.

- [ ] **Step 3: Implement `telegram/tips.ts`**

Create `apps/server/src/telegram/tips.ts`:

```ts
import { t, TIP_MAX_STARS, TIP_MIN_STARS } from '@group-chess/shared';
import type { Api } from 'grammy';

/** Tip jar spec §2.1: the invoice payload names the amount, so pre-checkout can check it. */
const PAYLOAD = /^tip:v1:([1-9]\d{0,4})$/;

export function tipPayload(stars: number): string {
  return `tip:v1:${stars}`;
}

export function parseTipPayload(payload: string): number | null {
  const match = PAYLOAD.exec(payload);
  if (!match) return null;
  const stars = Number(match[1]);
  return stars >= TIP_MIN_STARS && stars <= TIP_MAX_STARS ? stars : null;
}

/** Tip jar spec §2.2: approve only a well-formed payload whose amount and currency match. */
export function tipCheckoutAccepted(query: {
  invoice_payload: string;
  total_amount: number;
  currency: string;
}): boolean {
  const stars = parseTipPayload(query.invoice_payload);
  return stars !== null && stars === query.total_amount && query.currency === 'XTR';
}

/** A fresh link per tap (tip jar spec §2.1); an empty provider token means Telegram Stars. */
export function createTipInvoiceLink(api: Api, stars: number): Promise<string> {
  return api.createInvoiceLink(
    t('invoice.tip.title'),
    t('invoice.tip.description'),
    tipPayload(stars),
    '',
    'XTR',
    [{ label: t('invoice.tip.label'), amount: stars }],
  );
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm vitest run apps/server/test/unit/tips.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the table**

In `apps/server/src/db/schema.ts`, after the `adminActions` table:

```ts
/**
 * Tip jar spec §1: one row per successful Stars payment. Kept when the payer deletes their data —
 * the charge id and Telegram user id are what `refundStarPayment` needs.
 */
export const tips = pgTable('tips', {
  id: id(),
  userId: bigint({ mode: 'number' }).references(() => users.id),
  telegramUserId: bigint({ mode: 'number' }).notNull(),
  stars: integer().notNull(),
  telegramPaymentChargeId: text().notNull().unique(),
  paidAt: tz().notNull().defaultNow(),
  refundedAt: tz(),
});
```

and with the other row types at the bottom:

```ts
export type TipRow = typeof tips.$inferSelect;
```

- [ ] **Step 6: Generate the migration**

Run: `pnpm --filter @group-chess/server exec drizzle-kit generate --name tips`
Expected: creates `apps/server/drizzle/0003_tips.sql`, `apps/server/drizzle/meta/0003_snapshot.json`, and a new `_journal.json` entry. The SQL must be (whitespace aside):

```sql
CREATE TABLE "tips" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tips_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"telegram_user_id" bigint NOT NULL,
	"stars" integer NOT NULL,
	"telegram_payment_charge_id" text NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "tips_telegram_payment_charge_id_unique" UNIQUE("telegram_payment_charge_id")
);
--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
```

If drizzle-kit wants to change anything else (another table), stop: the snapshot is out of step and must be investigated, not committed.

- [ ] **Step 7: Truncate the new table in tests**

In `apps/server/test/helpers/db.ts`, add `tips` to the front of the truncate list (it references `users`):

```ts
    sql`truncate table tips, admin_actions, shares, board_images, moves, games, challenges, ratings, group_members, jobs, telegram_updates, groups, users restart identity cascade`,
```

- [ ] **Step 8: Write the migration test**

Append to `apps/server/test/integration/db.test.ts` (it already truncates in `beforeEach` and imports `insertUser`; add `tips` to its `'../../src/db/schema'` import):

```ts
describe('tips table', () => {
  it('stores a tip once per Telegram charge id', async () => {
    const user = await insertUser(db, { telegramUserId: 11 });
    const row = {
      userId: user.id,
      telegramUserId: 11,
      stars: 250,
      telegramPaymentChargeId: 'charge-1',
    };
    await db.insert(tips).values(row);
    const again = await db
      .insert(tips)
      .values(row)
      .onConflictDoNothing({ target: tips.telegramPaymentChargeId })
      .returning();
    expect(again).toHaveLength(0);
    const [stored] = await db.select().from(tips);
    expect(stored).toMatchObject({ stars: 250, refundedAt: null });
    expect(stored?.paidAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 9: Run it**

Run: `export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test && pnpm vitest run apps/server/test/integration/db.test.ts apps/server/test/unit/tips.test.ts && pnpm typecheck`
Expected: PASS (the test database migrates to 0003 on first use).

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/src/telegram/tips.ts apps/server/test/unit/tips.test.ts apps/server/test/helpers/db.ts apps/server/test/integration/db.test.ts
git commit -m "feat(server): a tips table and the tip invoice payload"
```

---

### Task 3: `POST /api/tips`

**Files:**
- Modify: `apps/server/src/api/context.ts`
- Create: `apps/server/src/api/routes/tips.ts`
- Modify: `apps/server/src/api/routes/index.ts`
- Modify: `apps/server/src/main.ts:99-106` (the `apiCtx` literal)
- Modify: `apps/server/test/helpers/api.ts:48-55` (the `ctx` literal)
- Modify: `apps/server/test/helpers/fakeTelegram.ts` (`respond` switch)
- Test: `apps/server/test/integration/api-tips.test.ts`

**Interfaces:**
- Consumes: `TipRequestSchema`, `TipInvoiceDtoSchema`, `type TipInvoiceDto` (Task 1); `createTipInvoiceLink`, `tips` (Task 2).
- Produces: `ApiContext.api: Api` (throttled Bot API client), `ApiContext.tipLimiter: RateLimiter`; `tipRoutes: RegisterRoutes`; `FakeTelegram` answers `createInvoiceLink` with `'https://t.me/$TestInvoice'`.

- [ ] **Step 1: Teach the fake Bot API to mint links**

In `apps/server/test/helpers/fakeTelegram.ts`, inside `respond`'s `switch`, before `default:`:

```ts
      case 'createInvoiceLink':
        return ok('https://t.me/$TestInvoice');
```

- [ ] **Step 2: Write the failing integration test**

Create `apps/server/test/integration/api-tips.test.ts`:

```ts
import { TipInvoiceDtoSchema } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tips } from '../../src/db/schema';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.rateLimiter.reset();
  api.ctx.tipLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

const tipAs = async (stars: unknown, user?: { id: number }) => {
  const payer = user ?? (await insertUser(db));
  return api.request('POST', '/api/tips', {
    token: await api.sessionFor(payer),
    body: { stars },
  });
};

describe('POST /api/tips', () => {
  it('mints a Stars invoice link for the amount and returns its URL', async () => {
    const res = await tipAs(250);
    expect(res.status).toBe(200);
    expect(TipInvoiceDtoSchema.parse(await res.json())).toEqual({
      url: 'https://t.me/$TestInvoice',
    });
    const calls = api.fake.callsTo('createInvoiceLink');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      title: 'Tip Chess Goat',
      description: 'A one-off tip to @Jarvl for hosting and development. Nothing is unlocked.',
      payload: 'tip:v1:250',
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Tip', amount: 250 }],
    });
  });

  it.each([0, 10_001, 2.5, '100', -5])('rejects %s stars without calling Telegram', async (stars) => {
    const res = await tipAs(stars);
    expect(res.status).toBe(400);
    expect(api.fake.callsTo('createInvoiceLink')).toHaveLength(0);
  });

  it('needs a session', async () => {
    const res = await api.request('POST', '/api/tips', { body: { stars: 100 } });
    expect(res.status).toBe(401);
  });

  it('allows ten invoices a minute per user, then answers 429', async () => {
    const payer = await insertUser(db);
    for (let i = 0; i < 10; i += 1) expect((await tipAs(100, payer)).status).toBe(200);
    const eleventh = await tipAs(100, payer);
    expect(eleventh.status).toBe(429);
    expect(await eleventh.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect((await tipAs(100)).status).toBe(200);
  });

  it('answers 500 when Telegram refuses the invoice', async () => {
    api.fake.failNext('createInvoiceLink', {
      error_code: 400,
      description: 'Bad Request: STARS_INVOICE_INVALID',
    });
    const res = await tipAs(100);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'internal' } });
  });

  it('keeps tip rows when the payer deletes their data', async () => {
    const payer = await insertUser(db, { telegramUserId: 11 });
    await db.insert(tips).values({
      userId: payer.id,
      telegramUserId: 11,
      stars: 500,
      telegramPaymentChargeId: 'charge-kept',
    });
    const token = await api.sessionFor(payer);
    expect((await api.request('DELETE', '/api/me', { token })).status).toBe(200);
    const [row] = await db.select().from(tips).where(eq(tips.telegramPaymentChargeId, 'charge-kept'));
    expect(row).toMatchObject({ userId: payer.id, telegramUserId: 11, stars: 500, refundedAt: null });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/integration/api-tips.test.ts`
Expected: FAIL — typecheck/runtime error on `api.ctx.tipLimiter` (undefined), and `POST /api/tips` answers 404.

- [ ] **Step 4: Extend `ApiContext`**

In `apps/server/src/api/context.ts`, add `import type { Api } from 'grammy';` and two fields to `ApiContext`:

```ts
  /** The throttled Bot API client, for the calls a request makes itself (tip jar spec §2.1). */
  api: Api;
  /** Tip jar spec §2.1: ten invoice links per user per minute. */
  tipLimiter: RateLimiter;
```

In `apps/server/src/main.ts`, in the `apiCtx` literal (after `rateLimiter`):

```ts
    api,
    tipLimiter: new RateLimiter(10, 60_000),
```

In `apps/server/test/helpers/api.ts`, in the `ctx` literal (after `rateLimiter`):

```ts
    api: createTelegramApi(config, { apiRoot: fake.url, throttle: false }),
    tipLimiter: new RateLimiter(10, 60_000),
```

- [ ] **Step 5: Add the route**

Create `apps/server/src/api/routes/tips.ts`:

```ts
import { TipRequestSchema, type TipInvoiceDto } from '@group-chess/shared';
import type { Hono } from 'hono';
import { DomainError } from '../../domain/errors';
import { createTipInvoiceLink } from '../../telegram/tips';
import type { ApiContext, ApiEnv } from '../context';
import { validate } from '../validate';

/**
 * Tip jar spec §2.1: one Stars invoice link per tap. A Bot API failure is left to the app's error
 * handler, which logs it and answers `internal`.
 */
export function tipRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  api.post('/tips', validate('json', TipRequestSchema), async (c) => {
    const user = c.get('user');
    if (!ctx.tipLimiter.allow(`tip:${user.id}`))
      throw new DomainError('rate_limited', 'too many tip invoices');
    const { stars } = c.req.valid('json');
    const body: TipInvoiceDto = { url: await createTipInvoiceLink(ctx.api, stars) };
    return c.json(body);
  });
}
```

In `apps/server/src/api/routes/index.ts`, import `tipRoutes` from `'./tips'` and append it to `gameRoutes`:

```ts
export const gameRoutes: RegisterRoutes[] = [
  groupsRoutes,
  challengeRoutes,
  gamesRoutes,
  eventsRoutes,
  adminRoutes,
  tipRoutes,
];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run apps/server/test/integration/api-tips.test.ts apps/server/test/integration/main.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/api apps/server/src/main.ts apps/server/test/helpers/api.ts apps/server/test/helpers/fakeTelegram.ts apps/server/test/integration/api-tips.test.ts
git commit -m "feat(server): POST /api/tips mints a Stars invoice link"
```

---

### Task 4: Bot payment updates

**Files:**
- Create: `apps/server/src/bot/userInfo.ts`
- Modify: `apps/server/src/bot/bot.ts` (use the moved `userInfo`; register payments before `return bot`)
- Create: `apps/server/src/bot/payments.ts`
- Modify: `apps/server/src/main.ts:36-41` (`ALLOWED_UPDATES`)
- Modify: `apps/server/test/helpers/updates.ts`
- Test: `apps/server/test/integration/payments.test.ts`, `apps/server/test/integration/main.test.ts:69-82`

**Interfaces:**
- Consumes: `tips` table, `tipCheckoutAccepted` (Task 2); keys `payment.tip_invalid`, `dm.tip_thanks` (Task 1); `ensureUser`, `enqueue`, `deleteMyData` (existing).
- Produces: `userInfo(user: User): TelegramUserInfo` in `bot/userInfo.ts`; `registerPayments(bot: Bot, deps: Deps): void` in `bot/payments.ts`; `preCheckoutUpdate(...)` test builder; `ALLOWED_UPDATES` includes `'pre_checkout_query'`.

- [ ] **Step 1: Add the update builder**

Append to `apps/server/test/helpers/updates.ts`:

```ts
export function preCheckoutUpdate(options: {
  from: User;
  payload: string;
  totalAmount: number;
  currency?: string;
}): Update {
  updateId += 1;
  return {
    update_id: updateId,
    pre_checkout_query: {
      id: `pcq-${updateId}`,
      from: options.from,
      currency: options.currency ?? 'XTR',
      total_amount: options.totalAmount,
      invoice_payload: options.payload,
    },
  } as Update;
}
```

- [ ] **Step 2: Write the failing integration test**

Create `apps/server/test/integration/payments.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot/bot';
import { webhookRoutes } from '../../src/bot/webhook';
import { jobs, tips, users } from '../../src/db/schema';
import { deleteMyData } from '../../src/domain/account';
import { Metrics } from '../../src/metrics';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { preCheckoutUpdate, privateChat, serviceUpdate, tgUser } from '../helpers/updates';

const { db, close } = openTestDb();
const deps = testDeps(db);
const config = testConfig();
let fake: FakeTelegram;
let bot: Bot;
let app: Hono;

// Alice is never inserted up front: her first contact with the bot is the payment itself.
const alice = tgUser(11, 'Alice', 'alice');

beforeAll(async () => {
  fake = await FakeTelegram.start();
  bot = await createBot(deps, { ...config, TELEGRAM_API_ROOT: fake.url });
  app = new Hono().route('/', webhookRoutes(bot, deps, config, new Metrics()));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const post = (update: unknown) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': config.WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
const dms = async () =>
  (await db.select().from(jobs).orderBy(jobs.id))
    .filter((job) => job.kind === 'send_message')
    .map((job) => job.payload);
const paid = (chargeId: string, stars = 250) =>
  serviceUpdate(privateChat(alice), alice, {
    successful_payment: {
      currency: 'XTR',
      total_amount: stars,
      invoice_payload: `tip:v1:${stars}`,
      telegram_payment_charge_id: chargeId,
      provider_payment_charge_id: '',
    },
  });
const refunded = (chargeId: string, stars = 250) =>
  serviceUpdate(privateChat(alice), alice, {
    refunded_payment: {
      currency: 'XTR',
      total_amount: stars,
      invoice_payload: `tip:v1:${stars}`,
      telegram_payment_charge_id: chargeId,
    },
  });

describe('pre_checkout_query', () => {
  it('approves a matching Stars tip', async () => {
    expect(
      (await post(preCheckoutUpdate({ from: alice, payload: 'tip:v1:250', totalAmount: 250 })))
        .status,
    ).toBe(200);
    const [call] = fake.callsTo('answerPreCheckoutQuery');
    expect(call?.body).toMatchObject({ ok: true });
    expect(call?.body.pre_checkout_query_id).toMatch(/^pcq-/);
  });

  it.each([
    ['a mismatched amount', { payload: 'tip:v1:250', totalAmount: 100 }],
    ['a forged payload', { payload: 'tip:v1:0250', totalAmount: 250 }],
    ['another currency', { payload: 'tip:v1:250', totalAmount: 250, currency: 'USD' }],
  ])('refuses %s with a short reason', async (_label, fields) => {
    await post(preCheckoutUpdate({ from: alice, ...fields }));
    expect(fake.callsTo('answerPreCheckoutQuery')[0]?.body).toMatchObject({
      ok: false,
      error_message: 'This tip link is no longer valid.',
    });
  });

  it('answers 500 so Telegram retries when the answer cannot be sent', async () => {
    fake.failNext('answerPreCheckoutQuery', {
      error_code: 400,
      description: 'Bad Request: query is too old',
    });
    const res = await post(
      preCheckoutUpdate({ from: alice, payload: 'tip:v1:250', totalAmount: 250 }),
    );
    expect(res.status).toBe(500);
  });
});

describe('successful_payment', () => {
  it('records the tip and queues one thank-you DM for a first-time payer', async () => {
    expect((await post(paid('charge-1'))).status).toBe(200);
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, 11));
    expect(await db.select().from(tips)).toEqual([
      expect.objectContaining({
        userId: user!.id,
        telegramUserId: 11,
        stars: 250,
        telegramPaymentChargeId: 'charge-1',
        refundedAt: null,
      }),
    ]);
    expect(await dms()).toEqual([
      {
        chatId: 11,
        threadId: null,
        text: 'Thank you for the ★250 tip! It helps keep Chess Goat running.',
      },
    ]);
  });

  it('ignores a replay of the same update', async () => {
    const update = paid('charge-1');
    await post(update);
    await post(update);
    expect(await db.select().from(tips)).toHaveLength(1);
    expect(await dms()).toHaveLength(1);
  });

  it('adds no row and no DM when the same charge arrives in a new update', async () => {
    await post(paid('charge-1'));
    await post(paid('charge-1'));
    expect(await db.select().from(tips)).toHaveLength(1);
    expect(await dms()).toHaveLength(1);
  });
});

describe('refunded_payment', () => {
  it('marks the tip refunded', async () => {
    await post(paid('charge-1'));
    await post(refunded('charge-1'));
    const [row] = await db.select().from(tips);
    expect(row?.refundedAt).toBeInstanceOf(Date);
  });

  it('marks a tip refunded even after the payer deleted their data', async () => {
    await post(paid('charge-1'));
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, 11));
    await deleteMyData(deps, user!.id);
    await post(refunded('charge-1'));
    const [row] = await db.select().from(tips);
    expect(row).toMatchObject({ telegramUserId: 11 });
    expect(row?.refundedAt).toBeInstanceOf(Date);
  });

  it('does nothing for an unknown charge id', async () => {
    expect((await post(refunded('charge-unknown'))).status).toBe(200);
    expect(await db.select().from(tips)).toHaveLength(0);
  });
});
```

Note on the deleted-payer case: after `deleteMyData` the user row's `telegram_user_id` is null, so the refund's `ensureUser`-free path (lookup by charge id only) is what makes this pass; do not look the payer up by Telegram id in the refund handler.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run apps/server/test/integration/payments.test.ts`
Expected: FAIL — no `answerPreCheckoutQuery` call is made, and no tip rows are written.

- [ ] **Step 4: Move `userInfo`**

Create `apps/server/src/bot/userInfo.ts`:

```ts
import type { User } from 'grammy/types';
import type { TelegramUserInfo } from '../domain/users';

export const userInfo = (user: User): TelegramUserInfo => ({
  telegramUserId: user.id,
  firstName: user.first_name,
  username: user.username ?? null,
  languageCode: user.language_code ?? null,
});
```

In `apps/server/src/bot/bot.ts`: delete the local `const userInfo = …` definition, add `import { userInfo } from './userInfo';`, drop `User` from the `grammy/types` import if it becomes unused, and drop `type TelegramUserInfo` from the `../domain/users` import if it becomes unused.

- [ ] **Step 5: Implement the handlers**

Create `apps/server/src/bot/payments.ts`:

```ts
import { t } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { tips } from '../db/schema';
import type { Deps } from '../domain/deps';
import { ensureUser } from '../domain/users';
import { enqueue } from '../jobs/queue';
import { tipCheckoutAccepted } from '../telegram/tips';
import { userInfo } from './userInfo';

/** Tip jar spec §2.2–2.3: Stars tips from the Mini App's Support card. */
export function registerPayments(bot: Bot, deps: Deps): void {
  // Answered inline, not queued: Telegram gives the bot 10 seconds.
  bot.on('pre_checkout_query', async (ctx) => {
    if (tipCheckoutAccepted(ctx.preCheckoutQuery)) await ctx.answerPreCheckoutQuery(true);
    else await ctx.answerPreCheckoutQuery(false, { error_message: t('payment.tip_invalid') });
  });

  bot.chatType('private').on('message:successful_payment', async (ctx) => {
    const payment = ctx.msg.successful_payment;
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await deps.db.transaction(async (tx) => {
      // The charge id is unique, so a payment Telegram delivers twice is thanked once.
      const inserted = await tx
        .insert(tips)
        .values({
          userId: user.id,
          telegramUserId: ctx.from.id,
          stars: payment.total_amount,
          telegramPaymentChargeId: payment.telegram_payment_charge_id,
        })
        .onConflictDoNothing({ target: tips.telegramPaymentChargeId })
        .returning({ id: tips.id });
      if (inserted.length === 0) return;
      await enqueue(tx, {
        kind: 'send_message',
        payload: {
          chatId: ctx.chat.id,
          threadId: null,
          text: t('dm.tip_thanks', { stars: payment.total_amount }),
        },
      });
    });
  });

  // Looked up by charge id alone: the payer may have deleted their data since.
  bot.on('message:refunded_payment', async (ctx) => {
    const refund = ctx.msg.refunded_payment;
    const updated = await deps.db
      .update(tips)
      .set({ refundedAt: sql`now()` })
      .where(eq(tips.telegramPaymentChargeId, refund.telegram_payment_charge_id))
      .returning({ id: tips.id });
    if (updated.length === 0) deps.log.warn('a refund arrived for a tip that is not recorded');
  });
}
```

In `apps/server/src/bot/bot.ts`, add `import { registerPayments } from './payments';` and, immediately before the final `return bot;`:

```ts
  registerPayments(bot, deps);
```

- [ ] **Step 6: Subscribe to pre-checkout queries**

In `apps/server/src/main.ts`:

```ts
/** Spec §5.1 step 4; `chat_member` only arrives where the bot is an administrator. Tip jar spec §2.3. */
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'my_chat_member',
  'chat_member',
  'pre_checkout_query',
] as const;
```

In `apps/server/test/integration/main.test.ts`, the "registers the webhook with the secret and the allowed updates" test:

```ts
    expect(call?.body.allowed_updates).toEqual([
      'message',
      'callback_query',
      'my_chat_member',
      'chat_member',
      'pre_checkout_query',
    ]);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run apps/server/test/integration/payments.test.ts apps/server/test/integration/main.test.ts apps/server/test/integration/bot.test.ts && pnpm typecheck`
Expected: PASS (bot.test.ts guards the `userInfo` move).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/bot apps/server/src/main.ts apps/server/test/helpers/updates.ts apps/server/test/integration/payments.test.ts apps/server/test/integration/main.test.ts
git commit -m "feat(bot): approve tip checkouts, record Stars payments and refunds"
```

---

### Task 5: `/paysupport`, command registration and the runbook

**Files:**
- Modify: `apps/server/src/bot/payments.ts`
- Modify: `apps/server/src/main.ts:43-51` (`BOT_COMMANDS`)
- Modify: `docs/operations.md`
- Test: `apps/server/test/integration/payments.test.ts`, `apps/server/test/integration/main.test.ts:41-54`

**Interfaces:**
- Consumes: `registerPayments` (Task 4); keys `dm.paysupport`, `command.paysupport.description` (Task 1).
- Produces: `/paysupport` private command; `BOT_COMMANDS.private` = `start`, `paysupport`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/integration/payments.test.ts` (add `commandUpdate` and `supergroup` to the `../helpers/updates` import):

```ts
describe('/paysupport', () => {
  it('explains tips and refunds in a private chat', async () => {
    await post(commandUpdate({ chat: privateChat(alice), from: alice, text: '/paysupport' }));
    expect(await dms()).toEqual([
      {
        chatId: 11,
        threadId: null,
        text: 'Tips unlock nothing in Chess Goat; they only support its hosting and development. For a refund within 30 days of a tip, message @Jarvl.',
      },
    ]);
  });

  it('stays silent in a group', async () => {
    await post(
      commandUpdate({ chat: supergroup(-1001000000001), from: alice, text: '/paysupport' }),
    );
    expect(await dms()).toEqual([]);
  });
});
```

In `apps/server/test/integration/main.test.ts`, "registers the commands per scope at boot":

```ts
    expect(byScope).toEqual({
      all_group_chats: ['play', 'chess', 'settings'],
      all_private_chats: ['start', 'paysupport'],
    });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/server/test/integration/payments.test.ts apps/server/test/integration/main.test.ts`
Expected: FAIL — no `send_message` job for `/paysupport`; `all_private_chats` is `['start']`.

- [ ] **Step 3: Implement**

In `apps/server/src/bot/payments.ts`, at the end of `registerPayments`:

```ts
  // Telegram expects every bot that takes payments to answer /paysupport (tip jar spec §2.3).
  bot.chatType('private').command('paysupport', async (ctx) => {
    await enqueue(deps.db, {
      kind: 'send_message',
      payload: { chatId: ctx.chat.id, threadId: null, text: t('dm.paysupport') },
    });
  });
```

In `apps/server/src/main.ts`:

```ts
/** Spec §5.1 step 3: three group commands, two private commands, nothing in the default scope. */
export const BOT_COMMANDS = {
  group: [
    { command: 'play', description: t('command.play.description') },
    { command: 'chess', description: t('command.chess.description') },
    { command: 'settings', description: t('command.settings.description') },
  ],
  private: [
    { command: 'start', description: t('command.start.description') },
    { command: 'paysupport', description: t('command.paysupport.description') },
  ],
} as const;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/server/test/integration/payments.test.ts apps/server/test/integration/main.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the operations doc**

In `docs/operations.md`, BotFather checklist step 3, replace "`/start` for private chats" with "`/start` and `/paysupport` for private chats". Step 4, replace the `allowed_updates` list with `message, callback_query, my_chat_member, chat_member, pre_checkout_query`. Add a step after step 5:

```markdown
6. Payments: nothing to set up. Tips are paid in Telegram Stars (`XTR`), which needs no payment provider in BotFather.
```

and renumber the old step 6 to 7. In the Runbook list, after the "A user asked for deletion" entry, add:

````markdown
- **A tip must be refunded**: find the row in `tips` (by `telegram_user_id`, `stars` and `paid_at`), then call the Bot API with its charge id:

  ```bash
  curl -s "https://api.telegram.org/bot$BOT_TOKEN/refundStarPayment" \
    -d user_id=<telegram_user_id> -d telegram_payment_charge_id=<telegram_payment_charge_id>
  ```

  Telegram then sends `refunded_payment` and the bot sets `refunded_at`. Tip rows survive "Delete my data" for exactly this reason.
````

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/bot/payments.ts apps/server/src/main.ts apps/server/test/integration docs/operations.md
git commit -m "feat(bot): /paysupport, and document Stars refunds"
```

---

### Task 6: `openInvoice` in the Telegram wrapper

**Files:**
- Modify: `apps/miniapp/src/tg/types.ts` (`TelegramWebApp`, after `showPopup?`)
- Modify: `apps/miniapp/src/tg/webapp.ts` (`Feature`, `FEATURE_MIN_VERSION`, `Tg`, `nullTg`, `createTg`)
- Modify: `apps/miniapp/test/support/fakeWebApp.ts`
- Modify: `apps/miniapp/test/support/render.tsx` (pass `invoiceError` through)
- Test: `apps/miniapp/test/tg.test.ts`

**Interfaces:**
- Produces: `type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending'` (exported from `tg/webapp.ts`); `Tg.openInvoice(url: string): Promise<InvoiceStatus> | null`; feature `'invoice'` at `'6.1'`; fake: `FakeWebAppOptions.invoiceError?: string`, `FakeWebAppRecord.invoices: string[]`, `FakeWebAppRecord.answerInvoice(status: InvoiceStatus-like string): void`; `renderApp` option `invoiceError?: string`.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe` of `apps/miniapp/test/tg.test.ts`:

```ts
  it('offers no invoice below 6.1', () => {
    expect(tgFor({ version: '6.0' }).openInvoice('https://t.me/$x')).toBeNull();
    expect(tgFor({ version: '6.0' }).supports('invoice')).toBe(false);
  });

  it('opens an invoice and resolves its final status', async () => {
    const tg = tgFor({ version: '6.1' });
    const status = tg.openInvoice('https://t.me/$x');
    expect(window.__tg!.invoices).toEqual(['https://t.me/$x']);
    window.__tg!.answerInvoice('paid');
    expect(await status).toBe('paid');
  });

  it('rejects when the client refuses to open the invoice', async () => {
    const tg = tgFor({ version: '8.0', invoiceError: 'WebAppInvoiceUrlInvalid' });
    await expect(tg.openInvoice('nope')).rejects.toThrow('WebAppInvoiceUrlInvalid');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/miniapp/test/tg.test.ts`
Expected: FAIL — `openInvoice` is not a function; `invoiceError`/`invoices` do not exist.

- [ ] **Step 3: Extend the fake**

In `apps/miniapp/test/support/fakeWebApp.ts`:

Add to `FakeWebAppOptions`:

```ts
  /** Makes `openInvoice` throw this message, e.g. `WebAppInvoiceUrlInvalid`. */
  invoiceError?: string;
```

Add to `FakeWebAppRecord`:

```ts
  invoices: string[];
  answerInvoice(status: 'paid' | 'cancelled' | 'failed' | 'pending'): void;
```

Next to `let pendingPopup …`:

```ts
  let pendingInvoice: ((status: string) => void) | null = null;
```

In the `record` literal, after `popups: [],`:

```ts
    invoices: [],
    answerInvoice: (status) => {
      const answer = pendingInvoice;
      pendingInvoice = null;
      answer?.(status);
    },
```

After the `if (atLeast(options.version, '6.1')) { webApp.setHeaderColor … }` block:

```ts
  if (atLeast(options.version, '6.1')) {
    webApp.openInvoice = (url: string, cb?: (status: string) => void) => {
      if (options.invoiceError) throw new Error(options.invoiceError);
      if (pendingInvoice !== null) throw new Error('WebAppInvoiceOpened');
      record.invoices.push(url);
      record.calls.push(`openInvoice:${url}`);
      pendingInvoice = cb ?? (() => undefined);
    };
  }
```

In `apps/miniapp/test/support/render.tsx`, add `invoiceError?: string;` to the `options` type and `invoiceError: options.invoiceError,` to the `installFakeWebApp({ … })` call.

- [ ] **Step 4: Implement the wrapper**

In `apps/miniapp/src/tg/types.ts`, in `TelegramWebApp` after `showPopup?(…): void;`:

```ts
  openInvoice?(
    url: string,
    callback?: (status: 'paid' | 'cancelled' | 'failed' | 'pending') => void,
  ): void;
```

In `apps/miniapp/src/tg/webapp.ts`:

Add `| 'invoice'` to `Feature`, and `invoice: '6.1',` to `FEATURE_MIN_VERSION`.

After the `HapticNotification` type:

```ts
export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending';
```

In `interface Tg`, after `openTelegramLink`:

```ts
  /**
   * Telegram's payment sheet (6.1+): resolves the invoice's final status, or rejects when the
   * client refuses the link. Returns null instead of a promise when the client has none.
   */
  openInvoice(url: string): Promise<InvoiceStatus> | null;
```

In `nullTg()`, after `openTelegramLink`:

```ts
    openInvoice: () => null,
```

In `createTg`'s returned object, after `openTelegramLink`:

```ts
    openInvoice(url) {
      if (!supports('invoice') || !raw.openInvoice) return null;
      // A synchronous throw (WebAppInvoiceOpened, WebAppInvoiceUrlInvalid) rejects the promise.
      return new Promise((resolve) => raw.openInvoice!(url, resolve));
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/miniapp && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/miniapp/src/tg apps/miniapp/test/support apps/miniapp/test/tg.test.ts
git commit -m "feat(miniapp): openInvoice in the Telegram wrapper, gated at 6.1"
```

---

### Task 7: The Support card

**Files:**
- Create: `apps/miniapp/src/ui/SupportCard.tsx`
- Modify: `apps/miniapp/src/ui/screens/Settings.tsx` (render between the prefs card and the banner card)
- Modify: `apps/miniapp/src/styles.css` (append after `.danger-row`)
- Test: `apps/miniapp/test/supportCard.test.tsx`, `apps/miniapp/test/settings.test.tsx`

**Interfaces:**
- Consumes: `TipInvoiceDtoSchema`, `TIP_MIN_STARS`, `TIP_MAX_STARS`, `app.settings.support.*` keys (Task 1); `Tg.openInvoice`, `tg.supports('invoice')`, fake `invoices` / `answerInvoice` / `invoiceError` (Task 6); `AUTHOR_URL`, `BRAND` from `../brand`; `toast`; `useApp`.
- Produces: `SupportCard()` component; `customStars(raw: string): number | null`. DOM hooks for tests: `[data-card="support"]`, `[data-tip="100|250|500"]`, `[data-action="tip-custom"]`, `[data-tip-input]`, `[data-action="tip-submit"]`, `[data-action="support-author"]`, `.tip-hint` with class `empty|ok|bad`.

- [ ] **Step 1: Write the failing tests**

Create `apps/miniapp/test/supportCard.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { customStars, SupportCard } from '../src/ui/SupportCard';
import { renderApp } from './support/render';
import type { FakeRoute } from './support/fakeFetch';

const INVOICE = 'https://t.me/$TestInvoice';
const mints: FakeRoute = ({ path }) =>
  path === '/api/tips' ? { status: 200, body: { url: INVOICE } } : { status: 404 };

const typeAmount = async (r: ReturnType<typeof renderApp>, value: string) => {
  const input = r.root.querySelector<HTMLInputElement>('[data-tip-input]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await r.flush();
  return input;
};
const toastText = () => document.querySelector('.toast')?.textContent ?? null;

describe('customStars', () => {
  it.each([
    ['1', 1],
    ['250', 250],
    ['10000', 10_000],
  ])('reads %s as %s', (raw, stars) => {
    expect(customStars(raw)).toBe(stars);
  });

  it.each(['', '0', '10001', '12345'])('refuses %j', (raw) => {
    expect(customStars(raw)).toBeNull();
  });
});

describe('SupportCard', () => {
  it('is not rendered on clients without invoices', () => {
    const r = renderApp(() => <SupportCard />, mints, { version: '6.0' });
    expect(r.root.querySelector('[data-card="support"]')).toBeNull();
  });

  it('tips a preset: posts the amount, opens the invoice, thanks on payment', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-tip="250"]');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ method: 'POST', path: '/api/tips', body: { stars: 250 } });
    expect(window.__tg!.invoices).toEqual([INVOICE]);
    expect(window.__tg!.haptics).toContain('impact:light');
    window.__tg!.answerInvoice('paid');
    await r.flush();
    expect(window.__tg!.haptics).toContain('notification:success');
    expect(toastText()).toBe('Thank you for supporting Chess Goat');
    expect(r.root.querySelector('[data-tip="250"]')?.classList.contains('on')).toBe(false);
  });

  it('says so when the payment fails', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-tip="100"]');
    window.__tg!.answerInvoice('failed');
    await r.flush();
    expect(window.__tg!.haptics).toContain('notification:error');
    expect(toastText()).toBe("The payment didn't go through");
  });

  it.each(['cancelled', 'pending'] as const)('stays quiet when the invoice ends %s', async (status) => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-tip="500"]');
    window.__tg!.answerInvoice(status);
    await r.flush();
    expect(toastText()).toBeNull();
    expect(r.root.querySelector('[data-tip="500"]')?.classList.contains('on')).toBe(true);
  });

  it('shows the generic error when the server cannot mint a link', async () => {
    const r = renderApp(
      () => <SupportCard />,
      () => ({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } }),
    );
    await r.click('[data-tip="100"]');
    expect(window.__tg!.invoices).toEqual([]);
    expect(toastText()).toBe('Something went wrong');
  });

  it('shows the generic error when the client refuses the invoice link', async () => {
    const r = renderApp(() => <SupportCard />, mints, { invoiceError: 'WebAppInvoiceUrlInvalid' });
    await r.click('[data-tip="100"]');
    expect(toastText()).toBe('Something went wrong');
    expect(r.root.querySelector<HTMLButtonElement>('[data-tip="100"]')?.disabled).toBe(false);
  });

  it('ignores a second tap while a tip is in flight', async () => {
    // A function, not null: TypeScript would narrow a null-initialised `let` to `never` below.
    let release = (): void => undefined;
    const r = renderApp(
      () => <SupportCard />,
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: { url: INVOICE } });
        }),
    );
    const first = r.root.querySelector<HTMLButtonElement>('[data-tip="100"]')!;
    const second = r.root.querySelector<HTMLButtonElement>('[data-tip="500"]')!;
    first.click();
    second.click(); // same tick: before any re-render
    await r.flush();
    await r.click('[data-tip="250"]');
    expect(r.calls).toHaveLength(1);
    expect(r.root.querySelector('[data-tip="100"] .tip-spinner')).not.toBeNull();
    release();
    await r.flush();
    expect(window.__tg!.invoices).toEqual([INVOICE]);
  });

  it('validates a custom amount before it can be tipped', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-action="tip-custom"]');
    const submit = () => r.root.querySelector<HTMLButtonElement>('[data-action="tip-submit"]')!;
    const hint = () => r.root.querySelector('.tip-hint')!;
    expect(hint().textContent).toBe('Any whole number from 1 to 10,000');
    expect(submit().disabled).toBe(true);

    await typeAmount(r, '0');
    expect(hint().classList.contains('bad')).toBe(true);
    expect(hint().textContent).toBe('Enter between 1 and 10,000 Stars');
    expect(submit().disabled).toBe(true);

    await typeAmount(r, '123');
    expect(hint().classList.contains('ok')).toBe(true);
    expect(hint().textContent).toBe('Telegram shows the exact total before you pay');
    await r.click('[data-action="tip-submit"]');
    expect(r.calls[0]).toMatchObject({ path: '/api/tips', body: { stars: 123 } });
  });

  it('keeps only digits from pasted text, at most five of them', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-action="tip-custom"]');
    expect((await typeAmount(r, '1,000')).value).toBe('1000');
    expect(r.root.querySelector('.tip-hint')?.classList.contains('ok')).toBe(true);
    expect((await typeAmount(r, ' 250 ')).value).toBe('250');
    expect((await typeAmount(r, '1234567')).value).toBe('12345');
    expect(r.root.querySelector('.tip-hint')?.classList.contains('bad')).toBe(true);
  });

  it('opens the author chat from the card body', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-action="support-author"]');
    expect(window.__tg!.links).toEqual(['https://t.me/Jarvl']);
  });
});
```

Append to `apps/miniapp/test/settings.test.tsx`, inside `describe('Settings', …)`:

```tsx
  it('shows the Support card between the preferences and the links', () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    const cards = [...r.root.querySelectorAll('.card')];
    const support = cards.findIndex((card) => card.matches('[data-card="support"]'));
    expect(support).toBe(1);
    expect(cards[2]?.querySelector('img.banner-img')).not.toBeNull();
  });

  it('says tip records are kept when asking to delete', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    await r.click('[data-action="delete"]');
    expect(window.__tg!.popups.at(-1)?.message).toContain('kept as payment records');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/miniapp/test/supportCard.test.tsx apps/miniapp/test/settings.test.tsx`
Expected: FAIL — cannot resolve `../src/ui/SupportCard`; the Settings card-order test fails.

- [ ] **Step 3: Implement the card**

Create `apps/miniapp/src/ui/SupportCard.tsx`:

```tsx
import { t, TIP_MAX_STARS, TIP_MIN_STARS, TipInvoiceDtoSchema } from '@group-chess/shared';
import { useRef, useState } from 'preact/hooks';
import { AUTHOR_URL, BRAND } from '../brand';
import { useApp } from './context';
import { toast } from './toast';

const PRESETS = [100, 250, 500] as const;

type Source = number | 'custom';

/** Whole Stars from the custom field, or null while it is empty or out of range. */
export function customStars(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const stars = Number(raw);
  return stars >= TIP_MIN_STARS && stars <= TIP_MAX_STARS ? stars : null;
}

const Spinner = () => <span class="tip-spinner" aria-hidden="true" />;

/** Tip jar spec §3.2: presets, a custom amount, and Telegram's own payment sheet. */
export function SupportCard() {
  const { client, tg } = useApp();
  const [selected, setSelected] = useState<Source | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState<Source | null>(null);
  // State lags a render behind; the ref stops a second tap in the same tick.
  const inFlight = useRef(false);
  if (!tg.supports('invoice')) return null;

  const amount = customStars(raw);
  const state = raw === '' ? 'empty' : amount === null ? 'bad' : 'ok';
  const hint = {
    empty: t('app.settings.support.hint'),
    ok: t('app.settings.support.hint_ok'),
    bad: t('app.settings.support.hint_bad'),
  }[state];

  const tip = async (stars: number, source: Source) => {
    if (inFlight.current) return;
    inFlight.current = true;
    tg.haptic('light');
    setSelected(source);
    setBusy(source);
    try {
      const { url } = await client.post('/api/tips', { stars }, TipInvoiceDtoSchema);
      const status = await tg.openInvoice(url);
      if (status === 'paid') {
        tg.hapticNotify('success');
        toast(t('app.settings.support.thanks'));
        setSelected(null);
        setRaw('');
        setCustomOpen(false);
      } else if (status === 'failed') {
        tg.hapticNotify('error');
        toast(t('app.settings.support.failed'));
      }
    } catch {
      toast(t('app.common.error'));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const toggleCustom = () => {
    tg.hapticSelection();
    setSelected(customOpen ? null : 'custom');
    setCustomOpen(!customOpen);
  };

  const onInput = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const digits = input.value.replace(/\D/g, '').slice(0, 5);
    // Written back directly too: when the digits are unchanged Preact skips the re-render.
    input.value = digits;
    setRaw(digits);
  };

  return (
    <div class="card" data-card="support">
      <div class="tip-intro">
        <span class="tip-head">{t('app.settings.support.title')}</span>
        <span class="tip-body">
          {t('app.settings.support.body_lead')}{' '}
          <button
            type="button"
            class="inline-link acc-text"
            data-action="support-author"
            onClick={() => tg.openTelegramLink(AUTHOR_URL)}
          >
            @{BRAND.author}
          </button>{' '}
          {t('app.settings.support.body')}
        </span>
      </div>
      <div class="tip-grid">
        {PRESETS.map((stars) => (
          <button
            type="button"
            key={stars}
            class={`tip${selected === stars ? ' on' : ''}`}
            data-tip={stars}
            disabled={busy !== null}
            onClick={() => void tip(stars, stars)}
          >
            {busy === stars ? (
              <Spinner />
            ) : (
              <>
                <span class="tip-star" aria-hidden="true">
                  ★
                </span>
                {stars}
              </>
            )}
          </button>
        ))}
        <button
          type="button"
          class={`tip-custom${customOpen ? ' on' : ''}`}
          data-action="tip-custom"
          aria-expanded={customOpen ? 'true' : 'false'}
          disabled={busy !== null}
          onClick={toggleCustom}
        >
          {t('app.settings.support.choose')}
        </button>
      </div>
      {customOpen && (
        <div class="tip-form">
          <div class="tip-row">
            <label class={`tip-input ${state}`}>
              <span class="tip-star" aria-hidden="true">
                ★
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder={t('app.settings.support.placeholder')}
                aria-label={t('app.settings.support.amount_label')}
                value={raw}
                onInput={onInput}
                data-tip-input
              />
            </label>
            <button
              type="button"
              class="tip-submit"
              data-action="tip-submit"
              disabled={amount === null || busy !== null}
              onClick={() => {
                if (amount !== null) void tip(amount, 'custom');
              }}
            >
              {busy === 'custom' ? <Spinner /> : t('app.settings.support.tip')}
            </button>
          </div>
          <span class={`tip-hint ${state}`}>{hint}</span>
        </div>
      )}
    </div>
  );
}
```

In `apps/miniapp/src/ui/screens/Settings.tsx`, add `import { SupportCard } from '../SupportCard';` and render `<SupportCard />` between the closing `</div>` of the toggles card and the `<div class="card">` that holds the banner:

```tsx
      </div>
      <SupportCard />
      <div class="card">
        <img class="banner-img" src={BRAND.bannerUrl} alt="" loading="lazy" />
```

- [ ] **Step 4: Style it**

Append to `apps/miniapp/src/styles.css`, after the `.danger-row` rule:

```css
/* Tip jar spec §3.2: the Support card. */
.tip-intro {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 14px 12px;
}

.tip-head {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--hint);
}

.tip-body {
  font-size: 15px;
  text-wrap: pretty;
}

.inline-link {
  border: 0;
  padding: 0;
  background: none;
  font: inherit;
  cursor: pointer;
}

.tip-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 0 14px 14px;
}

.tip,
.tip-custom {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 42px;
  border: 0;
  border-radius: 12px;
  background: var(--page);
  color: var(--text);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
}

.tip {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.tip .tip-star,
.tip-input .tip-star {
  color: var(--move);
}

.tip.on {
  background: var(--acc);
  color: var(--acc-ink);
}

.tip.on .tip-star {
  color: var(--acc-ink);
}

.tip-custom {
  grid-column: 1 / -1;
  font-weight: 600;
}

.tip-custom.on {
  background: var(--acc-soft);
  color: var(--acc-text);
}

.tip-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 14px 14px;
}

.tip-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tip-input {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 14px;
  border-radius: 12px;
  background: var(--page);
  box-shadow: inset 0 0 0 2px transparent;
}

.tip-input.ok {
  box-shadow: inset 0 0 0 2px var(--acc);
}

.tip-input.bad {
  box-shadow: inset 0 0 0 2px var(--destructive);
}

.tip-input .tip-star {
  font-size: 18px;
}

.tip-input input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.tip-submit {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 48px;
  padding: 0 18px;
  border: 0;
  border-radius: 12px;
  background: var(--acc);
  color: var(--acc-ink);
  font: inherit;
  font-size: 15px;
  font-weight: 700;
}

.tip-submit:disabled {
  opacity: 0.45;
}

.tip-hint {
  font-size: 13px;
  color: var(--hint);
}

.tip-hint.bad {
  color: var(--destructive);
}

.tip-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/miniapp && pnpm typecheck && pnpm lint`
Expected: PASS. If happy-dom fires `onClick` on a disabled button, "ignores a second tap" still passes through the `inFlight` ref.

- [ ] **Step 6: Commit**

```bash
git add apps/miniapp/src/ui apps/miniapp/src/styles.css apps/miniapp/test/supportCard.test.tsx apps/miniapp/test/settings.test.tsx
git commit -m "feat(miniapp): the Support card tips in Telegram Stars"
```

---

### Task 8: End to end, gates and a visual pass

**Files:**
- Modify: `apps/miniapp/e2e/screens.spec.ts` (the Settings step)
- Create: `apps/miniapp/e2e/tip.spec.ts`

**Interfaces:**
- Consumes: everything above; e2e helpers `openApp`, `seed` from `./support`; fake `invoices` / `answerInvoice`.

- [ ] **Step 1: Extend the screens spec**

In `apps/miniapp/e2e/screens.spec.ts`, replace the Settings step at the end of the test with:

```ts
    await page.locator('[data-nav="settings"]').click();
    await expect(page.locator('[data-action="about"]')).toBeVisible();
    await expect(page.locator('[data-card="support"]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-settings`);

    await page.locator('[data-action="tip-custom"]').click();
    await page.locator('[data-tip-input]').fill('12345');
    await expect(page.locator('.tip-hint.bad')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-settings-tip`);
```

- [ ] **Step 2: Add a composed tip flow**

Create `apps/miniapp/e2e/tip.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { openApp, seed } from './support';

test('a preset tip goes through the server and Telegram and says thank you', async ({ page }) => {
  const world = await seed('ranked', {});
  await openApp(page, { user: world.users.alice.telegram });
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-tip="250"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__tg!.invoices))
    .toEqual(['https://t.me/$TestInvoice']);
  await page.evaluate(() => window.__tg!.answerInvoice('paid'));
  await expect(page.locator('.toast')).toHaveText('Thank you for supporting Chess Goat');
});
```

If `seed('ranked', {})` needs a different first argument in this repo, use whichever seed name `screens.spec.ts` uses; the test only needs a signed-in Alice.

- [ ] **Step 3: Run the end-to-end suite**

Run: `export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test && pnpm e2e` (the script builds the app first: `vite build && playwright test`)
Expected: all specs pass, including `tip.spec.ts` and both colour schemes of `screens.spec.ts`.

- [ ] **Step 4: Run every gate**

Run: `export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm check:budget && pnpm check:licences`
Expected: all pass; the budget lines still say `OK`. Fix any `format:check` complaint with `pnpm format` and re-run.

- [ ] **Step 5: Visual pass against the prototype**

Run the screens spec with screenshots on:

Run: `SCREENS_DIR=/tmp/tip-screens pnpm --filter @group-chess/miniapp exec playwright test e2e/screens.spec.ts` (with `TEST_DATABASE_URL` exported; use the session scratchpad instead of `/tmp` when running as an agent)

Open `light-settings.png`, `dark-settings.png`, `light-settings-tip.png`, `dark-settings-tip.png` and compare with the prototype's Settings screen (`Chess Goat Prototype.dc.html`, the "Support Chess Goat" card): header in hint-coloured caps, body with @Jarvl in the accent, three equal preset tiles with gold stars, a full-width "Choose amount" bar, and in the open state a ringed input with a leading ★, a green Tip button and the hint line. Fix any spacing or colour that differs from the prototype in `styles.css` and re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/miniapp/e2e
git commit -m "test(e2e): the Support card fits at 390 px, and a tip round-trips"
```
