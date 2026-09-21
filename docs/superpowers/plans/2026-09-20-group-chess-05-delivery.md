# Group Chess 05 — Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the alpha deployable and operable: a production runtime and Docker image that serves the built Mini App, the BotFather command registration the server can do itself, CI that also builds the app, enforces the bundle and licence budgets and runs the end-to-end suite, a release workflow that publishes the image, Dependabot, and the README plus the deployment and operations checklist an operator needs.

**Architecture:** Nothing new in the product code beyond `setMyCommands` at boot and `tsx` as the production runtime (the server and the shared package ship as TypeScript, transpiled at start). The Docker image is multi-stage: a build stage installs everything and builds the Mini App; the runtime stage installs production dependencies for the server only and copies the built app in, served under `/app/` by plan 03's static handler. CI keeps the existing check job and adds the build, budget and licence gates; a second workflow runs Playwright and a Docker build on `main`; a third publishes the image on tags.

**Tech Stack:** Docker (node:22-bookworm-slim, corepack, pnpm 10.33), GitHub Actions (pnpm/action-setup, setup-node, docker/build-push-action, docker/metadata-action, actions/upload-artifact), Dependabot, `pnpm licenses list --json` for the allow-list gate.

**Spec:** [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](../specs/2026-09-20-group-chess-technical-design.md) §4.3–§4.4, §5.1, §11, §12 (supply chain, retention), §14, §16; PRD §13; parent plan [2026-09-20-group-chess.md](2026-09-20-group-chess.md); consumes plans 01–04.

## Global Constraints

- Configuration stays environment-only; no secrets in the repository, the image or the workflows (spec §4.4, §12). The image reads the same variables plan 03 defined.
- Migrations run at boot under the advisory lock (plan 02); rolling restarts are safe because clocks and jobs are rows (spec §4.4).
- The Mini App is served under `/app/` with immutable hashed assets and `no-store` `index.html` (spec §4.4, plan 03).
- Licence allow-list (spec §12): MIT, BSD, Apache-2.0, MPL-2.0, Unlicense, GPL-3.0-or-later — plus the permissive licences that appear in the lockfile and are compatible with GPL-3.0-or-later (ISC, 0BSD, BlueOak-1.0.0, CC0-1.0); the vendored cburnett set is CC BY-SA 3.0 (plan 03 ruling) and is documented, not a package.
- Bundle budget (spec §6.5) is enforced in CI with plan 04's script.
- CI on pull requests: lint, format, typecheck, unit and integration tests on a PostgreSQL service, the app build, bundle and licence gates, `pnpm audit`; on `main`: end-to-end and the Docker build; on tags: the image (spec §16).
- The BotFather checklist (spec §5.1) is documented; the parts the server can do itself (webhook and `allowed_updates` from plan 03, commands per scope here) are done at boot.

## Review Focus

1. The Docker image must start with only environment variables and serve both the API and the Mini App → Task 1 (Dockerfile), verified by the `docker` job in Task 2 (this environment has no Docker daemon, so the build is proven by CI).
2. `setMyCommands` must register exactly the three group commands and the one private command, with no default-scope commands, so the group menu stays at three entries → Task 1, test "registers the commands per scope at boot".
3. A dependency outside the licence allow-list must fail CI → Task 1, the negative run of `scripts/check-licences.mjs`.
4. The end-to-end job must run against a PostgreSQL service with the same harness developers use → Task 2 (`e2e.yml`).
5. An operator following the README must be able to configure BotFather, deploy, verify SSE through the proxy and know which alerts to set → Task 3.

---

### Task 1: Production runtime, command registration, Docker image and the licence gate

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `scripts/check-licences.mjs`
- Modify: `apps/server/package.json` (`tsx` to `dependencies`), `package.json` (root scripts), `apps/server/src/main.ts` (`setMyCommands`), `packages/shared/src/i18n/en.ts` (command descriptions), `apps/server/test/integration/main.test.ts`
- Test: `apps/server/test/integration/main.test.ts` ("registers the commands per scope at boot"), `node scripts/check-licences.mjs` (positive and negative runs)

**Interfaces:**
- Consumes: plan 03 `startServer`, `ALLOWED_UPDATES`, `FakeTelegram` (answers `setMyCommands` with `ok(true)` by default); plan 04 `scripts/check-bundle-size.mjs`.
- Produces: `BOT_COMMANDS` in `main.ts` (`{ group: [...], private: [...] }`), catalog keys `command.play.description`, `command.chess.description`, `command.settings.description`, `command.start.description`; root scripts `build`, `dev:server`, `dev:app`, `e2e`, `check:budget`, `check:licences`; the image `group-chess` listening on `PORT` (3000) with `MINI_APP_DIR` preset.

