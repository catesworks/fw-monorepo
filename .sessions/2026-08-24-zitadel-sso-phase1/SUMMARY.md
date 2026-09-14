# Summary — Zitadel SSO: Phase 0 gap closure + Phase 1 planning (2026-08-24)

## Goal

Continue the suite-wide SSO/SAML/SCIM migration (`sso-saml-scim-platform-identity.md`):
close the RLS false-alarm and 4 Phase 0 gaps, resolve a real contradiction in the
plan's identity-correlation decision, then plan and begin Phase 1 (rolodex's
production Zitadel cutover).

## What was done

### RLS check (4 apps)

- Investigated the plan's own "any RLS keyed on `auth.uid()`" open question.
  **False alarm** — all 5 apps are already safe via 3 different valid
  mechanisms (dropped policy / revoked default grants). No code change. Result
  recorded in `sso-saml-scim-platform-identity.md`'s "Checked and cleared" section.

### cogs — Phase 0 gaps 1, 2, 4 + Gap 3's userinfo helper

- `packages/auth/src/verify.ts` — added `checkAuthorizedParty` (azp/client_id
  cross-app token isolation).
- `packages/auth/src/plugins/claim-utils.ts` — flat-key-first lookup (dotted
  claim keys), array-wrapped role-claim handling.
- `packages/auth/src/plugins/userinfo.ts` — extracted `fetchUserinfo` as a
  standalone exported helper.
- Committed `4b849a3`, published as **`@cogs/auth@0.6.0`** via the changesets
  "Version Packages" PR (`89b2981`) → OIDC trusted publishing on npm.

### rolodex — Gap 2 + Gap 3 (JIT provisioning + enrichment)

- `packages/db/src/schema.ts` + migration `0012_daily_orphan.sql` — additive
  `zitadel_subject` column, no backfill.
- `apps/api/src/auth/middleware.ts` — `jitProvisionUser` lookup order:
  `zitadel_subject` → `providerSubject` → legacy id-as-sub → create. Userinfo
  enrichment (email/name) for tokens missing them, with negative + positive
  caching.
- Committed `fbbcd82`; dependency bump to `@cogs/auth@^0.6.0` in `34d5a1a`;
  format fix `2fdb067`. All CI green.
- ai-slop-cleaner pass run across both repos' changed files — no changes
  needed (already clean).

### yellow-pages — pushed 2 stale-unpushed plans + a real e2e fix

- Discovered `main` was 9 commits ahead of `origin/main` — two **fully
  completed** independent plans (`semantic-operational-graph`,
  `bidirectional-saas-connectors`, both through their real Phase 1-3, Phase 4
  explicitly cut from scope in each plan) had never been pushed.
- Ran `/e2e-check` against the local dev stack: 18 failed / 1 skipped / 105
  passed. Root-caused and fixed two real sticky-header CSS bugs (`overflow-x`
  without `overflow-y` coercion; a zero-headroom topbar wrapper), two stale
  e2e assertions, and a dev-tooling click-interception bug. Commit `04ca7f7`.
  Re-verified: 123 passed / 1 skipped (pre-existing, out of scope) / 0 failed.
- Wrote ADRs 0001/0002 documenting both root causes; committed `1617227`.
- Pushed all 10 commits to `origin/main`; CI green.

### fleetworks-monorepo — identity-correlation decision (Decision 5)

- Found a real contradiction: Decision 5's original text (email correlation)
  vs. the Phase 0 spike's own later finding (SCIM `externalId` is cleaner,
  "should replace" it) — never reconciled in the document.
- Drafted `.omc/plans/identity-correlation-externalid-decision.md`. **3 rounds
  of codex critic review**: REJECT (conflated `externalId`-locates-a-row with
  the value actually stored in `zitadel_subject`; missed a cardinality gap —
  one Zitadel `externalId` field can't equal 4 apps' independent local user
  IDs) → REVISE (a live acceptance criterion + a historical line still needed
  correcting) → **APPROVED**.
- Ralph executed the approved plan: 7 precise edits to
  `.omc/plans/sso-saml-scim-platform-identity.md` (Decision 5 amended with the
  corrected two-step mapping; D2 marked out of scope; architecture diagram
  clarified; Phase 0's historical line dated; Phase 1 task + risk-mitigation
  row + the live "Identity migration" AC all corrected; new dated cross-app
  survey section appended with chorus/helmsman/warden's existing
  `providerSubject` mechanism + concrete duplicate-row blast radius per app).
