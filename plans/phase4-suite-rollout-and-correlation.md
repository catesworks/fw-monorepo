# Plan: Phase 4 — 4-app suite rollout + per-app identity correlation

**Status:** pending approval · **Mode:** design plan (no code in this repo) · **Created:** 2026-09-05
**Parent:** `.omc/plans/sso-saml-scim-platform-identity.md` (Phase 4)
**Sibling / prerequisite reading:** `.omc/plans/identity-correlation-externalid-decision.md`

**Scope:** design — not implement — Phase 4 of the Zitadel platform-identity program: repointing
**helmsman → chorus → warden → yellow-pages** off Supabase Auth onto Zitadel, and resolving the
one thing the parent plan explicitly deferred rather than solved — **how a Zitadel identity is
correlated to each app's own pre-existing local `users` row**, given that the same person has four
independently-generated local user IDs in four separate databases.

**This repo (`fleetworks-monorepo`) contains no application source.** It holds
`infra/zitadel-local` (the Docker Zitadel stack + `seed.ts`) and `.omc/plans/*`. Every
implementation step below lands in the `chorus` / `helmsman` / `warden` / `yellow-pages` repos,
which are not present here. Nothing in this plan writes application code; it is the design a
Phase 4 executor picks up inside each app repo.

**Blocked on:** Phase 1 (rolodex pilot) landing — it is currently REVISE-blocked. **Exception:**
Step 0 below (Zitadel capability verification) has **no dependency on Phase 1** and should run
immediately and in parallel, because its outcome determines whether P4-D1 stands or falls back.

---

## Why this plan exists

The parent plan's Phase 4 is four bullet points. Its own dated cross-app survey (2026-08-24)
closes by saying the cross-app correlation mechanism "needs its own investigation when each app's
Phase 4 sub-task actually starts." This is that investigation, plus the sequenced rollout design
around it.

The sibling decision doc got to **APPROVED only after two rounds of codex-critic REJECT/REVISE**,
which caught (1) a value-conflation bug — `externalId` *locates* a row, the Zitadel `sub` is what
gets *stored* — and (2) a cardinality gap — one `externalId` cannot equal four local IDs. This
plan is written to not repeat either, and to be explicit about which of its own claims are
doc-verified versus pending live verification.

---

## Grounded facts

### Verified in this repo, 2026-09-05

- `infra/zitadel-local/.env:25` and `.env.example:32` pin `ZITADEL_VERSION=v4.17.1`;
  `docker-compose.yml:46,143` run `ghcr.io/zitadel/zitadel` and `zitadel-login` at that tag
  against `postgres:17.10-alpine`.
- `seed.ts:76-158` registers **nine OIDC clients inside one project** ("Fleetworks Suite"):
  5 web (helmsman :3025, chorus :3021, warden :3020, rolodex :3013, yellow-pages :3023) and
  4 native/mobile (`rolodex-mobile`, `helmsman-mobile`, `chorus-mobile`, `yellow-pages-mobile`).
  **Warden has no mobile client.** Concrete client IDs are in `generated-client-env.md`.
- `seed.ts:57-60` models exactly **two Zitadel-level project roles: `admin` and `member`**, and
  `seed.ts:184-200` states the design intent explicitly: *"an app's third rung is its own
  org_members role, which Zitadel neither knows nor needs to know."* Fine-grained role and org
  membership are already, deliberately, app-local.
- `seed.ts:82-116` records that **chorus, warden and yellow-pages web all run the OIDC code
  exchange server-side** in a Next.js route handler (`apps/web/src/app/auth/callback/route.ts`),
  registered as `OIDC_APP_TYPE_WEB`; chorus and warden port yellow-pages' BFF session subsystem.
  Helmsman and rolodex web remain `USER_AGENT` (browser) clients.
- `seed.ts:86,98,112` reference `fleetworks-web/infra/zitadel.tf` as the **production** Zitadel
  registration surface (Terraform), distinct from this local seed.
- `README.md:163-187` documents a **headless, browser-free way to mint a real token** for a seeded
  user (SessionService/CreateSession → `/oauth/v2/authorize` → OIDCService/CreateCallback with the
  *login-client* PAT → `/oauth/v2/token`). Step 0 and every per-app integration test can use this.
- **Attempted live verification 2026-09-05 and could not run it:** the Docker daemon is not
  running in this planning environment (`Cannot connect to the Docker daemon at
  unix:///Users/acates/.orbstack/run/docker.sock`; `curl` to the discovery endpoint returned no
  connection). Every "verify live" instruction below is therefore genuinely outstanding, not a
  formality.

### Inherited from Phase 0 (parent plan, 2026-08-23)

- Token verification and role resolution are **pure env config** in the shared `@cogs/auth`
  (`AUTH_ISSUER` / `AUTH_JWKS_URL` / `AUTH_AUDIENCE`, `ROLE_MAP_*`). Repointing an app is not a
  rewrite.
- Zitadel puts **every client in the project** into a token's `aud` array. With nine clients in
  one project, `aud` provides essentially **zero** cross-app isolation; the `azp`/`client_id`
  equality check (shipped in `@cogs/auth@0.6.0`) is the only control. See P4-D4.
- Zitadel access tokens are spec-compliant: **`email`/`name` are not on them.** `/oidc/v1/userinfo`
  is the proven fix. See P4-D5.
- Org scope rides the flat URN claim `urn:zitadel:iam:org:project:roles`, shape
  `{ role: { orgId: primaryDomain } }` — the **key is the Zitadel org ID, the value is the primary
  domain**. See P4-D3.

### Inherited from the cross-app survey (parent plan, 2026-08-24)

| App | `providerSubject` | JIT lookup | Org membership | Duplicate-row blast radius |
|---|---|---|---|---|
| chorus | `packages/db/src/schema.ts:44-55`, **nullable**, indexed | `apps/api/src/auth/middleware.ts:113-141` | `orgMembers`, `schema.ts:74-84` | zero org rows → silent role floor, access loss until manual re-grant |
| helmsman | `packages/db/src/schema.ts:71-78`, **NOT NULL** | `apps/api/src/auth/middleware.ts:147-175` | `org_members`, `schema.ts:29-45` | same, **plus** fragments `audit_events.actorId` and several `createdBy` columns |
| warden | `packages/db/src/schema.ts:26-37`, **nullable**, indexed | `apps/api/src/auth/middleware.ts:133-161`, gated on every `/api/*` (`apps/api/src/index.ts:90`) | `orgMembers`, `schema.ts:41-59` | same as chorus, but surfaces immediately and universally |