**Rulings recorded in this task:**
- The server runs under `tsx` in production (transpile on start, no type check) instead of a `tsc` build: the shared package ships TypeScript sources through its `exports`, and an alpha gains nothing from a second build graph. Cost if wrong: a `tsc -b` emit for `shared` and `server` plus `main` fields, about an hour.
- The runtime image installs production dependencies with `pnpm install --prod --filter "@group-chess/server..."` from the lockfile rather than `pnpm deploy`, whose semantics changed in pnpm 10. Cost if wrong: a few megabytes of image size.
- This environment has no Docker daemon, so the Dockerfile is verified by CI's `docker` job on `main` (Task 2), not locally. Cost if wrong: one CI round trip.

- [ ] **Step 1: Write the failing test for command registration**

In `apps/server/test/integration/main.test.ts` add inside `describe('startServer')`:

```ts
  it('registers the commands per scope at boot', () => {
    const calls = fake.callsTo('setMyCommands');
    expect(calls).toHaveLength(2);
    const byScope = Object.fromEntries(
      calls.map((call) => [
        (call.body.scope as { type: string }).type,
        (call.body.commands as { command: string }[]).map((c) => c.command),
      ]),
    );
    expect(byScope).toEqual({
      all_group_chats: ['play', 'chess', 'settings'],
      all_private_chats: ['start'],
    });
  });
```

Run: `pnpm vitest run --project server apps/server/test/integration/main.test.ts`
Expected: FAIL — `expected [] to have a length of 2`.

- [ ] **Step 2: Register the commands at boot**

In `packages/shared/src/i18n/en.ts` add after `'dm.start'`'s entry:

```ts
  'command.play.description': 'Challenge someone: reply to their message',
  'command.chess.description': 'Open the chess lobby',
  'command.settings.description': 'Group chess settings (admins)',
  'command.start.description': 'Allow move notifications',
```

In `apps/server/src/main.ts` add after the `ALLOWED_UPDATES` constant:

```ts
/** Spec §5.1 step 3: three group commands, one private command, nothing in the default scope. */
export const BOT_COMMANDS = {
  group: [
    { command: 'play', description: t('command.play.description') },
    { command: 'chess', description: t('command.chess.description') },
    { command: 'settings', description: t('command.settings.description') },
  ],
  private: [{ command: 'start', description: t('command.start.description') }],
} as const;
```

add `import { t } from '@group-chess/shared';` to the imports, and inside `if (bot) {` before the polling/webhook branch:

```ts
    await api.setMyCommands(BOT_COMMANDS.group, { scope: { type: 'all_group_chats' } });
    await api.setMyCommands(BOT_COMMANDS.private, { scope: { type: 'all_private_chats' } });
```

Run: `pnpm vitest run --project server apps/server/test/integration/main.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 3: Runtime dependency, root scripts and the licence gate**

In `apps/server/package.json` move `"tsx": "^4.23.0"` from `devDependencies` to `dependencies` (keep `drizzle-kit` in `devDependencies`; delete the `devDependencies` key only if it becomes empty — it does not).

In the root `package.json` `scripts` add:

```json
    "build": "pnpm --filter @group-chess/miniapp build",
    "dev:server": "pnpm --filter @group-chess/server dev",
    "dev:app": "pnpm --filter @group-chess/miniapp dev",
    "e2e": "pnpm --filter @group-chess/miniapp e2e",
    "check:budget": "node scripts/check-bundle-size.mjs",
    "check:licences": "node scripts/check-licences.mjs",
```

`scripts/check-licences.mjs`:

```js
#!/usr/bin/env node
// Spec §12: every dependency must carry a licence from the allow-list (all compatible with the
// repository's GPL-3.0-or-later). Reads `pnpm licenses list --json`; exits 1 on any other licence.
import { execFileSync } from 'node:child_process';

const DEFAULT_ALLOWED = [
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'Apache-2.0',
  'MPL-2.0',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'GPL-3.0-or-later',
];
const allowed = new Set((process.env.LICENCE_ALLOW ?? DEFAULT_ALLOWED.join(',')).split(',').map((s) => s.trim()));

