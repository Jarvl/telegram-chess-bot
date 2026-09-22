# Group Chess 01 — Foundation and Shared Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm/TypeScript workspace with its toolchain and CI skeleton, and deliver `packages/shared`: the protocol (ids, link payload codecs, error codes, DTO and request schemas), the chess arbiter, PGN and Lichess links, clock math, Glicko-2 with rating replay, and the English message catalog.

**Architecture:** `packages/shared` is a pure TypeScript library consumed as source (`exports` points at `src/index.ts`) by the server (Node) and the Mini App (Vite), so it uses no Node-only API. Modules are split by responsibility: `protocol/*` (zod schemas and codecs), `chess/*` (arbiter on chess.js, PGN), `clock.ts`, `rating/*` (Glicko-2 core and replay), `i18n/*` (catalog and label helpers). Everything is a pure function; the server owns all state.

**Tech Stack:** pnpm 10 workspaces, TypeScript 5.9 strict with `moduleResolution: bundler` and `verbatimModuleSyntax`, vitest 5 with `test.projects`, ESLint 10 flat config with typescript-eslint, Prettier 3, chess.js 1.4.0, zod 4.

**Spec:** [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](../specs/2026-09-20-group-chess-technical-design.md); parent plan [2026-09-20-group-chess.md](2026-09-20-group-chess.md).

## Global Constraints

- TypeScript `strict` plus `noUncheckedIndexedAccess`; Node 22 LTS pinned by `.nvmrc`; pnpm workspaces; ESLint and Prettier clean; vitest (spec D1, §16).
- `packages/shared` must run unchanged in Node and in the browser: no `node:*` imports, no `Buffer`, no `process` (spec §4.2: the same arbiter and codecs run on both sides).
- chess.js pinned to exactly `1.4.0` (spec Appendix A verified its behaviour); zod 4.
- Public ids match `^[A-Za-z0-9]{10}$` (spec §5.3, §12). Internal user ids travel through the API as decimal strings.
- Start payload forms `g_<gameId>`, `l_<groupId>`, `s_<groupId>`; callback data forms `ch/acc/<challengeId>`, `ch/dec/<challengeId>`, `gm/rem/<gameId>`, at most 64 bytes (spec §5.3).
- UCI regex `^[a-h][1-8][a-h][1-8][qrbn]?$`; a promotion move without a piece is illegal (spec §7.2, §12).
- Error codes exactly: `unauthorized`, `forbidden`, `not_found`, `stale_state`, `not_your_turn`, `illegal_move`, `expired`, `limit_exceeded`, `rate_limited`, `validation`; body `{ "error": { "code", "message" } }` (spec §9).
- Time per move ∈ {3600, 28800, 86400, 259200, 604800} ∪ {null}; reminder at `deadline − 0.1·T` only when `T ≥ 28800` and DMs are allowed (spec §7.3).
- Arbiter order: checkmate → stalemate → insufficient material → fivefold repetition (≥ 5 occurrences counting the initial position and every `fenAfter`) → 75-move rule (halfmove ≥ 150) → continue with claims `{ threefold: ≥ 3, fiftyMove: halfmove ≥ 100 }`. Position key = first four FEN fields. Never call chess.js `isGameOver()` or `isDraw()` (spec §7.2).
- Timeout with an opponent who cannot mate is a draw (FIDE 6.9; spec §18 item 5 recommends the draw over the PRD's loss).
- Glicko-2 constants: 1500 / 350 / 0.06, τ 0.5, ε 0.000001, RD floor 45, ceiling 350, provisional above 110, scale 173.7178; inactivity `φ² ← min(φ² + d·σ², (350 / 173.7178)²)`; the paper's vector must yield 1464.06 / 151.52 / 0.05999 (spec §7.5).
- PGN tags: `Event "Group Chess"`, `Site`, `Date` (UTC, `YYYY.MM.DD`), `White`, `Black`, `Result`, `WhiteElo`/`BlackElo` only for rated games, `TimeControl "-"`, `TimePerMove` seconds, `Termination` from `end_reason`; analysis fallback `https://lichess.org/analysis/pgn/` + SAN joined by `_`, URL-encoded (spec §7.6).
- Copy: short, chess-literate, SAN, `1-0`, `½-½`; emoji only as button icons (♟ 🔁 🔍); strings externalised, English only (PRD §8.4).
- Licence allow-list for dependencies: MIT, BSD, Apache-2.0, MPL-2.0, Unlicense, GPL-3.0-or-later (spec §12).

## Review Focus

1. A move sent with a stray promotion suffix on a non-promotion move (`e2e4q`) must be stored as `e2e4`, never as typed, or replays and PGN diverge from the board → Task 4, test "normalises a promotion suffix on a non-promotion move".
2. A checkmating move that also reaches the 75-move limit must count as checkmate; automatic-draw rules never override mate → Task 4, test "lets checkmate win over the 75-move rule".
3. A player name containing quotes or backslashes must not corrupt the PGN or the Lichess import → Task 5, test "escapes quotes and backslashes in tag values".
4. Rating maths must stay finite for a 350-RD newcomer beating a far stronger player and must never leave the RD bounds 45–350 → Task 7, tests "stays finite for an extreme rating gap", "never drops the deviation below the floor", "never inflates the deviation above the ceiling".
5. A deadline already in the past must format as zero, never as a negative duration → Task 6, tests "formats a passed deadline as zero" (both formatters).

---

### Task 1: Workspace scaffold and public id schema

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.gitignore`, `.editorconfig`, `.prettierrc.json`, `.prettierignore`, `eslint.config.js`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`, `packages/shared/src/index.ts`, `packages/shared/src/protocol/ids.ts`
- Test: `packages/shared/test/protocol/ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: root scripts `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`; package `@group-chess/shared` importable from workspace packages; `PUBLIC_ID_PATTERN: RegExp`, `PublicIdSchema: ZodString`, `type PublicId = string`, `isPublicId(value: unknown): value is PublicId`, `UserIdSchema: ZodString`, `type UserId = string`.

- [ ] **Step 1: Write the root workspace files**

`package.json`:

```json
{
  "name": "group-chess",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=22.12"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^10.0.0",
    "@types/node": "^22.20.0",
    "eslint": "^10.11.0",
    "prettier": "^3.9.8",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.70.0",
    "vite": "^8.3.0",
    "vitest": "^5.0.1"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`.nvmrc`:

```
22
```

`.gitignore`:

```
node_modules/
dist/
coverage/
*.tsbuildinfo
*.log
.env
.env.*
!.env.example
.superpowers/
.DS_Store
test-results/
playwright-report/
```

`.editorconfig`:

```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.prettierrc.json`:

```json
{
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

`.prettierignore`:

```
node_modules
dist
coverage
pnpm-lock.yaml
.superpowers
docs
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/dist/**', '**/node_modules/**', '**/coverage/**', '.superpowers/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
  },
]);
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  }
}
```

`tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "packages/shared" }]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
```

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
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
```

- [ ] **Step 2: Write the shared package manifest and configs**

`packages/shared/package.json`:

```json
{
  "name": "@group-chess/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "chess.js": "1.4.0",
    "zod": "^4.6.5"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "lib": ["ES2022"],
    "types": []
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared',
    include: ['test/**/*.test.ts'],
  },
});
```

`packages/shared/src/index.ts` (grows with every task):

```ts
export * from './protocol/ids';
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: exit 0, `pnpm-lock.yaml` created at the root, `node_modules/.pnpm` contains `chess.js@1.4.0` and `vitest@5.x`.

- [ ] **Step 4: Write the failing test**

`packages/shared/test/protocol/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PublicIdSchema, UserIdSchema, isPublicId } from '../../src/protocol/ids';

describe('PublicIdSchema', () => {
  it('accepts ten base62 characters', () => {
    expect(PublicIdSchema.safeParse('aZ09bY18cX').success).toBe(true);
  });

  it.each([
    ['nine characters', 'aZ09bY18c'],
    ['eleven characters', 'aZ09bY18cX1'],
    ['a dash', 'aZ09bY18c-'],
    ['a slash', 'aZ09bY18c/'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(PublicIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('isPublicId', () => {
  it('narrows only strings of the right shape', () => {
    expect(isPublicId('aZ09bY18cX')).toBe(true);
    expect(isPublicId(1234567890)).toBe(false);
    expect(isPublicId('aZ09bY18c_')).toBe(false);
  });
});

describe('UserIdSchema', () => {
  it('accepts a decimal id without leading zeros', () => {
    expect(UserIdSchema.safeParse('42').success).toBe(true);
    expect(UserIdSchema.safeParse('9007199254740993').success).toBe(true);
  });

  it.each([
    ['zero', '0'],
    ['a leading zero', '042'],
    ['a negative number', '-1'],
    ['letters', '4a2'],
    ['twenty digits', '12345678901234567890'],
  ])('rejects %s', (_label, value) => {
    expect(UserIdSchema.safeParse(value).success).toBe(false);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/test/protocol/ids.test.ts`
Expected: FAIL — the file cannot be loaded because `../../src/protocol/ids` does not exist.

- [ ] **Step 6: Write the implementation**

`packages/shared/src/protocol/ids.ts`:

```ts
import { z } from 'zod';

/** Public identifier of a game, group or challenge: ten base62 characters (spec §5.3, §12). */
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

export const PublicIdSchema = z.string().regex(PUBLIC_ID_PATTERN);

export type PublicId = z.infer<typeof PublicIdSchema>;

export function isPublicId(value: unknown): value is PublicId {
  return typeof value === 'string' && PUBLIC_ID_PATTERN.test(value);
}

/** Internal user ids travel through the API as decimal strings without leading zeros. */
export const UserIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);

export type UserId = z.infer<typeof UserIdSchema>;
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/test/protocol/ids.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 8: Verify the toolchain end to end**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: each command exits 0; `pnpm test` reports 13 passed in project `shared`. If `pnpm format:check` lists files, run `pnpm format` once and re-run the check.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace, toolchain and shared package with public id schema"
```

---

### Task 2: Enumerations, error codes and the link payload codecs

**Files:**
- Create: `packages/shared/src/protocol/enums.ts`, `packages/shared/src/protocol/errors.ts`, `packages/shared/src/protocol/startParam.ts`, `packages/shared/src/protocol/callbackData.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/protocol/enums.test.ts`, `packages/shared/test/protocol/errors.test.ts`, `packages/shared/test/protocol/startParam.test.ts`, `packages/shared/test/protocol/callbackData.test.ts`

**Interfaces:**
- Consumes: `PublicId` (Task 1).
- Produces: `TIME_PER_MOVE_OPTIONS`, `TimePerMoveSchema`, `type TimePerMove = 3600 | 28800 | 86400 | 259200 | 604800 | null`, `type TimePerMoveSeconds`, `ColourSchema`, `type Colour = 'white' | 'black'`, `opposite(colour: Colour): Colour`, `ColourChoiceSchema`, `type ColourChoice = Colour | 'random'`, `GameStatusSchema`, `type GameStatus`, `GameResultSchema`, `type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*'`, `EndReasonSchema`, `type EndReason`, `isRatedEndReason(reason: EndReason): boolean`, `ChallengeStatusSchema`, `type ChallengeStatus`, `ViewerRoleSchema`, `type ViewerRole`; `ERROR_CODES`, `ErrorCodeSchema`, `type ErrorCode`, `ApiErrorBodySchema`, `type ApiErrorBody`, `HTTP_STATUS_BY_ERROR_CODE: Record<ErrorCode, number>`, `apiErrorBody(code, message): ApiErrorBody`; `type StartParam`, `encodeStartParam(param): string`, `decodeStartParam(raw): StartParam | null`; `type CallbackData`, `encodeCallbackData(data): string`, `decodeCallbackData(raw): CallbackData | null`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/protocol/enums.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TimePerMoveSchema, isRatedEndReason, opposite } from '../../src/protocol/enums';

describe('TimePerMoveSchema', () => {
  it.each([3600, 28800, 86400, 259200, 604800, null])('accepts %s', (value) => {
    expect(TimePerMoveSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, 7200, 86400.5, '86400', undefined])('rejects %s', (value) => {
    expect(TimePerMoveSchema.safeParse(value).success).toBe(false);
  });
});

describe('opposite', () => {
  it('flips the colour', () => {
    expect(opposite('white')).toBe('black');
    expect(opposite('black')).toBe('white');
  });
});

describe('isRatedEndReason', () => {
  it.each([
    'checkmate',
    'stalemate',
    'insufficient_material',
    'fivefold_repetition',
    'seventy_five_moves',
    'threefold_claim',
    'fifty_move_claim',
    'draw_agreement',
    'resignation',
    'timeout',
  ] as const)('%s changes ratings', (reason) => {
    expect(isRatedEndReason(reason)).toBe(true);
  });

  it.each(['timeout_abort', 'abort', 'voided'] as const)('%s leaves ratings alone', (reason) => {
    expect(isRatedEndReason(reason)).toBe(false);
  });
});
```

`packages/shared/test/protocol/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  HTTP_STATUS_BY_ERROR_CODE,
  apiErrorBody,
} from '../../src/protocol/errors';

