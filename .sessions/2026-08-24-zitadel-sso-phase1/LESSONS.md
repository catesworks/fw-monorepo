# Lessons — Zitadel SSO Phase 0/1 (2026-08-24)

## Zitadel issues opaque access tokens by default, not JWTs

- **What happened:** Planned Phase 1 around `@cogs/auth`'s `verifyToken()`
  parsing a Zitadel-issued access token as a JWT. Codex critic review caught
  that `fleetworks-monorepo/infra/zitadel-local/seed.ts` never configures
  `accessTokenType` on the created OIDC apps.
- **Why:** Zitadel's default access-token format is opaque (a reference token),
  not a JWT — this has to be explicitly requested per-client. This was flagged
  as a caveat in the original Phase 0 spike record but wasn't carried forward
  into the seed script or this session's Phase 1 plan.
- **How to apply:** Before writing or trusting ANY plan that assumes a Zitadel
  access token is JWT-verifiable, confirm the specific OIDC client's
  `accessTokenType` setting — don't assume it from the issuer being Zitadel.
- **Evidence:** `fleetworks-monorepo/infra/zitadel-local/seed.ts:245` (app
  creation, no `accessTokenType` set); codex critic finding, 2026-08-24.

## `@cogs/auth`'s issuer/devSecret branches are mutually exclusive at runtime

- **What happened:** Designed an e2e test bypass assuming `AUTH_ISSUER` (real
  Zitadel JWKS) and `AUTH_DEV_SECRET` (HS256 bypass) could both be configured
  simultaneously in the same running API process, with the app choosing
  per-request. Wrong — `verify.ts`'s control flow is `if (config.issuer) ...
else if (config.devSecret) ...`: whichever is set first in that chain wins
  unconditionally, for every request.
- **Why:** I had read this exact code earlier in the same session (for a
  different reason — confirming multi-issuer support didn't exist) and still
  produced a plan that assumed the two paths could coexist. Re-reading your
  own research isn't a substitute for re-checking a new design against it.
- **How to apply:** A test/dev bypass that needs a _different_ verification
  path than production needs a genuinely separate process/config (a distinct
  test-stack launch with `AUTH_ISSUER` unset), not a "both configured, pick at
  runtime" design against this package as it exists today.
- **Evidence:** `cogs/packages/auth/src/verify.ts:113-137`; codex critic
  finding against `rolodex/.omc/plans/zitadel-sso-phase1-cutover.md`.

## SCIM PATCH-by-id 404s on a freshly-reseeded local Zitadel instance

- **What happened:** The Phase 0 spike (2026-08-23) recorded `externalId`
  round-tripping and being filterable via SCIM against this same local
  Zitadel stack. Re-verifying it this session (after a full stack teardown +
  reseed) found: `GET /scim/v2/{org}/Users?filter=...` (list) works and finds
  users correctly, but `GET`/`PATCH /scim/v2/{org}/Users/{id}` (single-user,
  both read and write) consistently 404s with `Errors.User.NotFound` — same
  internal error id on both the query and command side, despite the same user
  being present in the list/filter response.
- **Why:** Not fully root-caused. Possibly a command/query projection
  desync specific to this Zitadel version on a fresh bootstrap, not present
  in the longer-running instance the original spike tested against. Not
  confirmed either way — spent real time trying header variants
  (`X-Zitadel-Orgid`) with no success, then stopped rather than keep
  burning time on a secondary re-verification.
- **How to apply:** Before Phase 1's account-fix step (or anything else that
  needs to write to a specific Zitadel user by id via SCIM), re-test the
  single-user PATCH path fresh against whatever Zitadel instance will actually
  be used — don't assume the Phase 0 spike's finding still holds without
  re-checking, especially after a stack teardown/reseed.
- **Evidence:** direct `curl` testing this session, 2026-08-24 (test user
  `test-admin@fleetworks.dev`, Zitadel user id `387709031218717699`); no
  actual mutation landed (confirmed via list/filter re-check showing
  `externalId: None` afterward) — the live instance's data was not corrupted
  by this testing.

## A backgrounded research agent can die silently with no final notification

- **What happened:** Launched 3 parallel research agents; one (doing real live
  HTTP verification against the Zitadel instance) sent one partial-progress
  notification, then never sent a completion notification. Waited roughly 6
  hours (across several user check-ins) before treating it as dead.
- **Why:** The Agent tool's own documented failure mode — an agent can die on
  a terminal API error after retries and simply stop producing notifications;
  there's no automatic timeout-and-report.
- **How to apply:** If a background agent goes quiet for an unusually long
  time relative to the task's expected scope, check its live status via
  `TaskOutput(task_id, block=false)` (a `"No task found"` result confirms it's
  gone) rather than continuing to wait indefinitely. Re-do the remaining
  verification directly/quickly rather than re-launching an equivalent
  long-running agent from scratch.
- **Evidence:** agent id `afed667a64714a9ea`, this session, 2026-08-24.

---

Candidates to promote into long-term memory (if the project has a memory system):

- [ ] Zitadel local infra (`fleetworks-monorepo/infra/zitadel-local`) issues
      opaque access tokens by default — any app repointing `@cogs/auth` at it
      needs `accessTokenType: JWT` configured on its OIDC client first.
- [ ] `@cogs/auth`'s `verifyToken()` treats `issuer` and `devSecret` as
      mutually exclusive per-process, not per-request-selectable — relevant to
      any future e2e/test-bypass design across chorus/helmsman/warden too.
