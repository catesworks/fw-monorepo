# ADR 0006: @cogs/kubb-transforms rollout to the fw-* API clients (fw-fgi)

- Status: Proposed
- Date: 2026-10-01
- Bead: fw-fgi (epic, central `fw-beads` tracker, label `app:fleet`)
- Scope: fw-chorus, fw-helmsman, fw-rolodex, fw-warden, fw-yellow-pages
- Packages: `@cogs/kubb-transforms`, `@cogs/fetch-client`, `@cogs/react-query`, all `0.2.0` on npm

## Context

The epic says "migrate the 5 repos' hand-rolled Kubb **v3** codemods" onto the
published `@cogs/*` packages. The inventory below shows that premise is stale:

- **All five repos are already on Kubb v4** (`@kubb/*` `^4.37.0`).
- **None has a hand-rolled codemod.** No `hooks.done` in any `kubb.config.ts`,
  no `jscodeshift`, no `transform-kubb*` script, nothing under `scripts/` that
  post-processes generated code. Generated output is raw Kubb + Kubb's own
  Prettier pass.
- What each repo *does* hand-roll is the **seam pair**: a local
  `packages/fetch-client` (77-line `xior` wrapper) and `packages/react-query`
  (TanStack re-export + `createQueryClient` + `hashKey(s)`). Those are
  byte-identical across all five repos apart from the npm scope and a header
  comment.

So the epic is really two separable decisions: (A) adopt the codemods, and (B)
replace the local seam packages with `@cogs/fetch-client` / `@cogs/react-query`.

### Inventory (heads: chorus `bf397eb`, helmsman `ffd31f1`, rolodex `929b6c2`, warden `45cc49b`, yellow-pages `f7910dc`)

| Repo | Generated pkg | Gen files | Kubb config shape | Seam pkgs | xior-specific app code | `z.object({}).catchall` sites |
| --- | --- | --- | --- | --- | --- | --- |
| yellow-pages | `@yellowpages/yellowpages-api` | 346 | tag-grouped, `paramsType: object`, `operations: true`, `.ts` import ext, zod `typed: true`, `check` script | `@yellowpages/{fetch-client,react-query}` | `setup-token-refresh.ts` (refresh+retry on 401), `state-attributes.ts` (reads `error.response.data`) | yes |
| chorus | `@dns/chorus-api` | 127 | same template as yellow-pages | `@dns/*` | 2 files | 0 |
| rolodex | `@rolodex/rolodex-api` | 259 | same template | `@rolodex/*` | 3 files | yes |
| helmsman | `@helmsman/helmsman-api` | 459 | same template, but **extensionless** imports (`extension: {'.ts': ''}`), routes lack `operationId` | `@helmsman/*` | 2 files | yes |
| warden | `@tfe/warden-api` | 78 | **different**: bare `group: {type:'tag'}`, default `paramsType`, no `operations`, no `typed` zod, no import-ext setting, no `check` script; stray empty `packages/gatehouse-api/` | `@tfe/*` | 2 files | 0 |

## Decision

### Clusters

1. **Template cluster** — yellow-pages, chorus, rolodex. Identical Kubb config
   and seams; only scope names and spec content differ. **Pilot: yellow-pages**
   (largest of the three, and the only one exercising both zod passes heavily
   plus a `check` script that enforces generate-is-clean).
2. **Template + extensionless** — helmsman. Same as cluster 1 except import
   specifiers and missing `operationId`s. Validate separately: it is the
   largest output (459 files), and the missing ids matter if `confKey` is ever
   enabled (the client pass names operations by file basename).
3. **Divergent config** — warden. Different `paramsType`/grouping means
   different raw shapes for the URL-helper and hooks passes; must be its own
   pilot, not batch-applied.

### Phase A — codemods only (this epic's core; transport untouched)

Wire `@cogs/kubb-transforms` as `hooks.done`, followed by Prettier, with a
`kubb-transforms.config.ts` that points `fetchClient`/`reactQuery` at the
repo's **existing** local seams and enables only behavior-neutral passes:

| Pass | Setting | Why |
| --- | --- | --- |
| banner strip, import merge, URL-helper collapse, `requestData` rename | on (defaults) | pure reshaping; URL helpers become exported (additive) |
| `hooks.errorAlias`, `hooks.queryOptsParam` | on (defaults) | type alias + additive third param defaulting to `{}` |
| `zod.catchallToRecord` with `recordKeyType: 'z.string()'` | on | Zod 4 needs two-arg `z.record`; parse results identical for JSON input |
| `zod.mergeIntersections` | on (default) | no-op where no `.and()` is emitted |
| `clients.confKey` | **unset** | single API per app, no operations registry to route through |
| `hooks.placeholderData`, `hooks.nextTags` | **off** | runtime behavior changes (cached placeholder rows, Next fetch tags) — opt-in later per app |
| `hooks.mutationLifecycle` | **off** | 0.2.0 seams drop the return value of caller `onSuccess/onError/onSettled`, so TanStack stops awaiting a returned promise (e.g. `invalidateQueries`). Re-enable after a cogs fix |

