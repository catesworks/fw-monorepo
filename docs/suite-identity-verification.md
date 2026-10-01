# Suite-level identity verification (bead e8s.5.2.15)

Run on 2026-10-01 against the local Zitadel at `http://localhost:8089`
(`infra/zitadel-local`). The script is
`infra/zitadel-local/suite-identity-check.mjs`.

## What was checked

`test-admin@fleetworks.dev` signs in once, using one Zitadel Session API
session. That session is used for a headless Auth Code + PKCE flow against
each of the five web clients. The recipe is in `infra/zitadel-local/README.md`,
"Verifying it works yourself". Every access token has the same
`sub=387742353990919171`.

Each app's API ran by itself and was called at `GET /api/me`:

- with the token from its own web client, which should return 200 and
  resolve the user;
- with each of the four tokens from the other apps' web clients, which should
  return 401.

Every token's `aud` lists all 10 suite clients plus the project id, because
Zitadel puts the whole project in `aud`. A token minted for another app
therefore always passes a plain `aud` check. The only thing separating the
tokens is `azp`. The rejection comes from `@cogs/auth`'s
`checkAuthorizedParty`: 0.7.0 in four apps, 0.6.0 in warden. It requires
`azp` (or `client_id`) to be in `AUTH_AUDIENCE`.

```bash
cd infra/zitadel-local
node suite-identity-check.mjs --app rolodex=http://localhost:4013   # one --app per running API
```

The script exits non-zero if any expectation fails. It never prints tokens or
PATs.

## How each app was run

The apps were run one after another. Only one app's database and API were up
at any time. Each stack was torn down before the next started.

| App          | Postgres                                                                         | API                                                               | `AUTH_AUDIENCE` (from committed `apps/api/.env.dev`, unchanged) |
| ------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| rolodex      | repo `pnpm supabase:start` (db only), `:54222`                                   | `ENV=dev`, `:4013`                                                | web + mobile                                                    |
| chorus       | repo `pnpm supabase:start` (db only), `:54722`                                   | `ENV=dev`, `:4021`                                                | web + mobile                                                    |
| warden       | repo `pnpm supabase:start` (db only), `:54622`                                   | `ENV=dev`, `:4020`                                                | web only                                                        |
| yellow-pages | repo `pnpm supabase:start` (db only), `:54122`                                   | `ENV=dev`, `:4023`                                                | web + mobile                                                    |
| helmsman     | throwaway `suite-idcheck-helmsman-pg` (`supabase/postgres:17.6.1.165`), `:55491` | `ENV=dev`, `:4925`, `DATABASE_URL` overridden on the command line | web + mobile                                                    |

"db only" means `supabase:start -x` with every service except Postgres
excluded. `db:migrate` ran against each database before its API started.
Helmsman got a throwaway container because another agent was also using
helmsman test databases.

## Results

| App          | Own token | Foreign tokens (4 each) | User resolution                                                                                                                                                  |
| ------------ | --------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rolodex      | 200       | 401 ×4                  | Existing row (`id=sub`, created by an earlier real login, bead fw-ah1). Row count stayed the same (27), with 1 row for the email.                                |
| chorus       | 200       | 401 ×4                  | Pre-seeded row: `id=suite-idcheck-preseed`, `provider_subject=sub`. `/api/me` returned that id and no new row was created.                                       |
| helmsman     | 200       | 401 ×4                  | Pre-seeded row: `id=suite-idcheck-preseed`, `provider_subject=sub`. `/api/me` returned that id. The table held 1 row before and after.                           |
| warden       | 200       | 401 ×4                  | Existing row (`id=sub`), `orgId=warden-org`, `org:admin`. Row count stayed the same (9).                                                                         |
| yellow-pages | 200       | 401 ×4                  | Yellow-pages has no JIT step: `AuthUser.id` is the token's `sub`. It resolved to `sub` with `isBreakGlassAdmin=true` from the existing `break_glass_admins` row. |

All five apps are verified for (a) accepting their own token and (b) rejecting
tokens for other apps.

### Email-only correlation (chorus)

In this case the pre-seeded row matched on email, but its `provider_subject`
was a legacy value (`legacy-supabase-sub`). `/api/me` then returned a **new**
row with `id=sub`, so the email now had two rows.

None of the four JIT apps (rolodex, chorus, helmsman, warden) matches users by
email. They match on `provider_subject`, then on `id`. So "the same person
resolves to their existing row" only holds if `provider_subject` was rewritten
to the Zitadel `sub` before that person's first Zitadel login. This is the
expected design (helmsman D8), not a runtime bug. Every rewrite has to finish
before cutover.

All rows inserted for these tests were deleted afterwards.

## Defects and gaps found

1. **yellow-pages: `AuthUser.email` is empty for Zitadel access tokens.**
   `/api/me` returned `"email":""` and `"name":""`. Zitadel access tokens have
   no `email` claim, and `fw-yellow-pages/apps/api/src/auth/middleware.ts`
   (`authMiddleware` and `optionalAuth`, where `email: payload.email ?? ''`
   is set) does not fall back to userinfo. The other four apps do, through
   `resolveProfile` / `enrichFromUserinfo`. The web BFF hides this for display
   names, but anything server-side that reads `user.email` gets `''`.
2. **warden: `AUTH_AUDIENCE` does not include the warden mobile client.**
   `fw-warden/apps/api/.env.dev` has `AUTH_AUDIENCE=387742353839989763` (web
   only). The seeded warden mobile client `393212594208482309` is not
   referenced anywhere in fw-warden, so tokens from that client would get a 401. The other four apps list both web and mobile. This only matters once
   warden mobile is wired up.
3. **Roles in a fresh app are low.** In chorus and helmsman, the pre-seeded
   user resolved as `org:viewer` with `hasOrg:false`, because those apps take
   roles from their own org membership tables, not from the Zitadel `admin`
   project role. Yellow-pages reports `org:viewer` plus break-glass. This is
   expected per-app RBAC, recorded so it is not mistaken for an identity
   failure.

## Not covered here

- Browser login (`/verify-stage`) for each app's web `/auth/callback`. This
  run tests at the API layer.
- Mobile client tokens.
- `fleetworks-web/infra/zitadel.tf` parity with production.