describe('ApiErrorBodySchema', () => {
  it('parses a body produced by apiErrorBody', () => {
    expect(ApiErrorBodySchema.parse(apiErrorBody('stale_state', 'expected ply 12'))).toEqual({
      error: { code: 'stale_state', message: 'expected ply 12' },
    });
  });

  it('rejects unknown codes', () => {
    expect(ApiErrorBodySchema.safeParse({ error: { code: 'teapot', message: '' } }).success).toBe(
      false,
    );
  });
});

describe('HTTP_STATUS_BY_ERROR_CODE', () => {
  it.each([
    ['stale_state', 409],
    ['not_your_turn', 409],
    ['expired', 409],
    ['illegal_move', 422],
    ['rate_limited', 429],
    ['unauthorized', 401],
    ['validation', 400],
  ] as const)('%s maps to %d', (code, status) => {
    expect(HTTP_STATUS_BY_ERROR_CODE[code]).toBe(status);
  });
});
```

`packages/shared/test/protocol/startParam.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeStartParam,
  encodeStartParam,
  type StartParam,
} from '../../src/protocol/startParam';

describe('start param codec', () => {
  it('encodes a game link payload', () => {
    expect(encodeStartParam({ kind: 'game', gameId: 'aZ09bY18cX' })).toBe('g_aZ09bY18cX');
  });

  it('encodes lobby and settings payloads', () => {
    expect(encodeStartParam({ kind: 'lobby', groupId: 'aZ09bY18cX' })).toBe('l_aZ09bY18cX');
    expect(encodeStartParam({ kind: 'settings', groupId: 'aZ09bY18cX' })).toBe('s_aZ09bY18cX');
  });

  it('decodes what it encodes', () => {
    const params: StartParam[] = [
      { kind: 'game', gameId: 'aZ09bY18cX' },
      { kind: 'lobby', groupId: 'grp0000001' },
      { kind: 'settings', groupId: 'grp0000001' },
    ];
    for (const param of params) {
      expect(decodeStartParam(encodeStartParam(param))).toEqual(param);
    }
  });

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['an unknown prefix', 'x_aZ09bY18cX'],
    ['an upper-case prefix', 'G_aZ09bY18cX'],
    ['a short id', 'g_aZ09bY18c'],
    ['a long id', 'g_aZ09bY18cXX'],
    ['path characters', 'g_../../etc'],
    ['a missing underscore', 'gaZ09bY18cX'],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeStartParam(raw)).toBeNull();
  });
});
```

`packages/shared/test/protocol/callbackData.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeCallbackData,
  encodeCallbackData,
  type CallbackData,
} from '../../src/protocol/callbackData';

