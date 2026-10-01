# Capability gate results (2026-10-01, local Zitadel v4.17.1)

Tracks `fleetworks-monorepo-e8s.2.4` (Phase 2 Step 1 capability gate) and
`fleetworks-monorepo-e8s.1.5` (SCIM PATCH-by-id 404).

Instance: local stack in this directory, `http://localhost:8089`, Zitadel
v4.17.1, org "Fleetworks" (`387742307199329283`, shortened below as `$ORG`).
Auth: the seed-bot PAT, read via `docker compose cp` per README.md (never
printed). All test objects were prefixed `cap-gate-*` (3 SCIM users, 1 extra org
with 1 user, 1 authorization) and were deleted afterwards; verified gone. One
side effect: a SCIM `PATCH displayName` was applied to the seeded
`test-viewer@fleetworks.dev` with its existing value ("Test Viewer"), so no net
change.

Notation: `SCIM` = `http://localhost:8089/scim/v2/$ORG/...` with
`Content-Type: application/scim+json`; `RPC` = `POST /<package>.<Service>/<Method>`
(JSON body, Bearer PAT).

## Results

| #   | Check                                             | Result                                                      |
| --- | ------------------------------------------------- | ----------------------------------------------------------- |
| a   | SCIM enterprise `employeeNumber` round-trips      | **FAIL (VOID)**: accepted 201, silently dropped, not stored |
| b   | Read API for per-user project-role grants         | **PASS**: `AuthorizationService/ListAuthorizations`         |
| c   | `ListUsers` pagination >= 2 pages, no dupes/drops | **PASS**: offset/limit, 26 users in 3 pages                 |
| d   | SCIM GET/PATCH `/Users/{id}` 404 retest           | **Not reproduced**: works for human users (see .1.5)        |
| e   | `externalId` overwrite hazard                     | **CONFIRMED**: SCIM PATCH and PUT clobber/delete it         |

### (a) employeeNumber: FAIL

- `POST SCIM/Users` with schemas `core:2.0:User` + `extension:enterprise:2.0:User`
  and `"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User":{"employeeNumber":"EMP-cap-gate-1"}`
  -> **201**. The response body has no enterprise block.
- `GET SCIM/Users/{id}` and `SCIM/Users?filter=userName eq ...` (200): no
  `employeeNumber`, no enterprise schema.
- `RPC zitadel.user.v2.UserService/GetUserByID` and `/ListUsers` (200): no
  employee-number field anywhere in the user object.
- `RPC zitadel.user.v2.UserService/ListUserMetadata` (200) shows only two keys:
  `urn:zitadel:scim:emails` and `urn:zitadel:scim:externalId` (base64 values).
  `POST /management/v1/users/{id}/metadata/_search` returns the same two.
- `GET SCIM/Schemas` (200) advertises only `core:2.0:User`; the enterprise
  extension is not supported on this version.
- `PATCH` with path `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber`
  -> **400** `scimType=invalidPath` "unknown urn attribute prefix"
  (`SCIM-FF431`). `PUT` with the extension -> 200 but still nothing stored.
- Event-store check: `select count(*) from eventstore.events2 where payload::text
ilike '%EMP-%'` -> `0`. The value is never persisted, not merely unreadable.

Conclusion: tier 1 of the match ladder (employeeNumber) **does not exist** on
v4.17.1. Per the acceptance criteria this is a blocking Void: the plan must be
revised before Step 2.

### (b) role-grant read: PASS

- `RPC zitadel.authorization.v2.AuthorizationService/ListAuthorizations` (200).
  Filter shapes (the `Filter` oneof is required; `{"userId":{...}}` returned
  400 "value is required"):
  - `{"filters":[{"inUserIds":{"ids":["<userId>"]}}]}` for one user,
  - `{"filters":[{"projectId":{"id":"<projectId>"}}]}` for a project,
  - `{}` for everything (default `appliedLimit` 100).
- Response: `{"pagination":{"totalResult","appliedLimit"},"authorizations":[{"id",
"project":{"id","name","organizationId"},"organization":{...},"user":{"id",
"preferredLoginName","displayName","organizationId"},"state":"STATE_ACTIVE",
"roles":[{"key","displayName"}]}]}`.
- Created `CreateAuthorization {userId, projectId, organizationId, roleKeys:["member"]}`
  -> 200 `{id}`; it appeared in the list; `DeleteAuthorization {id}` -> 200.
- Legacy alternative also works: `POST /management/v1/users/grants/_search`
  with header `x-zitadel-orgid` and `{"queries":[{"userIdQuery":{"userId":"..."}}]}`
  -> 200 with `roleKeys`.

### (c) ListUsers pagination: PASS

- `RPC zitadel.user.v2.UserService/ListUsers` with
  `{"query":{"offset":N,"limit":10,"asc":true}}`. Pagination is
  offset/limit (no cursor); `details.totalResult` is returned on every page.
- Offsets 0/10/20/30 returned 10/10/6/0 rows (all 200); `totalResult` 26;
  26 ids, 26 unique; the sorted union equals the single `limit:100` list
  exactly. Always pass `asc:true` (or another explicit sort) so paging is
  deterministic.
