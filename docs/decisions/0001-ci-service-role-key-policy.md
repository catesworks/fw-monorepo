# ADR 0001: CI service-role key policy (fw-tng)

- Status: Accepted
- Accepted 2026-10-02; approver: the user (decision relayed by fw-beads-6e)
- Date: 2026-10-01
- Bead: fw-tng (parent fw-zso)
- Scope: fw-rolodex, fw-chorus, fw-helmsman, fw-warden, fw-yellow-pages

## Context

Four session dossiers (warden, chorus, yellow-pages, helmsman) flagged that the Supabase service-role key (`SUPABASE_SECRET_KEY`) is stored as a GitHub Actions secret in each repo so the manual "Lighthouse CI (live)" workflow can log in by minting an admin magic link for an existing test user. That key bypasses RLS on the whole project, and no rotation or scoping policy exists for it.

The fleet has since moved to Zitadel. State of each repo at `main` on 2026-10-01 (judged from code; no workflow was run):

| Repo            | Workflow references the key                                                      | What `apps/web/lighthouse-auth.cjs` reads                             | Result                                                                                              |
| --------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| fw-rolodex      | no; passes `TESTING_DRAIN_TOKEN` (`.github/workflows/lighthouse-ci-live.yml:52`) | `TESTING_DRAIN_TOKEN`, calls `/internal/testing/zitadel-session`      | Compliant. Magic-link route deleted in a84723e.                                                     |
| fw-chorus       | yes (`lighthouse-ci-live.yml:49-51`)                                             | `SUPABASE_SECRET_KEY`, Supabase `generate_link`, then `/auth/confirm` | Broken: `/auth/confirm` no longer exists; no `/internal/testing/zitadel-session` route in the API.  |
| fw-yellow-pages | yes (`:49-51`)                                                                   | `SUPABASE_SECRET_KEY`, `/auth/confirm`                                | Broken, same as chorus.                                                                             |
| fw-helmsman     | yes (`:49-51`)                                                                   | `LHCI_ZITADEL_TEST_LOGIN_NAME`, `TESTING_DRAIN_TOKEN`, `LHCI_API_URL` | Broken: script throws at its first check because none are passed; the key is passed but never read. |
| fw-warden       | yes (`:51-53`)                                                                   | `TESTING_DRAIN_TOKEN`                                                 | Broken: script throws at its first check; key passed but never read.                                |

The key's runtime use (Render/Vercel env, `secrets.manifest.yml`, `device-store.ts`, `seed-auth` scripts) is out of scope. rolodex `render.yaml:96-101` already states the rule: it stays on the server and never goes in a GitHub secret.

## Decision

1. No fw-* repo holds `SUPABASE_SECRET_KEY` (or any Supabase service-role/secret key) as a GitHub Actions secret. CI login for Lighthouse uses the rolodex pattern: the runner holds only a narrow `TESTING_DRAIN_TOKEN`; the API's `/internal/testing/zitadel-session` returns real Zitadel tokens for one allowlisted test account; the web app's `/auth/testing-session` turns them into a session cookie.
2. `TESTING_DRAIN_TOKEN` is the only login secret CI holds. It is stored as a GitHub Environment secret (`lhci-live`), different per repo and environment, and only able to mint a session for that repo's allowlisted LHCI account, which holds the lowest role (copy helmsman's `lhci-bot`, `org:viewer` in a dedicated org).
3. Rotation: rotate `SUPABASE_SECRET_KEY` once per repo after the GitHub secret is deleted (treat as exposed), then every 180 days or on staff change/incident, through the 1Password + env-sync pipeline so runtime holders update together. Rotate `TESTING_DRAIN_TOKEN` every 90 days and on any leak. (Unverified: whether each Supabase project supports per-consumer secret keys.)
4. Deletion order per repo: merge the workflow change, run the live workflow once and confirm logged-in pages are audited, delete the `SUPABASE_SECRET_KEY`, `SUPABASE_URL`, `LHCI_TEST_USER_EMAIL` Actions secrets, then do the one-time rotation.

## Per-repo changes