/** True when a licence expression is satisfied by the allow-list: any OR alternative, every AND part. */
export function permitted(expression) {
  const text = expression.replace(/^\(|\)$/g, '').trim();
  if (text.includes(' OR ')) return text.split(' OR ').some((part) => permitted(part));
  if (text.includes(' AND ')) return text.split(' AND ').every((part) => permitted(part));
  return allowed.has(text);
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const byLicence = JSON.parse(raw);
const offenders = [];
let total = 0;
for (const [licence, packages] of Object.entries(byLicence)) {
  total += packages.length;
  if (permitted(licence)) continue;
  for (const pkg of packages) offenders.push(`${pkg.name}@${pkg.versions.join(',')} (${licence})`);
}
console.log(`${total} packages, ${Object.keys(byLicence).length} licence expressions, allow-list: ${[...allowed].join(', ')}`);
if (offenders.length > 0) {
  console.error('Licences outside the allow-list:');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log('All dependency licences are allowed.');
```

Run: `pnpm install && node scripts/check-licences.mjs && (LICENCE_ALLOW=MIT node scripts/check-licences.mjs; test $? -eq 1 && echo "negative run fails as intended")`
Expected: the first run prints the package count and "All dependency licences are allowed."; the negative run lists the non-MIT packages and the shell prints "negative run fails as intended".

- [ ] **Step 4: The image and the local stack**

`.dockerignore`:

```
.git
.github
.superpowers
node_modules
**/node_modules
**/dist
**/test-results
**/playwright-report
**/*.tsbuildinfo
docs
scripts/local-postgres.sh
.env
.env.*
```

`Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
# Spec §4.4: multi-stage — build the Mini App, then a runtime image with the server and the bundle.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/miniapp/package.json apps/miniapp/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm --filter @group-chess/miniapp build && node scripts/check-bundle-size.mjs

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@group-chess/server..." \
    && chown -R node:node /app
COPY --from=build --chown=node:node /app/apps/miniapp/dist ./apps/miniapp/dist
ENV MINI_APP_DIR=/app/apps/miniapp/dist
ENV PORT=3000
EXPOSE 3000
USER node
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
```

`docker-compose.yml` (local development stack, not production):

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: group_chess
    ports:
      - '5432:5432'
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      timeout: 5s
      retries: 10

  app:
    build: .
    env_file: .env
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/group_chess
      PORT: '3000'
    ports:
      - '3000:3000'
    depends_on:
      db:
        condition: service_healthy

volumes:
  db-data:
```

Run: `pnpm prettier --check docker-compose.yml && grep -c 'FROM' Dockerfile`
Expected: Prettier accepts the compose file; `grep` prints `3` (three stages).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(delivery): add the production runtime, command registration, Docker image and licence gate"
```

---

### Task 2: CI gates, the end-to-end workflow, the release workflow and Dependabot

**Files:**
- Create: `.github/workflows/e2e.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`
- Modify: `.github/workflows/ci.yml`
- Test: `pnpm prettier --check .github` (YAML parses); the workflows run on GitHub.

**Interfaces:**
- Consumes: Task 1 scripts and the Dockerfile; plan 04's `apps/miniapp` e2e script and harness.
- Produces: workflow `CI` (pull requests and `main`): check job with lint, format, typecheck, tests, app build, bundle budget, licences, audit; workflow `End-to-end` (`main`, manual): Playwright against the harness on a PostgreSQL service plus a Docker build; workflow `Release` (tags `v*`): image at `ghcr.io/<owner>/<repo>` tagged with the version and the commit; weekly Dependabot for npm and GitHub Actions.

- [ ] **Step 1: Extend the CI workflow**

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: group_chess_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/group_chess_test
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - run: pnpm check:budget
      - run: pnpm check:licences
      - run: pnpm audit --prod --audit-level=high
```

- [ ] **Step 2: The end-to-end and Docker workflow**

`.github/workflows/e2e.yml`:

```yaml
name: End-to-end

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  playwright:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: group_chess_e2e
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/group_chess_e2e
      CI: '1'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @group-chess/miniapp exec playwright install --with-deps chromium
      - run: pnpm e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: |
            apps/miniapp/playwright-report
            apps/miniapp/test-results
          retention-days: 7

  docker:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          tags: group-chess:ci
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 3: The release workflow and Dependabot**

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  packages: write

jobs:
  image:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=sha
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  staging:
    # Spec §16: tags deploy staging; production is a manual promotion. The hook URL is a repository
    # secret; when it is absent this job is skipped and the image is still published.
    needs: image
    if: ${{ vars.STAGING_DEPLOY_HOOK_ENABLED == 'true' }}
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - env:
          HOOK: ${{ secrets.STAGING_DEPLOY_HOOK }}
        run: |
          curl --fail --silent --show-error -X POST "$HOOK" \
            -H 'Content-Type: application/json' \
            -d "{\"tag\":\"${GITHUB_REF_NAME}\"}"
```

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      minor-and-patch:
        update-types: ['minor', 'patch']
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: docker
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 4: Verify the YAML parses and the referenced scripts exist**

Run: `pnpm prettier --check .github && pnpm check:licences && pnpm check:budget`
Expected: Prettier accepts all four YAML files; both scripts exit 0 (the app is built from Task 1's verification; rebuild with `pnpm build` first if `apps/miniapp/dist` is missing).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "ci: add build, budget and licence gates, the end-to-end and Docker workflow, the release workflow and Dependabot"
```

---

### Task 3: README, deployment checklist and operations runbook

**Files:**
- Create: `README.md`, `docs/operations.md`
- Modify: `.env.example` (group the optional block under a heading; no value changes)
- Test: `pnpm format:check` (Markdown formatting), a link check by eye — every path named in the README exists (`ls` the list in Step 3).

**Interfaces:**
- Consumes: everything above.
- Produces: the operator-facing documents.

- [ ] **Step 1: The README**

`README.md`:

```markdown
# Group Chess

A Telegram bot and Mini App for playing correspondence chess inside group chats. People challenge each other with `/play` or from the app, play on a real board inside Telegram (drag and drop or tap-tap), and the group sees only cards, results and shared positions. Rules and clocks are enforced on the server; every finished game gets a Lichess analysis link.

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Technical design: [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](docs/superpowers/specs/2026-09-20-group-chess-technical-design.md)
- Implementation plans: [docs/superpowers/plans/2026-09-20-group-chess.md](docs/superpowers/plans/2026-09-20-group-chess.md)
- Deploying and running it: [docs/operations.md](docs/operations.md)

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | Rules (chess.js + arbiter), Glicko-2, PGN, the zod protocol, the English message catalog |
| `apps/server` | One Node process with four roles (`api`, `bot`, `jobs`, `clock`): grammY bot, Hono API with SSE, Drizzle on PostgreSQL 16, a table-backed job outbox and clock scanners |
| `apps/miniapp` | The Preact + chessground Mini App, built with Vite and served by the server under `/app/` |
| `scripts` | Local PostgreSQL, piece vendoring, bundle-budget and licence gates |

## Requirements

- Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`)
- PostgreSQL 16 for integration and end-to-end tests (`scripts/local-postgres.sh start` runs one on port 54329 when `initdb` is available, or use Docker: `docker compose up db`)
- A Telegram bot token from BotFather for a real deployment

## Quick start

```bash
pnpm install
cp .env.example .env            # fill in BOT_TOKEN, BOT_USERNAME, MINI_APP_SHORT_NAME, PUBLIC_URL, secrets
scripts/local-postgres.sh start  # or: docker compose up -d db
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess
pnpm dev:server                  # migrations run at boot; the bot long-polls when TELEGRAM_POLLING=true
pnpm dev:app                     # Vite on :5173, proxying /api to :3000
```

Telegram must load the Mini App over public HTTPS: point BotFather's app URL at a tunnel (for example cloudflared) that forwards to the Vite dev server or to the server with `MINI_APP_DIR=apps/miniapp/dist` after `pnpm build`.

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess_test
pnpm test                        # unit + integration (PostgreSQL); without TEST_DATABASE_URL only unit tests run
pnpm build && pnpm check:budget  # Mini App bundle inside the §6.5 budget
pnpm check:licences              # every dependency inside the licence allow-list
pnpm e2e                         # builds the app and runs Playwright against the real server + a fake Bot API
```

The end-to-end suite needs Chromium: `pnpm --filter @group-chess/miniapp exec playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_PATH` at an existing binary.

## Configuration

Everything is an environment variable, validated at boot (`apps/server/src/config.ts`).

| Variable | Required | Meaning |
|---|---|---|
| `BOT_TOKEN` | yes | From BotFather |
| `BOT_USERNAME` | yes | Without `@`; used in direct links |
| `MINI_APP_SHORT_NAME` | yes | The `/newapp` short name; links are `https://t.me/<BOT_USERNAME>/<MINI_APP_SHORT_NAME>?startapp=…` |
| `PUBLIC_URL` | yes | HTTPS origin of this server; the webhook is `<PUBLIC_URL>/telegram/webhook`, the app `<PUBLIC_URL>/app/` |
| `WEBHOOK_SECRET` | yes | ≥ 16 characters; sent by Telegram as `X-Telegram-Bot-Api-Secret-Token` |
| `DATABASE_URL` | yes | PostgreSQL 16 |
| `SESSION_SECRET` | yes | ≥ 32 characters; signs the Mini App session tokens (rotating it logs everyone out) |
| `LICHESS_TOKEN` | no | Raises the import quota from 100 to 200 per hour |
| `ROLES` | no | `api,bot,jobs,clock` (default all) |
| `LOG_LEVEL` | no | `info` |
| `PORT` | no | `3000` |
| `TELEGRAM_POLLING` | no | `true` for long polling in development (no public URL needed for the bot) |
| `TELEGRAM_API_ROOT` | no | A local Bot API server or a test fake |
| `LICHESS_API_URL` | no | `https://lichess.org` |
| `MINI_APP_DIR` | no | Directory of the built Mini App to serve under `/app/` (the Docker image presets it) |

## Deployment in one paragraph

Build the image (`docker build -t group-chess .` or take `ghcr.io/<owner>/<repo>:<version>` from a release), run it with the variables above and a PostgreSQL 16 database, put an HTTPS reverse proxy in front that does not buffer `/api/games/*/events`, register the Mini App in BotFather with `<PUBLIC_URL>/app/`, and open the bot. Migrations, the webhook and the command menu are set up by the server at boot. The full checklist, the metrics and the alerts are in [docs/operations.md](docs/operations.md).

## Licence

GPL-3.0-or-later (see `LICENSE`): the board is [chessground](https://github.com/lichess-org/chessground). The chess piece glyphs are the cburnett set by Colin M.L. Burnett, CC BY-SA 3.0 (`apps/server/src/images/ATTRIBUTION.md`). Every dependency is checked against the allow-list in `scripts/check-licences.mjs`.
```

- [ ] **Step 2: The operations document**

`docs/operations.md`:

```markdown
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
- Reverse proxy: HTTPS only; forward `/telegram/webhook`, `/api/*`, `/app/*`, `/healthz`, `/readyz`. Disable response buffering for `/api/games/*/events` (the server sends `X-Accel-Buffering: no`, `Cache-Control: no-store` and a `ping` every 20 s). Redact the query string of that route in access logs (it carries the session token). Optionally restrict `/telegram/webhook` to Telegram's published address ranges.
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
| `move_latency_seconds`, `sse_streams`, `sse_reconnects_total`, `game_opens_total{role}`, `games_started_total`, `games_finished_total{end_reason}`, `shares_total`, `active_groups` | Dashboards |

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
```

- [ ] **Step 3: Tidy the environment example and check the links**

In `.env.example` replace the line `# Optional (plan 03):` with `# Optional:`.

Run:

```bash
pnpm format:check
for p in docs/PRD.md docs/superpowers/specs/2026-09-20-group-chess-technical-design.md docs/superpowers/plans/2026-09-20-group-chess.md docs/operations.md apps/server/src/config.ts apps/server/src/images/ATTRIBUTION.md scripts/check-licences.mjs scripts/local-postgres.sh LICENSE; do test -e "$p" && echo "ok $p" || echo "MISSING $p"; done
```

Expected: Prettier passes; every path prints `ok`.

- [ ] **Step 4: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: add the README and the deployment and operations guide"
```

---

## Self-review

**Spec coverage (plan 05 scope).** §4.4 Docker image, `/app/` serving, migrations at boot → Task 1 (Dockerfile) and the operations doc. §5.1 BotFather checklist → Task 1 (`setMyCommands`) and Task 3. §11 SSE proxy checklist item, backups, restore drill → Task 3. §12 supply chain (lockfile, Dependabot, audit, licence allow-list) → Tasks 1 and 2. §14 metrics and alerts → Task 3 table. §16 CI on pull requests, `main` and tags → Task 2. PRD §13 alpha exit criteria → the runbook's metrics.

**Placeholder scan.** Every file is given in full; the only edit-style steps name the exact lines to change. The staging deploy is a documented hook behind a repository variable, not a placeholder.

**Type consistency across tasks.** The root scripts named in Task 1 are the ones CI (Task 2) and the README (Task 3) call. The image's `MINI_APP_DIR` matches plan 03's static handler. `setMyCommands` uses grammY's `BotCommand` shape and the fake answers it with `ok(true)` (plan 03 fake).

**Known limits carried forward.** The Docker build is verified in CI only (no daemon here). Lighthouse against staging (spec §6.5) needs a staging URL and is left to the operator's first deploy. The `pnpm audit` gate can turn red on a new advisory unrelated to a change; that is the intended behaviour of a supply-chain gate.
