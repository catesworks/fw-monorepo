# ADR 0002: Rolodex Phase 1 is a clean cutover, not dual-accept + backfill

- **Status:** proposed (execution plan REVISE'd by codex critic — see FOLLOWUPS.md)
- **Date:** 2026-08-24
- **Deciders:** user + session

## Context

Phase 1 as originally scoped in `sso-saml-scim-platform-identity.md` specifies
dual-accept (Zitadel-first, Supabase-fallback) plus a backfill migration,
sized for a live production user base needing zero-downtime migration. Two
facts confirmed this session change that premise:

1. Rolodex's production login **already** federates through Zitadel today —
   via Supabase's `custom:fleetworks` OIDC connection
   (`rolodex/apps/web/src/app/login/login-form.tsx:24,60-69`), confirmed by
   rolodex's own dated `docs/sessions/2026-08-07-runtime-env-prod-launch/ARCHITECTURE.md`.
   This is Decision 1's Option A (federate into Supabase), not the plan's
   target Option B (Zitadel issues tokens directly) — Option A has no SCIM
   home, so Option B is still the right end state, but "existing Supabase
   users" already includes people who log in via the Zitadel-backed button
   today; the token `sub` they have has never changed regardless of path.
2. The user confirmed real user count is near-zero (the user + seed/test
   accounts) — the protection dual-accept/backfill machinery provides has no
   real population to justify its cost here.

## Options considered

1. **Build the originally-scoped dual-accept + backfill anyway**, for
   consistency with what Phase 4 will need for the other 4 apps. Rejected:
   those apps have real user populations and their own Phase 4 sub-tasks;
   building this now for rolodex's near-zero population is pure overhead.
2. **Keep Option A (Supabase-federated login) indefinitely.** Rejected: no
   SCIM home, and SCIM is a stated product requirement.
3. **Clean cutover to Option B**: no dual-accept, no backfill pipeline;
   hand-fix the handful of real accounts with a one-off script; retire the
   `custom:fleetworks` button; rolodex's API verifies Zitadel-issued tokens
   directly.

## Decision

**Option 3.** Confirmed with the user. `@cogs/auth` needs zero code changes
for the API side (token verification is pure env config, per the Phase 0
spike's own finding) — this plan does not touch the shared package at all.

## Consequences

- **Positive:** smallest-risk path that still reaches the plan's real target
  (direct Zitadel token verification) given the actual near-zero user
  population; avoids building and testing migration machinery with nothing
  real to migrate.
- **Negative / cost:** if real signups happen before this cutover lands, the
  "hand-fix a handful of accounts" approach stops being viable and the fuller
  dual-accept/backfill design (already specified in the amended Decision 5)
  would need to be revisited.
- **Follow-on:** the execution plan for this decision
  (`rolodex/.omc/plans/zitadel-sso-phase1-cutover.md`) was drafted and sent to
  codex critic review — result: **REVISE**, 5 real findings (Zitadel's opaque
  default access tokens, `@cogs/auth`'s issuer/devSecret mutual exclusion
  breaking the planned e2e bypass, an HttpOnly session design that contradicts
  existing browser-JS token reads, an incomplete auth-surface inventory, and a
  too-vague account-fix step). **None of this has been implemented.** Full
  list and recommended order in `FOLLOWUPS.md`.

## Notes

- The clean-cutover _decision itself_ was explicitly reviewed and endorsed by
  codex critic ("optimal for 2–3 real accounts") — it's the _execution plan_
  for that decision that needs rework, not the decision.
- `cogs/packages/auth` has zero diff as a result of this decision, confirmed.
