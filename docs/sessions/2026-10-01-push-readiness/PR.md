# docs+infra: SAML brokering proof, force-SSO gate artifacts, ADRs 0001-0006 accepted (do not merge until owner pre-checks)

## Summary

25 commits (29 files, +3763/-1), docs plus local-only proof scripts and gate artifacts. No `packages/*` runtime changes.

- **SAML brokering local proof** (`infra/zitadel-local/saml-broker-demo.sh`, `saml-brokering-findings.md`) and **SAML attribute mapping via an Actions V2 hook** (fw-prs, fw-mf9). The demo generates a throwaway key at runtime; no key material is committed.
- **SCIM findings**: two-org role-claim capture on Zitadel v4.17.1 (`scim-findings.md`), duplicate-Zitadel-user SCIM hazard (FOLLOWUPS).
- **ADRs 0001-0006 are now Accepted** (2026-10-02). The approver is recorded as the user, relayed via fw-beads-6e.
- **ADR 0001 amendment** (service-role key policy) accompanies the force-SSO gate.
- **Force-SSO Actions V2 gate artifacts** (`infra/zitadel-local/force-sso-gate/`: `gate.mjs`, tests, `e2e-local.mjs`, terraform). **NOT applied anywhere.** Fail-closed by default, with a shadow mode. Unproven paths remain (see Known open issues). Bead fw-uwku.
- `docs/cogs-auth-source.md` (where `@cogs/auth` lives and how it is consumed).
- Script hardening for `saml-broker-demo.sh` and `suite-identity-check.mjs` per review (5315aa9), plus `docs/suite-identity-verification.md`.
- Force-SSO enforcement findings (fw-xw4): the login-client PAT can log in as any user.
- Housekeeping: `.beads/interactions.jsonl` syncs, prettier on decision docs.

## Migrations

None.

## Env / secrets (names only)

No env vars, secrets or GitHub settings are added by this repo. The scripts read credentials from flags or env (for example the local Zitadel admin credentials) and are local-only. The ADRs describe owner work elsewhere: the `lhci-live` Environment (fw-sfi) and the ADR 0005 production queries (fw-k4iu).

Scan note: no tokens, keys, JWTs, credentialed URLs or long base64 blobs were found in the added lines. Known benign, local-only by design: the default local test-admin password in `suite-identity-check.mjs`, and the throwaway SimpleSAMLphp user passwords in the SAML demo. No `.env*` files were added.

## Deploy / owner steps

Nothing deploys from this repo automatically. Merging to `main` runs `ci.yml` and `release.yml`. `release.yml` runs changesets, and this PR adds no changesets and touches no `packages/*`, so it publishes nothing new. Verify with the workflow runs after merge. The gate is not applied; applying it to production is an owner step (fw-uwku, still open).

## Risks

- Very low for production: no runtime code.
- The gate artifacts could be mistaken for applied enforcement. They are not applied.
- The local scripts accept credentials via flags or env and are documented as local-only.
- Terraform for the gate has no backend: the signing key would land in local state. Add an encrypted remote backend before any real apply (ops doc).
- Open policy: whether OTP-only sessions count as a force-SSO factor (needs-user, fw-zf72).

## Verification

- Clean-worktree run at `5315aa9` (Node v24.1.0, pnpm 10.33.0, `turbo --force`): install --frozen-lockfile, typecheck, lint, format:check, build and test all PASS (16 tests). See README section 10.
- Commits after `5315aa9` were NOT part of that clean-worktree run: `3d8f90c` (docs), `1fd2554` (ADR status, docs), `772bf92` (gate), `5ae64e6` (docs).
- `772bf92` had its own tests: gate unit tests 7 passed; local e2e 14 of 14 checks passed (local Zitadel :8089, throwaway orgs removed); `terraform validate` success; `terraform fmt -check` clean; eslint and prettier clean on the touched files. No terraform plan or apply was run.
- Pushed HEAD: see Review round 4 (verified at `ee139eb`, plus this docs commit). CI on this PR is the first real run of these commits.

## Review round 4

Independent review (comment 5969979602): COMMENT, no HIGH. Fixed in `ee139eb`:

- MED1: `ZITADEL_URL` must be https (non-localhost) even when the gate serves TLS itself.
- MED2: `GATE_TS_WINDOW_S` must be an integer 1..3600, else boot fails.
- MED3: unresolved org denies even with a scope list (fail closed); header comment and ops doc updated, decision recorded.
- MED4: `ci.yml` now runs `node --test force-sso-gate/gate.test.mjs` in `infra/zitadel-local`.
- LOW: tfvars.example keeps shadow mode; no-backend state warning; request chunks buffered as Buffers; `saml-broker-demo.sh` Docker-host guard (accepts default, desktop-linux, orbstack); login-name lookup now `EQUALS_IGNORE_CASE`; OTP-only policy item documented and tracked as fw-zf72.
- `release.yml` checked: changesets/action opens a version PR when changesets are pending and otherwise runs `changeset publish`, which only publishes package versions not already on npm. Nothing to publish here; no change.

Verified at `ee139eb`: gate unit tests 9 passed; local e2e 14 of 14, throwaway orgs removed; prettier, eslint, `bash -n` clean; `terraform fmt -check` clean. `terraform validate` could not run offline (provider cache broken, init needs the registry), and only a tfvars example value changed.

## Known open issues

- fw-uwku: production apply of the force-SSO gate.
- fw-k4iu: ADR 0005 production queries. Update 2026-10-02: run read-only against all three prod DBs; results and decision are in the ADR's "Results 2026-10-02" section (fallback deletable in chorus, rolodex, helmsman, as separate stacked branches).
- fw-8bo9: test-mint machine user.
- Gate paths not proven locally are documented in the gate ops and rollout doc.

## Suggested split

Single branch and PR. A theme split fails the file-overlap check (`2a4b848` edits files created by `97eb6f0` and `dfce16f`).

## Rollback

Revert the merge commit. No runtime or state impact. Nothing was applied to any non-local system.

## Pre-merge checklist

- [ ] Owner reviews the ADR acceptance (0001-0006) and the ADR 0001 amendment
- [ ] Owner confirms the force-SSO gate is NOT to be applied by this merge (fw-uwku)
- [ ] CI green on this PR
- [ ] Owner is aware that the merge triggers `release.yml` (no new publishable changes)
- [ ] Cross-repo push order respected (fw-monorepo first; ADRs are cited by consumer repos)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
