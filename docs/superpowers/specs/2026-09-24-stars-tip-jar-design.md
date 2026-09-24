# Chess Goat: the Telegram Stars tip jar

Status: accepted for planning, 2026-09-24. Source design: the Claude Design project
`Chess Goat Prototype.dc.html`, the "Support Chess Goat" card in Settings and its invoice flow.
Builds on the [Chess Goat redesign](./2026-09-22-chess-goat-redesign-design.md) (PR #17), which
deferred the tip jar to this spec; the Settings screen, tokens and brand come from there.

## What this is

A voluntary, one-off tip in Telegram Stars from the Mini App's Settings screen. A tip unlocks
nothing. It shows appreciation and helps cover the server.

Someone taps ★250 in Settings, pays in Telegram's own payment sheet, sees "Thank you for
supporting Chess Goat", and receives a thank-you DM; the server records the payment.

| In scope | Out of scope |
|---|---|
| The Support card in Settings: presets ★100 / ★250 / ★500 and a custom amount of 1–10,000 | Supporter badges, perks or anything a tip unlocks |
| `POST /api/tips`, which mints an invoice link (currency `XTR`) | A tip history in the app; in-app or API refunds |
| The bot's `pre_checkout_query`, `successful_payment` and `refunded_payment` handling | A Prometheus metric for tips |
| A `tips` table | `/terms`; tipping from group chats |
| `/paysupport` in private chats, and a documented manual refund | Subscriptions or recurring tips |

Delivered as one PR against `main`, which has the redesign (#17) merged.

Where the prototype and its screenshots disagree, the prototype's code wins: the presets are
100 / 250 / 500 (the `custom-tip` screenshots show an older 50 / 150 / 500).

## 1. Data

A new table `tips`, migration `0003_tips`:

| Column | Type | Notes |
|---|---|---|
| `id` | serial primary key | |
| `user_id` | integer, nullable, references `users.id`, no cascade | The payer's user row (anonymised if they delete their data) |
| `telegram_user_id` | bigint, not null | Needed by `refundStarPayment` |
| `stars` | integer, not null | |
| `telegram_payment_charge_id` | text, not null, unique | Idempotency key and refund handle |
| `paid_at` | timestamptz, not null, default `now()` | |
| `refunded_at` | timestamptz, nullable | Set when `refunded_payment` arrives |

`deleteMyData` does not touch `tips`: the rows are payment records, kept for refunds and
disputes. The Delete confirmation says so (§3.3).

## 2. Server and bot

### 2.1 Invoice endpoint

`POST /api/tips`, in a new `api/routes/tips.ts`, behind the existing initData session like
every `/api` route.

- Body `TipRequestSchema = { stars: integer, 1 ≤ stars ≤ 10,000 }`, added to the shared protocol
  next to the other request schemas. Response `TipInvoiceDto = { url: string }`.
- Rate limit: a per-user `RateLimiter(10, 60_000)`; beyond it, `DomainError('rate_limited')`.
- Calls `createTipInvoiceLink(api, stars)` in a new `telegram/tips.ts`, which wraps
  `createInvoiceLink` with:
  - `title`: "Tip Chess Goat"
  - `description`: "A one-off tip to @Jarvl for hosting and development. Nothing is unlocked."
  - `payload`: `tip:v1:<stars>`
  - `currency`: `XTR`, `provider_token`: `""`
  - `prices`: `[{ label: 'Tip', amount: stars }]`
- `ApiContext` gains `api: Api`, the throttled Bot API client `main.ts` already builds (the bot's
  own `bot.api`, or `createTelegramApi` without a bot).
- A Bot API failure or timeout is logged with the error and surfaces as the existing `internal`
  code (500); no new error code is added.

A link is minted for every tap; links are not cached.

### 2.2 Payment updates

A new `bot/payments.ts`, registered from `createBot`.

- **`pre_checkout_query`**: `parseTipPayload(payload)` accepts exactly `tip:v1:<n>` with `n` an
  integer from 1 to 10,000. The query is approved (`ok: true`) only when the payload parses,
  `n === total_amount` and `currency === 'XTR'`; otherwise `ok: false` with
  `error_message` "This tip link is no longer valid." It is answered inline in the webhook
  handler, not through the job queue, because Telegram allows 10 seconds.
- **`message:successful_payment`** (private chat): `ensureUser` for the payer, then insert the
  tip with `onConflictDoNothing` on `telegram_payment_charge_id`. Only when a row was inserted,
  enqueue `send_message` to the payer's private chat with `dm.tip_thanks`:
  "Thank you for the ★{stars} tip! It helps keep Chess Goat running." A replayed update therefore
  adds neither a row nor a second DM.
- **`message:refunded_payment`**: set `refunded_at = now()` on the row with that charge id. An
  unknown charge id logs a warning and does nothing else.

### 2.3 Commands and subscription

- `/paysupport` joins `BOT_COMMANDS.private`. It replies with `dm.paysupport`: tips unlock
  nothing; for a refund within 30 days, message @Jarvl.
- `ALLOWED_UPDATES` gains `pre_checkout_query`. `successful_payment` and `refunded_payment`
  arrive inside `message`, which is already subscribed.

### 2.4 Refunds

Operator-run, by the tip's transaction id (its `telegram_payment_charge_id`, which the payer sees on
their Telegram receipt). Inside the app container, from `apps/server`:

```bash
pnpm run refund-tip <transaction id>
```

`refundTip` (`domain/tipRefunds.ts`) looks the tip up by that id, refuses an unknown or
already-refunded one without calling Telegram, shows the operator the transaction id, amount,
payment time and payer, and asks `[y/N]`. Only `y` or `yes` calls `refundStarPayment` with the row's
`telegram_user_id`; any other answer, or none, refunds nothing. The script uses the container's own `BOT_TOKEN` and `DATABASE_URL`, so the
token is never typed or pasted. Telegram then sends `refunded_payment`, and the bot records
`refunded_at`. `docs/operations.md` documents it, with the raw `refundStarPayment` call as the
fallback when the container is down.

## 3. Mini App

### 3.1 Telegram wrapper

In `tg/webapp.ts`:

- A new feature `invoice`, minimum version `6.1`.
- `openInvoice(url): Promise<'paid' | 'cancelled' | 'failed' | 'pending'> | null`, resolving
  from the `openInvoice` callback's status; `null` when the client lacks the feature (the same
  shape as `showPopup`).