Per repo: `pnpm --filter <api-pkg> add -D @cogs/kubb-transforms@0.2.0`, add
the config file, add it to the api package `tsconfig.json` `include` and to the
root ESLint `additionalIgnores` (next to `**/kubb.config.ts`), `pnpm generate`
against the committed `openapi.json` (never a live URL), review, commit.

### Phase B — seam replacement (separate beads, not part of the pilot)

`@cogs/fetch-client` is API-compatible with the local seam's `configureClient`
/ `ClientConfig` / Kubb types, but it is **not** a drop-in:

- it is native `fetch`, not `xior`: `getClientInstance()` returns a
  `FetchClient`, so every app's `setupTokenRefreshWithRetry(XiorInstance)`
  (refresh + single retry on 401) must be re-implemented. Its
  `ResponseInterceptor` only observes successful responses, so the retry has
  to wrap the `client` function or move into the cogs package;
- errors become `FetchClientError` (`.status`, `.data`) instead of `XiorError`
  (`.response.status`, `.response.data`). yellow-pages `state-attributes.ts`
  already reads both shapes; other repos must be audited.

`@cogs/react-query` changes `createQueryClient` defaults: no retry on
terminal 4xx and `mutations.retry: false` (local seams retry every query 3×).
Low risk, but behavioral; land it as its own commit per repo. It is a
prerequisite only if `hooks.nextTags` is turned on (needs `nextHashKeys`).

## Pilot result (yellow-pages, Phase A)

Commit `5f3662d` in fw-yellow-pages: `refactor(api-client): migrate to
@cogs/kubb-transforms (fw-fgi pilot)`.

- Installed `@cogs/kubb-transforms@0.2.0` from the npm registry (lockfile:
  additions only — jscodeshift 0.15.2 + its babel/flow deps).
- Regenerated from the committed `openapi.json`; no network, no live API.
  289 of 346 files changed (+1719/−2546). A second `pnpm generate` produced a
  byte-identical diff (idempotent; the `check` script stays green).
- Diff review: banner removal; `import client, { type … }` merges;
  `getXUrl()` now exported and returning a string (`.url.toString()` →
  `.toString()`); `requestData` → `data`; `XErrorResponse` aliases;
  optional `queryOpts` spread after `queryFn`; 18 request schemas and ~60
  properties `z.object({}).catchall(X)` → `z.record(z.string(), X)`.
  Catchall vs record checked at runtime under the repo's Zod 4 over
  objects/arrays/null/primitives/null-prototype: identical except for a
  `Date` instance (not reachable from JSON). No app code imports the
  generated zod schemas.
- With `mutationLifecycle` on (first attempt) the seam drops callers'
  promises. No yellow-pages caller passes mutation options today, so there
  was no behavior change, but it was turned off rather than committed as a
  latent bug.
- `pnpm typecheck` 0, `pnpm lint` 0 errors, `pnpm format:check` clean,
  `pnpm test` 728/728 (all web suites that consume the client pass).

## Verification (per repo)

1. `pnpm --filter <api-pkg> generate` twice → second run adds no diff.
2. `git diff --stat -- packages/<api>/src` reviewed by category, as above;
   any change outside those categories blocks the merge.
3. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (DB suites
   only against a throwaway Postgres on a non-default port via
   `TEST_DATABASE_URL`, never `localhost:5432`).
4. The api package's `check` script, where present (warden has none: add one or
   run the generate+diff manually).
5. A dev-server smoke test (one list page, one mutation) — not done in the pilot.

## Rollback

Each repo's migration is a single commit touching only `kubb.config.ts`, the
new config, `package.json`, the lockfile, `tsconfig.json`, `eslint.config.js`
and generated `src/`. `git revert <sha>` then `pnpm install` restores it; or
delete the `hooks.done` entry and regenerate. Nothing at runtime depends on
the transforms package (it's a devDependency).

## Effort

| Item | Estimate |
| --- | --- |
| chorus, rolodex (copy the pilot config, regenerate, review) | ~0.5 h each |
| helmsman (extensionless + 459 files to review) | ~1 h |
| warden (own pilot, different raw shapes) | ~1.5–2 h |
| Phase B per repo (fetch transport + token-refresh rewrite + tests) | ~0.5–1 day each; do one first |
| cogs fix: lifecycle seams should `return` the caller's result | small, in cogs |

## Risks

- `@cogs/kubb-transforms` 0.2.0 was verified against Kubb 4.39.3 scratch
  output; the fleet pins `^4.37.0`. A Kubb minor that changes raw shapes can
  make passes silently skip (they match AST shapes), so step 2 above is
  load-bearing on every Kubb bump.
- The TS config file loads through Node's native type stripping (Node ≥ 22.18).
  The pilot ran on Node 24.1. Repos that say `>= 22` in `engines` need ≥ 22.18
  locally and in CI, or a `.json` config.
- `hooks.done` uses `pnpm exec`, so generation needs pnpm on PATH (it already
  does via the `generate` script).
- The transforms reprint long lines; the trailing Prettier hook is required or
  `format:check` fails.