- **fw-rolodex:** no workflow change; add `environment: lhci-live` to the job.
- **fw-warden:** `lighthouse-ci-live.yml:51-53`: delete `LHCI_TEST_USER_EMAIL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`; add `TESTING_DRAIN_TOKEN`. Add `environment: lhci-live`. Make sure the production API has `TESTING_DRAIN_TOKEN` set.
- **fw-helmsman:** `:49-51`: delete the same three; add `TESTING_DRAIN_TOKEN`, `LHCI_ZITADEL_TEST_LOGIN_NAME`, `LHCI_API_URL` (no default API URL). Add `environment: lhci-live`. Decide `render.yaml:88-91`, which says to leave `TESTING_DRAIN_TOKEN` unset in production (makes the live audit impossible): set it in prod and update the comment, or point the workflow at a non-prod deploy. Fix the stale "Supabase magic link" comment at `apps/web/lighthouserc.live.cjs:10-12`.
- **fw-chorus:** `:49-51`: delete the three; add `TESTING_DRAIN_TOKEN`; `environment: lhci-live`. Port first from rolodex: `apps/api/src/routes/testing.ts` (+ test), `apps/web/src/app/auth/testing-session/route.ts`, `apps/web/lighthouse-auth.cjs`, and the `TESTING_DRAIN_TOKEN` env entry. Until then set `AUTH_PATHS = []` at `apps/web/lighthouserc.live.cjs:14` with a comment pointing at this ADR.
- **fw-yellow-pages:** `:49-51`: same as chorus; same port; `AUTH_PATHS = []` at `apps/web/lighthouserc.live.cjs:12` until then. The comment at `:10-11` ("logs in via the password form") is stale.

## Consequences

- A leaked CI secret yields a viewer-level test session, not RLS-bypassing database access.
- Fixes four Lighthouse live workflows that look broken today.
- Cost: chorus and yellow-pages need ~0.5 day each to port the token-mint route (adds a drain-token-gated mint endpoint to their production API; it fails closed when the token is unset). One-time service-role rotation per Supabase project must go through env-sync.
- No rotation was performed while writing this ADR.

## Alternatives considered

| Option                                                           | Pros                                        | Cons                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Keep the key in a GH Environment secret with a required reviewer | Smallest change                             | Still a full RLS-bypass key in CI; the magic-link flow no longer works post-Zitadel |
| Per-repo drain-token mint (chosen)                               | Narrow secret; proven in rolodex and warden | Port needed in chorus and yellow-pages; test-only endpoint in prod                  |
| Drop logged-in Lighthouse audits                                 | Zero secrets                                | Loses dashboard performance coverage                                                |

## Amendment 2026-10-02: decision 2 blast radius (fw-uwku)

Status stays Accepted. An independent review (2026-10-01, noted on bead fw-uwku) found that decision 2 understates the exposure:

- The drain-token allowlist limits the **route** (`/internal/testing/zitadel-session` mints only for one allowlisted account). It does not limit the **API process** that serves the route. That process holds `ZITADEL_SEED_BOT_PAT` (IAM_OWNER) and `ZITADEL_LOGIN_CLIENT_PAT` (IAM_LOGIN_CLIENT) in its environment. Either credential can log in as any user in any org without a password (`infra/zitadel-local/force-sso-enforcement-findings.md`). Anyone with code execution or env access in that process has that power, whatever `TESTING_DRAIN_TOKEN` says.
- Unsetting `TESTING_DRAIN_TOKEN` disables the route but leaves both PATs in the environment.
- There are more production holders than the original scope suggests: fw-chorus (ada35a8) and fw-yellow-pages (3f3cf1d) add two more.

Amended wording of decision 2: `TESTING_DRAIN_TOKEN` is the only login secret **CI** holds, and the route can only mint for the allowlisted account. The consequence "a leaked CI secret yields a viewer-level test session" holds for CI. It does not hold for the API process, which must be treated as a holder of credentials that can impersonate any user until the controls below are in place.

Required follow-ups (tracked in fw-uwku):

1. Deploy the Actions V2 two-part gate (session gate + finalize gate, HTTPS, signed, fail-closed by default) before force-SSO is offered to any customer. Artifacts: `infra/zitadel-local/force-sso-gate/`; operations and rollout runbook: `infra/zitadel-local/force-sso-gate-ops.md`. Production apply needs the owner's approval.
2. Move the mint routes off the `seed-bot` (IAM_OWNER) PAT to a dedicated IAM_LOGIN_CLIENT "test-mint" machine user; keep only the Login UI and that user as login-client holders (findings, recommendations 2-3).
3. Do not set the two PATs or `TESTING_DRAIN_TOKEN` in any API environment that does not run Lighthouse/e2e. Rotate both PATs on the admin-credential schedule.
