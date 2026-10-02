# ADR 0002: Fleet e2e auth strategy (fw-z9b)

- Status: Accepted
- Accepted 2026-10-02; approver: the user (decision relayed by fw-beads-6e)
- Date: 2026-10-01
- Bead: fw-z9b (parent fw-zso)
- Scope: fw-rolodex, fw-chorus, fw-helmsman, fw-warden, fw-yellow-pages
- Related: ADR 0001 (the `TESTING_DRAIN_TOKEN` mint path is shared with Lighthouse CI); fw-rolodex 89367cb (production boot guard)

## Context

The bead describes a "4-1 split" between bypass and real hosted login. Current code shows a 3-1-1 split.

| Repo            | Suite          | Main-suite login                                                                                                                                                                                                | Real hosted Zitadel login exercised?                                                | Prod boot guard                                                              |
| --------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| fw-rolodex      | `apps/e2e`     | HS256 bypass: `GET /auth/e2e-login` (`apps/web/src/app/auth/e2e-login/route.ts:38-60`), gated by `E2E_AUTH_BYPASS==='true' && NODE_ENV!=='production'`, signed with `AUTH_DEV_SECRET`, separate `ENV=e2e` stack | No (`tests/login.spec.ts:4-9` only checks the button renders; its comment is stale) | Yes (`packages/environment/src/environment.ts:423-442`)                      |
| fw-chorus       | `apps/e2e`     | HS256 bypass, same route, `ENV=e2e` stack                                                                                                                                                                       | No                                                                                  | No                                                                           |
| fw-yellow-pages | `apps/web/e2e` | HS256 bypass, same route, `ENV=e2e` stack                                                                                                                                                                       | Partial (`login.spec.ts:5-16` checks the handoff, doesn't finish)                   | No                                                                           |
| fw-helmsman     | `apps/web/e2e` | Real-token mint without the UI: `POST /internal/testing/zitadel-session` with `x-drain-token`, then `/auth/testing-session`; one cached session per role; no `ENV=e2e` stack                                    | Yes, once (`specs/login/login.spec.ts` via `flows/zitadel-login.ts`)                | No                                                                           |
| fw-warden       | `e2e/`         | Real hosted login for every test (`specs/auth.setup.ts`, per-test re-login fixture in `fixtures.ts:20-35` because Zitadel invalidates refresh tokens); config comment says this roughly triples per-test work   | Yes, every test                                                                     | No (API only at `apps/api/src/index.ts:31`; web has no `instrumentation.ts`) |

No repo runs Playwright in GitHub Actions today; all suites run locally against local Supabase and local Zitadel.

Constraints:

- `@cogs/auth` treats `AUTH_ISSUER` and `AUTH_DEV_SECRET` as mutually exclusive per process, so an `ENV=e2e` stack cannot accept real Zitadel tokens. A real-login test in rolodex, chorus or yellow-pages must run on the normal `ENV=dev` stack.
- Warden's real-login setup satisfies its cutover plan acceptance criterion 12 (a real local PKCE login before any production change); that must survive.
- The bypass route refuses `NODE_ENV=production` on the web side, but `AUTH_DEV_SECRET` in a production API process would make `@cogs/auth` accept HS256 tokens. Only rolodex fails the boot on that.

## Decision

Standardize the shape, not the mechanism.

1. The main suite never drives the hosted login page. Either (a) the HS256 `/auth/e2e-login` bypass on an `ENV=e2e` stack, or (b) the drain-token real-token mint. Repos keep their current mechanism.
2. Exactly one real hosted-login smoke test per app: full Auth Code + PKCE against local Zitadel (`localhost:8089`), asserts `/auth/callback` sets the session cookie and one logged-in page renders. Put it in its own Playwright project (e.g. `real-login`) targeting the `ENV=dev` stack; reuse the flows in warden `e2e/flows/zitadel-login.ts` and helmsman `apps/web/e2e/flows/`. Skip with a clear message if `localhost:8089` is unreachable.
3. Production boot guard in all five repos (copy rolodex 89367cb, ~20 lines + a test): API and web refuse to start when `NODE_ENV==='production' || ENV==='prod'` and `E2E_AUTH_BYPASS==='true' || AUTH_DEV_SECRET` is set. Do it even where `/auth/e2e-login` doesn't exist. `TESTING_DRAIN_TOKEN` stays out of the guard (accepted production secret under ADR 0001).

## Migration per repo (~4 developer-days total, independent)

- **fw-rolodex (~0.5d):** guard done. Add a `real-login` project to `apps/e2e/playwright.config.ts`, port warden's `zitadel-login.ts` flow, replace the stub in `apps/e2e/tests/login.spec.ts:4-9` and delete the stale comment.
- **fw-chorus (~1d):** guard in `packages/environment/src/environment.ts:417-423` (rename the destructured `assertValidRuntimeEnvironment` to `assertCatalogValid`, add the rolodex wrapper + test; callers `apps/api/src/index.ts:177`, `apps/web/src/instrumentation.ts:11` unchanged). Add a `real-login` project + test in `apps/e2e/src/specs/auth/login.spec.ts`.
- **fw-yellow-pages (~1d):** same guard change at `packages/environment/src/environment.ts:468-474` (callers `apps/api/src/index.ts:39`, `apps/web/src/instrumentation.ts:10`). Extend `apps/web/e2e/login.spec.ts` with one completing login in a `real-login` project on `ENV=dev`.
- **fw-helmsman (~2h):** guard at `packages/environment/src/environment.ts:570-576` (callers `apps/api/src/index.ts:163`, `apps/web/src/instrumentation.ts:10`). No suite change; `specs/login/login.spec.ts` is the real-login test.
- **fw-warden (~1d):** guard at `packages/environment/src/index.ts:148-154` (API caller passes no argument; the wrapper defaults to `process.env`; web `instrumentation.ts` optional since warden has no `/auth/e2e-login`). Switch the main suite to helmsman's mint: port `fw-helmsman/apps/web/e2e/support/testing-session.ts` into `e2e/` (server half already exists: `apps/api/src/routes/testing.ts`, `apps/web/src/app/auth/testing-session/route.ts`), rewrite `specs/auth.setup.ts` to cache a minted session, delete the per-test re-login fixture and re-export plain `@playwright/test`. Check first how a minted cookie carrying a Zitadel refresh token handles refresh rotation (helmsman shows it is workable). Keep `specs/login.spec.ts` as the real PKCE login.

## Consequences

- Fast deterministic main suites plus proof the real login works; warden's suite ~3x cheaper per test.
- `AUTH_DEV_SECRET` or `E2E_AUTH_BYPASS` accidentally set in production fails the boot instead of silently accepting forged tokens.
- Cost: bypass repos need local Zitadel for one test on a different stack (`ENV=dev`). Two mechanisms (HS256 bypass, drain-token mint) coexist; revisit if e2e moves into CI, where the drain-token mint (no separate `ENV=e2e` stack) would probably win.

## Alternatives considered

| Option                                                        | Pros                            | Cons                                                                                              |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Real hosted login everywhere (warden today)                   | Highest fidelity                | ~3x slower per test; refresh rotation forces re-login per test; brittle against the hosted page   |
| Bypass everywhere, no real login                              | Fastest                         | Nobody tests `/auth/login`, PKCE or `/auth/callback` until production; breaks warden criterion 12 |
| Bypass main suite + one real-login test + boot guard (chosen) | Speed and fidelity; small diffs | Two mechanisms; real-login test needs local Zitadel on `ENV=dev`                                  |
| Converge everyone on the drain-token mint                     | One mechanism                   | Removes working `ENV=e2e` stacks in 3 repos for no current benefit                                |
