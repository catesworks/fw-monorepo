# Local Supabase Auth signup flags in the fw-* repos (e8s.4)

- Status: Findings + recommendation (no other repo edited)
- Date: 2026-10-01
- Bead: fleetworks-monorepo-e8s.4 (Phase 5: decommission Supabase Auth human login)
- Scope: the **local** `supabase/config.toml` in each fw-* app repo. Disabling
  GoTrue human login on the production Supabase projects is a separate,
  restricted change, and this document does not cover it.

## Finding

Every fw-* app repo with a local Supabase stack still allows open signup locally:

| Repo            | File                   | `[auth] enable_signup` | `[auth.email] enable_signup` | Supabase Auth calls left in code (excluding comments, docs, node_modules)                                                                                       |
| --------------- | ---------------------- | ---------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fw-chorus       | `supabase/config.toml` | `true` (line 176)      | `true` (line 221)            | `apps/api/scripts/seed-auth.ts:125` `auth.admin.createUser` (local seed only)                                                                                   |
| fw-helmsman     | `supabase/config.toml` | `true` (line 176)      | `true` (line 221)            | none (`apps/api/src/seed-auth.ts` says it no longer mints Supabase users)                                                                                       |
| fw-rolodex      | `supabase/config.toml` | `true` (line 180)      | `true` (line 225)            | `apps/api/src/scripts/seed-auth.ts:126` `auth.admin.createUser` (local seed only)                                                                               |
| fw-warden       | `supabase/config.toml` | `true` (line 178)      | `true` (line 223)            | **`apps/mobile/app/login.tsx:50` `signInWithPassword`, `apps/mobile/app/register.tsx:45` `signUp`**, `apps/mobile/lib/fleetworks-oauth.ts:31` `signInWithOAuth` |
| fw-yellow-pages | `supabase/config.toml` | `true` (line 176)      | `true` (line 221)            | none                                                                                                                                                            |

`[auth.sms] enable_signup` is already `false` and `enable_anonymous_sign_ins`
is already `false` in all five. fw-web, fw-overview, fw-beads and
fw-monorepo have no `supabase/config.toml`. Repo heads at the time of the
scan: chorus `47f377d`, helmsman `c5fba55`, rolodex `bf5cd7b`, warden
`45cc49b`, yellow-pages `2cc1843`. All were on `main` with a clean
`config.toml`.

## Recommended per-repo change

The change is to set both `enable_signup` keys to `false`, keep
`[auth] enabled = true`, and leave everything else alone. Supabase stays the
data layer, and the local GoTrue still issues the service/machine JWTs that
PostgREST and storage use.

| Repo            | Recommendation                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fw-helmsman     | Flip both to `false` now. Nothing calls Supabase Auth for humans.                                                                                                                                                                                                                                                                                                         |
| fw-yellow-pages | Flip both to `false` now. Nothing calls Supabase Auth for humans.                                                                                                                                                                                                                                                                                                         |
| fw-chorus       | Flip both to `false`, then run the `apps/api` `seed:auth` step (or `process-compose up`) once to confirm `seed-auth` still works. It uses the admin API (`auth.admin.createUser`, service-role key). GoTrue's `enable_signup` gates the public `/signup` endpoint, not admin user creation. That is **inferred from GoTrue behaviour, not tested here**, hence the check. |
| fw-rolodex      | Same as chorus: flip, then confirm `seed:auth` still runs.                                                                                                                                                                                                                                                                                                                |
| fw-warden       | **Do not flip yet.** The Expo mobile app still has Supabase password login and a `signUp` registration screen. `enable_signup=false` would break local mobile registration. Flip it in the same change that removes `register.tsx` / `signInWithPassword` from the mobile app (the Phase 4 mobile cutover for warden).                                                    |

Each flip is a two-line change in that repo's `supabase/config.toml`. It
takes effect on the next `supabase stop && supabase start`. Open it as a PR
in that repo, per the "never commit straight to main" convention. Do not
make the change from this monorepo.

## Not covered

- Production GoTrue settings (dashboard / Management API `DISABLE_SIGNUP`,
  external providers). These are restricted, and they are gated by e8s.4's own
  sequencing: all apps on Zitadel and dual-accept windows closed.
- Removing the legacy Supabase JWT verifier fallback and the legacy JWT secrets
  from each app's config (the other half of e8s.4's acceptance criteria).
- Runtime behaviour of the e2e suites after the flip. The grep covered the e2e
  directories as well, and it found no `signUp` / `signInWithPassword` outside
  warden mobile. The suites were not run.