describe('callback data codec', () => {
  it('encodes the three card actions', () => {
    expect(encodeCallbackData({ action: 'accept_challenge', challengeId: 'aZ09bY18cX' })).toBe(
      'ch/acc/aZ09bY18cX',
    );
    expect(encodeCallbackData({ action: 'decline_challenge', challengeId: 'aZ09bY18cX' })).toBe(
      'ch/dec/aZ09bY18cX',
    );
    expect(encodeCallbackData({ action: 'rematch', gameId: 'aZ09bY18cX' })).toBe(
      'gm/rem/aZ09bY18cX',
    );
  });

  it('stays within Telegram’s 64-byte limit', () => {
    const encoded = encodeCallbackData({ action: 'decline_challenge', challengeId: 'aZ09bY18cX' });
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(64);
  });

  it('decodes what it encodes', () => {
    const all: CallbackData[] = [
      { action: 'accept_challenge', challengeId: 'aZ09bY18cX' },
      { action: 'decline_challenge', challengeId: 'aZ09bY18cX' },
      { action: 'rematch', gameId: 'aZ09bY18cX' },
    ];
    for (const data of all) {
      expect(decodeCallbackData(encodeCallbackData(data))).toEqual(data);
    }
  });

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['an unknown action', 'ch/xyz/aZ09bY18cX'],
    ['a short id', 'gm/rem/aZ09bY18c'],
    ['trailing data', 'gm/rem/aZ09bY18cX/extra'],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeCallbackData(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/shared/test/protocol`
Expected: FAIL — four new files cannot load their modules under `src/protocol/`; `ids.test.ts` still passes.

- [ ] **Step 3: Write the implementations**

`packages/shared/src/protocol/enums.ts`:

```ts
import { z } from 'zod';

/** Time per move in seconds (PRD §7.2). `null` means the game has no clock. */
export const TIME_PER_MOVE_OPTIONS = [3600, 28800, 86400, 259200, 604800] as const;

export type TimePerMoveSeconds = (typeof TIME_PER_MOVE_OPTIONS)[number];

export const TimePerMoveSchema = z.union([
  z.literal(3600),
  z.literal(28800),
  z.literal(86400),
  z.literal(259200),
  z.literal(604800),
  z.null(),
]);

export type TimePerMove = z.infer<typeof TimePerMoveSchema>;

export const ColourSchema = z.enum(['white', 'black']);

export type Colour = z.infer<typeof ColourSchema>;

export function opposite(colour: Colour): Colour {
  return colour === 'white' ? 'black' : 'white';
}

/** The colour a challenger asks for; `random` is settled by a coin flip on accept. */
export const ColourChoiceSchema = z.enum(['white', 'black', 'random']);

export type ColourChoice = z.infer<typeof ColourChoiceSchema>;

export const GameStatusSchema = z.enum(['active', 'finished']);

export type GameStatus = z.infer<typeof GameStatusSchema>;

/** PGN result tokens. `*` marks an unfinished, aborted or voided game. */
export const GameResultSchema = z.enum(['1-0', '0-1', '1/2-1/2', '*']);

export type GameResult = z.infer<typeof GameResultSchema>;

export const EndReasonSchema = z.enum([
  'checkmate',
  'stalemate',
  'insufficient_material',
  'fivefold_repetition',
  'seventy_five_moves',
  'threefold_claim',
  'fifty_move_claim',
  'draw_agreement',
  'resignation',
  'timeout',
  'timeout_abort',
  'abort',
  'voided',
]);

export type EndReason = z.infer<typeof EndReasonSchema>;

/** End reasons that change ratings (spec §7.1). Aborts and voids never do. */
const RATED_END_REASONS: ReadonlySet<EndReason> = new Set<EndReason>([
  'checkmate',
  'stalemate',
  'insufficient_material',
  'fivefold_repetition',
  'seventy_five_moves',
  'threefold_claim',
  'fifty_move_claim',
  'draw_agreement',
  'resignation',
  'timeout',
]);

export function isRatedEndReason(reason: EndReason): boolean {
  return RATED_END_REASONS.has(reason);
}

export const ChallengeStatusSchema = z.enum([
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired',
]);

export type ChallengeStatus = z.infer<typeof ChallengeStatusSchema>;

export const ViewerRoleSchema = z.enum(['white', 'black', 'spectator']);

export type ViewerRole = z.infer<typeof ViewerRoleSchema>;
```

`packages/shared/src/protocol/errors.ts`:

```ts
import { z } from 'zod';

export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'stale_state',
  'not_your_turn',
  'illegal_move',
  'expired',
  'limit_exceeded',
  'rate_limited',
  'validation',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** HTTP status per code. The board treats every 409 as "reload the state and snap back" (spec §6.3). */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_state: 409,
  not_your_turn: 409,
  expired: 409,
  limit_exceeded: 409,
  illegal_move: 422,
  rate_limited: 429,
  validation: 400,
};

export function apiErrorBody(code: ErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}
```

`packages/shared/src/protocol/startParam.ts`:

```ts
import type { PublicId } from './ids';

/** What a Mini App direct link opens (spec §5.3). */
export type StartParam =
  | { kind: 'game'; gameId: PublicId }
  | { kind: 'lobby'; groupId: PublicId }
  | { kind: 'settings'; groupId: PublicId };

const START_PARAM_PATTERN = /^([gls])_([A-Za-z0-9]{10})$/;

export function encodeStartParam(param: StartParam): string {
  switch (param.kind) {
    case 'game':
      return `g_${param.gameId}`;
    case 'lobby':
      return `l_${param.groupId}`;
    case 'settings':
      return `s_${param.groupId}`;
  }
}

export function decodeStartParam(raw: string | null | undefined): StartParam | null {
  if (!raw) return null;
  const match = START_PARAM_PATTERN.exec(raw);
  if (!match) return null;
  const prefix = match[1];
  const id = match[2];
  if (!prefix || !id) return null;
  if (prefix === 'g') return { kind: 'game', gameId: id };
  if (prefix === 'l') return { kind: 'lobby', groupId: id };
  return { kind: 'settings', groupId: id };
}
```

`packages/shared/src/protocol/callbackData.ts`:

```ts
import type { PublicId } from './ids';

/** Inline-button callback payloads; everything else on a card is a URL button (spec §5.3). */
export type CallbackData =
  | { action: 'accept_challenge'; challengeId: PublicId }
  | { action: 'decline_challenge'; challengeId: PublicId }
  | { action: 'rematch'; gameId: PublicId };

const CALLBACK_PATTERN = /^(ch\/acc|ch\/dec|gm\/rem)\/([A-Za-z0-9]{10})$/;

export function encodeCallbackData(data: CallbackData): string {
  switch (data.action) {
    case 'accept_challenge':
      return `ch/acc/${data.challengeId}`;
    case 'decline_challenge':
      return `ch/dec/${data.challengeId}`;
    case 'rematch':
      return `gm/rem/${data.gameId}`;
  }
}

export function decodeCallbackData(raw: string | null | undefined): CallbackData | null {
  if (!raw) return null;
  const match = CALLBACK_PATTERN.exec(raw);
  if (!match) return null;
  const verb = match[1];
  const id = match[2];
  if (!verb || !id) return null;
  if (verb === 'ch/acc') return { action: 'accept_challenge', challengeId: id };
  if (verb === 'ch/dec') return { action: 'decline_challenge', challengeId: id };
  return { action: 'rematch', gameId: id };
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './protocol/enums';
export * from './protocol/errors';
export * from './protocol/startParam';
export * from './protocol/callbackData';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/shared/test/protocol`
Expected: PASS — 66 tests across five files (ids 13, enums 25, errors 9, startParam 11, callbackData 8).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add game enumerations, error codes and link payload codecs"
```

---

### Task 3: DTO and request schemas

**Files:**
- Create: `packages/shared/src/protocol/dto.ts`, `packages/shared/src/protocol/requests.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/protocol/dto.test.ts`, `packages/shared/test/protocol/requests.test.ts`

**Interfaces:**
- Consumes: `PublicIdSchema`, `UserIdSchema` (Task 1); `ChallengeStatusSchema`, `ColourChoiceSchema`, `ColourSchema`, `EndReasonSchema`, `GameResultSchema`, `GameStatusSchema`, `TimePerMoveSchema`, `ViewerRoleSchema` (Task 2).
- Produces (all zod schemas with matching `type X = z.infer<…>` exports): `UciSchema`, `IsoDateSchema`, `PlayerRefSchema`, `GamePlayerSchema`, `MoveDtoSchema`, `DrawOfferSchema`, `ClaimsSchema`, `GroupRefSchema`, `GameDtoSchema`, `GameSummarySchema`, `ChallengeDtoSchema`, `WinDrawLossSchema`, `LeaderboardEntrySchema`, `GroupSettingsSchema` + `GROUP_SETTINGS_DEFAULTS`, `FinishedPageDtoSchema`, `LobbyDtoSchema`, `PlayersPickerDtoSchema`, `PlayerPageDtoSchema`, `PrefsSchema` + `PREFS_DEFAULTS`, `MeGroupsDtoSchema`, `GroupSettingsDtoSchema`, `LaunchRouteSchema`, `LaunchResponseSchema`, `OkDtoSchema`; requests `LaunchRequestSchema`, `MoveRequestSchema`, `ChallengeRequestSchema`, `ShareRequestSchema`, `PrefsUpdateRequestSchema`, `GroupSettingsUpdateRequestSchema`, `BlockRequestSchema`, `TelemetryRequestSchema`, `FinishedQuerySchema`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/protocol/dto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GROUP_SETTINGS_DEFAULTS,
  GameDtoSchema,
  GroupSettingsSchema,
  LaunchRouteSchema,
  LeaderboardEntrySchema,
} from '../../src/protocol/dto';

const activeGame = {
  id: 'aZ09bY18cX',
  group: { id: 'grp0000001', title: 'Chess Club' },
  status: 'active',
  white: {
    id: '1',
    name: 'Alice',
    username: 'alice',
    rating: 1520,
    provisional: false,
    ratingAfter: null,
    provisionalAfter: null,
  },
  black: {
    id: '2',
    name: 'Bob',
    username: null,
    rating: 1498,
    provisional: true,
    ratingAfter: null,
    provisionalAfter: null,
  },
  timePerMove: 86400,
  rated: true,
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  plyCount: 1,
  version: 1,
  moves: [
    {
      ply: 1,
      uci: 'e2e4',
      san: 'e4',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      playedAt: '2026-09-20T10:00:00.000Z',
    },
  ],
  deadlineAt: '2026-09-21T10:00:00.000Z',
  serverTime: '2026-09-20T10:00:05.000Z',
  drawOffer: null,
  claims: { threefold: false, fiftyMove: false },
  viewerRole: 'black',
  result: null,
  endReason: null,
  voided: false,
  startedAt: '2026-09-20T09:00:00.000Z',
  finishedAt: null,
};

describe('GameDtoSchema', () => {
  it('parses an active game without changing it', () => {
    expect(GameDtoSchema.parse(activeGame)).toEqual(activeGame);
  });

  it('parses a finished game carrying Lichess links', () => {
    const finished = {
      ...activeGame,
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: '2026-09-20T12:00:00.000Z',
      white: { ...activeGame.white, ratingAfter: 1534, provisionalAfter: false },
      black: { ...activeGame.black, ratingAfter: 1484, provisionalAfter: true },
      lichessUrl: 'https://lichess.org/abcdefgh',
      analysisUrl: 'https://lichess.org/analysis/pgn/e4',
    };
    expect(GameDtoSchema.safeParse(finished).success).toBe(true);
  });

  it('rejects a negative version', () => {
    expect(GameDtoSchema.safeParse({ ...activeGame, version: -1 }).success).toBe(false);
  });

  it('rejects a move with a malformed UCI string', () => {
    const moves = [{ ...activeGame.moves[0], uci: 'e2e9' }];
    expect(GameDtoSchema.safeParse({ ...activeGame, moves }).success).toBe(false);
  });

  it('rejects a server time that is not ISO-8601', () => {
    expect(GameDtoSchema.safeParse({ ...activeGame, serverTime: 'yesterday' }).success).toBe(
      false,
    );
  });
});

describe('LaunchRouteSchema', () => {
  it('parses a locked route', () => {
    const route = { kind: 'locked', group: { id: 'grp0000001', title: 'Chess Club' } };
    expect(LaunchRouteSchema.parse(route)).toEqual(route);
  });

  it('rejects an unknown kind', () => {
    expect(LaunchRouteSchema.safeParse({ kind: 'admin' }).success).toBe(false);
  });
});

describe('GroupSettingsSchema', () => {
  it('accepts the defaults', () => {
    expect(GroupSettingsSchema.parse(GROUP_SETTINGS_DEFAULTS)).toEqual({
      defaultTimePerMove: 86400,
      ratedDefault: true,
      allowOpenChallenges: true,
      maxActiveGamesPerUser: 5,
      leaderboardMinGames: 5,
      cardTopicMode: 'origin',
      fixedTopicId: null,
    });
  });

  it.each([0, 21])('rejects %d active games per user', (value) => {
    expect(
      GroupSettingsSchema.safeParse({ ...GROUP_SETTINGS_DEFAULTS, maxActiveGamesPerUser: value })
        .success,
    ).toBe(false);
  });
});

describe('LeaderboardEntrySchema', () => {
  it('rejects a negative win count', () => {
    const entry = {
      id: '1',
      name: 'Alice',
      username: null,
      rating: 1500,
      provisional: true,
      gamesPlayed: 0,
      record: { wins: -1, draws: 0, losses: 0 },
    };
    expect(LeaderboardEntrySchema.safeParse(entry).success).toBe(false);
  });
});
```

`packages/shared/test/protocol/requests.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ChallengeRequestSchema,
  GroupSettingsUpdateRequestSchema,
  LaunchRequestSchema,
  MoveRequestSchema,
  PrefsUpdateRequestSchema,
  TelemetryRequestSchema,
} from '../../src/protocol/requests';

describe('MoveRequestSchema', () => {
  const valid = { uci: 'e7e8q', expectedPly: 0, clientMoveId: 'abcdefgh' };

  it('accepts a promotion move with a client move id', () => {
    expect(MoveRequestSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['an off-board square', { ...valid, uci: 'e7e9' }],
    ['a fractional ply', { ...valid, expectedPly: 1.5 }],
    ['a short client move id', { ...valid, clientMoveId: 'abc' }],
    ['a client move id with a space', { ...valid, clientMoveId: 'abcd efgh' }],
  ])('rejects %s', (_label, body) => {
    expect(MoveRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('ChallengeRequestSchema', () => {
  it('accepts an open challenge', () => {
    const body = { opponentId: null, timePerMove: 86400, colour: 'random', rated: true };
    expect(ChallengeRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a time control that is not offered', () => {
    const body = { opponentId: '7', timePerMove: 7200, colour: 'white', rated: false };
    expect(ChallengeRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an unknown colour', () => {
    const body = { opponentId: '7', timePerMove: 3600, colour: 'pink', rated: false };
    expect(ChallengeRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('TelemetryRequestSchema', () => {
  it('accepts one event', () => {
    const body = { events: [{ kind: 'sse_failed', durationMs: 30000 }] };
    expect(TelemetryRequestSchema.safeParse(body).success).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(TelemetryRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects more than ten events', () => {
    const events = Array.from({ length: 11 }, () => ({ kind: 'move_retry' }));
    expect(TelemetryRequestSchema.safeParse({ events }).success).toBe(false);
  });
});

describe('PrefsUpdateRequestSchema', () => {
  it('accepts a partial preferences update', () => {
    expect(PrefsUpdateRequestSchema.parse({ prefs: { confirmMoves: false } })).toEqual({
      prefs: { confirmMoves: false },
    });
  });

  it('accepts a write-access prompt result on its own', () => {
    expect(PrefsUpdateRequestSchema.parse({ writeAccess: { allowed: true } })).toEqual({
      writeAccess: { allowed: true },
    });
  });
});

describe('GroupSettingsUpdateRequestSchema', () => {
  it('accepts a single field', () => {
    expect(GroupSettingsUpdateRequestSchema.parse({ leaderboardMinGames: 3 })).toEqual({
      leaderboardMinGames: 3,
    });
  });

  it('still enforces the range of each field', () => {
    expect(GroupSettingsUpdateRequestSchema.safeParse({ maxActiveGamesPerUser: 0 }).success).toBe(
      false,
    );
  });
});

describe('LaunchRequestSchema', () => {
  it('rejects empty init data', () => {
    expect(LaunchRequestSchema.safeParse({ initData: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/shared/test/protocol/dto.test.ts packages/shared/test/protocol/requests.test.ts`
Expected: FAIL — both files cannot load `../../src/protocol/dto` / `../../src/protocol/requests`.

- [ ] **Step 3: Write the implementations**

`packages/shared/src/protocol/dto.ts`:

```ts
import { z } from 'zod';
import {
  ChallengeStatusSchema,
  ColourChoiceSchema,
  ColourSchema,
  EndReasonSchema,
  GameResultSchema,
  GameStatusSchema,
  TimePerMoveSchema,
  ViewerRoleSchema,
} from './enums';
import { PublicIdSchema, UserIdSchema } from './ids';

export const UciSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);

export type Uci = z.infer<typeof UciSchema>;

/** Timestamps travel as ISO-8601 UTC strings, exactly what `Date#toISOString()` produces. */
export const IsoDateSchema = z.iso.datetime();

export const PlayerRefSchema = z.object({
  id: UserIdSchema,
  name: z.string(),
  username: z.string().nullable(),
  /** Rounded current rating in this group; 1500 (provisional) before the first rated game. */
  rating: z.number().int(),
  provisional: z.boolean(),
});

export type PlayerRef = z.infer<typeof PlayerRefSchema>;

export const GamePlayerSchema = PlayerRefSchema.extend({
  /** Rating after the game; null while it runs and for casual, aborted or voided games. */
  ratingAfter: z.number().int().nullable(),
  provisionalAfter: z.boolean().nullable(),
});

export type GamePlayer = z.infer<typeof GamePlayerSchema>;

export const MoveDtoSchema = z.object({
  ply: z.number().int().min(1),
  uci: UciSchema,
  san: z.string().min(1),
  fenAfter: z.string().min(1),
  playedAt: IsoDateSchema,
});

export type MoveDto = z.infer<typeof MoveDtoSchema>;

export const DrawOfferSchema = z.object({
  by: ColourSchema,
  atPly: z.number().int().min(0),
});

export type DrawOffer = z.infer<typeof DrawOfferSchema>;

export const ClaimsSchema = z.object({
  threefold: z.boolean(),
  fiftyMove: z.boolean(),
});

export const GroupRefSchema = z.object({
  id: PublicIdSchema,
  title: z.string(),
});

export type GroupRef = z.infer<typeof GroupRefSchema>;

export const GameDtoSchema = z.object({
  id: PublicIdSchema,
  group: GroupRefSchema,
  status: GameStatusSchema,
  white: GamePlayerSchema,
  black: GamePlayerSchema,
  timePerMove: TimePerMoveSchema,
  rated: z.boolean(),
  fen: z.string().min(1),
  plyCount: z.number().int().min(0),
  version: z.number().int().min(0),
  moves: z.array(MoveDtoSchema),
  deadlineAt: IsoDateSchema.nullable(),
  serverTime: IsoDateSchema,
  drawOffer: DrawOfferSchema.nullable(),
  claims: ClaimsSchema,
  viewerRole: ViewerRoleSchema,
  result: GameResultSchema.nullable(),
  endReason: EndReasonSchema.nullable(),
  voided: z.boolean(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  /** Only present once the game is finished (spec §7.6). */
  lichessUrl: z.url().optional(),
  analysisUrl: z.url().optional(),
});

export type GameDto = z.infer<typeof GameDtoSchema>;

export const GameSummarySchema = z.object({
  id: PublicIdSchema,
  white: PlayerRefSchema,
  black: PlayerRefSchema,
  status: GameStatusSchema,
  timePerMove: TimePerMoveSchema,
  rated: z.boolean(),
  plyCount: z.number().int().min(0),
  sideToMove: ColourSchema,
  yourTurn: z.boolean(),
  deadlineAt: IsoDateSchema.nullable(),
  lastMoveAt: IsoDateSchema.nullable(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  result: GameResultSchema.nullable(),
  endReason: EndReasonSchema.nullable(),
  voided: z.boolean(),
});

export type GameSummary = z.infer<typeof GameSummarySchema>;

export const ChallengeDtoSchema = z.object({
  id: PublicIdSchema,
  challenger: PlayerRefSchema,
  opponent: PlayerRefSchema.nullable(),
  timePerMove: TimePerMoveSchema,
  challengerColour: ColourChoiceSchema,
  rated: z.boolean(),
  status: ChallengeStatusSchema,
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  viewer: z.object({
    canAccept: z.boolean(),
    canDecline: z.boolean(),
    canCancel: z.boolean(),
  }),
});

export type ChallengeDto = z.infer<typeof ChallengeDtoSchema>;

export const WinDrawLossSchema = z.object({
  wins: z.number().int().min(0),
  draws: z.number().int().min(0),
  losses: z.number().int().min(0),
});

export type WinDrawLoss = z.infer<typeof WinDrawLossSchema>;

export const LeaderboardEntrySchema = PlayerRefSchema.extend({
  gamesPlayed: z.number().int().min(0),
  record: WinDrawLossSchema,
});

export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const GroupSettingsSchema = z.object({
  defaultTimePerMove: TimePerMoveSchema,
  ratedDefault: z.boolean(),
  allowOpenChallenges: z.boolean(),
  maxActiveGamesPerUser: z.number().int().min(1).max(20),
  leaderboardMinGames: z.number().int().min(0).max(100),
  cardTopicMode: z.enum(['origin', 'fixed']),
  fixedTopicId: z.number().int().positive().nullable(),
});

export type GroupSettings = z.infer<typeof GroupSettingsSchema>;

export const GROUP_SETTINGS_DEFAULTS: GroupSettings = {
  defaultTimePerMove: 86400,
  ratedDefault: true,
  allowOpenChallenges: true,
  maxActiveGamesPerUser: 5,
  leaderboardMinGames: 5,
  cardTopicMode: 'origin',
  fixedTopicId: null,
};

export const FinishedPageDtoSchema = z.object({
  items: z.array(GameSummarySchema),
  nextCursor: z.string().nullable(),
});

export type FinishedPageDto = z.infer<typeof FinishedPageDtoSchema>;

export const LobbyDtoSchema = z.object({
  group: GroupRefSchema,
  isAdmin: z.boolean(),
  settings: GroupSettingsSchema.pick({
    defaultTimePerMove: true,
    ratedDefault: true,
    allowOpenChallenges: true,
  }),
  /** Active games, the viewer's "your move" games first. */
  active: z.array(GameSummarySchema),
  finished: FinishedPageDtoSchema,
  challenges: z.array(ChallengeDtoSchema),
  players: z.array(LeaderboardEntrySchema),
});

export type LobbyDto = z.infer<typeof LobbyDtoSchema>;

export const PlayersPickerDtoSchema = z.object({
  players: z.array(PlayerRefSchema),
});

export type PlayersPickerDto = z.infer<typeof PlayersPickerDtoSchema>;

export const PlayerPageDtoSchema = z.object({
  player: LeaderboardEntrySchema,
  /** The viewer's record against this player. */
  headToHead: WinDrawLossSchema,
  recentGames: z.array(GameSummarySchema),
});

export type PlayerPageDto = z.infer<typeof PlayerPageDtoSchema>;

export const PrefsSchema = z.object({
  confirmMoves: z.boolean(),
  closeAfterMove: z.boolean(),
  notifications: z.boolean(),
  boardTheme: z.string().max(32).nullable(),
  pieceSet: z.string().max(32).nullable(),
});

export type Prefs = z.infer<typeof PrefsSchema>;

export const PREFS_DEFAULTS: Prefs = {
  confirmMoves: true,
  closeAfterMove: true,
  notifications: true,
  boardTheme: null,
  pieceSet: null,
};

export const MeGroupsDtoSchema = z.object({
  groups: z.array(
    GroupRefSchema.extend({
      activeGames: z.number().int().min(0),
      yourMove: z.number().int().min(0),
    }),
  ),
});

export type MeGroupsDto = z.infer<typeof MeGroupsDtoSchema>;

export const GroupSettingsDtoSchema = z.object({
  group: GroupRefSchema,
  settings: GroupSettingsSchema,
  blocked: z.array(PlayerRefSchema),
  botIsAdmin: z.boolean(),
  isForum: z.boolean(),
});

export type GroupSettingsDto = z.infer<typeof GroupSettingsDtoSchema>;

/** Where the app lands after `POST /launch`, with that screen's data (spec §6.1 step 3). */
export const LaunchRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('game'), game: GameDtoSchema }),
  z.object({ kind: z.literal('lobby'), lobby: LobbyDtoSchema }),
  z.object({ kind: z.literal('settings'), settings: GroupSettingsDtoSchema }),
  z.object({ kind: z.literal('groups'), groups: MeGroupsDtoSchema }),
  z.object({ kind: z.literal('locked'), group: GroupRefSchema }),
]);

export type LaunchRoute = z.infer<typeof LaunchRouteSchema>;

export const LaunchResponseSchema = z.object({
  token: z.string().min(1),
  user: z.object({
    id: UserIdSchema,
    name: z.string(),
    username: z.string().nullable(),
  }),
  prefs: PrefsSchema,
  /** True when the write-access prompt has never been shown to this user (spec §6.1 step 4). */
  askWriteAccess: z.boolean(),
  route: LaunchRouteSchema,
  serverTime: IsoDateSchema,
  bot: z.object({
    username: z.string(),
    miniAppShortName: z.string(),
  }),
});

export type LaunchResponse = z.infer<typeof LaunchResponseSchema>;

export const OkDtoSchema = z.object({ ok: z.literal(true) });

export type OkDto = z.infer<typeof OkDtoSchema>;
```

`packages/shared/src/protocol/requests.ts`:

```ts
import { z } from 'zod';
import { GroupSettingsSchema, PrefsSchema, UciSchema } from './dto';
import { ColourChoiceSchema, TimePerMoveSchema } from './enums';
import { UserIdSchema } from './ids';

export const LaunchRequestSchema = z.object({
  initData: z.string().min(1).max(4096),
});

export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;

export const MoveRequestSchema = z.object({
  uci: UciSchema,
  expectedPly: z.number().int().min(0),
  /** Client-generated id reused on retries so a move is applied at most once (spec §7.4). */
  clientMoveId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

export type MoveRequest = z.infer<typeof MoveRequestSchema>;

export const ChallengeRequestSchema = z.object({
  /** null for an open challenge. */
  opponentId: UserIdSchema.nullable(),
  timePerMove: TimePerMoveSchema,
  colour: ColourChoiceSchema,
  rated: z.boolean(),
});

export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;

export const ShareRequestSchema = z.object({
  ply: z.number().int().min(0),
});

export type ShareRequest = z.infer<typeof ShareRequestSchema>;

export const PrefsUpdateRequestSchema = z.object({
  prefs: PrefsSchema.partial().optional(),
  writeAccess: z.object({ allowed: z.boolean() }).optional(),
});

export type PrefsUpdateRequest = z.infer<typeof PrefsUpdateRequestSchema>;

export const GroupSettingsUpdateRequestSchema = GroupSettingsSchema.partial();

export type GroupSettingsUpdateRequest = z.infer<typeof GroupSettingsUpdateRequestSchema>;

export const BlockRequestSchema = z.object({
  userId: UserIdSchema,
});

export type BlockRequest = z.infer<typeof BlockRequestSchema>;

export const TelemetryRequestSchema = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(['launch_failed', 'move_retry', 'sse_failed']),
        code: z.string().max(64).optional(),
        durationMs: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(10),
});

export type TelemetryRequest = z.infer<typeof TelemetryRequestSchema>;

export const FinishedQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
});

export type FinishedQuery = z.infer<typeof FinishedQuerySchema>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './protocol/dto';
export * from './protocol/requests';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/shared/test/protocol/dto.test.ts packages/shared/test/protocol/requests.test.ts`
Expected: PASS — 27 tests (dto 11, requests 16).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; 93 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add API DTO and request schemas"
```

---

### Task 4: Arbiter on chess.js

**Files:**
- Create: `packages/shared/src/chess/arbiter.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/chess/arbiter.test.ts`

**Interfaces:**
- Consumes: `opposite`, `type Colour`, `type GameResult` (Task 2).
- Produces: `INITIAL_FEN: string`; `type Claims = { threefold: boolean; fiftyMove: boolean }`; `type AutomaticDrawReason = 'stalemate' | 'insufficient_material' | 'fivefold_repetition' | 'seventy_five_moves'`; `type Outcome = { kind: 'continue'; claims: Claims } | { kind: 'checkmate'; winner: Colour } | { kind: 'draw'; reason: AutomaticDrawReason }`; `type ApplyMoveResult = { legal: false } | { legal: true; uci: string; san: string; fenAfter: string; capture: boolean; check: boolean; outcome: Outcome }`; `applyMove(fen: string, keysSoFar: readonly string[], uci: string): ApplyMoveResult`; `computeClaims(fen: string, keysSoFar: readonly string[]): Claims`; `positionKey(fen: string): string`; `sideToMove(fen: string): Colour`; `halfmoveClock(fen: string): number`; `isValidFen(fen: string): boolean`; `parseUci(uci: string): { from; to; promotion? } | null`; `legalDests(fen: string): Map<string, string[]>`; `timeoutOutcome(fen: string, flagged: Colour): { result: GameResult; endReason: 'timeout' }`.

`keysSoFar` is the position key of every position reached so far, the initial position included and the current position last; the server derives it from the initial FEN plus each stored `fen_after`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/chess/arbiter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  INITIAL_FEN,
  applyMove,
  computeClaims,
  isValidFen,
  legalDests,
  parseUci,
  positionKey,
  sideToMove,
  timeoutOutcome,
} from '../../src/chess/arbiter';

const INITIAL_KEY = positionKey(INITIAL_FEN);
const PROMOTION_FEN = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
/** After 1.Nf3 Nf6 2.Ng1: Black's Ng8 recreates the initial position. */
const BEFORE_RETURN_FEN = 'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 3 2';

describe('applyMove', () => {
  it('plays a legal opening move and reports a continuing game', () => {
    expect(applyMove(INITIAL_FEN, [INITIAL_KEY], 'e2e4')).toEqual({
      legal: true,
      uci: 'e2e4',
      san: 'e4',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      capture: false,
      check: false,
      outcome: { kind: 'continue', claims: { threefold: false, fiftyMove: false } },
    });
  });

  it.each([
    ['an illegal destination', 'e2e5'],
    ["the opponent's piece", 'e7e5'],
    ['dash notation', 'e2-e4'],
    ['an off-board square', 'i9i9'],
    ['an empty string', ''],
  ])('rejects %s', (_label, uci) => {
    expect(applyMove(INITIAL_FEN, [INITIAL_KEY], uci)).toEqual({ legal: false });
  });

  it('normalises a promotion suffix on a non-promotion move', () => {
    const result = applyMove(INITIAL_FEN, [INITIAL_KEY], 'e2e4q');
    expect(result.legal && result.uci).toBe('e2e4');
  });

  it('requires the promotion piece', () => {
    expect(applyMove(PROMOTION_FEN, [], 'a7a8')).toEqual({ legal: false });
  });

  it('promotes and reports check', () => {
    const result = applyMove(PROMOTION_FEN, [], 'a7a8q');
    expect(result.legal && [result.uci, result.san, result.check]).toEqual([
      'a7a8q',
      'a8=Q+',
      true,
    ]);
  });

  it('reports a capture', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const result = applyMove(fen, [], 'e4d5');
    expect(result.legal && [result.san, result.capture]).toEqual(['exd5', true]);
  });

  it('detects checkmate for the mover', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';
    const result = applyMove(fen, [], 'd8h4');
    expect(result.legal && [result.san, result.outcome]).toEqual([
      'Qh4#',
      { kind: 'checkmate', winner: 'black' },
    ]);
  });

  it('detects stalemate', () => {
    const result = applyMove('k7/8/1K6/8/8/8/8/2Q5 w - - 0 1', [], 'c1c7');
    expect(result.legal && result.outcome).toEqual({ kind: 'draw', reason: 'stalemate' });
  });

  it('ends the game when a capture leaves insufficient material', () => {
    const result = applyMove('8/8/8/8/8/8/1r6/K6k w - - 0 1', [], 'a1b2');
    expect(result.legal && result.outcome).toEqual({
      kind: 'draw',
      reason: 'insufficient_material',
    });
  });

  it('ends the game on the fifth occurrence of a position', () => {
    const keys = [INITIAL_KEY, INITIAL_KEY, INITIAL_KEY, INITIAL_KEY];
    const result = applyMove(BEFORE_RETURN_FEN, keys, 'f6g8');
    expect(result.legal && result.outcome).toEqual({
      kind: 'draw',
      reason: 'fivefold_repetition',
    });
  });

  it('makes threefold repetition claimable, not automatic', () => {
    const result = applyMove(BEFORE_RETURN_FEN, [INITIAL_KEY, INITIAL_KEY], 'f6g8');
    expect(result.legal && result.outcome).toEqual({
      kind: 'continue',
      claims: { threefold: true, fiftyMove: false },
    });
  });

  it('ends the game at 75 moves without a capture or pawn move', () => {
    const result = applyMove('8/8/8/8/8/8/1R6/K6k w - - 149 100', [], 'b2b3');
    expect(result.legal && result.outcome).toEqual({
      kind: 'draw',
      reason: 'seventy_five_moves',
    });
  });

  it('makes the fifty-move rule claimable at halfmove 100', () => {
    const result = applyMove('8/8/8/8/8/8/1R6/K6k w - - 99 60', [], 'b2b3');
    expect(result.legal && result.outcome).toEqual({
      kind: 'continue',
      claims: { threefold: false, fiftyMove: true },
    });
  });

  it('lets checkmate win over the 75-move rule', () => {
    const result = applyMove('7k/8/6K1/8/8/8/8/1R6 w - - 149 100', [], 'b1b8');
    expect(result.legal && result.outcome).toEqual({ kind: 'checkmate', winner: 'white' });
  });
});

describe('computeClaims', () => {
  it('reports threefold when the current position appeared three times', () => {
    const keys = [INITIAL_KEY, 'other', INITIAL_KEY, 'another', INITIAL_KEY];
    expect(computeClaims(INITIAL_FEN, keys)).toEqual({ threefold: true, fiftyMove: false });
  });

  it('reports the fifty-move claim from the halfmove clock', () => {
    expect(computeClaims('8/8/8/8/8/8/1R6/K6k w - - 100 60', ['k'])).toEqual({
      threefold: false,
      fiftyMove: true,
    });
  });
});

describe('position helpers', () => {
  it('keys a position by placement, side, castling and en passant only', () => {
    expect(positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 7 12')).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
    );
  });

  it('reads the side to move', () => {
    expect(sideToMove(INITIAL_FEN)).toBe('white');
    expect(sideToMove('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBe(
      'black',
    );
  });

  it('records an en passant square only when a capture is legal', () => {
    const afterE5 = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
    const withCapture = applyMove(afterE5, [], 'f7f5');
    expect(withCapture.legal && withCapture.fenAfter.split(' ')[3]).toBe('f6');
    const without = applyMove(INITIAL_FEN, [], 'e2e4');
    expect(without.legal && without.fenAfter.split(' ')[3]).toBe('-');
  });

  it('validates FEN strings', () => {
    expect(isValidFen(INITIAL_FEN)).toBe(true);
    expect(isValidFen('not a fen')).toBe(false);
  });

  it('parses UCI with an optional promotion piece', () => {
    expect(parseUci('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(parseUci('e2e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(parseUci('e2e4k')).toBeNull();
  });
});

describe('legalDests', () => {
  it('groups legal destinations by origin square', () => {
    const dests = legalDests(INITIAL_FEN);
    expect(dests.size).toBe(10);
    expect(dests.get('e2')).toEqual(['e3', 'e4']);
    expect(dests.get('g1')).toEqual(['f3', 'h3']);
    expect(dests.get('e1')).toBeUndefined();
  });

  it('lists a promotion square once', () => {
    expect(legalDests(PROMOTION_FEN).get('a7')).toEqual(['a8']);
  });
});

describe('timeoutOutcome', () => {
  it.each([
    ['a bare king', '4k3/8/8/8/8/8/8/4K3 b - - 0 1'],
    ['king and knight against a bare king', '4k3/8/8/8/8/8/8/4KN2 b - - 0 1'],
    ['king and bishop against a bare king', '4k3/8/8/8/8/8/8/4KB2 b - - 0 1'],
    ['king and bishop against a bishop on the same colour', '2b1k3/8/8/8/8/8/8/4KB2 b - - 0 1'],
  ])('is a draw when the opponent cannot mate: %s', (_label, fen) => {
    expect(timeoutOutcome(fen, 'black')).toEqual({ result: '1/2-1/2', endReason: 'timeout' });
  });

  it.each([
    ['king and knight against a pawn', '4k3/4p3/8/8/8/8/8/4KN2 b - - 0 1'],
    ['king and bishop against a bishop on the other colour', '4kb2/8/8/8/8/8/8/4KB2 b - - 0 1'],
    ['king and rook', '4k3/8/8/8/8/8/8/4KR2 b - - 0 1'],
    ['two knights', '4k3/8/8/8/8/8/8/3NKN2 b - - 0 1'],
  ])('is a loss when the opponent could still mate: %s', (_label, fen) => {
    expect(timeoutOutcome(fen, 'black')).toEqual({ result: '1-0', endReason: 'timeout' });
  });

  it('draws a white flag fall against a bare black king', () => {
    expect(timeoutOutcome('4k3/8/8/8/8/8/8/4KQ2 w - - 0 1', 'white')).toEqual({
      result: '1/2-1/2',
      endReason: 'timeout',
    });
  });

  it('scores a white flag fall against a black rook as a black win', () => {
    expect(timeoutOutcome('r3k3/8/8/8/8/8/8/4K3 w - - 0 1', 'white')).toEqual({
      result: '0-1',
      endReason: 'timeout',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/test/chess/arbiter.test.ts`
Expected: FAIL — cannot load `../../src/chess/arbiter`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/chess/arbiter.ts`:

```ts
import { Chess, type Move, type Square } from 'chess.js';
import { opposite, type Colour, type GameResult } from '../protocol/enums';

export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export type Claims = { threefold: boolean; fiftyMove: boolean };

export type AutomaticDrawReason =
  | 'stalemate'
  | 'insufficient_material'
  | 'fivefold_repetition'
  | 'seventy_five_moves';

export type Outcome =
  | { kind: 'continue'; claims: Claims }
  | { kind: 'checkmate'; winner: Colour }
  | { kind: 'draw'; reason: AutomaticDrawReason };

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export type ParsedUci = { from: Square; to: Square; promotion?: PromotionPiece };

export type ApplyMoveResult =
  | { legal: false }
  | {
      legal: true;
      /** Normalised coordinate notation, e.g. `e2e4` or `a7a8q`; the value to store. */
      uci: string;
      san: string;
      fenAfter: string;
      capture: boolean;
      check: boolean;
      outcome: Outcome;
    };

const UCI_PATTERN = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function parseUci(uci: string): ParsedUci | null {
  const match = UCI_PATTERN.exec(uci);
  if (!match) return null;
  const from = match[1] as Square;
  const to = match[2] as Square;
  const promotion = match[3] as PromotionPiece | undefined;
  return promotion ? { from, to, promotion } : { from, to };
}

/** The first four FEN fields identify a position for repetition purposes (spec §7.2). */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function sideToMove(fen: string): Colour {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export function halfmoveClock(fen: string): number {
  return Number(fen.split(' ')[4] ?? '0');
}

export function isValidFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

function countKey(keys: readonly string[], key: string): number {
  let count = 0;
  for (const candidate of keys) {
    if (candidate === key) count += 1;
  }
  return count;
}

/** Claims available in the position `fen`, whose key is the last entry of `keysSoFar`. */
export function computeClaims(fen: string, keysSoFar: readonly string[]): Claims {
  return {
    threefold: countKey(keysSoFar, positionKey(fen)) >= 3,
    fiftyMove: halfmoveClock(fen) >= 100,
  };
}

/**
 * Applies `uci` to `fen`. `keysSoFar` holds the position key of every position reached so far,
 * the initial position included, so repetitions of the new position can be counted.
 * Threefold repetition and the fifty-move rule are reported as claims, never as an outcome.
 */
export function applyMove(fen: string, keysSoFar: readonly string[], uci: string): ApplyMoveResult {
  const parsed = parseUci(uci);
  if (!parsed) return { legal: false };
  const chess = new Chess(fen);
  let move: Move;
  try {
    move = chess.move(parsed);
  } catch {
    return { legal: false };
  }
  const fenAfter = chess.fen();
  const repetitions = countKey(keysSoFar, positionKey(fenAfter)) + 1;
  const halfmoves = halfmoveClock(fenAfter);

  let outcome: Outcome;
  if (chess.isCheckmate()) {
    outcome = { kind: 'checkmate', winner: sideToMove(fen) };
  } else if (chess.isStalemate()) {
    outcome = { kind: 'draw', reason: 'stalemate' };
  } else if (chess.isInsufficientMaterial()) {
    outcome = { kind: 'draw', reason: 'insufficient_material' };
  } else if (repetitions >= 5) {
    outcome = { kind: 'draw', reason: 'fivefold_repetition' };
  } else if (halfmoves >= 150) {
    outcome = { kind: 'draw', reason: 'seventy_five_moves' };
  } else {
    outcome = {
      kind: 'continue',
      claims: { threefold: repetitions >= 3, fiftyMove: halfmoves >= 100 },
    };
  }

  return {
    legal: true,
    uci: move.lan,
    san: move.san,
    fenAfter,
    capture: move.captured !== undefined,
    check: chess.inCheck(),
    outcome,
  };
}

/** Legal destinations per origin square, in the shape chessground's `movable.dests` wants. */
export function legalDests(fen: string): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  for (const move of new Chess(fen).moves({ verbose: true })) {
    const targets = dests.get(move.from) ?? [];
    if (!targets.includes(move.to)) targets.push(move.to);
    dests.set(move.from, targets);
  }
  return dests;
}

type Material = { nonKing: string[]; bishopSquares: Set<'light' | 'dark'> };

function materialOf(fen: string, colour: Colour): Material {
  const placement = fen.split(' ')[0] ?? '';
  const material: Material = { nonKing: [], bishopSquares: new Set() };
  let rank = 7;
  let file = 0;
  for (const symbol of placement) {
    if (symbol === '/') {
      rank -= 1;
      file = 0;
      continue;
    }
    if (symbol >= '1' && symbol <= '8') {
      file += Number(symbol);
      continue;
    }
    const isWhite = symbol === symbol.toUpperCase();
    const piece = symbol.toLowerCase();
    if ((colour === 'white') === isWhite && piece !== 'k') {
      material.nonKing.push(piece);
      if (piece === 'b') material.bishopSquares.add((rank + file) % 2 === 0 ? 'dark' : 'light');
    }
    file += 1;
  }
  return material;
}

/**
 * FIDE Article 6.9: the player whose flag fell loses, unless the opponent could not checkmate by
 * any series of legal moves, in which case the game is drawn (spec §18 item 5).
 */
export function timeoutOutcome(
  fen: string,
  flagged: Colour,
): { result: GameResult; endReason: 'timeout' } {
  const winner = opposite(flagged);
  const winning = materialOf(fen, winner);
  const losing = materialOf(fen, flagged);
  let canMate: boolean;
  if (winning.nonKing.length === 0) {
    canMate = false;
  } else if (winning.nonKing.length === 1 && winning.nonKing[0] === 'n') {
    canMate = losing.nonKing.length > 0;
  } else if (winning.nonKing.length === 1 && winning.nonKing[0] === 'b') {
    const onlySameColourBishops =
      losing.nonKing.every((piece) => piece === 'b') &&
      [...losing.bishopSquares].every((square) => winning.bishopSquares.has(square));
    canMate = !(losing.nonKing.length === 0 || onlySameColourBishops);
  } else {
    canMate = true;
  }
  if (!canMate) return { result: '1/2-1/2', endReason: 'timeout' };
  return { result: winner === 'white' ? '1-0' : '0-1', endReason: 'timeout' };
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './chess/arbiter';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/test/chess/arbiter.test.ts`
Expected: PASS — 37 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; 130 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add the chess arbiter with automatic ends, claims and flag-fall rules"
```

---

### Task 5: PGN export and Lichess analysis links

**Files:**
- Create: `packages/shared/src/chess/pgn.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/chess/pgn.test.ts`

**Interfaces:**
- Consumes: `type EndReason`, `type GameResult`, `type TimePerMove` (Task 2).
- Produces: `type PgnHeaderInput = { event?: string; site: string; date: Date; white: string; black: string; result: GameResult; whiteElo?: number | null; blackElo?: number | null; timePerMove: TimePerMove; endReason: EndReason | null }`; `buildPgn(headers: PgnHeaderInput, sanMoves: readonly string[]): string`; `formatPgnDate(date: Date): string`; `LICHESS_ANALYSIS_BASE = 'https://lichess.org/analysis/pgn/'`; `analysisUrl(sanMoves: readonly string[]): string`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/chess/pgn.test.ts`:

```ts
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { analysisUrl, buildPgn, formatPgnDate } from '../../src/chess/pgn';

const base = {
  site: 'Chess Club',
  date: new Date('2026-09-20T18:30:00Z'),
  white: 'Alice',
  black: 'Bob',
  result: '1-0' as const,
  whiteElo: 1520,
  blackElo: 1498,
  timePerMove: 86400 as const,
  endReason: 'checkmate' as const,
};
const scholarsMate = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];

describe('buildPgn', () => {
  it('writes the seven-tag roster followed by the Group Chess tags', () => {
    expect(buildPgn(base, scholarsMate)).toBe(
      [
        '[Event "Group Chess"]',
        '[Site "Chess Club"]',
        '[Date "2026.09.20"]',
        '[Round "-"]',
        '[White "Alice"]',
        '[Black "Bob"]',
        '[Result "1-0"]',
        '[WhiteElo "1520"]',
        '[BlackElo "1498"]',
        '[TimeControl "-"]',
        '[TimePerMove "86400"]',
        '[Termination "Normal"]',
        '',
        '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
        '',
      ].join('\n'),
    );
  });

  it('round-trips through chess.js', () => {
    const chess = new Chess();
    chess.loadPgn(buildPgn(base, scholarsMate));
    expect(chess.history()).toEqual(scholarsMate);
    expect(chess.getHeaders().White).toBe('Alice');
    expect(chess.getHeaders().TimePerMove).toBe('86400');
  });

  it('escapes quotes and backslashes in tag values', () => {
    const pgn = buildPgn({ ...base, white: 'Bob "Rook" O\\Neil' }, ['e4']);
    expect(pgn).toContain('[White "Bob \\"Rook\\" O\\\\Neil"]');
  });

  it('omits Elo tags for casual games and marks unfinished games', () => {
    const pgn = buildPgn(
      { ...base, whiteElo: null, blackElo: null, result: '*', endReason: null, timePerMove: null },
      [],
    );
    expect(pgn).not.toContain('Elo');
    expect(pgn).toContain('[TimePerMove "-"]');
    expect(pgn).toContain('[Termination "Unterminated"]');
    expect(pgn.endsWith('\n\n*\n')).toBe(true);
  });

  it.each([
    ['timeout', 'Time forfeit'],
    ['timeout_abort', 'Abandoned'],
    ['abort', 'Abandoned'],
    ['voided', 'Adjudication'],
    ['resignation', 'Normal'],
  ] as const)('maps %s to Termination "%s"', (reason, termination) => {
    expect(buildPgn({ ...base, endReason: reason }, ['e4'])).toContain(
      `[Termination "${termination}"]`,
    );
  });

  it('wraps the movetext at 80 columns', () => {
    const moves = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 'Nf3' : 'Nf6'));
    const movetext = buildPgn(base, moves).split('\n\n')[1] ?? '';
    const lines = movetext.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines.at(-1)?.endsWith('1-0')).toBe(true);
  });
});

describe('formatPgnDate', () => {
  it('formats in UTC with dots', () => {
    expect(formatPgnDate(new Date('2026-01-05T23:30:00Z'))).toBe('2026.01.05');
  });
});

describe('analysisUrl', () => {
  it('joins SAN with underscores and URL-encodes symbols', () => {
    expect(analysisUrl(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Bxf7+'])).toBe(
      'https://lichess.org/analysis/pgn/e4_e5_Nf3_Nc6_Bc4_Bc5_Bxf7%2B',
    );
    expect(analysisUrl(scholarsMate)).toContain('Qxf7%23');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/test/chess/pgn.test.ts`
Expected: FAIL — cannot load `../../src/chess/pgn`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/chess/pgn.ts`:

```ts
import type { EndReason, GameResult, TimePerMove } from '../protocol/enums';

export type PgnHeaderInput = {
  event?: string;
  /** The group title. */
  site: string;
  /** Game start, rendered in UTC. */
  date: Date;
  white: string;
  black: string;
  result: GameResult;
  /** Ratings before the game; omit or null for casual games. */
  whiteElo?: number | null;
  blackElo?: number | null;
  timePerMove: TimePerMove;
  endReason: EndReason | null;
};

/** PGN standard `Termination` values, capitalised the way Lichess exports them. */
const TERMINATION: Readonly<Record<EndReason, string>> = {
  checkmate: 'Normal',
  stalemate: 'Normal',
  insufficient_material: 'Normal',
  fivefold_repetition: 'Normal',
  seventy_five_moves: 'Normal',
  threefold_claim: 'Normal',
  fifty_move_claim: 'Normal',
  draw_agreement: 'Normal',
  resignation: 'Normal',
  timeout: 'Time forfeit',
  timeout_abort: 'Abandoned',
  abort: 'Abandoned',
  voided: 'Adjudication',
};

const MAX_LINE = 80;

export const LICHESS_ANALYSIS_BASE = 'https://lichess.org/analysis/pgn/';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatPgnDate(date: Date): string {
  return `${date.getUTCFullYear()}.${pad2(date.getUTCMonth() + 1)}.${pad2(date.getUTCDate())}`;
}

function tagValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function wrap(tokens: readonly string[]): string {
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current.length === 0) {
      current = token;
    } else if (current.length + 1 + token.length > MAX_LINE) {
      lines.push(current);
      current = token;
    } else {
      current = `${current} ${token}`;
    }
  }
  lines.push(current);
  return lines.join('\n');
}

export function buildPgn(headers: PgnHeaderInput, sanMoves: readonly string[]): string {
  const tags: Array<[string, string]> = [
    ['Event', headers.event ?? 'Group Chess'],
    ['Site', headers.site],
    ['Date', formatPgnDate(headers.date)],
    ['Round', '-'],
    ['White', headers.white],
    ['Black', headers.black],
    ['Result', headers.result],
  ];
  if (headers.whiteElo != null) tags.push(['WhiteElo', String(Math.round(headers.whiteElo))]);
  if (headers.blackElo != null) tags.push(['BlackElo', String(Math.round(headers.blackElo))]);
  tags.push(['TimeControl', '-']);
  tags.push(['TimePerMove', headers.timePerMove === null ? '-' : String(headers.timePerMove)]);
  tags.push(['Termination', headers.endReason ? TERMINATION[headers.endReason] : 'Unterminated']);

  const tagSection = tags.map(([name, value]) => `[${name} "${tagValue(value)}"]`).join('\n');
  const tokens: string[] = [];
  sanMoves.forEach((san, index) => {
    if (index % 2 === 0) tokens.push(`${index / 2 + 1}.`);
    tokens.push(san);
  });
  tokens.push(headers.result);
  return `${tagSection}\n\n${wrap(tokens)}\n`;
}

/** Lichess's analysis board pre-loaded with the whole game, no account needed (spec §7.6). */
export function analysisUrl(sanMoves: readonly string[]): string {
  return LICHESS_ANALYSIS_BASE + sanMoves.map((san) => encodeURIComponent(san)).join('_');
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './chess/pgn';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/test/chess/pgn.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; 142 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add PGN export and Lichess analysis links"
```

---

### Task 6: Clock math and duration formatting

**Files:**
- Create: `packages/shared/src/clock.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/clock.test.ts`

**Interfaces:**
- Consumes: `type TimePerMove` (Task 2).
- Produces: `REMINDER_MIN_TIME_PER_MOVE = 28800`, `REMINDER_FRACTION = 0.1`, `deadlineAfterMove(now: Date, timePerMove: TimePerMove): Date | null`, `reminderAt(deadline: Date | null, timePerMove: TimePerMove, dmAllowed: boolean): Date | null`, `formatTimeLeft(ms: number): string` (DM copy: `3 d`, `23 h`, `45 min`, `30 s`), `formatClock(ms: number): string` (app clocks: `1d 1:01`, `1:01:01`, `1:05`, `0:00`).

- [ ] **Step 1: Write the failing test**

`packages/shared/test/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deadlineAfterMove, formatClock, formatTimeLeft, reminderAt } from '../src/clock';

const now = new Date('2026-09-20T10:00:00.000Z');

describe('deadlineAfterMove', () => {
  it('adds the time per move', () => {
    expect(deadlineAfterMove(now, 86400)?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });

  it('has no deadline without a clock', () => {
    expect(deadlineAfterMove(now, null)).toBeNull();
  });
});

describe('reminderAt', () => {
  const deadline = new Date('2026-09-21T10:00:00.000Z');

  it('falls at ten percent of the time control before the deadline', () => {
    expect(reminderAt(deadline, 86400, true)?.toISOString()).toBe('2026-09-21T07:36:00.000Z');
    expect(reminderAt(new Date('2026-09-20T18:00:00.000Z'), 28800, true)?.toISOString()).toBe(
      '2026-09-20T17:12:00.000Z',
    );
  });

  it('is skipped for controls under eight hours', () => {
    expect(reminderAt(new Date('2026-09-20T11:00:00.000Z'), 3600, true)).toBeNull();
  });

  it('is skipped when the player has not allowed DMs', () => {
    expect(reminderAt(deadline, 86400, false)).toBeNull();
  });

  it('is skipped without a clock', () => {
    expect(reminderAt(null, null, true)).toBeNull();
  });
});

describe('formatTimeLeft', () => {
  it.each([
    [3 * 86_400_000 + 1000, '3 d'],
    [23 * 3_600_000 + 59 * 60_000, '23 h'],
    [45 * 60_000, '45 min'],
    [30_000, '30 s'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatTimeLeft(ms)).toBe(expected);
  });

  it('formats a passed deadline as zero', () => {
    expect(formatTimeLeft(-5000)).toBe('0 s');
  });
});

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [59_999, '0:59'],
    [65_000, '1:05'],
    [3_661_000, '1:01:01'],
    [90_061_000, '1d 1:01'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatClock(ms)).toBe(expected);
  });

  it('formats a passed deadline as zero', () => {
    expect(formatClock(-1000)).toBe('0:00');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/test/clock.test.ts`
Expected: FAIL — cannot load `../src/clock`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/clock.ts`:

```ts
import type { TimePerMove } from './protocol/enums';

/** Reminders exist only for controls of eight hours or more (spec §5.7, §7.3). */
export const REMINDER_MIN_TIME_PER_MOVE = 28800;

export const REMINDER_FRACTION = 0.1;

export function deadlineAfterMove(now: Date, timePerMove: TimePerMove): Date | null {
  if (timePerMove === null) return null;
  return new Date(now.getTime() + timePerMove * 1000);
}

export function reminderAt(
  deadline: Date | null,
  timePerMove: TimePerMove,
  dmAllowed: boolean,
): Date | null {
  if (!deadline || timePerMove === null || !dmAllowed) return null;
  if (timePerMove < REMINDER_MIN_TIME_PER_MOVE) return null;
  return new Date(deadline.getTime() - timePerMove * REMINDER_FRACTION * 1000);
}

/** Coarse remaining time for DM copy, e.g. `23 h left`. Never negative. */
export function formatTimeLeft(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)} h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return `${seconds} s`;
}

/** Ticking clock display for the app. Never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}:${mm}`;
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${minutes}:${ss}`;
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './clock';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/test/clock.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; 159 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add clock math and duration formatting"
```

---

### Task 7: Glicko-2 core

**Files:**
- Create: `packages/shared/src/rating/glicko2.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/rating/glicko2.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GLICKO2` constants object `{ initialRating: 1500, initialRd: 350, initialVolatility: 0.06, tau: 0.5, epsilon: 0.000001, rdFloor: 45, rdCeiling: 350, provisionalRd: 110, scale: 173.7178 }`; `type Rating = { rating: number; rd: number; volatility: number }`; `INITIAL_RATING: Rating`; `type Score = 0 | 0.5 | 1`; `type RatedGame = { opponent: Rating; score: Score }`; `ratePeriod(player: Rating, games: readonly RatedGame[], tau?: number): Rating`; `inflateForInactivity(player: Rating, idleDays: number): Rating`; `isProvisional(rd: number): boolean`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/rating/glicko2.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GLICKO2,
  INITIAL_RATING,
  inflateForInactivity,
  isProvisional,
  ratePeriod,
} from '../../src/rating/glicko2';

describe('ratePeriod', () => {
  it("reproduces the worked example in Glickman's paper", () => {
    const player = { rating: 1500, rd: 200, volatility: 0.06 };
    const result = ratePeriod(
      player,
      [
        { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
        { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
        { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
      ],
      0.5,
    );
    expect(result.rating).toBeCloseTo(1464.06, 1);
    expect(result.rd).toBeCloseTo(151.52, 2);
    expect(result.volatility).toBeCloseTo(0.05999, 4);
  });

  it('only widens the deviation in a period without games', () => {
    const result = ratePeriod({ rating: 1500, rd: 200, volatility: 0.06 }, []);
    expect(result.rating).toBe(1500);
    expect(result.rd).toBeCloseTo(200.27, 1);
    expect(result.volatility).toBe(0.06);
  });

  it('raises the winner and lowers the loser by the same amount for equal players', () => {
    const a = { rating: 1500, rd: 100, volatility: 0.06 };
    const b = { rating: 1500, rd: 100, volatility: 0.06 };
    const winner = ratePeriod(a, [{ opponent: b, score: 1 }]);
    const loser = ratePeriod(b, [{ opponent: a, score: 0 }]);
    expect(winner.rating).toBeGreaterThan(1500);
    expect(loser.rating).toBeLessThan(1500);
    expect(winner.rating - 1500).toBeCloseTo(1500 - loser.rating, 6);
  });

  it('leaves equal players equal after a draw while shrinking their deviation', () => {
    const a = { rating: 1500, rd: 200, volatility: 0.06 };
    const result = ratePeriod(a, [{ opponent: a, score: 0.5 }]);
    expect(result.rating).toBeCloseTo(1500, 6);
    expect(result.rd).toBeLessThan(200);
  });

  it('never drops the deviation below the floor', () => {
    const settled = { rating: 1500, rd: 45, volatility: 0.06 };
    const manyDraws = Array.from({ length: 50 }, () => ({ opponent: settled, score: 0.5 as const }));
    const result = ratePeriod(settled, manyDraws);
    expect(result.rd).toBe(GLICKO2.rdFloor);
  });

  it('stays finite for an extreme rating gap', () => {
    const newcomer = { rating: 1500, rd: 350, volatility: 0.06 };
    const result = ratePeriod(newcomer, [
      { opponent: { rating: 3000, rd: 350, volatility: 0.06 }, score: 1 },
    ]);
    expect(Number.isFinite(result.rating)).toBe(true);
    expect(result.rating).toBeGreaterThan(1500);
    expect(result.rd).toBeGreaterThanOrEqual(GLICKO2.rdFloor);
    expect(result.rd).toBeLessThanOrEqual(GLICKO2.rdCeiling);
    expect(Number.isFinite(result.volatility)).toBe(true);
  });
});

describe('inflateForInactivity', () => {
  it('applies one volatility step per idle day', () => {
    const result = inflateForInactivity({ rating: 1600, rd: 50, volatility: 0.06 }, 100);
    expect(result.rating).toBe(1600);
    expect(result.rd).toBeCloseTo(115.6, 1);
  });

  it('never inflates the deviation above the ceiling', () => {
    const result = inflateForInactivity({ rating: 1600, rd: 340, volatility: 0.06 }, 10_000);
    expect(result.rd).toBe(GLICKO2.rdCeiling);
  });

  it('changes nothing for zero idle days', () => {
    const player = { rating: 1600, rd: 50, volatility: 0.06 };
    expect(inflateForInactivity(player, 0)).toEqual(player);
  });
});

describe('isProvisional', () => {
  it('is provisional above a deviation of 110', () => {
    expect(isProvisional(INITIAL_RATING.rd)).toBe(true);
    expect(isProvisional(110.5)).toBe(true);
    expect(isProvisional(110)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/test/rating/glicko2.test.ts`
Expected: FAIL — cannot load `../../src/rating/glicko2`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/rating/glicko2.ts`:

```ts
/** Glicko-2 as in Glickman, "Example of the Glicko-2 system", with the spec's constants (§7.5). */
export const GLICKO2 = {
  initialRating: 1500,
  initialRd: 350,
  initialVolatility: 0.06,
  tau: 0.5,
  epsilon: 0.000001,
  rdFloor: 45,
  rdCeiling: 350,
  provisionalRd: 110,
  scale: 173.7178,
} as const;

export type Rating = { rating: number; rd: number; volatility: number };

export const INITIAL_RATING: Rating = {
  rating: GLICKO2.initialRating,
  rd: GLICKO2.initialRd,
  volatility: GLICKO2.initialVolatility,
};

export type Score = 0 | 0.5 | 1;

export type RatedGame = { opponent: Rating; score: Score };

export function isProvisional(rd: number): boolean {
  return rd > GLICKO2.provisionalRd;
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muOpponent: number, phiOpponent: number): number {
  return 1 / (1 + Math.exp(-g(phiOpponent) * (mu - muOpponent)));
}

function clampRd(rating: Rating): Rating {
  return {
    ...rating,
    rd: Math.min(GLICKO2.rdCeiling, Math.max(GLICKO2.rdFloor, rating.rd)),
  };
}

/** One rating period. Production passes one game; the paper's example passes three. */
export function ratePeriod(
  player: Rating,
  games: readonly RatedGame[],
  tau: number = GLICKO2.tau,
): Rating {
  const { scale, epsilon } = GLICKO2;
  const mu = (player.rating - 1500) / scale;
  const phi = player.rd / scale;
  const sigma = player.volatility;

  if (games.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return clampRd({ rating: player.rating, rd: phiStar * scale, volatility: sigma });
  }

  let vInverse = 0;
  let deltaSum = 0;
  for (const { opponent, score } of games) {
    const muJ = (opponent.rating - 1500) / scale;
    const phiJ = opponent.rd / scale;
    const gJ = g(phiJ);
    const e = expectedScore(mu, muJ, phiJ);
    vInverse += gJ * gJ * e * (1 - e);
    deltaSum += gJ * (score - e);
  }
  const v = 1 / vInverse;
  const delta = v * deltaSum;

  // Step 5: the new volatility, by the Illinois variant of regula falsi.
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const delta2 = delta * delta;
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (ex * (delta2 - phi2 - v - ex)) / (2 * (phi2 + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k += 1;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > epsilon) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  // Steps 6 and 7.
  const phiStar = Math.sqrt(phi2 + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;

  return clampRd({ rating: muNew * scale + 1500, rd: phiNew * scale, volatility: sigmaNew });
}

/** Spec §7.5: `φ² ← min(φ² + d·σ², (350 / 173.7178)²)` for `d` idle days before a result. */
export function inflateForInactivity(player: Rating, idleDays: number): Rating {
  if (idleDays <= 0) return player;
  const { scale, rdCeiling } = GLICKO2;
  const phi2 = (player.rd / scale) ** 2;
  const ceiling2 = (rdCeiling / scale) ** 2;
  const inflated = Math.min(phi2 + idleDays * player.volatility ** 2, ceiling2);
  return { ...player, rd: Math.sqrt(inflated) * scale };
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './rating/glicko2';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/test/rating/glicko2.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; 169 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add Glicko-2 rating core with inactivity inflation"
```

---

### Task 8: Rating replay for game results and void rebuilds

**Files:**
- Create: `packages/shared/src/rating/replay.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/rating/replay.test.ts`

**Interfaces:**
- Consumes: `type Rating`, `INITIAL_RATING`, `inflateForInactivity`, `ratePeriod`, `type Score` (Task 7); `type Colour` (Task 2).
- Produces: `type PlayerRatingState = Rating & { gamesPlayed: number; wins: number; draws: number; losses: number; lastRatedGameAt: Date | null }`; `type RatedGameRecord = { white: string; black: string; result: '1-0' | '0-1' | '1/2-1/2'; finishedAt: Date }`; `type RatingSnapshot = { white: { before: Rating; after: Rating }; black: { before: Rating; after: Rating } }`; `freshPlayerState(): PlayerRatingState`; `scoreFor(result, colour): Score`; `idleDaysBefore(state, at): number`; `applyRatedGame(states: Map<string, PlayerRatingState>, game: RatedGameRecord): RatingSnapshot` (mutates `states`); `replayRatings(games: readonly RatedGameRecord[]): { states: Map<string, PlayerRatingState>; snapshots: RatingSnapshot[] }`.

The server calls `applyRatedGame` with the two players' current rows when a rated game ends, and `replayRatings` over a group's rated, finished, non-voided games in `finished_at` order when an admin voids a game (spec §7.5).

- [ ] **Step 1: Write the failing test**

`packages/shared/test/rating/replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  applyRatedGame,
  freshPlayerState,
  replayRatings,
  scoreFor,
  type PlayerRatingState,
  type RatedGameRecord,
} from '../../src/rating/replay';

const day = 86_400_000;
const t0 = new Date('2026-09-01T12:00:00Z');
const game = (
  white: string,
  black: string,
  result: RatedGameRecord['result'],
  daysAfterT0: number,
): RatedGameRecord => ({ white, black, result, finishedAt: new Date(t0.getTime() + daysAfterT0 * day) });

describe('scoreFor', () => {
  it('maps the PGN result to each side', () => {
    expect(scoreFor('1-0', 'white')).toBe(1);
    expect(scoreFor('1-0', 'black')).toBe(0);
    expect(scoreFor('0-1', 'white')).toBe(0);
    expect(scoreFor('1/2-1/2', 'black')).toBe(0.5);
  });
});

describe('applyRatedGame', () => {
  it('rates two newcomers from the initial rating and records the result', () => {
    const states = new Map<string, PlayerRatingState>();
    const snapshot = applyRatedGame(states, game('alice', 'bob', '1-0', 0));

    expect(snapshot.white.before).toEqual({ rating: 1500, rd: 350, volatility: 0.06 });
    expect(snapshot.black.before).toEqual({ rating: 1500, rd: 350, volatility: 0.06 });
    expect(snapshot.white.after.rating).toBeGreaterThan(1500);
    expect(snapshot.black.after.rating).toBeLessThan(1500);
    expect(snapshot.white.after.rating - 1500).toBeCloseTo(1500 - snapshot.black.after.rating, 6);

    const alice = states.get('alice');
    const bob = states.get('bob');
    expect(alice).toMatchObject({ gamesPlayed: 1, wins: 1, draws: 0, losses: 0 });
    expect(bob).toMatchObject({ gamesPlayed: 1, wins: 0, draws: 0, losses: 1 });
    expect(alice?.lastRatedGameAt).toEqual(t0);
    expect(alice?.rating).toBe(snapshot.white.after.rating);
  });

  it('counts a draw for both players', () => {
    const states = new Map<string, PlayerRatingState>();
    applyRatedGame(states, game('alice', 'bob', '1/2-1/2', 0));
    expect(states.get('alice')).toMatchObject({ draws: 1, wins: 0, losses: 0 });
    expect(states.get('bob')).toMatchObject({ draws: 1, wins: 0, losses: 0 });
    expect(states.get('alice')?.rating).toBeCloseTo(1500, 6);
  });

  it('widens a returning player’s deviation before applying the result', () => {
    const states = new Map<string, PlayerRatingState>();
    const first = applyRatedGame(states, game('alice', 'bob', '1-0', 0));
    const second = applyRatedGame(states, game('bob', 'alice', '0-1', 100));
    expect(second.black.before.rd).toBeGreaterThan(first.white.after.rd);
    expect(second.black.before.rating).toBe(first.white.after.rating);
  });

  it('leaves a fresh state untouched when building from an empty map', () => {
    expect(freshPlayerState()).toEqual({
      rating: 1500,
      rd: 350,
      volatility: 0.06,
      gamesPlayed: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      lastRatedGameAt: null,
    });
  });
});

describe('replayRatings', () => {
  const games = [
    game('alice', 'bob', '1-0', 0),
    game('bob', 'carol', '1-0', 1),
    game('carol', 'alice', '1/2-1/2', 2),
  ];

  it('produces one snapshot per game and a state per player', () => {
    const { states, snapshots } = replayRatings(games);
    expect(snapshots).toHaveLength(3);
    expect([...states.keys()].sort()).toEqual(['alice', 'bob', 'carol']);
    expect(states.get('bob')).toMatchObject({ gamesPlayed: 2, wins: 1, losses: 1 });
  });

  it('changes later snapshots when an earlier game is voided out of the replay', () => {
    const full = replayRatings(games);
    const withoutSecond = replayRatings([games[0]!, games[2]!]);
    expect(withoutSecond.snapshots[1]?.white.before.rating).not.toBeCloseTo(
      full.snapshots[2]?.white.before.rating ?? 0,
      3,
    );
    expect(withoutSecond.states.get('carol')?.gamesPlayed).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/test/rating/replay.test.ts`
Expected: FAIL — cannot load `../../src/rating/replay`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/rating/replay.ts`:

```ts
import type { Colour } from '../protocol/enums';
import {
  INITIAL_RATING,
  inflateForInactivity,
  ratePeriod,
  type Rating,
  type Score,
} from './glicko2';

export type PlayerRatingState = Rating & {
  gamesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  lastRatedGameAt: Date | null;
};

export type RatedGameRecord = {
  white: string;
  black: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  finishedAt: Date;
};

export type RatingSnapshot = {
  white: { before: Rating; after: Rating };
  black: { before: Rating; after: Rating };
};

const MS_PER_DAY = 86_400_000;

export function freshPlayerState(): PlayerRatingState {
  return {
    ...INITIAL_RATING,
    gamesPlayed: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    lastRatedGameAt: null,
  };
}

export function scoreFor(result: RatedGameRecord['result'], colour: Colour): Score {
  if (result === '1/2-1/2') return 0.5;
  return (result === '1-0') === (colour === 'white') ? 1 : 0;
}

/** Fractional days since the player's last rated game in this group; 0 for a first game. */
export function idleDaysBefore(state: PlayerRatingState, at: Date): number {
  if (!state.lastRatedGameAt) return 0;
  return Math.max(0, (at.getTime() - state.lastRatedGameAt.getTime()) / MS_PER_DAY);
}

function toRating(state: PlayerRatingState): Rating {
  return { rating: state.rating, rd: state.rd, volatility: state.volatility };
}

function advance(
  state: PlayerRatingState,
  after: Rating,
  score: Score,
  at: Date,
): PlayerRatingState {
  return {
    ...after,
    gamesPlayed: state.gamesPlayed + 1,
    wins: state.wins + (score === 1 ? 1 : 0),
    draws: state.draws + (score === 0.5 ? 1 : 0),
    losses: state.losses + (score === 0 ? 1 : 0),
    lastRatedGameAt: at,
  };
}

/**
 * Applies one rated result as its own rating period for both players (spec §7.5), inflating each
 * player's deviation for the days they were idle first. Mutates `states`; returns the snapshots
 * the game row stores.
 */
export function applyRatedGame(
  states: Map<string, PlayerRatingState>,
  game: RatedGameRecord,
): RatingSnapshot {
  const white = states.get(game.white) ?? freshPlayerState();
  const black = states.get(game.black) ?? freshPlayerState();
  const whiteBefore = inflateForInactivity(toRating(white), idleDaysBefore(white, game.finishedAt));
  const blackBefore = inflateForInactivity(toRating(black), idleDaysBefore(black, game.finishedAt));
  const whiteScore = scoreFor(game.result, 'white');
  const blackScore = scoreFor(game.result, 'black');
  const whiteAfter = ratePeriod(whiteBefore, [{ opponent: blackBefore, score: whiteScore }]);
  const blackAfter = ratePeriod(blackBefore, [{ opponent: whiteBefore, score: blackScore }]);
  states.set(game.white, advance(white, whiteAfter, whiteScore, game.finishedAt));
  states.set(game.black, advance(black, blackAfter, blackScore, game.finishedAt));
  return {
    white: { before: whiteBefore, after: whiteAfter },
    black: { before: blackBefore, after: blackAfter },
  };
}

/** Rebuilds a group's ratings from scratch; `games` must be in `finishedAt` order. */
export function replayRatings(games: readonly RatedGameRecord[]): {
  states: Map<string, PlayerRatingState>;
  snapshots: RatingSnapshot[];
} {
  const states = new Map<string, PlayerRatingState>();
  const snapshots = games.map((game) => applyRatedGame(states, game));
  return { states, snapshots };
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './rating/replay';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/test/rating/replay.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; 176 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add rating replay for game results and void rebuilds"
```

---

### Task 9: English message catalog and label helpers

**Files:**
- Create: `packages/shared/src/i18n/en.ts`, `packages/shared/src/i18n/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/i18n.test.ts`

**Interfaces:**
- Consumes: `type EndReason`, `type GameResult`, `type TimePerMove`, `type TimePerMoveSeconds` (Task 2).
- Produces: `en` catalog object; `type MessageKey = keyof typeof en`; `type MessageParams = Record<string, string | number>`; `format(template: string, params: MessageParams): string`; `t(key: MessageKey, params?: MessageParams): string`; `movesLabel(count: number): string`; `timePerMoveLabel(timePerMove: TimePerMove): string`; `timeSpanLabel(seconds: TimePerMoveSeconds): string`; `endReasonLabel(reason: EndReason): string`; `resultLabel(result: GameResult): string`; `ratedLabel(rated: boolean): string`; `ratingLabel(rating: number, provisional: boolean): string`.

Card and DM templates follow spec §5.4, §5.5 and §5.7 word for word; the Mini App's own strings are added to the same catalog in plan 4.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/i18n.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  endReasonLabel,
  format,
  movesLabel,
  ratedLabel,
  ratingLabel,
  resultLabel,
  t,
  timePerMoveLabel,
  timeSpanLabel,
} from '../src/i18n';

describe('format', () => {
  it('interpolates named parameters', () => {
    expect(format('{a} vs {b}', { a: 'Alice', b: 'Bob' })).toBe('Alice vs Bob');
  });

  it('leaves unknown placeholders in place', () => {
    expect(format('Move {n} · {missing}', { n: 12 })).toBe('Move 12 · {missing}');
  });
});

describe('t', () => {
  it('renders a challenge card title', () => {
    expect(t('card.challenge.direct', { challenger: 'Alice', opponent: 'Bob' })).toBe(
      '♟ Alice challenges Bob',
    );
  });

  it('renders the running card status line', () => {
    expect(
      t('card.running.status', {
        timePerMove: timePerMoveLabel(86400),
        rated: ratedLabel(true),
        moveNumber: 12,
        sideToMove: 'Bob',
      }),
    ).toBe('1 day per move · Rated · Move 12 · Bob to move');
  });
});

describe('labels', () => {
  it.each([
    [3600, '1 hour per move'],
    [28800, '8 hours per move'],
    [86400, '1 day per move'],
    [259200, '3 days per move'],
    [604800, '7 days per move'],
    [null, 'No clock'],
  ] as const)('timePerMoveLabel(%s)', (value, expected) => {
    expect(timePerMoveLabel(value)).toBe(expected);
  });

  it('names a time span for abort reasons', () => {
    expect(timeSpanLabel(86400)).toBe('1 day');
    expect(timeSpanLabel(28800)).toBe('8 hours');
  });

  it('pluralises moves', () => {
    expect(movesLabel(1)).toBe('1 move');
    expect(movesLabel(34)).toBe('34 moves');
  });

  it('names end reasons', () => {
    expect(endReasonLabel('checkmate')).toBe('Checkmate');
    expect(endReasonLabel('seventy_five_moves')).toBe('75-move rule');
    expect(endReasonLabel('voided')).toBe('Voided by an admin');
  });

  it('shows draws with the ½ glyph', () => {
    expect(resultLabel('1/2-1/2')).toBe('½-½');
    expect(resultLabel('1-0')).toBe('1-0');
  });

  it('marks provisional ratings with a question mark', () => {
    expect(ratingLabel(1519.6, false)).toBe('1520');
    expect(ratingLabel(1500, true)).toBe('1500?');
  });

  it('names rated and casual games', () => {
    expect(ratedLabel(true)).toBe('Rated');
    expect(ratedLabel(false)).toBe('Casual');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/test/i18n.test.ts`
Expected: FAIL — cannot load `../src/i18n`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/i18n/en.ts`:

```ts
/** Every user-facing string the server sends to Telegram (spec §5.4, §5.5, §5.7, §11). */
export const en = {
  'time.per_move.3600': '1 hour per move',
  'time.per_move.28800': '8 hours per move',
  'time.per_move.86400': '1 day per move',
  'time.per_move.259200': '3 days per move',
  'time.per_move.604800': '7 days per move',
  'time.per_move.none': 'No clock',
  'time.span.3600': '1 hour',
  'time.span.28800': '8 hours',
  'time.span.86400': '1 day',
  'time.span.259200': '3 days',
  'time.span.604800': '7 days',
  'game.rated': 'Rated',
  'game.casual': 'Casual',
  'colour.white': 'White',
  'colour.black': 'Black',
  'result.1-0': '1-0',
  'result.0-1': '0-1',
  'result.1/2-1/2': '½-½',
  'result.*': '*',
  'end_reason.checkmate': 'Checkmate',
  'end_reason.stalemate': 'Stalemate',
  'end_reason.insufficient_material': 'Insufficient material',
  'end_reason.fivefold_repetition': 'Fivefold repetition',
  'end_reason.seventy_five_moves': '75-move rule',
  'end_reason.threefold_claim': 'Threefold repetition',
  'end_reason.fifty_move_claim': '50-move rule',
  'end_reason.draw_agreement': 'Draw agreed',
  'end_reason.resignation': 'Resignation',
  'end_reason.timeout': 'Timeout',
  'end_reason.timeout_abort': 'Aborted',
  'end_reason.abort': 'Aborted',
  'end_reason.voided': 'Voided by an admin',
  'moves.one': '{count} move',
  'moves.other': '{count} moves',
  'card.challenge.direct': '♟ {challenger} challenges {opponent}',
  'card.challenge.open': '♟ {challenger} is looking for a game',
  'card.challenge.terms': '{timePerMove} · {rated}',
  'card.challenge.terms_colour': '{timePerMove} · {rated} · {challenger} plays {colour}',
  'card.challenge.declined': '♟ {challenger} vs {opponent} · Declined',
  'card.challenge.withdrawn': '♟ {challenger} vs {opponent} · Challenge withdrawn',
  'card.challenge.expired': '♟ {challenger} vs {opponent} · Challenge expired',
  'card.challenge.open_withdrawn': '♟ {challenger} · Challenge withdrawn',
  'card.challenge.open_expired': '♟ {challenger} · Challenge expired',
  'card.running.title': '♟ {white} ({whiteRating}) vs {black} ({blackRating})',
  'card.running.title_casual': '♟ {white} vs {black}',
  'card.running.status': '{timePerMove} · {rated} · Move {moveNumber} · {sideToMove} to move',
  'card.finished.title':
    '♟ {white} ({whiteBefore} → {whiteAfter}) vs {black} ({blackBefore} → {blackAfter})',
  'card.finished.title_casual': '♟ {white} vs {black}',
  'card.finished.status': '{endReason} · {result} · {moves} · {timePerMove}',
  'card.aborted.title': '♟ {white} vs {black} · Aborted',
  'card.aborted.no_move': 'no move within {span}',
  'card.aborted.by_player': 'aborted by {name}',
  'card.voided.title': '♟ {white} vs {black} · Voided by an admin',
  'card.voided.status': 'was {endReason} · {result}',
  'card.share.caption': '{sharer} shared move {moveNumber} · {white} vs {black} · {sideToMove} to move',
  'card.welcome':
    'Play chess with this group on a real board inside Telegram. The chat only sees results and shared positions. Admins: promote me so everyone here can watch games.',
  'button.accept': 'Accept',
  'button.decline': 'Decline',
  'button.cancel': 'Cancel',
  'button.open_game': '♟ Open game',
  'button.open_chess': '♟ Open Chess',
  'button.open_settings': 'Open settings',
  'button.open': '♟ Open',
  'button.rematch': '🔁 Rematch',
  'button.analyse': '🔍 Analyse on Lichess',
  'button.go_to_group': 'Go to group',
  'dm.turn': 'Your move vs {opponent} · {lastMove} · {timeLeft} left',
  'dm.turn.no_clock': 'Your move vs {opponent} · {lastMove}',
  'dm.turn.first': 'Your move vs {opponent} · {timeLeft} left',
  'dm.turn.first_no_clock': 'Your move vs {opponent}',
  'dm.reminder': '{timeLeft} left for your move vs {opponent}',
  'dm.challenge': '{challenger} challenges you · {timePerMove} · {rated}',
  'dm.game_end': '{result} vs {opponent} · {endReason}',
  'dm.game_end.rating': '{result} vs {opponent} · {endReason} · {before} → {after}',
  'reply.self': "You can't challenge yourself.",
  'reply.bot': "Bots don't play here.",
  'reply.anonymous': 'Reply to a message from a person to challenge them.',
  'reply.blocked': "That challenge isn't possible in this group.",
  'reply.pending_limit': 'You already have {count} pending challenges here.',
  'reply.active_limit': '{name} already has {count} active games here.',
  'reply.pair_limit': 'You already have {count} games with {name}.',
  'reply.open_disabled': 'Open challenges are off in this group.',
  'alert.not_your_challenge': 'Only {name} can accept this challenge.',
  'alert.own_challenge': "You can't accept your own challenge.",
  'alert.accepted_first': 'Someone accepted first.',
  'alert.challenge_gone': 'This challenge is no longer open.',
  'alert.only_players_rematch': 'Only the players can ask for a rematch.',
  'locked.hint': 'Open a game card in the group once, or ask an admin to promote the bot.',
} as const;
```

`packages/shared/src/i18n/index.ts`:

```ts
import type { EndReason, GameResult, TimePerMove, TimePerMoveSeconds } from '../protocol/enums';
import { en } from './en';

export { en };

export type MessageKey = keyof typeof en;

export type MessageParams = Record<string, string | number>;

/** Replaces `{name}` placeholders; unknown placeholders are left in place so a typo is visible. */
export function format(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

export function t(key: MessageKey, params: MessageParams = {}): string {
  return format(en[key], params);
}

export function movesLabel(count: number): string {
  return t(count === 1 ? 'moves.one' : 'moves.other', { count });
}

export function timePerMoveLabel(timePerMove: TimePerMove): string {
  return timePerMove === null ? t('time.per_move.none') : t(`time.per_move.${timePerMove}`);
}

export function timeSpanLabel(seconds: TimePerMoveSeconds): string {
  return t(`time.span.${seconds}`);
}

export function endReasonLabel(reason: EndReason): string {
  return t(`end_reason.${reason}`);
}

export function resultLabel(result: GameResult): string {
  return t(`result.${result}`);
}

export function ratedLabel(rated: boolean): string {
  return t(rated ? 'game.rated' : 'game.casual');
}

/** Provisional ratings carry a `?` suffix (spec §5.4). */
export function ratingLabel(rating: number, provisional: boolean): string {
  return `${Math.round(rating)}${provisional ? '?' : ''}`;
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './i18n';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/test/i18n.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; 190 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add the English message catalog and label helpers"
```

---

## Self-review

**Spec coverage (plan 1 scope):** §5.3 payload and callback formats → Task 2; §9 error codes and DTO shapes → Tasks 2–3; §7.2 arbiter including the en passant key case, mandatory promotion, precedence → Task 4; §7.6 PGN headers and analysis URL → Task 5; §7.3 clock formulas → Task 6; §7.5 Glicko-2 constants, vector, inactivity, floor/ceiling, provisional threshold → Task 7; rebuild-by-replay and snapshots → Task 8; §5.4/§5.5/§5.7 copy and §13 externalised strings → Task 9; §16 tooling and CI skeleton → Task 1. Deferred to later plans by design: the card renderer (needs Telegram entities; plan 3), the public id generator (needs a CSPRNG in the server; plan 2), the Mini App strings (plan 4).

**Placeholder scan:** none; every step carries its code and expected output.

**Type consistency:** `TimePerMove` is `number literal | null` everywhere; `Colour` is `'white' | 'black'`; `WinDrawLossSchema` (not `Record`, which would shadow the TypeScript utility type) is used by both `LeaderboardEntrySchema` and `PlayerPageDtoSchema`; `applyMove` returns the normalised `uci` that Task 3's `MoveDtoSchema` validates; `Score` from Task 7 is the type Task 8's `scoreFor` returns.

**Review Focus:** all five lines have their tests in the named tasks.