- `test/support/fakeWebApp.ts` gains a scripted `openInvoice` that records the URL and resolves
  the status the test chooses.

### 3.2 The Support card

A new `ui/SupportCard.tsx`, rendered by `Settings.tsx` between the preferences card and the
banner card. It is not rendered when `tg.supports('invoice')` is false (a plain browser or a
client below 6.1).

- Header "SUPPORT CHESS GOAT" and the body "Chess Goat is maintained by @Jarvl and will always be
  free without ads. A tip in Telegram Stars shows your appreciation and helps cover the cost of
  the server." @Jarvl opens `AUTHOR_URL` with `openTelegramLink`.
- A three-column grid of presets ★100, ★250, ★500. The selected one takes `--acc` with
  `--acc-ink` text and star; the others sit on `--page` with a `--move` star.
- A full-width "Choose amount" toggle spanning the grid, `--acc-soft` / `--acc-text` while open.
  Open, it shows a numeric input (digits only, at most 5 characters, placeholder "Any amount",
  a leading ★) and a Tip button, and a hint line below:
  - empty: "Any whole number from 1 to 10,000"
  - valid: "Telegram shows the exact total before you pay", with an `--acc` ring on the input
  - invalid: "Enter between 1 and 10,000 Stars" in `--destr`, with a `--destr` ring
  The Tip button is at 45% opacity and does nothing until the amount is valid. The prototype's
  "≈ $x" estimate is left out: its fixed rate would be wrong in many regions.

Tapping a preset or Tip:

1. `tg.haptic('light')`; the tapped button shows a small spinner and the card ignores taps until
   the flow settles.
2. `POST /api/tips { stars }`, then `tg.openInvoice(url)`.
3. By status:
   - `paid`: `hapticNotify('success')`, toast "Thank you for supporting Chess Goat", the
     selection and custom amount are cleared.
   - `failed`: `hapticNotify('error')`, toast "The payment didn't go through".
   - `cancelled` or `pending`: nothing.
4. If the POST fails: the generic `app.common.error` toast.

### 3.3 Copy and styles

- Strings go in the shared `t()` catalogue under `app.settings.support.*`; the bot's strings are
  `dm.tip_thanks`, `dm.paysupport`, `command.paysupport.description` and the pre-checkout error.
- `app.settings.delete_confirm` gains a clause: tip records are kept as payment records.
- `styles.css` gains `.tip-grid`, `.tip`, `.tip.on`, `.tip-custom`, `.tip-input` and `.tip-hint`,
  built on PR #17's tokens.

## 4. Error handling

| Case | Behaviour |
|---|---|
| Out-of-range or non-integer amount in the POST | 400 from `validate`; the app cannot send one |
| More than 10 invoices a minute | 429 `rate_limited`; generic error toast |
| `createInvoiceLink` fails or times out | 500 `internal`, logged; generic error toast |
| Forged or stale payload, amount or currency mismatch at pre-checkout | `ok: false` with the short message; nobody is charged |
| `answerPreCheckoutQuery` throws | The handler rethrows, the webhook returns 500 and Telegram retries; if it never succeeds the query expires and nobody is charged |
| `successful_payment` delivered twice | The unique charge id makes the second insert a no-op: no row, no DM |
| Payer has blocked the bot | The row is still written; the DM job fails like any other undeliverable DM |
| `refunded_payment` for an unknown charge id | A warning is logged |
| Client below 6.1, or a plain browser | No Support card |

## 5. Testing and gates

- **Server unit**: `parseTipPayload` accepts `tip:v1:<n>` for 1–10,000 and rejects other
  prefixes, versions, zero, out-of-range and non-integer amounts; the pre-checkout decision
  checks amount and currency.
- **Server integration** (with `FakeTelegram` and the updates helpers):
  - `POST /api/tips` sends the §2.1 `createInvoiceLink` body and returns its URL; bad amounts
    give 400, the eleventh call in a minute gives 429, a Bot API failure gives 500.
  - `pre_checkout_query` is answered ok for a valid payload and not ok for each mismatch.
  - `successful_payment` writes one row and one DM job; replaying the same update writes neither.
  - `refunded_payment` sets `refunded_at`.
  - `/paysupport` replies in a private chat.
  - `deleteMyData` leaves the user's tip rows intact.
  - `ALLOWED_UPDATES` includes `pre_checkout_query`; `BOT_COMMANDS.private` includes
    `paysupport`; the migration applies.
- **Mini App unit (vitest)**: the card is absent without the `invoice` feature; a preset tap
  posts its amount and opens the returned URL; `paid`, `failed` and `cancelled` produce the right
  toast and haptic (or none); custom-amount validation for empty, invalid and valid input and the
  disabled Tip button; taps are ignored while a tip is in flight; an API failure shows the error
  toast.
- **Playwright**: the 390 px no-overflow screens spec covers Settings with the Support card and
  the custom amount open, light and dark, with `openInvoice` in the fake WebApp.
- The full check suite passes (lint, typecheck, tests, bundle size, licences), followed by a
  visual pass in the browser against the prototype.
