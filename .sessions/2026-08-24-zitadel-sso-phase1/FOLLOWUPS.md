# Follow-ups — Zitadel SSO Phase 0/1 (2026-08-24)

## Blocked on the user (decisions / approvals / access)

- [ ] None currently — the last open decision (clean cutover vs. dual-accept,
      given near-zero real users) was already made this session. Everything
      below is blocked on work, not on a pending decision.

## Blocked on work (do next)

The Phase 1 cutover plan (`rolodex/.omc/plans/zitadel-sso-phase1-cutover.md`)
got a codex critic **REVISE** verdict with 5 concrete findings. In recommended
order:

- [ ] **Fix Zitadel's opaque-token default.** `fleetworks-monorepo/infra/zitadel-local/seed.ts`
      needs to configure the Rolodex OIDC app for JWT access tokens
      (`accessTokenType`), not the current opaque default. Verify with a real
      login that `@cogs/auth`'s `verifyToken()` can actually parse the result.
      This is the one purely mechanical, no-design-decision item — do it first.
- [ ] **Decide the session architecture** (the one real design fork): a
      same-origin BFF/proxy (web's own routes hold the token server-side,
      proxy authenticated requests to the API) vs. a session endpoint that
      hands the browser a short-lived access token. Current recommendation
      leans BFF/proxy (keeps tokens off the browser entirely; rolodex's
      `use-access-token.ts` already centralizes API calls through one seam).
      Whichever is chosen, inventory every consumer of the current Supabase
      session (`useSupabaseSession`, `providers.tsx`, `dashboard/layout.tsx`,
      `public-home-chrome.tsx`, `userinfo-roles.ts`, device-check, both logout
      sites) and design refresh/expiry/CSRF/PKCE-state-cookie handling
      explicitly.
- [ ] **Redesign the e2e bypass** around the issuer/devSecret mutual-exclusion
      finding (see `LESSONS.md`) — a genuinely separate test-stack launcher
      (API started with `AUTH_ISSUER` unset, `AUTH_DEV_SECRET` set) rather than
      the original same-process design. Add a production-startup assertion
      that refuses `E2E_AUTH_BYPASS=true`.
- [ ] **Complete the auth-surface inventory**: signup, forgot/reset password,
      `/auth/confirm`, device-check, and both logout sites all still need an
      explicit decision (remove, redirect, or keep + update their e2e tests).
- [ ] **Write the real cutover runbook**: exact row counts for the real
      accounts, backup before mutating, deploy-ordering (web/API), a short
      maintenance window, forced reauthentication, rollback values — not the
      vague "one-off script" the first draft had.
- [ ] Re-submit `zitadel-sso-phase1-cutover.md` for another codex critic pass
      once the above are addressed, before handing to Ralph for
      implementation.
- [ ] **Investigate the SCIM PATCH-by-id 404** (see `LESSONS.md`) before
      relying on it for the account-fix step — may need a different write
      path (management API instead of SCIM) if it doesn't resolve.

## Nice-to-have / later

- [ ] Phase 4 (chorus/helmsman/warden) correlation mechanism — explicitly
      deferred in the amended master plan, not urgent (their Phase 4
      sub-tasks haven't started).
- [ ] Phase 2 (SCIM provisioning + `directory_users` reconciliation, Decision 2) — its own future decision, informed by but not identical to this
      session's Decision 5 work.

## Known risks / watch-outs

- The local Zitadel Docker stack is **currently running** (`localhost:8089`).
  If left up indefinitely, it's a disposable/local-only instance per its own
  README, but worth remembering it's there consuming resources.
- `.omc/` is gitignored repo-wide across this suite — any future session
  verifying "did this plan's edit land correctly" must use a file
  snapshot + `diff --no-index`, not `git status`/`git diff`, for anything
  under `.omc/plans/`.
- The Phase 1 plan file itself (`rolodex/.omc/plans/zitadel-sso-phase1-cutover.md`)
  is REVISE-blocked, not approved — do not hand it to Ralph as-is.

## Done this session (for reference)

- [x] RLS false-alarm documented, no code change (`sso-saml-scim-platform-identity.md`)
- [x] Gaps 1/2/3/4 closed in cogs (`4b849a3`) + rolodex (`fbbcd82`)
- [x] `@cogs/auth@0.6.0` published (`89b2981`)
- [x] rolodex dependency bump + format fix (`34d5a1a`, `2fdb067`)
- [x] yellow-pages: pushed 2 stale-unpushed completed plans + sticky-header e2e fix (`04ca7f7`, `1617227`)
- [x] Identity-correlation Decision 5 contradiction resolved, 3× codex-approved, executed into `sso-saml-scim-platform-identity.md`
- [x] Local Zitadel stack restarted + reseeded
- [x] Major architecture finding surfaced: rolodex already federates via Zitadel through Supabase (Option A), confirmed via two dated internal sources
- [x] Clean-cutover decision made (near-zero real users)
- [x] Phase 1 plan drafted, codex-reviewed → REVISE (5 findings recorded above)
