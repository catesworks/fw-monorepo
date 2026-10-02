# fw-monorepo: push readiness for unpushed local commits (2026-10-01)

- **Range:** `origin/main..1d27f64`: **19 commits**, all authored 2026-10-01 (08:48 to 14:34 local) by Andrew Cates (agent co-authored).
- **Size:** 17 files, +2,494 / -0 (additions only).
- **State:** nothing is pushed. **Docs plus local-only proof scripts.** No runtime code, no `packages/*` changes, no migrations, env vars or workflow changes.
- **Verified at HEAD:** yes (section 6).

> **fw-helmsman is documented separately.** It has 124 unpushed commits, with migrations 0017-0028, a worker app and a `RUNTIME_CALLBACK_SECRET` requirement. See:
>
> - `/Volumes/dev-ssd/repos/catesworks/fw-helmsman/docs/sessions/2026-10-01-wave2/README.md` (push readiness section; bead fw-f44q)
> - `/Volumes/dev-ssd/repos/catesworks/fw-helmsman/docs/sessions/2026-10-01-wave3/README.md`

---

## 1. What changed (grouped by theme)

### 1a. Fleet decisions (ADRs), referenced by consumer-repo commits

- `a9a17b5` (fw-tng, fw-z9b): `docs/decisions/0001-ci-service-role-key-policy.md` (GitHub Environment `lhci-live`, no service-role key in CI) and `0002-fleet-e2e-auth-strategy.md`.
- `8406066` (fw-2n4): `0003-observability-vendor.md`.
- `a482ced` (fw-eif): `0004-otel-conventions.md`. This is what the default-off OTel commits in chorus, rolodex, warden and yellow-pages implement.
- `751986e` (e8s.4.1) and `855daad` (fw-8xp): `0005-supabase-auth-decommission.md`, including the legacy subject-matching removal checklist and the Q1-Q4 queries for fw-k4iu.
- `76cb9eb` (fw-fgi): `0006-kubb-transforms-rollout.md`.
- `40de9de` (e8s.4): `supabase-auth-local-config.md`.

### 1b. Identity / SSO research docs

- `d434519` (e8s.2.2): the duplicate-Zitadel-user SCIM hazard, appended to `.sessions/2026-08-24-zitadel-sso-phase1/FOLLOWUPS.md`.
- `a194a91` (fw-jq4): `docs/cogs-auth-source.md`.
- `07969bc` (e8s.5.2.3): two-org role-claim capture, in `infra/zitadel-local/scim-findings.md`.
- `28af51f` (e8s.5.1.2): rolodex real-login local path, in `infra/zitadel-local/README.md`.
- `2a4b848` (fw-xw4): `infra/zitadel-local/force-sso-enforcement-findings.md`. This is the source of needs-user **fw-uwku**: the login-client PAT can log in as any user.

### 1c. Local-only proof scripts (`infra/zitadel-local/`)

These only target the local Zitadel at `localhost:8089` and throwaway containers.

- `97eb6f0` (fw-prs): `saml-broker-demo.sh` + `saml-brokering-findings.md`.
- `dfce16f` (fw-mf9): SAML attribute mapping via an Actions V2 hook.
- `8b6e0c7` (e8s.5.2.15): `suite-identity-check.mjs` + `docs/suite-identity-verification.md`.

### 1d. Housekeeping

- `ce1c389`, `3e6ac60`, `bbb861b`: `.beads/interactions.jsonl` syncs.
- `1d27f64`: prettier on the decision docs. This fixed the fw-nhau format failure.

## 2. Migrations

None.

## 3. Env vars / secrets / GitHub settings

None are added by this repo. The ADRs **describe** owner work in other repos:

- ADR 0001 covers the `lhci-live` Environment and secrets in the fleet repos. Bead **fw-sfi**.
- ADR 0005 covers the production queries. Bead **fw-k4iu**.

## 4. Deploy / owner actions

Pushing `main` runs `ci.yml` and `release.yml`.

- `release.yml` runs `changesets/action`. With no pending changesets it runs `pnpm release`, which is `turbo run build --filter=./packages/*` followed by `changeset publish`.
- That publishes any public package (`@fleet-works/suite-nav` 0.1.0, `@fleet-works/ui` 0.1.1) whose current version is not yet on npm.
- **This range does not touch `packages/*`**, so it adds nothing new to publish. It behaves the same as any other push to `main`.