None of the three JIT paths queries any external-identity table today. **Whatever mechanism this
plan picks must be wired into that exact lookup function to have any effect.**

> **Gap in the inherited survey — flagged, not papered over.** The 2026-08-24 survey covered
> chorus, helmsman and warden **only**. **Yellow-pages was never surveyed**: its `users` schema,
> whether it even has a `providerSubject` column, its JIT-provisioning path, and its duplicate-row
> blast radius are all **unknown**. Step YP-0 exists to close this before any yellow-pages design
> is treated as settled. Do not assume yellow-pages matches the other three.

### Zitadel v4 capability research, 2026-09-05 (documentation-verified)

Sources: `zitadel.com/docs` claims reference, user-metadata guide, User Service v2 API reference,
SCIM v2 guide, `zitadel/zitadel` `cmd/defaults.yaml`.

- **User metadata is a first-class, documented Zitadel feature**, present across v1→v4. v2 User
  Service endpoints: `POST /v2/users/{user_id}/metadata` (set/upsert, `user.write`),
  `DELETE /v2/users/{user_id}/metadata` (`user.write`), `POST /v2/users/{user_id}/metadata/search`
  (list, `user.read`). The v1 `/management/v1/users/{id}/metadata/{key}` endpoints still work but
  are deprecated. **There is no bulk-set in v2** — loop single calls.
- **Metadata values are base64-encoded on the wire**, in both directions. This is documented and
  is the single most likely source of a silent correlation bug (see AC-C4).
- **Search by metadata exists** — `ListUsers` (`POST /v2/users`) accepts `metadata_key_filter` /
  `metadata_value_filter` — **but the response does not include metadata values**, so reading a
  value still costs a follow-up per-user call. *Exact version this shipped in could not be
  confirmed from docs; verify on 4.17.1.*
- **Metadata can ride a token claim** (`urn:zitadel:iam:user:metadata`, requires the identically
  named scope), but only on the **ID token / userinfo**, or on an **access token if and only if
  the access token type is JWT rather than opaque**. Values in the claim are base64. Open upstream
  issue **#8435** reports metadata appearing in tokens regardless of the "User Info inside ID
  Token" setting, causing header-size blowups; resolution status for 4.17.1 unconfirmed.
  **This plan's design deliberately does not depend on any of that** — see P4-D1.
- **SCIM does not expose arbitrary metadata.** Zitadel's SCIM v2 implements the User schema only
  (**no `/Groups` endpoint**), and internally persists non-core SCIM attributes *as user metadata*
  under `urn:zitadel:scim:`-prefixed keys. Two consequences: (a) our own keys must not collide
  with that namespace, and (b) **SCIM `externalId` is stored per *provisioning domain***, so
  "one Zitadel user has exactly one externalId field" — the sibling plan's stated premise — is
  imprecise for Zitadel specifically. See P4-D1's treatment of Option D; the *decision* it drove
  is still right, the *reason* needs correcting.
- Reading another user's metadata needs `user.read`: instance-scoped (`IAM_OWNER`,
  `IAM_USER_MANAGER`, …) reads across all orgs; org-scoped (`ORG_USER_MANAGER`, `ORG_OWNER`, …)
  is confined to the granted org.
- Other open upstream caveats to keep in view: **#9033** (`GetUserByID` v2 does not return metadata
  inline), **#11369** (Actions v2 `updateHumanUser` cannot set metadata; only create can),
  **#8338** (Action `setMetadata` can double-encode a value). **Key-length, value-size and
  keys-per-user limits are undocumented** — Step 0 probes them.

---

## The problem, stated precisely

At runtime, an incoming Zitadel access token gives an app exactly one identity fact: `sub` = the
Zitadel user's immutable ID. The app's JIT path must answer:

> Is there already a local `users` row for this person, created back when they logged in via
> Supabase Auth with a completely different `sub`?

If the answer is wrongly "no", the app creates a duplicate row. Per the survey, that costs the
person all org membership in all three surveyed apps, and additionally orphans helmsman's audit
trail. It is silent — the user simply appears to be a brand-new, unaffiliated account.

**The critical reframe this plan is built on:** *this is a one-time backfill problem, not a runtime
problem.* Once `zitadel_subject` on the existing row holds the Zitadel `sub`, the already-shipped
runtime lookup matches on `sub` alone, forever, with no external call. Correlation machinery is
needed exactly once per (app, pre-existing user) pair. This is the same conclusion rolodex's
Phase 1 reached, and it is what makes the token-claim question (metadata-in-JWT, #8435, opaque vs
JWT access tokens) **entirely irrelevant to the correctness of this design**.

Two cohorts, and only one of them has a problem:

1. **Legacy cohort** — exists in one or more of the four app databases today. Needs correlation.
   Finite, enumerable, and known at provisioning time.
2. **Net-new cohort** — created in Zitadel (by admin or, later, by a customer IdP over SCIM) after
   cutover. Has no local row anywhere. JIT-create is the *correct* behaviour. **No correlation
   needed.**

---

## Decisions

### P4-D1 — Correlation mechanism: **per-app Zitadel user metadata keys, populated at proactive provisioning time, consumed by a one-time per-app backfill.** Fallback named and pre-designed.

**Chosen mechanism.** Each Zitadel user carries one metadata key per Fleetworks app in which that
person already has a local account:

```
fleetworks_chorus_user_id        = <chorus  users.id>
fleetworks_helmsman_user_id      = <helmsman users.id>
fleetworks_warden_user_id        = <warden  users.id>
fleetworks_yellow_pages_user_id  = <yellow-pages users.id>
fleetworks_rolodex_user_id       = <rolodex users.id>     # see "Recommendation to Phase 1"
```

A Zitadel user can hold many metadata keys, so **the cardinality gap that killed the naive
`externalId` extension does not exist here** — four apps, four keys, one Zitadel user, no conflict.
Keys are `[a-z0-9_]` only (no colons, no URN shape): key-charset rules are undocumented upstream,
and this charset is the conservative choice pending Step 0. The `fleetworks_` prefix keeps us
clear of Zitadel's internal `urn:zitadel:scim:` namespace.

