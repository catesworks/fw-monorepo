# Session: Zitadel SSO — gaps closed, Phase 1 cutover blocked on real issues — 2026-08-24

> Resume pointer + index for this session's dossier. Read this first.

## State in one paragraph

The RLS "bug" across 4 apps was a false alarm (documented, no code change). All 4
Phase 0 gaps for `sso-saml-scim-platform-identity.md` are closed, published
(`@cogs/auth@0.6.0`), and consumed (rolodex bumped). The identity-correlation
Decision 5 contradiction is resolved and locked (3× codex-approved). Two
independent yellow-pages plans that had been sitting unpushed for a day are now
pushed, plus a real e2e bug found and fixed. Phase 1 (rolodex's actual Zitadel
cutover) is **planned but not implemented** — a codex critic pass returned
**REVISE** with 5 concrete, real problems (not polish), the biggest being that
Zitadel's local instance issues opaque tokens by default, which `@cogs/auth`
cannot verify at all. Nothing in Phase 1 has been coded yet. The local Zitadel
Docker stack is currently **running** (`localhost:8089`, seeded).

## Resume prompt (paste into a new session)

```
Resume the zitadel-sso-phase1 work. Read
fleetworks-monorepo/.sessions/2026-08-24-zitadel-sso-phase1/README.md and
FOLLOWUPS.md. State: identity-correlation decision locked and executed;
Phase 1 cutover plan drafted but REVISE'd by codex critic (5 real issues,
biggest is Zitadel opaque-token config). Next action: fix the Zitadel client's
accessTokenType to JWT in fleetworks-monorepo/infra/zitadel-local/seed.ts,
verify a real JWT comes back, then resume revising
rolodex/.omc/plans/zitadel-sso-phase1-cutover.md against the other 4 codex
findings before re-submitting for review.
```

## Repo state

| Repo                       | Branch | Last commit                                                               | Committed? | Pushed? | Notes                                                                                                                                                                                    |
| -------------------------- | ------ | ------------------------------------------------------------------------- | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cogs                       | main   | `89b2981` Version Packages (#2)                                           | yes        | yes     | `@cogs/auth@0.6.0` published to npm via OIDC trusted publishing                                                                                                                          |
| rolodex                    | main   | `2fdb067` style: prettier-format migration 0012 meta files                | yes        | yes     | `.omc/plans/zitadel-sso-phase1-cutover.md` exists but is gitignored (repo-wide `.omc/` policy) — not a commit, a local planning artifact, currently marked **pending approval / REVISE** |
| yellow-pages               | main   | `1617227` docs(session): dossier for e2e-sticky-headers session           | yes        | yes     | includes 2 previously-unpushed completed plans (semantic-operational-graph, bidirectional-saas-connectors) + the sticky-header e2e fix                                                   |
| fleetworks-monorepo        | main   | `5753e18` feat(test): add real Vitest suite for suite-nav and ui packages | yes        | yes     | this session's own edits (`.omc/plans/identity-correlation-externalid-decision.md`, and the amended `sso-saml-scim-platform-identity.md`) are gitignored, local-only — see Lessons       |
| chorus / helmsman / warden | main   | (untouched this session)                                                  | —          | —       | surveyed read-only for cross-app impact; zero diff confirmed via `git status`                                                                                                            |

## Read first (rebuilds context fastest)

1. `SUMMARY.md` — full chronological account of what happened, with evidence
2. `FOLLOWUPS.md` — the 5 codex-critic findings blocking Phase 1, plus what's next
3. `fleetworks-monorepo/.omc/plans/sso-saml-scim-platform-identity.md` — the amended master plan (Decision 5's corrected two-step mapping, the cross-app survey section)
4. `rolodex/.omc/plans/zitadel-sso-phase1-cutover.md` — the REVISE'd Phase 1 plan, needs rework
5. `LESSONS.md` — the opaque-token gotcha, the SCIM PATCH bug, the dead-agent lesson

## First action

Fix `fleetworks-monorepo/infra/zitadel-local/seed.ts` (or the running instance's
Rolodex OIDC app config) to request JWT access tokens instead of Zitadel's
default opaque tokens — verify with a real login against the live local
instance (`localhost:8089`, currently up) that `@cogs/auth`'s `verifyToken()`
can actually parse the result, before touching anything else in the Phase 1
plan.

## Dossier contents

- `SUMMARY.md` — what was done, chronologically, with commit SHAs
- `LESSONS.md` — the opaque-token gotcha, SCIM PATCH-by-id bug, dead background agent
- `adr/0001-identity-correlation-externalid-two-step-mapping.md` — the locked Decision 5 amendment
- `adr/0002-zitadel-phase1-clean-cutover.md` — the clean-cutover-over-dual-accept call (still REVISE-blocked on execution details)
- `FOLLOWUPS.md` — the 5 blocking codex findings + what's left
- `BLOG.md` — public write-up (⚠ review before publishing)
