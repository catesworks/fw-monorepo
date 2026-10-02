# ADR 0005: Supabase Auth (GoTrue) human-login decommission plan (e8s.4.1)

- Status: Accepted
- Accepted 2026-10-02; approver: the user (decision relayed by fw-beads-6e)
- Date: 2026-10-01
- Bead: fleetworks-monorepo-e8s.4.1 (parent epic fleetworks-monorepo-e8s.4, Phase 5)
- Scope: fw-chorus, fw-rolodex, fw-yellow-pages, fw-helmsman, fw-warden
- Companion: [supabase-auth-local-config.md](supabase-auth-local-config.md) (local `enable_signup` findings)

## Context

Zitadel is the human identity provider for all five fw-* apps. Supabase stays
the data layer (Postgres, PostgREST, storage) and still holds machine/service
credentials. Phase 5 turns off GoTrue as a _human_ login path and removes the
config that only existed for it, without breaking anything that still talks to
GoTrue as a machine.

Heads scanned: chorus `bf397eb`, rolodex `929b6c2`, yellow-pages `f7910dc`,
helmsman `360763b`, warden `45cc49b`. Grep covered `apps/`, `packages/`,
`scripts/`, env files and `secrets.manifest.yml` / `render.yaml`, excluding
`node_modules`, build output and tests.

### Already done (2026-10-01)

Local `supabase/config.toml` has `[auth] enable_signup = false` and
`[auth.email] enable_signup = false` in chorus (`bf397eb`), rolodex
(`929b6c2`) and yellow-pages (`f7910dc`). Verified on each repo's own local
stack: public `POST /auth/v1/signup` returns `422 signup_disabled`, while
`db:migrate`, `db:seed`, `seed:auth` (admin `createUser` in chorus and rolodex)
and the full vitest suite (`DATABASE_URL` set) all pass. This confirms that
`enable_signup` gates only the public endpoint, not the admin API.

## Current state per repo

Every API verifies human tokens with `@cogs/auth` `verifyToken()` against one
issuer (`AUTH_ISSUER` / `AUTH_JWKS_URL` / `AUTH_AUDIENCE`). None of them keeps a
second, Supabase-specific signature verifier in code. Yellow-pages removed its
`SUPABASE_JWT_SECRET` base64 fallback earlier. The legacy Supabase leftovers in
the APIs live in **identity correlation**, not verification: the
`provider_subject` and `id === sub` lookups in `apps/api/src/auth/middleware.ts`
(JIT provisioning) still resolve old Supabase `sub` uuids.