- Caveat: `ListUsers` without an org filter is **instance-wide**; it returned a
  user from a second org during the test. Add an org filter for per-org
  enumeration. Machine users (e.g. `fleetworks-seed-bot`, `login-client`) are
  included in the list.

### (d) SCIM by-id 404 retest: not reproduced (see .1.5)

### (e) externalId overwrite: CONFIRMED

`externalId` is stored as user metadata key `urn:zitadel:scim:externalId`
(base64), shared between SCIM and any other writer.

1. Set via `RPC UserService/SetUserMetadata`
   `{userId, metadata:[{key:"urn:zitadel:scim:externalId", value:b64("rolodex-link-001")}]}`
   -> 200; SCIM GET shows `"externalId":"rolodex-link-001"`.
2. IdP-style `PATCH SCIM/Users/{id}` `replace externalId = "idp-ext-999"` -> 204;
   re-read: `idp-ext-999` (overwritten).
3. IdP-style `PATCH` of `displayName` only -> 204; `externalId` unchanged.
4. Re-set to `rolodex-link-001`, then `PUT SCIM/Users/{id}` **without**
   `externalId` -> 200; re-read: `externalId` absent and the metadata key is
   **deleted** (`ListUserMetadata` shows only `urn:zitadel:scim:emails`).
5. Re-set, then `POST SCIM/Users` with an existing `userName` -> **409**
   `Errors.User.AlreadyExists`; `externalId` unchanged.

Conclusion: do not store the Rolodex link in `externalId`. A SCIM PATCH of
`externalId` or any SCIM PUT from the customer IdP silently overwrites or
deletes it.

## .1.5: single-user SCIM GET/PATCH 404 (acceptance (a): works, root cause class identified)

On this instance (same stack, v4.17.1) single-user SCIM works:

- `GET SCIM/Users/{id}` -> **200** for SCIM-created users and for users created
  by `UserService/CreateUser` (seed users `test-admin`, `test-viewer`,
  `admin@fleetworks.local`).
- `PATCH SCIM/Users/{id}` (`replace displayName`, `replace externalId`) -> **204**,
  verified via `UserService/GetUserByID` and `ListUserMetadata`.
- `PUT SCIM/Users/{id}` -> 200.

The exact reported error (`Errors.User.NotFound`; ids `QUERY-Dfbg2` on GET and
`COMMAND-ugjs0upun6` on PATCH, 404) was reproduced under two conditions:

| Hypothesis                                                      | Tested call                                             | Result                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Nonexistent / stale id (e.g. id from before a `down -v` reseed) | GET/PATCH the 2026-08-24 id `387709031218717699`        | **404 `Errors.User.NotFound`, same ids as reported**                           |
| Org in path differs from the user's resource-owner org          | user created in a second org; GET/PATCH via `$ORG` path | **404 `Errors.User.NotFound`, same ids**; via own org 200/204                  |
| Machine user                                                    | GET/PATCH `fleetworks-seed-bot`                         | GET 404 `Errors.Users.NotFound` (SCIM-USRT1), PATCH 404 `Errors.User.NotFound` |
| Trailing slash                                                  | GET `.../Users/{id}/`                                   | 404 "404 page not found" (router, different body)                              |
| Unknown org id in path                                          | GET `/scim/v2/999/Users/{id}`                           | 403 `AUTH-Bs7Ds` "Organisation doesn't exist"                                  |
| Instance vs org-scoped PAT                                      | seed-bot PAT (org-scoped) used throughout               | works; not varied (no instance-level credential tried)                         |
| `X-Zitadel-Orgid` header                                        | not needed on the working calls                         | n/a                                                                            |

Interpretation: by-id SCIM 404 means "no _human_ user with this id in the org
named in the path." The org-mismatch variant never returns the user from
list/filter (filter in the wrong org returns `totalResults:0`), so it does not
by itself explain "list finds the user, by-id does not." The most consistent
explanation of the 2026-08-24 observation is a **stale user id** (the recorded
id `387709031218717699` does not exist on this instance, whose ids start at
`3877423...`, i.e. it predates the reseed). That is a hypothesis fitting the
evidence, not proven for the original run.

Operational guidance: SCIM by-id GET/PATCH is usable. Always take the id from a
fresh list/filter or create response in the same org, and use that org's id in
the path. For account-fixing where the user's org is not known, the v2/management
API is the org-agnostic write path:
`RPC zitadel.user.v2.UserService/SetUserMetadata` (tested, 200) for metadata
and `UserService/GetUserByID` (tested, 200) for reads. `UserService/UpdateUser`
was not exercised.

## Not determined

- Whether the original 2026-08-24 404 was a stale id: the original instance no
  longer exists and the exact request was not preserved.
- Behaviour on the production instance (`id.fleetworks.dev`); never touched.
- Whether an instance-level credential behaves differently from the org-scoped
  seed-bot PAT for SCIM (not tried).
- Pagination behaviour beyond 26 users (default page cap 100 observed via
  `appliedLimit`; larger sets not exercised).
- Whether a future Zitadel release adds enterprise-extension storage.
