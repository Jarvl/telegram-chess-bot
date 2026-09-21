# Deployment and operations

## BotFather checklist (spec §5.1)

1. Create the bot; keep privacy mode on (the default). The bot only ever sees its commands, replies to its own messages, button taps and Mini App requests.
2. `/newapp`: choose the bot, a title, a short description, an image, and the short name that becomes `MINI_APP_SHORT_NAME`. Web App URL: `<PUBLIC_URL>/app/`. In the bot's settings enable the same URL as the **Main Mini App**, so the profile button opens the lobby.
3. Commands: the server registers them itself at every boot (`/play`, `/chess`, `/settings` for group chats; `/start` for private chats; nothing in the default scope). Do not add commands in BotFather.
4. Webhook: the server calls `setWebhook` at boot with `WEBHOOK_SECRET` and `allowed_updates` `message, callback_query, my_chat_member, chat_member`. With `TELEGRAM_POLLING=true` it deletes the webhook and long-polls instead.
5. Leave the menu button on its default (opens the Main Mini App).
6. Add the bot to a group. It posts a welcome card with an **♟ Open Chess** button; promote it to administrator so it can pin the card and see joins and leaves.

## Deploying the image

- One container, all four roles by default (`ROLES=api,bot,jobs,clock`). To split, run several containers with subsets; scanners and the job worker are safe to run in several instances (`SELECT … FOR UPDATE SKIP LOCKED`). With more than one `api` replica, SSE needs the `PgNotifyBus` upgrade named in the design (§4.3); the alpha runs one.
- Migrations run at boot under an advisory lock, so several replicas can start at once. Rolling restarts are safe: clocks and jobs are rows; Telegram retries the webhook; SSE clients reconnect.
- Health: `GET /healthz` (process up), `GET /readyz` (database reachable). Metrics: `GET /metrics` (Prometheus); keep it behind the network policy.
- Reverse proxy: HTTPS only; forward `/telegram/webhook`, `/api/*`, `/app/*`, `/healthz`, `/readyz`. Disable response buffering for `/api/games/*/events` (the server sends `X-Accel-Buffering: no`, `Cache-Control: no-store` and a `ping` every 20 s). Redact the query string of that route and of `/api/games/*/pgn` in access logs (the first carries the session token, the second a five-minute download token). Optionally restrict `/telegram/webhook` to Telegram's published address ranges.
- Before the beta: run Lighthouse against the staging `/app/` URL on a throttled mobile profile and keep first board paint under 2 s (spec §6.5); the byte budget in CI is only a proxy for it.
- Verification on staging after every deploy: open a game in the Mini App from two accounts, make a move on one and watch it appear on the other within 2 s without a refresh; if it appears only after a reload, the proxy is buffering the stream.
- Database: daily snapshots kept 30 days, encrypted at rest; run one restore drill before the beta. Retention inside the database: `telegram_updates` 7 days, finished jobs 30 days (the daily `prune` job), games indefinitely.
- Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET`, `SESSION_SECRET`, `LICHESS_TOKEN` live in the platform's secret store, never in the image or the repository. Rotating `SESSION_SECRET` logs every Mini App session out; rotating `WEBHOOK_SECRET` needs a restart (the server re-registers the webhook).
- Releases: a tag `vX.Y.Z` builds and publishes `ghcr.io/<owner>/<repo>:X.Y.Z`; staging deploys from the tag when the repository variable `STAGING_DEPLOY_HOOK_ENABLED` is `true` and the secret `STAGING_DEPLOY_HOOK` holds the platform's deploy hook; production is a manual promotion of the same image.

## Metrics and alerts (spec §14)

| Metric | Alert |
|---|---|
| `webhook_updates_total{type}` | Together with the proxy's 5xx count: webhook 5xx above 1 % over 5 min |
| `jobs_pending{kind}`, `jobs_oldest_age_seconds{kind}` | Oldest age above 60 s |
| `scanner_lag_seconds{scanner}` | Above 30 s |
| `telegram_api_calls_total{method,status}`, `telegram_429_total` | Spikes of 5xx or 429 |
| `lichess_imports_total{outcome}` | Failure ratio above 50 % over an hour |
| `miniapp_load_errors_total`, `miniapp_move_failures_total` | Load errors above 1 % of launches |
| `jobs_failed_total{kind}` | Any increase: a job exhausted its attempts (`last_error` on the row says why) |
| `moves_total`, `move_latency_seconds`, `sse_streams`, `sse_reconnects_total`, `game_opens_total{role}`, `games_started`, `games_finished_total{end_reason}`, `shares`, `active_groups` (the last three table-backed gauges carry no `_total` suffix, unlike spec §14's draft names) | Dashboards |

Logs are JSON (pino) with numeric and public ids only; bound query parameters are stripped from error messages.

## Runbook

- **A card stopped updating**: `games.card_missing` is set when Telegram answered "message to edit not found"; the game itself continues in the app. Nothing to do.
- **DMs stopped for a user**: `users.dm_allowed` turned false after a 403 from Telegram; the user can `/start` the bot again.
- **Lichess links missing**: `lichess_import_status = 'failed'` after eight attempts over about a day; the fallback analysis link is on the card and in the app. Check `lichess_imports_total{outcome}` and the token quota.
- **A rated game must be voided**: an admin does it from the app's group settings; ratings are recomputed by the `rebuild_ratings` job and the affected cards are re-edited.
- **Ratings look wrong without a void**: enqueue `rebuild_ratings` for the group by inserting a job row (`kind = 'rebuild_ratings'`, `payload = {"groupId": <internal id>}`, `dedup_key = 'ratings:<group public id>'`).
- **A user asked for deletion**: they do it themselves in the app (Settings → Delete my data); it resigns their games, cancels their challenges and anonymises the row immediately.

## Known limits of the alpha

- One process holds the per-user API limiter and the Lichess pacing; a second replica doubles both.
- `/api/launch` has no pre-session rate limit; put one on the proxy if a flood of forged launch data ever matters (each attempt costs two HMAC rounds).
- The membership verdict cache is per user and group (10 minutes for a grant, 1 minute for a denial); a user added to a group sees it within a minute.
- Mini App launch failures are counted on the server (`miniapp_load_errors_total` rises when `POST /api/launch` fails); a launch that never reaches the API (Telegram's script failing to load) leaves no trace, because telemetry needs a session.