**How it is used — three flows, none of them at runtime:**

1. **Write (provisioning time).** When a person is provisioned into Zitadel, the provisioning
   script sets one metadata key per app they already exist in. This is the same script Phase 1
   writes for rolodex, extended.
2. **Read (one-time per-app backfill).** For each app, enumerate provisioned Zitadel users, read
   `fleetworks_<app>_user_id`, **base64-decode it**, look up that local `users.id`, and write the
   **Zitadel user's own `id`/`sub` — never the metadata value** — into that row's `zitadel_subject`
   column. This is deliberately the identical two-step shape the sibling plan locked for rolodex:
   *the metadata locates the row; the `sub` is what gets stored.*
3. **Write-back (optional, best-effort, post-JIT-create).** When an app JIT-creates a genuinely new
   local row, it may asynchronously set `fleetworks_<app>_user_id` on the Zitadel user so the link
   is durable for future environments/restores. **Must be fail-open and off the request path** — a
   failed IdP write must never fail a login. Optional; not required by any acceptance criterion.

**Why the backfill does not need the metadata search filter.** Enumerate-and-read is O(N) in users,
runs once, offline. `metadata_key_filter` on `ListUsers` is an optimization only, and since its
response omits values it would still need per-user follow-up calls. Making the design independent
of an unversion-confirmed filter is deliberate.

#### Alternatives considered

- **(B) A per-app external-identity mapping table (`zitadel_identity_links`) as the runtime lookup.**
  **Rejected as a runtime mechanism — it is redundant.** Each app already has a column
  (`providerSubject`) whose entire job is "IdP subject → local row." A second table storing the
  same relation adds a join and a schema change and prevents nothing, because the correlation
  question is *which* Zitadel user maps to which local row — a mapping table is a *destination*,
  not a *join key*. This is the same reasoning that removed the `oauth_accounts` "reuse as-is"
  guidance from the sibling plan. **Partially retained** in a different role: see the fallback.
- **(C) Direct email match at backfill time, with no durable Zitadel-side link.** Rejected as the
  *mechanism* (it leaves no re-runnable artifact, no audit trail, and no way to bootstrap a new
  environment or a sixth app), but **retained as the bootstrap signal** — see "Isn't this just
  email correlation again?" below.
- **(D) SCIM `externalId`, extended suite-wide.** Rejected — **but the sibling plan's stated reason
  is imprecise and should be corrected.** Zitadel does *not* store a single `externalId` field; it
  stores externalId **scoped per SCIM provisioning domain** (internally, as `urn:zitadel:scim:`-
  prefixed metadata). So Zitadel could in principle hold four externalIds for one user. It is still
  the wrong choice, for three sturdier reasons: (i) it requires each app to masquerade as a distinct
  SCIM provisioning client, which they are not — in Phase 2 the *customer's* Okta/Entra is the SCIM
  client; (ii) the per-domain key layout is an undocumented implementation detail, not a supported
  API contract; (iii) it is strictly more contorted than writing the same underlying metadata store
  directly, which is what Option A does. **Net:** the decision stands, the justification is now
  correct. *(This also *downgrades* — does not eliminate — a risk worth recording: a customer IdP's
  Phase-2 SCIM writes clobbering rolodex's Phase-1 externalId is **probably** prevented by domain
  scoping. Verify in Step 0.4 rather than assuming either way.)*
- **(E) A new suite-wide "Fleetworks Person ID" column added to all four apps.** Rejected: it adds
  a migration to four repos and still has to be bootstrapped by the same signal, so it buys nothing
  over metadata while costing four schema changes.
- **(F) Put the metadata in the access token as a claim and correlate at runtime.** Rejected on the
  reframe above — correlation is a backfill concern, so paying a per-request claim cost is pure
  downside. It would additionally require JWT (not opaque) access tokens, an extra scope, and it
  walks straight into upstream #8435's token-bloat report.

#### Fallback, pre-designed (do not improvise this under time pressure)

**If Step 0 shows metadata is unusable on v4.17.1** (unavailable, size/count-limited below need, or
the service-account grant model does not permit it), fall back to **A′: a per-app
`zitadel_identity_links` backfill ledger** — `(zitadel_user_id, local_user_id, matched_by,
matched_at, confidence, reviewed_by)` — living in each app's own DB. It is *not* a runtime lookup
(the runtime path stays `zitadel_subject`); it is the idempotence-and-audit artifact that metadata
would otherwise have provided, relocated from the IdP into the app. Cost: four independent ledgers,
no single suite-wide view, and a new app cannot bootstrap from Zitadel alone. Acceptable; strictly
worse; only on Step 0 failure.

#### "Isn't this just email correlation again?" — no, and the difference is the whole point