| Repo            | Human login via GoTrue left in code                                                                                                                                                | Machine/service GoTrue or service-role use (must stay until replaced)                                                                                                                                                                                                                                                  | Legacy-only leftovers                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fw-chorus       | none. Web and mobile use Zitadel (`login-form.tsx` and `fleetworks-oauth.ts` mention Supabase in comments only)                                                                    | `apps/web/src/lib/device-store.ts` (`SUPABASE_SECRET_KEY`, device-token store); `apps/api/scripts/seed-auth.ts` `auth.admin.createUser/listUsers/updateUserById` (local only)                                                                                                                                          | `middleware.ts:134` legacy `id === sub` lookup; `packages/environment` describes `AUTH_ISSUER` as "Supabase Auth issuer URL ({PROJECT_URL}/auth/v1)"; `SUPABASE_SERVICE_ROLE_KEY` alias next to `SUPABASE_SECRET_KEY` |
| fw-rolodex      | `scripts/smoke-authed.mjs` (password grant against hosted `/auth/v1/token`, manual smoke script)                                                                                   | `apps/api/src/access/fleetworks-connector.ts` (GoTrue **Admin** API `PUT /auth/v1/admin/users/{id}` writes `app_metadata.fleetworks` roles into each fleet Supabase project's `auth.users`); `scripts/supabase-oauth.mjs` (GoTrue OAuth-server client admin); `device-store.ts`; `seed-auth.ts` admin API (local only) | `middleware.ts:169-205` `provider_subject` = legacy Supabase sub and `id === sub` fallbacks; `seed-auth.ts` accepts `SUPABASE_SERVICE_ROLE_KEY` as an alias                                                           |
| fw-yellow-pages | none. `seed-auth.ts` no longer calls Supabase. Admin user listing moved to `zitadel-management.ts`                                                                                 | `device-store.ts`, `device-check.ts` (`SUPABASE_SECRET_KEY`)                                                                                                                                                                                                                                                           | `middleware.ts:88` `break_glass_admin` read from `app_metadata.yellowpages` (a Supabase-written claim); stale "requires a valid Supabase JWT" docstrings                                                              |
| fw-helmsman     | none (`seed-auth.ts` no longer mints Supabase users)                                                                                                                               | `device-store.ts`                                                                                                                                                                                                                                                                                                      | `middleware.ts:157-198` legacy `id === sub` path; `environment.ts:34` Supabase hosted-issuer shape guard                                                                                                              |
| fw-warden       | **yes**: `apps/mobile/app/login.tsx:50` `signInWithPassword`, `apps/mobile/app/register.tsx:45` `signUp`, `apps/mobile/lib/fleetworks-oauth.ts:31` `supabase.auth.signInWithOAuth` | `device-store.ts`; `SUPABASE_SERVICE_ROLE_KEY` in env                                                                                                                                                                                                                                                                  | `middleware.ts:135-171` JIT keyed on Supabase sub plus legacy `id === sub`                                                                                                                                            |

No repo references `SUPABASE_JWT_SECRET` in code or env any more (only
yellow-pages' explanatory comment). The "legacy JWT secrets" the epic asks to
remove are therefore **platform-side**: the hosted projects' GoTrue JWT secret
and signing keys, plus any copies in Render, Vercel, CapRover or 1Password.
That inventory is restricted work (step P3 below).

### Must stay (machine/service, not human login)

- `SUPABASE_SECRET_KEY` / service role for `device-store` in every web app
  (PostgREST with service role, no GoTrue user session).
- `dg_` / `yp_` / `wl_` PATs and `ci:agent` tokens. These are resolved from app
  tables and never touch GoTrue. Phase 5 must not change them.
- The local `auth.admin.*` seed scripts in chorus and rolodex (proven to work
  with signup off).
- Rolodex's fleetworks access connector. It writes into `auth.users` through
  the GoTrue Admin API, so **GoTrue cannot be disabled as a service**. Only
  human sign-in and sign-up are disabled. If that claim is no longer read by
  any app (all apps take roles from `org_members` / Zitadel), retiring the
  connector is a separate decision, not part of this plan.

## Decision (proposed)

Disable GoTrue **human** login per hosted project. Keep GoTrue running for
admin and service use. Remove the code and config that only served human
Supabase sessions. Order: code first (reversible by revert), then platform
settings (restricted), then secrets (the hardest to undo, so last).

### Code-removable now (normal PRs per repo, no prod access)

1. Rolodex: delete `scripts/smoke-authed.mjs` (Supabase password-grant smoke),
   or rewrite it to obtain a Zitadel token.
2. Rolodex, helmsman, chorus, warden API middleware: drop the `id === sub`
   legacy fallback **only after** a read-only prod query shows zero `users`
   rows still matched only by a Supabase uuid (see P1). Until then it is
   dead-but-safe code.
3. Chorus: fix the `AUTH_ISSUER` description/example in
   `packages/environment` to name Zitadel. Drop the `SUPABASE_SERVICE_ROLE_KEY`
   alias in favour of `SUPABASE_SECRET_KEY` (rolodex `seed-auth.ts` too).
4. Yellow-pages: correct stale "Supabase JWT" docstrings. Decide whether
   `break_glass_admin` moves to a Zitadel role or app-table flag (needs a small
   design, because the claim source disappears once nobody writes
   `app_metadata`).
5. Helmsman: local `enable_signup = false` (skipped here because another agent
   is active in that repo; same two-line change, same proof).

### Restricted prod work (owner-run, per hosted Supabase project)

P1. Read-only pre-check per project: count `auth.users` sign-ins in the last N
days (`last_sign_in_at`). Anything non-zero outside warden means a human
path is still live. Stop and investigate.
P2. Dashboard / Management API: disable signup (`DISABLE_SIGNUP`), disable the
email/password provider and any external OAuth providers configured for
humans. Leave the service-role key and the Admin API working.
P3. Inventory and rotate: the hosted project's legacy JWT secret / signing key,
and anon/publishable keys that only shipped to clients for human sessions.
Remove now-unused `SUPABASE_*` human-session vars (e.g.
`NEXT_PUBLIC_SUPABASE_ANON_KEY`) from Vercel, Render/CapRover and the
1Password `<repo>/<service>/<env>` items via env-sync. Rotating the JWT
secret also rotates the service-role key, so every service-role consumer
(device-store, rolodex connector, env-sync targets) must be updated in the
same window.
P4. Verify: public `/auth/v1/signup` and password grant return errors; web and
mobile Zitadel login still work; `dg_` PAT, `ci:agent` and device-store
calls succeed; rolodex connector reconcile still writes.

### Per-repo ordered steps

| Order | Repo            | Steps                                                                                                                                 |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | fw-yellow-pages | code 4 → P1 → P2 → P4 → P3 → P4                                                                                                       |
| 2     | fw-chorus       | code 3 → P1 → code 2 → P2 → P4 → P3 → P4                                                                                              |
| 3     | fw-helmsman     | code 5 → P1 → code 2 → P2 → P4 → P3 → P4                                                                                              |
| 4     | fw-rolodex      | code 1, 3 → P1 → code 2 → P2 (keep Admin API) → P4 incl. connector reconcile → P3 (connector secrets updated in the same window) → P4 |
| 5     | fw-warden       | blocked, see exception                                                                                                                |

One project at a time, with at least a day of normal traffic between projects,
so a regression points to exactly one change.

## Warden mobile exception

Warden's Expo app still signs users up and in through Supabase Auth
(`register.tsx` `signUp`, `login.tsx` `signInWithPassword`,
`fleetworks-oauth.ts` `supabase.auth.signInWithOAuth`). Its local
`enable_signup` stays `true`, and its hosted project must not get P2 until the
Phase 4 warden mobile cutover ships to the stores **and** the minimum supported
app version no longer contains those screens. Old installed builds would
otherwise break at login. Warden's step list then follows chorus's.

## Rollback

- Code steps: `git revert` of the per-repo PR. The local `enable_signup` flip
  is a two-line revert plus `supabase stop && supabase start`.
- P2: re-enable signup and providers in the dashboard. No data is lost,
  because `auth.users` rows are untouched.
- P3: secret rotation cannot be undone. Rollback means rolling _forward_ to
  the new key everywhere, which is why P3 comes after P2 has soaked and why
  every service-role consumer is listed before rotating. Keep the previous key
  valid for the platform's grace period where Supabase allows it.

## Consequences

- GoTrue becomes an internal admin/service component. Human identity is
  Zitadel only (warden excepted until its mobile cutover).
- The e8s.4 acceptance criterion "legacy Supabase verifier fallback removed"
  is already met in code (single-issuer `verifyToken`). What remains is
  identity-correlation cleanup (code 2) and platform-side secrets (P3).
- Rolodex's dependency on the GoTrue Admin API is the one reason GoTrue cannot
  be switched off entirely. Revisit if that connector is retired.

## Checklist: removing legacy subject matching (code step 2, fw-8xp)

Status: **not done on purpose.** Deleting the `id === sub` fallback is only safe
if no production `users` row can still be reached through it. A row that is
reachable only that way would, after removal, miss every lookup and be
re-created by JIT provisioning under a new identity, orphaning the original
user's memberships and data. That needs a read-only production check per DB
first. Line numbers are against the heads on 2026-10-01 (the table above cites
older lines).

### What the fallback is

Every JIT function does: (1) look up `users.provider_subject = sub`; (2) if
missing, look up `users.id = sub` and try to backfill `provider_subject`;
(3) otherwise insert a new row with `id = provider_subject = sub`. Step 2 only
matters when a row's `id` equals the token's `sub` but its `provider_subject`
does not (null, empty, or an old Supabase uuid). Step 1 is not legacy: it is
the live correlation key and must stay.

| Repo            | Location                                                                                                                                    | Notes                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fw-chorus       | `apps/api/src/auth/middleware.ts:134-146` (`jitProvisionUser`, lookup at 136, guarded backfill at 140-144)                                  | `provider_subject` nullable.                                                                                                                                  |
| fw-rolodex      | `apps/api/src/auth/middleware.ts:188-197` (lookup 190, unguarded backfill 195); `provider_subject` fallback at 181-185 and doc block at 169 | Also has `zitadel_subject` (lookup at the top of the function). The unguarded backfill can overwrite a re-keyed `provider_subject`.                           |
| fw-helmsman     | `apps/api/src/auth/middleware.ts:157-199` (lookup 159, guarded backfill 196)                                                                | `provider_subject` is NOT NULL with a unique index; empty string means "unset". The branch is kept deliberately (plan D8).                                    |
| fw-warden       | `apps/api/src/auth/middleware.ts:160-172` (lookup 162, backfill 166-170); docstring at 135-136 still says "Supabase sub"                    | Blocked by the warden mobile exception regardless.                                                                                                            |
| fw-yellow-pages | none                                                                                                                                        | `AuthUser.id` is `payload.sub` verbatim; there is no users-table correlation to remove. Only `break_glass_admins` is read by `sub` (`middleware.ts:111-117`). |

### Read-only SQL for the operator (run in each production DB)

Zitadel subjects are numeric strings; Supabase subjects are uuids. All queries
are `SELECT` only.

```sql
-- Q1: rows the id-fallback could still be the only path to
-- (provider_subject unset). Expect 0.
SELECT count(*) FROM users WHERE provider_subject IS NULL OR provider_subject = '';

-- Q2: rows never re-keyed to a Zitadel sub (provider_subject still uuid-shaped).
-- Expect 0 for every user who has logged in since the cutover; list the rest and
-- decide per row (inactive account vs. missed backfill).
SELECT id, email, provider_subject
FROM users
WHERE provider_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Q3: rows whose id differs from provider_subject AND whose id is not uuid-shaped
-- (id equals a Zitadel sub but provider_subject disagrees, the exact case the
-- fallback fires on). Expect 0.
SELECT id, provider_subject
FROM users
WHERE id <> provider_subject
  AND id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
```

Rolodex only (adds the third key):

```sql
-- Q4: rows with no Zitadel correlation yet.
SELECT count(*) FROM users WHERE zitadel_subject IS NULL;
```

Also confirm the duplicate-user symptom is absent: no two rows share an email
(`SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;`).

Decision rule: Q1 and Q3 zero in a DB means the `id === sub` branch (and its
backfill UPDATE) can be deleted in that repo. Q2 non-zero rows are users who
have not logged in since the cutover; they are not reachable through the `id`
fallback either (their `id` is a Supabase uuid, not a Zitadel sub), so they
need a `provider_subject` rewrite or accept re-provisioning. Do not delete the
`provider_subject` lookup. Keep helmsman's empty-string guard reasoning (D8) in
mind: helmsman rows with `provider_subject = ''` fail Q1 by design until
rewritten.