- Final codex reviewer pass on the executed diff: **APPROVED**, zero files
  changed outside the one doc.
- Note: `.omc/` is gitignored repo-wide here — this work is real and complete,
  but is a local planning artifact, not a commit. `diff --no-index` against a
  pre-edit snapshot was used as the actual scope-proof instead of `git diff`.

### fleetworks-monorepo — local Zitadel infra

- Restarted the local Zitadel Docker stack (`infra/zitadel-local`, already
  committed by a prior session at `86b5529`) — was down since the Phase 0
  spike's own cleanup.
- Re-seeded (`ZITADEL_BASE_URL=http://localhost:8089 node seed.ts`): org
  "Fleetworks", project "Fleetworks Suite", 2 roles, 5 per-app OIDC clients, 2
  test users. Generated `infra/zitadel-local/generated-client-env.md`
  (gitignored).

### Phase 1 planning (rolodex) — drafted, REVISE'd, not implemented

- Cross-app survey (3 parallel research agents on chorus/helmsman/warden):
  confirmed all three already ship the same `providerSubject` column + 3-tier
  JIT-lookup shape rolodex's Gap 2 added — helmsman's is real prior art
  (`docs/adr/0003-supabase-backend-migration.md:29`) from an actual prior
  Zitadel→Supabase migration.
- **Major finding, independently confirmed via two dated internal sources**
  (rolodex's own `docs/sessions/2026-08-07-runtime-env-prod-launch/ARCHITECTURE.md`
  and `zitadel-local/README.md`): rolodex's production login **already**
  federates through Zitadel today, via Supabase's `custom:fleetworks` OIDC
  connection — Option A (federate into Supabase), not the plan's target
  Option B (Zitadel issues tokens directly). The master plan's own "Grounded
  facts" section doesn't mention this at all.
- User's call, given real user count is near-zero (the user + seed/test
  accounts): **clean cutover** to Option B — no dual-accept, no backfill
  pipeline, hand-fix the handful of real accounts, retire the
  `custom:fleetworks` button.
- Drafted `rolodex/.omc/plans/zitadel-sso-phase1-cutover.md`. Codex critic
  review: **REVISE**, with 5 concrete, real problems — see `FOLLOWUPS.md`.
  **No implementation code has been written for Phase 1.**

## Verification

- cogs: `pnpm test` (237/237, `@cogs/auth`), `tsc --noEmit` clean.
- rolodex: `npx vitest run apps/api/src/auth` (26/26 auth-scoped), full suite
  527/527, `pnpm typecheck` clean (both `apps/api` and `apps/web`).
- yellow-pages: `pnpm test:e2e` 123 passed / 1 skipped / 0 failed (run twice),
  `tsc --noEmit` clean.
- fleetworks-monorepo identity-correlation edit: `diff --no-index` snapshot
  review (every changed hunk mapped to one of the 7 approved edit points),
  `git status --short` clean in all 5 repos, final codex reviewer APPROVED.
- Phase 1 cutover plan: **not implemented, not verified** — blocked on REVISE.

## Commits

| SHA       | Repo                | Message                                                               | Pushed?                                |
| --------- | ------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `4b849a3` | cogs                | fix(auth): SSO-SAML-SCIM Phase 1 gaps                                 | yes                                    |
| `89b2981` | cogs                | Version Packages (#2) — publishes `@cogs/auth@0.6.0`                  | yes                                    |
| `fbbcd82` | rolodex             | feat(auth): SSO-SAML-SCIM Phase 1 — zitadel_subject + JIT correlation | yes                                    |
| `34d5a1a` | rolodex             | chore(deps): bump @cogs/auth to ^0.6.0                                | yes                                    |
| `2fdb067` | rolodex             | style: prettier-format migration 0012 meta files                      | yes                                    |
| `04ca7f7` | yellow-pages        | fix(web): fix broken sticky table/topbar headers, ...                 | yes                                    |
| `1617227` | yellow-pages        | docs(session): dossier for e2e-sticky-headers session                 | yes                                    |
| —         | fleetworks-monorepo | identity-correlation decision + master plan amendment                 | N/A — `.omc/` gitignored, not a commit |

## Out of scope / deferred

- Phase 1's actual implementation (dual — now single-path cutover) — see `FOLLOWUPS.md`.
- Phase 2 (SCIM provisioning + directory reconciliation), Phase 3 (SAML), Phase 4 (other 3 apps) — untouched, per the master plan's own sequencing.
- Master plan D2's `directory_users` correlation — explicitly deferred to its own future decision (recorded in the amended plan).