Something has to make the very first link between "Zitadel user X" and "chorus row Y", and for the
legacy cohort that signal is, unavoidably, **email** (optionally corroborated by
`employeeNumber`/`objectGUID` via rolodex's directory). There is no magic. What was rejected in D5
was **runtime** email correlation, and the difference is categorical:

| | Rejected D5 email correlation | This plan |
|---|---|---|
| When | Every login, forever | Once, offline, before cutover |
| On mismatch | Silently creates a duplicate row | Row lands on an operator review list; **nothing is written** |
| Reviewable | No | Yes — dry-run report is a gate |
| Leaves behind | Nothing | Durable non-email link (metadata + `zitadel_subject`) |
| Steady state | Permanently email-dependent | **Zero email dependence** |

The output of the bootstrap is a non-email identifier. After cutover, no code path anywhere
consults email for identity.

**The Suite Identity Roster (SIR)** is the bootstrap deliverable: extract
`(app, local_user_id, email, display_name, active)` from all five apps' `users` tables, dedupe on
normalized email, emit one roster row per person with 1–5 app links, plus a **conflict report**
(same email different people, same person different emails per app, ambiguous/absent email).
Conflicts are resolved by a human into an override file; **unresolved conflicts block that person's
provisioning — fail closed, never auto-match.** The SIR contains real PII (see Risks) and must be
generated to a gitignored path and never committed.

---

### P4-D2 — Every app adds its own **nullable `zitadel_subject` column**. Do **not** reuse `providerSubject`.

Each of chorus/helmsman/warden already has `providerSubject`, and reusing it looks free. It is not:

- **helmsman's `providerSubject` is `NOT NULL`** (`schema.ts:71-78`) — every row already holds the
  person's **Supabase** subject. Overwriting it with a Zitadel `sub` **destroys the legacy
  identifier while the dual-accept window is still open.** The next legacy Supabase token then
  misses tier-2 lookup and creates exactly the duplicate row this whole plan exists to prevent.
- chorus's and warden's are nullable but *populated* for anyone who ever signed in — same failure,
  just for a subset.
- A single column cannot hold two issuers' subjects unambiguously without issuer-qualifying the
  value, which is a data-format migration masquerading as a shortcut.

**Decision:** each app adds a **nullable, uniquely-indexed `zitadel_subject`**, and its JIT lookup
becomes the identical 4-tier ladder rolodex now runs:

```
zitadel_subject == sub  →  providerSubject == sub (legacy Supabase)  →  legacy id-as-sub  →  create
```

This makes all five apps structurally identical, which is worth a great deal for review and for
Phase 5's teardown. The unique index is load-bearing: it turns a correlation bug into a constraint
violation instead of a silent duplicate.

---

### P4-D3 — Org scope: role comes from the Zitadel claim; **org membership stays app-local**; the claim's org ID is correlated via a new `orgs.zitadel_org_id` column.

The claim is `urn:zitadel:iam:org:project:roles` with shape `{ role: { orgId: primaryDomain } }`.
Three traps, each with a decision:

1. **The Zitadel org ID is not the app's org ID.** Chorus/helmsman/warden each have their own local
   org UUIDs. Mapping requires an explicit correlation, and this is *the same conflation error* as
   the externalId one, one level up. **Decision:** each multi-tenant app adds a nullable,
   uniquely-indexed **`orgs.zitadel_org_id`** column, backfilled by the same reviewed offline
   process as users. No env-var map — a map in config drifts and cannot be constrained.
2. **Join on the org ID, never on `primaryDomain`.** The claim's *key* is the stable Zitadel org ID;
   the *value* is a primary domain, which is renameable. Joining on the value is a latent breakage.
3. **The claim can carry more than one org**, if a person holds role grants in several Zitadel orgs.
   `orgId` is therefore **not a scalar** and code that reads "the" org from the claim is wrong.

**Decision:** in Phase 4, **`org_members`/`orgMembers` remains the sole authority for which orgs a
person belongs to and at what app-level role.** The Zitadel claim is used to (a) resolve the coarse
platform role (`admin`/`member` — the only two Zitadel models, per `seed.ts:57-60`) and (b) **assert**
that the org the request is scoped to appears in the claim. Zitadel is not granted the power to
*create* membership in Phase 4.

This is not a dodge — it is what `seed.ts:184-200` already says the system is: *"an app's third rung
is its own org_members role, which Zitadel neither knows nor needs to know."* Zitadel-driven org
provisioning is a real capability, but it belongs with Phase 2's SCIM work, and it cannot be built
now regardless: **Zitadel's SCIM has no `/Groups` endpoint**, so group/entitlement provisioning has
no SCIM path at all today.

> **Consistency note with the parent plan.** The parent's AC says multi-tenant apps "correctly
> derive `orgId` from the Zitadel org/grant claim." This decision satisfies that — `orgId` *is*
> derived from the claim, via `orgs.zitadel_org_id` — while declining to let the claim *grant*
> membership. If a reviewer reads the parent AC as requiring claim-granted membership, that is a
> genuine scope disagreement and should be settled before helmsman starts. Logged as OQ-3.

---

### P4-D4 — `azp` must be an **allow-list per app**, not a scalar, or every mobile login 401s.

Nine clients, one project ⇒ `aud` contains all nine ⇒ `azp` is the only isolation control. But each
app now has **two** legitimate clients:

| App | Allowed `azp` set |
|---|---|
| helmsman | `helmsman`, `helmsman-mobile` |
| chorus | `chorus`, `chorus-mobile` |
| warden | `warden` **only** — no mobile client is seeded |
| yellow-pages | `yellow-pages`, `yellow-pages-mobile` |
| rolodex | `rolodex`, `rolodex-mobile` |

**Decision:** `@cogs/auth`'s azp check must accept a **set** (`AUTH_ALLOWED_AZP`, comma-separated),
not a single value. **Verify `@cogs/auth@0.6.0`'s actual shape first** — if it is scalar today, that
is a shared-package change and it blocks helmsman, so it must be found in Step 0.5, not in
helmsman's PR. Isolation must still hold: chorus's set never contains a yellow-pages client ID.

---

### P4-D5 — `/oidc/v1/userinfo` is called on the **JIT-create/enrich path only**, not per request.

Zitadel access tokens carry no `email`/`name`. Phase 0 proved userinfo works, and framed it as
"per request (cached)". **Refined here:** once a local row exists, the hot path resolves by `sub`
alone and needs nothing from userinfo. Call it **only** when the local row is absent, or present
with an empty `email`/`name` (repairing exactly the malformed rows Phase 0's gap-2 created).

This matters beyond latency: a per-request userinfo call makes **every API request in every app
fail when Zitadel is unreachable**, converting an IdP blip into a total suite outage. Cache keyed
on **`(issuer, sub)`** — never `sub` alone, which would collide across the dual-accept window's two
issuers — with a short TTL and serve-stale-on-error.

---

### P4-D6 — Dual-accept runs **two separately-configured verifiers**, never one verifier that picks an algorithm from the token header.

Per app, a flag (`AUTH_LEGACY_SUPABASE_ENABLED`) keeps the legacy Supabase verifier alive behind the
Zitadel one. Two hard constraints:

- **Each verifier pins its own algorithm allow-list.** Zitadel verifier: RS256 + JWKS only. Legacy
  verifier: the app's existing mode only. A single verifier that reads `alg` from the header and
  selects a key accordingly is the classic algorithm-confusion vulnerability — and yellow-pages,
  which holds *both* an HS256 shared secret and (soon) a JWKS public key, is exactly the shape where
  it becomes exploitable. See P4-D7.
- **Machine tokens short-circuit both.** `dg_` (rolodex), `ci:agent` PATs (helmsman), chorus PATs,
  `WEBHOOK_DRAIN_TOKEN`-style internal tokens are D6-scoped and must be detected before either JWT
  verifier runs.

**Exit criteria (per app), data-driven rather than by feel:** every auth decision emits a metric/log
tagged with which verifier accepted it. The legacy verifier is disabled only when (a) zero legacy
acceptances for N consecutive days, **and** (b) 100% of *active* local users have a non-null
`zitadel_subject`. This gives Phase 5 a gate instead of a guess, and it is why the observability
line is a real requirement, not garnish.

---

### P4-D7 — yellow-pages' HS256→JWKS swap is its own sub-task, sequenced last, with security tests the other three do not need.

Yellow-pages verifies with a symmetric `SUPABASE_JWT_SECRET`. Beyond the mechanical swap:

- During dual-accept it holds a symmetric secret **and** asymmetric JWKS material simultaneously —
  the only app in the suite that does. Algorithm-confusion tests (below) are mandatory here and
  merely prudent elsewhere.
- `SUPABASE_JWT_SECRET` may still be needed for non-human paths; the AC is that it is gone from the
  **human** token path, which is a narrower and more honestly testable claim than "the env var is
  deleted."
- Yellow-pages is **single-tenant**, so P4-D3 does not apply to it. That is a *simplification*, and
  it is the one thing making "hardest verifier change" and "last in line" tolerable together.
- **Its schema and JIT path are unsurveyed** (see the Grounded-facts gap). Step YP-0 surveys it
  first; if yellow-pages turns out to lack a `providerSubject` column or a JIT path shaped like the
  other three, **its design is reopened, not force-fitted.**

---

## Implementation Steps

### Step 0 — Zitadel capability verification (**not blocked on Phase 1; run first, run now**)

Against the local v4.17.1 stack (`docker compose up -d --wait && node seed.ts`), using the headless
token recipe in `README.md:163-187`. **Every item below is a live check, because none of it could be
verified in this planning environment (Docker daemon down, 2026-09-05).**

1. **Metadata write/read round-trip.** `POST /v2/users/{id}/metadata` with
   `fleetworks_chorus_user_id`; read it back via `POST /v2/users/{id}/metadata/search`. Confirm the
   **base64 encode/decode** behaviour explicitly in both directions and write down the exact shape.
2. **Multi-key.** Set all four `fleetworks_*_user_id` keys on one user simultaneously; confirm all
   four persist and are independently readable. *This is the empirical disproof of the cardinality
   objection — capture the raw response as evidence.*
3. **Undocumented limits.** Probe key charset (does `_` work? does `:`?), max key length, max value
   size, and keys-per-user, since none is documented upstream. Record actual observed limits.
4. **Namespace safety + SCIM interaction.** Confirm our `fleetworks_`-prefixed keys neither collide
   with nor are clobbered by `urn:zitadel:scim:`-prefixed keys, and check whether a SCIM write under
   a *different* provisioning domain leaves them (and a prior externalId) intact. This is what
   downgrades-or-confirms the Phase-2-clobbering risk in P4-D1 Option D.
5. **`@cogs/auth@0.6.0` azp shape.** Read the shipped code: is the azp check scalar or set-valued
   (P4-D4)? A scalar check is a shared-package change and it blocks helmsman.
6. **Service-account grant.** Determine the minimum role for the backfill machine user
   (`ORG_USER_MANAGER` if single-org; instance-level only if it must read across orgs) and confirm
   metadata read works with exactly that grant and no more.
7. *(Optional, informational only)* Whether `ListUsers` `metadata_key_filter` exists on 4.17.1.
   Nothing depends on it; record the answer for future optimization.

**Gate:** items 1, 2 and 6 pass ⇒ **P4-D1 stands**. Any of them fails ⇒ **fall back to A′** and
amend this document before starting helmsman. Do not proceed on a partial result.

### Step 1 — Suite Identity Roster + provisioning extension (once, spans all apps)

1. Build the SIR extractor: per-app read-only export of `(app, local_user_id, email, display_name,
   active)`; normalize and dedupe on email; emit roster + conflict report to a **gitignored** path.
2. Human review of the conflict report; unresolved entries stay unprovisioned (fail closed).
3. Extend Phase 1's rolodex provisioning script to write all applicable `fleetworks_<app>_user_id`
   metadata keys per person, idempotently (re-runnable, no-op on unchanged).
4. **Dry-run mode is mandatory and is the default.** It reports counts per app: would-link,
   already-linked, unmatched, conflicted — and writes nothing.

### Step 2 — helmsman (first: already JWKS, so the correlation mechanism is exercised in isolation)

> **Sequencing tension, stated openly.** The parent plan's order is lowest-*verifier*-risk first,
> and by that measure helmsman is easiest. By **blast radius** it is the worst of the three — the
> only one that also fragments `audit_events.actorId` and `createdBy`. The order is kept, because
> controlling one variable at a time (no verifier change ⇒ any failure is unambiguously a
> correlation failure) is worth more than going gentlest-first. The tension is paid for by making
> helmsman's correlation gate the strictest in the rollout — and that is *cheap* here precisely
> because `providerSubject` is `NOT NULL`, so **every** helmsman user is already IdP-linked and
> 100% correlation coverage is a legitimate, achievable bar. Any unmatched row is a hard stop.

1. Add nullable unique `zitadel_subject` to `users`; add nullable unique `orgs.zitadel_org_id`.
   **Do not touch `providerSubject`** (P4-D2).
2. Extend the JIT lookup at `apps/api/src/auth/middleware.ts:147-175` to the 4-tier ladder.
3. Repoint `@cogs/auth` env to Zitadel; set `AUTH_ALLOWED_AZP` = {helmsman, helmsman-mobile}
   (P4-D4); enable dual-accept (P4-D6).
4. Map the URN role claim onto helmsman's `org:admin`/`org:contributor`/`org:viewer`; wire
   `orgs.zitadel_org_id` per P4-D3; **membership stays in `org_members`.**
5. Run the backfill dry-run; require **100% coverage, zero unmatched**; then apply.
6. Swap web login to Zitadel (helmsman web is a `USER_AGENT` client — browser PKCE, not the BFF
   shape chorus/warden/yellow-pages use); point `helmsman-mobile` at its own client.
7. Full AC suite (below) + the helmsman-specific audit-trail assertion.

### Step 3 — chorus

Same 1–7, with: JIT at `apps/api/src/auth/middleware.ts:113-141`; `orgMembers` at `schema.ts:74-84`;
routes mounted at root (no `/api` prefix — note when writing route-level tests); `GET /api/me`
role assertion; azp set {chorus, chorus-mobile}; **web login is the server-side BFF route handler**
(`apps/web/src/app/auth/callback/route.ts`, `OIDC_APP_TYPE_WEB`), ported from yellow-pages' BFF
session subsystem — not the browser PKCE shape helmsman used.

### Step 4 — warden

Same, with: JIT at `apps/api/src/auth/middleware.ts:133-161`, gated on **every** `/api/*`
(`apps/api/src/index.ts:90`) — so a correlation regression here is instantly total, and warden's
canary/rollback window must be correspondingly tighter. `orgMembers` at `schema.ts:41-59`; base
`/api/gatehouse/v2`; Kubb client threads bearer via `useAccessToken`; **azp set = {warden} only**;
BFF-style server-side callback.

### Step 5 — yellow-pages (two sub-tasks, in order)

**YP-0 — survey first (closes the inherited gap).** Record, with file:line citations matching the
2026-08-24 survey's format: the `users` schema, whether `providerSubject` exists and its nullability,
the JIT-provisioning path, every table keyed on the user id, and the concrete duplicate-row blast
radius. **If yellow-pages does not match the other three's shape, reopen its design here.**

**YP-1 — verifier swap (HS256 → RS256/JWKS).** Replace `SUPABASE_JWT_SECRET` verification on the
**human** path with JWKS/RS256. Two verifiers, each with a pinned algorithm allow-list (P4-D6/D7) —
never one verifier selecting a key from the token's `alg` header.

**YP-2 — correlation + cutover.** Steps 1–7 as above, minus P4-D3 (single-tenant); azp set
{yellow-pages, yellow-pages-mobile}; BFF callback (yellow-pages is the origin of that pattern).

### Step 6 — close out

Per app, once its dual-accept exit criteria (P4-D6) are met: disable the legacy verifier, then hand
to Phase 5 for Supabase GoTrue teardown. **Phase 5 is out of scope here.**

---

## Acceptance Criteria (testable)

### Correlation (per app: helmsman, chorus, warden, yellow-pages)

- [ ] **AC-C1 — no duplicate row, the headline test.** A user with an existing local row, whose
      Zitadel user carries `fleetworks_<app>_user_id`, authenticates with a Zitadel token after the
      backfill: `SELECT count(*) FROM users WHERE …` is unchanged, and the request resolves to the
      **pre-existing** row id.
- [ ] **AC-C2 — blast-radius assertion, app-specific, not generic.** After that login: chorus and
      warden assert the person's `orgMembers`/`org_members` rows are intact and their effective role
      is unchanged (not floored). Helmsman additionally asserts a new `audit_events` row carries the
      **original** `actorId`, and that no `createdBy` column now points at a second identity.
- [ ] **AC-C3 — two-step mapping is honoured (the exact bug the sibling plan's critic caught).**
      Assert `zitadel_subject` holds the **Zitadel user's `sub`**, and that the metadata value
      (the local user id) appears **nowhere** in `zitadel_subject` or `providerSubject`.
- [ ] **AC-C4 — base64 decode is exercised.** A metadata value containing a real UUID round-trips
      through set → read → decode → match. A deliberately non-decoded comparison must be shown to
      *fail* the match (proving the test would catch a missing decode rather than passing by luck).
- [ ] **AC-C5 — `providerSubject` is not clobbered.** Before/after the backfill, every row's
      `providerSubject` is byte-identical. Explicit on helmsman, where the column is `NOT NULL` and
      overwriting it silently breaks dual-accept.
- [ ] **AC-C6 — unmatched fails closed.** A Zitadel user with **no** `fleetworks_<app>_user_id`
      metadata and no matching row appears in the backfill's unmatched report and causes **zero**
      writes. A net-new user (cohort 2) logging in afterwards is correctly JIT-created — one row,
      not zero, not two.
- [ ] **AC-C7 — backfill is idempotent.** Running it twice produces an identical DB state and a
      second-run report of `linked: 0, already-linked: N`.
- [ ] **AC-C8 — unique index is real.** Attempting to write the same `zitadel_subject` onto two rows
      raises a constraint violation rather than succeeding.

### Token verification (per app)

- [ ] **AC-T1** Valid Zitadel RS256 token → 200. Expired → 401. Wrong `aud` → 401. Wrong `iss` → 401.
- [ ] **AC-T2 — cross-app isolation, the Phase-0 gap.** A token minted for **another app's** client
      (whose `aud` legitimately contains this app's client ID, because all nine clients share one
      project) → **401**. Run this with a yellow-pages-client token against chorus specifically.
- [ ] **AC-T3 — mobile azp.** A token from `<app>-mobile` → 200. Warden asserts the inverse: it has
      no mobile client, so any mobile-client token → 401.
- [ ] **AC-T4 — dual-accept.** Legacy Supabase token → 200 while the flag is on; Zitadel token → 200;
      with the flag off, legacy → 401 and Zitadel → 200. Four assertions.
- [ ] **AC-T5 — machine tokens unchanged (regression).** helmsman `ci:agent` PAT and chorus PAT
      authenticate byte-identically to pre-change behaviour, and are never routed through either JWT
      verifier.
- [ ] **AC-T6 — observability gate exists.** Each auth decision emits which verifier accepted it;
      a test asserts the legacy-acceptance counter increments on a legacy token and not on a Zitadel
      one. This is what P4-D6's exit criteria are measured against.

### Claim → role / org (helmsman, chorus, warden only)

- [ ] **AC-O1** The URN role claim maps to the app's role model; a token with no recognised role
      resolves to the app's least-privileged role and **fails closed** (explicitly asserting the
      Phase-0 gap-4 concern that `extractStrings` returns `[]` on an unexpected shape).
- [ ] **AC-O2 — org correlation, not conflation.** The app's `orgId` is resolved via
      `orgs.zitadel_org_id`; a test asserts the raw Zitadel org ID from the claim is **never** used
      directly as a local `orgId`, and that the join uses the claim's **key** (org ID), not its
      **value** (`primaryDomain`).
- [ ] **AC-O3 — multi-org claim.** A token whose role claim carries **two** Zitadel orgs is handled
      deterministically (no silent "first key wins"); a request scoped to an org absent from the
      claim → 403.
- [ ] **AC-O4 — membership stays local.** A user with a valid Zitadel role claim but **no**
      `org_members` row gets **no** access — the claim does not grant membership (P4-D3).

### yellow-pages only

- [ ] **AC-Y1 — survey exists.** YP-0's findings are written up with file:line citations before any
      yellow-pages code changes; the inherited-survey gap is closed in writing.
- [ ] **AC-Y2 — HS256 gone from the human path.** Human tokens verify RS256/JWKS; no code path
      reachable from human auth reads `SUPABASE_JWT_SECRET`.
- [ ] **AC-Y3 — algorithm confusion rejected.** A token with `alg: HS256` signed using the JWKS
      **public key** as an HMAC secret → 401. `alg: none` → 401. A token with `alg: RS256` but an
      unknown `kid` → 401. Each verifier's algorithm allow-list is asserted directly, not inferred.
- [ ] **AC-Y4 — single-tenant.** No org-scope logic is introduced (P4-D3 does not apply); asserted
      by absence.

### Per-repo hygiene

- [ ] **AC-H1** `pnpm typecheck` 0 errors and `pnpm test` green in each touched repo.
- [ ] **AC-H2** Browser verification of each web-login change (`/verify-stage`), one per app,
      matching each app's actual client shape (helmsman = browser PKCE; chorus/warden/yellow-pages =
      server-side BFF callback route).
- [ ] **AC-H3** `fleetworks-web/infra/zitadel.tf` is updated for production alongside each app's
      local seed entry — the local `seed.ts` is **not** the production registration surface.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Metadata turns out unusable on v4.17.1** (undocumented limits, grant model, or a 4.17-specific regression). | Step 0 gates the whole plan; fallback A′ is pre-designed rather than improvised. Note the *decision* is robust either way — both options implement the same two-step mapping and the same runtime path. |
| **Base64 decode is silently omitted** in the backfill, so no metadata value ever matches and every user is "unmatched". | AC-C4 requires proving the negative case fails. Fail-closed behaviour (AC-C6) means the visible symptom is a loud unmatched report, not silent duplicates. |
| **`providerSubject` clobbered on helmsman** (`NOT NULL`), breaking dual-accept mid-window. | P4-D2 forbids reuse; AC-C5 asserts byte-identical before/after. |
| **Zitadel org ID used directly as a local `orgId`** — the externalId conflation error, repeated one level up. | P4-D3's dedicated `orgs.zitadel_org_id` column + AC-O2. |
| **Joining org scope on `primaryDomain`** (the claim's renameable *value*) instead of the org ID (its stable *key*). | Called out explicitly in P4-D3; asserted in AC-O2. |
| **Multi-org role claims** treated as scalar. | AC-O3. |
| **Mobile logins 401 on day one** because the azp check is scalar. | P4-D4 + Step 0.5 finds it in `@cogs/auth@0.6.0` *before* helmsman starts, since it is a shared-package change. |
| **Cross-app token leakage** — nine clients in one project means `aud` isolates nothing. | AC-T2, run adversarially (yellow-pages token → chorus). See OQ-1 on per-app projects as defence in depth. |
| **Algorithm confusion on yellow-pages**, the only app holding both a symmetric secret and JWKS material. | P4-D6/D7 mandate two verifiers with independently pinned algorithm lists; AC-Y3. |
| **Suite-wide outage if Zitadel blips**, because userinfo is on the hot path. | P4-D5 confines userinfo to the JIT-create/enrich path; cache keyed `(issuer, sub)`, serve-stale-on-error. |
| **Warden's blast radius is instantaneous** — auth gates every `/api/*`. | Tighter canary + rollback window for warden specifically; it is sequenced third, after the mechanism is twice-proven. |
| **The SIR contains real PII** (emails, names, across five apps) — and rolodex's own docs already flag that its JWT gate is the only control over `birthDate`/`mail`. | SIR generated to a gitignored path, never committed, deleted after backfill; conflict-override files redact or hash emails. Treat the SIR as production PII, not a build artifact. |
| **Phase 1 slips further**, and Phase 4 stalls behind it. | Step 0 and Step 1's SIR extractor are genuinely independent of Phase 1 and can proceed now; only Steps 2–5 wait. |
| **This plan is followed while Phase 1's actual implementation diverges** from the template it assumes. | Re-verify rolodex's shipped Phase 1 shape before Step 2 begins; if it diverged, amend here first rather than letting two patterns coexist. |

---

## Pre-mortem — three concrete ways this fails

1. **"The backfill ran clean, but 40% of users still got duplicates."** The SIR deduped on raw email,
   and a large cohort has different emails per app (work vs. personal, or a domain migration). The
   dry-run reported them as *distinct people*, not as conflicts, so they were provisioned as separate
   Zitadel users and each linked to only one app. **Prevented by:** the SIR must report
   *same-person-different-email* candidates (fuzzy/name/directory-corroborated) as **conflicts
   requiring review**, not silently accept them as distinct. This is the single weakest joint in the
   design and deserves the most review attention.
2. **"helmsman went fine, warden took the whole app down for an hour."** Warden's auth gate covers
   every `/api/*`, so a claim-mapping edge case that would degrade one endpoint elsewhere 401s
   everything at once. **Prevented by:** warden ships behind the dual-accept flag with a rehearsed
   single-env-var rollback, and its canary window is measured in minutes, not days.
3. **"Everything passed, then Phase 2 broke rolodex."** The customer IdP's SCIM integration wrote
   `externalId` over rolodex's Phase-1 value. Domain scoping *probably* prevents this — but it was
   assumed rather than tested. **Prevented by:** Step 0.4 tests exactly this interaction, and the
   Phase-4 mechanism deliberately does not depend on `externalId` at all, so at worst the damage is
   confined to rolodex.

---

## Open Questions

*(Recorded here rather than in `.omc/plans/open-questions.md`: this task is scoped to a single new
file. Merge them into that file when this plan is approved.)*

- **OQ-1 — one Zitadel project or five?** Nine clients in one project makes `aud` meaningless and
  leaves a single equality check as the only cross-app boundary. Per-app *projects* would restore
  real `aud` isolation, at the cost of per-project role grants and a claim-shape change
  (`…:project:{projectId}:roles`). **Recommendation: keep one project for Phase 4** — do not churn
  the identity topology mid-rollout — and open it as a hardening follow-up. Needs a decision-owner.
- **OQ-2 — does the parent plan's Phase 4 AC require claim-*granted* org membership?** P4-D3 reads
  it as claim-*derived* `orgId` with membership staying local. If a reviewer reads it the other way,
  that is a real scope disagreement and must be settled **before** helmsman starts.
- **OQ-3 — are all app users AD/Workday-backed?** If yes, rolodex's `directory_users` gives the SIR
  a much stronger corroborating key (`employeeNumber`/`objectGUID`) than email, and materially
  de-risks pre-mortem #1. If contractors/externals exist only in app DBs, email is all there is for
  that cohort.
- **OQ-4 — where does the mobile access token come from?** Native clients use their own client IDs
  (P4-D4 covers azp), but whether mobile hits the same API auth path as web, and whether it can
  reach `/oidc/v1/userinfo`, was not verified. Confirm during Step 2.
- **OQ-5 — should Phase 1 (rolodex) also write `fleetworks_rolodex_user_id` metadata?** Not this
  plan's call, but recommended: it makes all five apps use one mechanism, and it insulates rolodex
  from any `externalId` clobbering. Raise with Phase 1's owner before Phase 1 lands, since it is
  nearly free to add now and expensive to retrofit.
- **OQ-6 — deployment target for production Zitadel** (Cloud vs. self-hosted) is still unstated
  (parent plan says "state explicitly before Phase 1"). Phase 4's design is agnostic, but the
  backfill's service-account grant model (Step 0.6) and `fleetworks-web/infra/zitadel.tf` both need
  the answer.

---

## Verification Steps

1. **Step 0:** run all seven checks against local v4.17.1; capture raw request/response pairs as
   evidence in the same style Phase 0 used. Publish a written GO (P4-D1) or FALLBACK (A′) verdict.
2. **Per app, pre-cutover:** backfill dry-run report reviewed and signed off — helmsman requires
   100% coverage / zero unmatched; the others require every unmatched row individually explained.
3. **Per app, post-cutover:** the full AC suite green; `pnpm typecheck` 0; `pnpm test` green.
4. **Adversarial, per app:** mint a token for a *different* app's client using the headless recipe
   (`README.md:163-187`) and confirm 401 (AC-T2). This is the one test most likely to be skipped and
   most likely to matter.
5. **Rollback rehearsal, per app:** flip `AUTH_LEGACY_SUPABASE_ENABLED` back on in staging and
   confirm legacy tokens authenticate again within one request. Rehearsed, not assumed.
6. **Suite-level, after all four:** one person logs into all five apps with one Zitadel identity and
   resolves to their **pre-existing** row in each — the actual deliverable, tested end to end.

---

## ADR

- **Decision.** Phase 4 correlates Zitadel identities to per-app local users via **per-app Zitadel
  user metadata keys** (`fleetworks_<app>_user_id`), written at proactive provisioning time and
  consumed by a **one-time, per-app, offline backfill** that writes the **Zitadel user's own `sub`**
  — never the metadata value — into a **new nullable `zitadel_subject` column** in each app. The
  runtime JIT path becomes the same 4-tier ladder in all five apps and makes **no external calls**.
  Rollout order is **helmsman → chorus → warden → yellow-pages**.
- **Drivers.** (1) The cardinality gap that killed suite-wide `externalId` is real and must be solved
  by a mechanism with N-per-user capacity. (2) Correlation is a *backfill-time* problem, not a
  runtime one — which removes any dependency on metadata-in-token, opaque-vs-JWT access tokens, and
  upstream issue #8435. (3) A duplicate row means silent org-membership loss (and, on helmsman, a
  fragmented audit trail), so the mechanism must fail **closed and loudly**. (4) The suite already
  treats fine-grained role and org membership as app-local (`seed.ts:184-200`); the design should
  follow that grain rather than fight it.
- **Alternatives considered.** (A′) per-app local mapping ledger — retained as the pre-designed
  fallback if Step 0 fails, strictly worse (no suite-wide view, cannot bootstrap a new environment).
  (B) a mapping table as the *runtime* lookup — rejected as redundant with `providerSubject`.
  (C) email correlation as the mechanism — rejected; retained only as the one-time, reviewed,
  fail-closed *bootstrap* signal whose output is a non-email identifier. (D) suite-wide SCIM
  `externalId` — rejected, **and the parent plan's reason corrected**: Zitadel scopes externalId per
  provisioning domain, so the "one field" premise is imprecise; the real objections are that apps
  are not SCIM clients, the key layout is an undocumented internal detail, and it is a contortion
  around the very metadata store Option A uses directly. (E) a new suite-wide person-ID column in
  four apps — rejected; same bootstrap problem plus four migrations. (F) metadata as a runtime token
  claim — rejected by the backfill reframe.
- **Why chosen.** It is the only option with the right cardinality, that leaves a durable non-email
  artifact, that requires **zero** runtime external calls, that reuses the exact two-step mapping
  already reviewed and approved for rolodex, and whose single unverified assumption is isolated
  behind an explicit, cheap, first-in-line live-verification gate with a pre-designed fallback.
- **Consequences.** Four repos each get two nullable unique columns (`users.zitadel_subject`, and
  `orgs.zitadel_org_id` for the three multi-tenant ones), a 4-tier JIT ladder, and a one-time
  backfill script. `@cogs/auth` may need its azp check widened from scalar to set (Step 0.5) — a
  shared-package change that blocks helmsman. A Zitadel service account with `user.read` (and
  `user.write` if optional write-back is enabled) becomes a new operational dependency. The SIR is
  a PII-bearing artifact requiring handling discipline. Zitadel-driven org *provisioning* is
  explicitly deferred and, given SCIM has no `/Groups` endpoint, is not currently buildable anyway.
- **Follow-ups.** OQ-1 (per-app projects as `aud` hardening). OQ-2 (settle the org-membership scope
  reading before helmsman). OQ-5 (recommend Phase 1 also write rolodex's metadata key). Phase 5's
  legacy-verifier teardown consumes P4-D6's observability counter as its gate. Yellow-pages' YP-0
  survey should be appended to the parent plan's dated survey section in the same format, closing
  the gap this plan found.