Needs-user beads anchored in these docs:

- **fw-uwku**: force-SSO / login-client PAT.
- **fw-k4iu**: ADR 0005 queries.
- **fw-sfi**: ADR 0001 GitHub setup.
- **fw-700**: cogs publish.

## 5. Risks

- Very low for production, since there is no runtime code.
- `saml-broker-demo.sh` and `suite-identity-check.mjs` accept credentials via flags or env and are documented as local-only. A secret-pattern scan of the added lines found no tokens, keys or credentialed URLs.
- ADRs 0001-0006 were accepted on 2026-10-02 (user decision relayed by fw-beads-6e); see section 10c.

## 6. Verification evidence

Bead **fw-nhau**:

- First pass at `2a4b848`: turbo 8/8 PASS. Format failed on 7 unformatted docs, fixed by `1d27f64`.
- **RE-VERIFICATION 2 at `1d27f64` (= current HEAD): GREEN.**

## 7. Known open defects

None in this repo. The documents record open owner decisions: fw-uwku, fw-k4iu, and fw-8bo9 (test-mint machine user).

## 8. Suggested PR split

A theme split (docs vs. infra scripts) fails the file-overlap check: `2a4b848` (docs) edits `saml-brokering-findings.md`, which the earlier infra commits `97eb6f0`/`dfce16f` created. Two options:

- **Recommended:** one PR with all 19 commits in order. It is docs only and easy to review per file.
- Or two stacked PRs:
  1. `d434519 ce1c389 a9a17b5 a194a91 97eb6f0 8406066 a482ced 3e6ac60 dfce16f`
  2. `07969bc 40de9de 28af51f 751986e 8b6e0c7 bbb861b 76cb9eb 855daad 2a4b848 1d27f64`

**Cross-repo push order (the same in every fleet dossier):**

1. **fw-monorepo first.** Its ADRs (0001, 0004, 0005, 0006) are what the consumer commits cite.
2. **cogs.** It is independent. Its push opens the "Version Packages" PR, and merging that PR publishes `@cogs/*`.
3. **fw-web.**
4. **fw-yellow-pages.** Verified at HEAD.
5. **fw-chorus** and **fw-warden.** Each needs a final clean pass on its last 3 and 6 commits respectively.
6. **fw-rolodex last.** It is the largest, and migration 0015 creates a role.
7. **fw-helmsman** follows its own dossier (links above).

No consumer depends on unpublished cogs code.

## 9. Rollback

Revert the merge commit. There is no runtime or state impact.

## 10. Final verification (clean worktree)

- **HEAD verified:** `5315aa9` (confirmed with `git rev-parse`). The doc commit that records this section follows the verified HEAD and changes docs only.
- **Date:** 2026-10-01
- **Method:** detached `git worktree` at `5315aa9`, Node v24.1.0, pnpm 10.33.0. Commands mirror `.github/workflows/ci.yml` (install, typecheck, build, test), plus lint and format:check.

| Command | Result | Detail |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | |
| `pnpm typecheck` | PASS | rerun with `turbo --force`, 0 cached |
| `pnpm lint` | PASS | rerun with `turbo --force` |
| `pnpm format:check` | PASS | |
| `pnpm build` | PASS | `turbo --force`, suite-nav and ui (tsup ESM, CJS, DTS) |
| `pnpm test` | PASS | `turbo --force`: suite-nav 1 file, 6 tests; ui 4 files, 10 tests; 16 tests total |

- **Database suites:** none in this repo. No `TEST_DATABASE_URL` or `REQUIRE_DB_TESTS` references exist and `docs/testing-database.md` is absent, so no DB container was started.
- **Known warnings (environmental, not defects):**
  - pnpm prints `Failed to replace env in config: ${NPM_TOKEN}` from the host `~/.npmrc`.
  - The suite-nav lint run prints "React version was set to detect ... react not installed".
- **Cache note:** the first pass replayed turbo cache hits. typecheck, lint, build and test were rerun with `--force` to confirm real execution.
- **Defects:** none.
