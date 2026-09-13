# Plan: Suite-wide SSO / SAML / SCIM via Zitadel Cloud (platform identity)

**Status:** pending approval · **Mode:** direct · **Created:** 2026-07-23
**Scope:** deliver enterprise identity — **SSO, SAML, and SCIM** — across the 5-app Fleetworks suite (chorus, helmsman, rolodex, warden, yellow-pages) by putting **Zitadel Cloud** in front of every app as the central Identity Provider (IdP) and token issuer. The 5 apps keep their 5 separate Supabase **data** projects; Supabase Auth (GoTrue) stops being the human-login token issuer. This is the concrete engineering plan for the enterprise-identity deliverable that the separately-decided Zitadel migration is meant to unlock. **Rolodex is the pilot** (it is the suite's directory/access app and the app whose marketing page now names SSO/SAML/SCIM as a platform guarantee).

## The idea (framing)
Today the suite is 5 apps, each with its **own** Supabase Auth project → 5 separate logins, no SSO. The decision to consolidate onto **Zitadel Cloud** has already been made (outside this task) and was described as "a big lift, not even sure it will work yet." This plan does **not** re-decide that; it delivers the specific customer-facing capability the migration exists for: one login (SSO) across all 5 apps, SAML for enterprise customers whose IdP only speaks SAML, and SCIM so customer IdPs (Okta/Entra) can provision/deprovision users into the suite automatically. Because feasibility across 5 independently-authed apps is genuinely unproven, the plan is **spike-first against one app (Rolodex)** with an explicit GO/NO-GO gate before any suite-wide rollout.

## Grounded facts (verified 2026-07-23 from each app's CLAUDE.md)
- **5 apps, 5 separate Supabase Auth projects — no shared auth exists today.** Each app authenticates its own users independently; there is no cross-app session or shared identity.
- **Per-app token verification is heterogeneous** (this matters for repointing to Zitadel):
  - **helmsman** — Supabase Auth **RS256 JWT, JWKS verification via `AUTH_JWKS_URL`** (`packages/auth` = JWT verification + RBAC middleware). Org-scoped; API base `/api/v1`; envelope `{total,next,prev,items[]}`. Service-account PATs are role `ci:agent`. Deployed as `coastguard-api` on Render.
  - **yellow-pages** — Supabase Auth verified with a **symmetric shared secret `SUPABASE_JWT_SECRET` (HS256)** in the API auth middleware (`packages/auth`). This is the hardest to repoint: HS256-shared-secret verification cannot validate Zitadel's asymmetric (RS256) tokens without swapping the verifier to JWKS.
  - **chorus** — Supabase Auth (JWT) + service-account PATs; `packages/auth` = Supabase JWT verification + role resolution. Org-scoped multi-tenant (unix-style per-resource `mode` bits). Routes mounted at root (no `/api` prefix). `GET /api/me` returns roles.
  - **warden** — Supabase JWT required on **all** endpoints (intentional deviation from the upstream Gatehouse spec's `security:[]`). Kubb-generated client passes bearer via `useAccessToken`. Base `/api/gatehouse/v2`.
  - **rolodex** — Supabase Auth (JWT) + `dg_` service-account PATs. **Single-tenant global directory** (NOT org-scoped). `directory_users`/`directory_groups`/`group_members` are an **LDAP Sync Cache mirror of Active Directory / Workday** (read-only). `/api/access/*` = outbound access provisioning: group membership drives GitHub/ADO/GitLab access via a pull reconciler (GitHub real; ADO/GitLab stubbed). **PII caveat noted in its own docs: `birthDate`, `telephoneNumber`, `mail`, `workEmail` are exposed and "the v1 auth gate (Supabase JWT) is the only access control."**
- **Common stack:** Node ≥22 ESM, TypeScript strict, Hono API, Next.js 16 web (React 19), Drizzle + Postgres (Supabase), Vitest, pnpm workspaces. Every app already isolates auth in a `packages/auth` package — the seam we repoint.
- **Rolodex is already the suite's directory/access hub** — it mirrors AD/Workday and provisions downstream access. Any SCIM design must reconcile with Rolodex rather than create a second competing directory.
- **Middleware internals were NOT read at source level** for this plan (grounded on each app's CLAUDE.md). The Phase 0 spike's first task is to read each `packages/auth` and record the exact verification mode (HS256-secret vs RS256/JWKS), claim shape, and org-scoping mechanism per app.

## Decisions (locked, with justification)

### D1 — Federation approach: **Zitadel is the central IdP AND the token issuer; each app's `packages/auth` is repointed to verify Zitadel-issued JWTs (RS256/JWKS). Supabase becomes data-only (GoTrue bypassed for human login).**
The two candidate approaches were:
- **(A) Federate INTO each Supabase project** — configure Zitadel as an external SSO/SAML connection in each of the 5 Supabase projects; Supabase Auth stays the token issuer and apps keep verifying Supabase JWTs unchanged.
- **(B) Zitadel issues the tokens directly** — repoint each app's JWKS verification at Zitadel; Supabase Auth no longer issues human tokens.

**CHOSEN: (B).** Justification:
1. **SCIM has no home under (A).** Supabase Auth does **not** expose a SCIM v2 service-provider endpoint, so customer IdPs cannot provision users into Supabase. SCIM is a hard requirement (it is on the marketing page). Zitadel *does* act as a SCIM v2 service provider, so provisioning must land in Zitadel — which only makes sense if Zitadel is the identity source of record (B), not a federated upstream feeding Supabase (A).
2. **(A) defeats consolidation.** Under (A) there are still 5 separate Supabase SSO configurations to maintain, and Supabase's own enterprise SSO is **SAML-only and per-project** — you would configure the same SAML connection 5 times and still have 5 issuers. That is not "one identity across 5 apps."
3. **(B) is a smaller code change than it appears.** Every app already isolates verification in `packages/auth`; helmsman **already** does RS256/JWKS via `AUTH_JWKS_URL`. Repointing = new issuer/JWKS URL + audience + claim-mapping, not a rewrite. (yellow-pages is the exception — it must switch from HS256-shared-secret to JWKS; see D5/Risks.)
4. **True SSO + SAML + SCIM from one system.** Zitadel natively provides OIDC, SAML (as SP/broker toward customer IdPs), and SCIM in one place, so all three deliverables come from a single integration surface rather than three per-app integrations.

**Honest caveat (unproven):** whether a single Zitadel token cleanly passes 5 independently-built middlewares — given the HS256/JWKS divergence and differing claim/org-scoping assumptions — is exactly the "not sure it'll work" risk. Phase 0 proves it on Rolodex before any commitment.

### D2 — SCIM: **Zitadel is the SCIM v2 service provider; the customer's IdP (Okta/Entra) provisions users+groups INTO Zitadel. Rolodex reconciles FROM Zitadel.** No second competing directory.
Authoritative-field split (the anti-two-directories rule):
- **Zitadel is authoritative for**: identity existence, authentication, and **platform group/role membership** used for login and app authorization. This is what SCIM writes.
- **Rolodex remains authoritative for**: rich AD/Workday attribute enrichment (employeeNumber, DN, objectGUID, SSH public keys, telephone, etc.) and downstream **access-target reconciliation** (GitHub/ADO/GitLab via `/api/access/*`).
- **Join key:** a stable correlation identifier (email as default; `employeeNumber`/`objectGUID` where available) links a Zitadel user to a `directory_users` row. Rolodex adds a `zitadel_subject` column and a reconciler that treats Zitadel as the source of "who exists / what platform groups they are in," never overwriting AD-sourced attribute columns. **[2026-08-24 forward-reference: this is a separate correlation problem from D5 below — `directory_users`, not `users`; Phase 2, not Phase 1 — and is not resolved by the identity-correlation decision recorded in `.omc/plans/identity-correlation-externalid-decision.md`. That plan's reasoning (externalId-locates-a-row) is likely applicable here too, but Phase 2 needs its own explicit decision, not an inherited one, since `directory_users` is a read-only AD/Workday mirror with different constraints.]**

### D3 — SAML: **enterprise customers whose IdP speaks only SAML federate via Zitadel's SAML brokering. Apps never speak SAML directly** — Zitadel is the SAML SP/broker and always issues OIDC tokens downstream to the 5 apps.
This keeps every app on a single inbound protocol (OIDC bearer verification) regardless of whether the customer's upstream IdP is OIDC or SAML.

### D4 — Rollout: **spike/POC against Rolodex ONLY first, with a GO/NO-GO gate, before touching the other 4 apps.**
Rolodex is chosen as the pilot because (a) it is the app whose marketing page names the SSO/SAML/SCIM guarantee, (b) it is the directory/access hub where SCIM reconciliation must land anyway, and (c) it is single-tenant, so it avoids multi-tenant org-scoping complexity while proving the core token/SCIM/SAML mechanics. Multi-tenant org-scoping (chorus/helmsman/warden) is deliberately deferred to after the pilot proves feasibility.

### D5 — Identity migration: ~~existing Supabase user identities are correlated to Zitadel subjects on email during a dual-accept transition window~~ **[SUPERSEDED 2026-08-24, rolodex/Phase 1 only — see `.omc/plans/identity-correlation-externalid-decision.md`]**; a `zitadel_subject` column is added wherever a Supabase user id is referenced.
The token `sub` changes from a Supabase UUID to a Zitadel subject. Any table keyed on the Supabase user id (and any Supabase RLS keyed on `auth.uid()`) must be identified and migrated. During transition each app **accepts both** its legacy Supabase token and a Zitadel token (verifier tries Zitadel first, falls back to Supabase) so there is no big-bang cutover.

**Amendment (2026-08-24, rolodex/Phase 1 scope only):** the original email-correlation join key above is superseded by a corrected two-step mapping, per `.omc/plans/identity-correlation-externalid-decision.md`: (1) at proactive SCIM-provisioning time, Zitadel's `externalId` attribute on each provisioned user is set to rolodex's own existing `users.id` for that person — `externalId` is used *only* to locate the correct local row, during a one-time backfill; (2) that one-time backfill script then writes the Zitadel user's own `id`/`sub` (never the `externalId` itself) into `zitadel_subject` on the matched row. After the backfill, the already-shipped runtime JIT lookup (`zitadel_subject` → `providerSubject` → legacy id-as-sub → create) compares an incoming token's real `sub` against `zitadel_subject` exactly as built, with no runtime `externalId` lookup needed. This amendment covers **rolodex only**. Chorus/helmsman/warden's Phase 4 correlation source remains an open, explicitly deferred decision — a single Zitadel `externalId` field cannot simultaneously equal four apps' independent local user IDs for the same person, so the same mechanism does not extend suite-wide without a separate per-app mapping design (see the dated cross-app survey section near the end of this document).

### D6 — Service-account / machine tokens stay app-local and out of scope for Zitadel SSO.
`dg_` (rolodex), `ci:agent` PATs (helmsman), chorus PATs, and `WEBHOOK_DRAIN_TOKEN`-style internal tokens are machine credentials — they remain issued and verified by each app as today. Only **human interactive login** federates through Zitadel.

## Architecture
```
                        Customer IdP (Okta / Entra / AD FS)
                          │  OIDC or SAML (federation)          │ SCIM v2 push
                          ▼                                      ▼
                 ┌─────────────────────── Zitadel Cloud ───────────────────────┐
                 │  central IdP · OIDC + SAML broker · SCIM v2 service provider │
                 │  Org + Projects; per-app OIDC clients; roles/groups         │
                 └───────────────┬──────────────────────────────┬─────────────┘
                   OIDC Auth Code │ (PKCE, hosted login)         │ SCIM/mgmt read
                        + RS256 access tokens (JWKS)             │
        ┌──────────────┬──────────────┬──────────────┬──────────┴───┬───────────┐
        ▼              ▼              ▼              ▼               ▼           │
   chorus/auth    helmsman/auth   warden/auth   yellow-pages/auth  rolodex/auth │
   (repoint JWKS) (JWKS today)   (repoint JWKS) (HS256→JWKS swap)  (repoint JWKS)│
        │              │              │              │               │          │
        └── each verifies Zitadel token → maps claims → app org+role │          │
                                                                     ▼          │
                                            Rolodex directory reconciler ◄──────┘
                                       (Zitadel = identity+groups authoritative;
                                        directory_users = AD/Workday attrs +
                                        /api/access provisioning; join on email/
                                        employeeNumber; adds zitadel_subject col)

   Supabase (×5)  = DATA ONLY (Postgres via Drizzle). GoTrue no longer issues human tokens.
```

**[2026-08-24 note]** The diagram's "join on email/employeeNumber" annotation describes the **Rolodex directory reconciler** (D2, `directory_users`, Phase 2) — it does not describe Decision 5's `users`-table JIT-provisioning correlation (Phase 1, amended above). The two are separate correlation problems on separate tables; do not read this diagram as describing D5's now-corrected mechanism.

**Token verification (per app `packages/auth`):** introduce `ZITADEL_ISSUER`, `ZITADEL_JWKS_URL`, and expected `audience`/client-id env. Verify RS256 against Zitadel JWKS; validate issuer + audience + expiry. During transition, verify Zitadel first and fall back to the legacy Supabase verifier (D5).

**Claim → app-model mapping:** Zitadel project roles/groups map to each app's existing role model. For multi-tenant apps (chorus, helmsman, warden), a Zitadel org / project-grant identifier maps to the app's `orgId`; Phase 0/4 defines exactly which Zitadel claim carries org scope. For single-tenant rolodex, only the platform role/groups matter.

**Web login flow:** each Next.js app swaps its Supabase Auth UI/`supabase-js` sign-in for an OIDC Authorization-Code-with-PKCE flow to Zitadel's hosted login; the resulting access token is sent as the bearer the API already expects (warden already threads bearer via `useAccessToken`; reuse that shape).

**SCIM + reconciliation:** customer IdP provisions into Zitadel via SCIM v2. Rolodex gains a `zitadel-directory` reconciler (mirrors the existing sync/reconciler pattern in `/api/sync/*` and `/api/access/*`) that reads Zitadel users/groups (Zitadel management API or SCIM read), correlates to `directory_users` on the join key, and updates only the Zitadel-owned fields (existence, `zitadel_subject`, platform group membership) — never AD-sourced attribute columns.

## Implementation Steps (phased)

### Phase 0 — Feasibility spike / POC on Rolodex only (GO/NO-GO gate) **← the "by the weekend" deliverable**
- Read each app's `packages/auth` and record exact verification mode, claim shape, and org-scoping mechanism (fills the one gap in Grounded facts).
- Stand up a Zitadel Cloud dev instance: one Org, a Rolodex OIDC client (Auth Code + PKCE), and a couple of test roles/groups.
- Repoint a **local** Rolodex `packages/auth` to verify Zitadel tokens (RS256/JWKS) behind an env flag; obtain a real Zitadel token and prove it passes Rolodex's middleware and maps to a role.
- Prove identity migration on ONE user: correlate an existing Supabase user to a Zitadel subject by email; confirm `directory_users` join works. **[2026-08-24: historical — describes what Phase 0 actually did, and loosely blends D5's `users`/subject correlation with D2's `directory_users` join in one sentence. Not current guidance for either; see the amended D5 above and the dated cross-app survey section for what's actually decided now.]**
- Prove a minimal **SCIM** push into Zitadel (from a trial Okta/Entra dev tenant, or Zitadel's SCIM test client) and reconcile that one user into Rolodex's directory read-only.
- **GO/NO-GO:** document what worked, what didn't, and whether Zitadel Cloud's SCIM maturity is sufficient. Do not proceed to Phase 1+ without an explicit GO.

### Phase 1 — Rolodex production SSO (OIDC)
- Repoint Rolodex `packages/auth` to Zitadel with dual-accept (Zitadel-first, Supabase fallback) behind config.
- Swap the Rolodex web app login to Zitadel hosted login (OIDC Auth Code + PKCE); keep `dg_` PATs unchanged (D6).
- Add `zitadel_subject` to the user-referencing tables; backfill via the two-step `externalId`-locates-the-row mapping (amended D5, 2026-08-24 — not email correlation).
- Tests: token verification (valid/expired/wrong-audience), dual-accept fallback, claim→role mapping, PAT path untouched.

### Phase 2 — SCIM provisioning into Zitadel + Rolodex directory reconciliation
- Configure Zitadel as SCIM v2 service provider; connect the customer IdP (or dev tenant) to provision users+groups.
- Build the Rolodex `zitadel-directory` reconciler (authoritative-field split per D2); wire it alongside `/api/sync/*`. Deprovisioning (SCIM delete/deactivate) must revoke platform access on the next reconcile.
- Tests: create/update/deactivate via SCIM propagates to Zitadel and reconciles into `directory_users` on the join key; AD-sourced attribute columns are never overwritten; deprovision revokes access.

### Phase 3 — SAML brokering for SAML-only enterprise IdPs
- Configure Zitadel as a SAML SP/broker toward a SAML customer IdP; confirm brokered login still emits an OIDC token Rolodex accepts unchanged (D3).
- Tests: SAML-brokered login yields a working Rolodex session; app code path identical to OIDC.

### Phase 4 — Roll out to the other 4 apps (one at a time)
- Per app: repoint `packages/auth` to Zitadel with dual-accept; swap web login; define org-scope claim mapping for multi-tenant apps (chorus, helmsman, warden). **yellow-pages requires swapping HS256-shared-secret verification for JWKS/RS256** — treat as its own sub-task with extra test coverage.
- Order suggestion (lowest-risk first): helmsman (already JWKS) → chorus → warden → yellow-pages (HS256→JWKS last).
- Tests per app: mirror Phase 1 tests + org-scoping assertion for multi-tenant apps.

### Phase 5 — Decommission human login on Supabase Auth
- After all apps run on Zitadel and the dual-accept window closes, disable GoTrue human login per project; keep Supabase for data and keep all machine/service tokens.
- Remove legacy Supabase verifier fallback and legacy JWT secrets from config.

## Acceptance Criteria (testable)
- [ ] **Phase 0 gate:** a real Zitadel-issued access token passes Rolodex's repointed `packages/auth` and resolves to a role; a written GO/NO-GO decision exists covering token verification, identity correlation, and SCIM maturity.
- [ ] **SSO (Rolodex):** logging into the Rolodex web app redirects to Zitadel hosted login and returns an authenticated session; the API accepts the Zitadel bearer; an expired or wrong-`audience` token is rejected (401).
- [ ] **Dual-accept transition:** during the window, both a legacy Supabase token and a Zitadel token authenticate successfully; after the window, only Zitadel tokens do. Two tests, one each.
- [ ] **Machine tokens untouched:** a `dg_` PAT (rolodex) and a `ci:agent` PAT (helmsman) authenticate exactly as before the change (regression test).
- [ ] **Identity migration:** an existing user's local row is located via SCIM `externalId` (set at proactive provisioning time to that row's local user id); `zitadel_subject` is populated with the Zitadel user's own `id`/`sub` (not the `externalId`) via the one-time backfill (amended D5, 2026-08-24); no table keyed on the old Supabase user id is orphaned (documented inventory + test on the correlated row).
- [ ] **SCIM provisioning:** creating a user in the customer IdP provisions them into Zitadel via SCIM and, on next reconcile, produces/updates a matching `directory_users` row in Rolodex on the join key — **without** overwriting any AD/Workday-sourced attribute column. (Assertion: attribute columns unchanged; identity/group columns updated.)
- [ ] **SCIM deprovisioning:** deactivating/deleting a user via SCIM revokes their platform access on the next Rolodex reconcile.
- [ ] **No competing directory:** a single test documents the authoritative-field split — Zitadel fields vs Rolodex-owned attribute fields — and asserts the reconciler writes only its owned set.
- [ ] **SAML:** a SAML-only customer IdP, brokered through Zitadel, yields a working Rolodex session via the identical downstream OIDC code path (no app-level SAML handling).
- [ ] **Suite rollout:** each of chorus, helmsman, warden, yellow-pages verifies a Zitadel token and maps claims to its role model; multi-tenant apps correctly derive `orgId` from the Zitadel org/grant claim. **yellow-pages** specifically no longer uses `SUPABASE_JWT_SECRET` (HS256) to verify human tokens — it verifies RS256 via JWKS.
- [ ] Per touched repo: `pnpm typecheck` 0, `pnpm test` green, and browser verification (`/verify-stage`) passes for any web-login change.

## Risks & Mitigations
| Risk | Mitigation |
|---|---|
| **Core feasibility unproven** — a single Zitadel token may not cleanly pass 5 independently-built middlewares (the user's "not sure it'll work"). | Phase 0 spike on Rolodex with a hard GO/NO-GO gate before any suite-wide work; inventory each verifier first. |
| **HS256/JWKS divergence** — yellow-pages verifies with a symmetric shared secret and cannot validate Zitadel's asymmetric tokens as-is. | Treat YP as a distinct sub-task (verifier swap to JWKS/RS256); sequence it last in Phase 4 with extra tests. |
| **Identity `sub` change breaks FKs / RLS** keyed on the Supabase user id or `auth.uid()`. | Add `zitadel_subject` + the amended two-step `externalId`-locates-the-row correlation (D5, amended 2026-08-24 — not email); inventory every reference and any Supabase RLS before cutover; dual-accept avoids big-bang. |
| **Zitadel Cloud SCIM maturity** may be incomplete for the customer IdPs in scope. | Validate real SCIM push (Okta/Entra dev tenant) in Phase 0; if immature, fall back to Zitadel management-API-driven provisioning and flag as a follow-up. |
| **Two competing directories** (customer AD ↔ Zitadel ↔ Rolodex). | Authoritative-field split (D2): Zitadel owns identity+platform groups; Rolodex owns AD/Workday attributes + access targets; join on a stable key; reconciler writes only its owned set. |
| **PII exposure widens** — Rolodex already notes JWT is its only gate over `birthDate`/`mail`/etc. | Keep the auth gate strict post-repoint; do not broaden read scope during migration; re-affirm the existing PII caveat in the reconciler. |
| **Org-scoping representation** in Zitadel for multi-tenant apps (chorus/helmsman/warden). | Define the exact org-carrying claim in Phase 0/4 and map Zitadel org/project-grant → `orgId`; assert in per-app tests. |
| **Big-bang cutover / downtime.** | Per-app incremental rollout + dual-accept window; decommission (Phase 5) only after all apps are stable on Zitadel. |
| **"By the weekend" timeline** is unrealistic for all 5 apps + SCIM + SAML. | Scope the weekend to Phase 0 (feasibility) only; everything else is gated on GO. |
| **Machine-token regression** during the auth swap. | D6 keeps PATs app-local; explicit regression tests that PAT paths are unchanged. |

## Verification Steps
1. **Phase 0:** with the Zitadel dev instance up, run Rolodex locally (`pnpm supabase:start && pnpm dev`), obtain a Zitadel token, and confirm an authenticated `GET` against a protected Rolodex route returns 200 while an expired token returns 401. Record GO/NO-GO.
2. **Per repo touched:** `pnpm typecheck` (0 errors) + `pnpm test` (green). DB-backed tests gate on `DATABASE_URL` as usual.
3. **SSO manual:** browser flow (`/verify-browser`) — Rolodex web login redirects to Zitadel, returns, and renders an authenticated page (screenshot).
4. **Dual-accept:** automated test proving a legacy Supabase token and a Zitadel token both authenticate during the window; a post-window test proving only Zitadel works.
5. **SCIM:** provision a test user in the IdP → confirm the user appears in Zitadel → run the Rolodex reconciler → assert a `directory_users` row exists/updates on the join key with AD attribute columns untouched; then deactivate and assert access is revoked on next reconcile.
6. **SAML:** brokered login from a SAML dev IdP through Zitadel yields a working Rolodex session (screenshot + session assertion).
7. **Suite rollout:** for each of the other 4 apps, repeat steps 2–4; for multi-tenant apps additionally assert `orgId` is derived correctly from the Zitadel claim; for yellow-pages assert verification is JWKS/RS256 (no `SUPABASE_JWT_SECRET` on the human-token path).

## Phase 0 GO/NO-GO — spike results (2026-08-23)

**Recommendation: QUALIFIED GO.** Every mechanism this plan depends on is proven to work against a real, self-hosted Zitadel instance (v4.17.1) and real Rolodex code — nothing hand-waved, nothing mocked. But four concrete gaps must close before Phase 1 starts, and one framing correction (Cloud vs. self-hosted) changes the deployment story. None of the four gaps is a redesign; all are additive, scoped fixes to code this spike already exercised.

Executed against `rolodex` only, per Phase 0's own scope. Evidence lives in `rolodex/.omc/prd.json` (US-001–004) and `rolodex/.omc/progress.txt`'s "SSO-SAML-SCIM PHASE 0 SPIKE" section — every claim below cites real request/response pairs and real before/after DB state, not descriptions of expected behavior.

### What's proven

1. **Token verification is pure env config, zero code changes.** `@cogs/auth`'s `verifyToken()` (already shared by all 5 apps) is issuer-agnostic JWKS verification. Pointing `AUTH_ISSUER`/`AUTH_JWKS_URL`/`AUTH_AUDIENCE` at Zitadel instead of Supabase made it accept a real Zitadel-minted RS256 token with no changes to `verify.ts`/`config.ts`/`middleware.ts`. Negative controls (wrong aud, wrong issuer, cross-issuer JWKS) all correctly failed.
2. **Role resolution is pure env config, zero code changes.** `IdpTokenPlugin` + `ROLE_MAP_*` correctly decode Zitadel's flat URN role claim (`urn:zitadel:iam:org:project:roles`) and map it onto Rolodex's `org:admin`/`org:contributor`/`org:viewer`/`ci:agent` set. The full `resolveRolesFromPlugins` path (IdP + DB plugins, exactly as `middleware.ts` wires them) resolved the seeded test-admin to `["org:admin"]` correctly, with working negative controls.
3. **SCIM v2 fully works on self-hosted Zitadel** (full CRUD + soft/hard deprovision, proven via real HTTP calls) — **the plan's assumption that this required Zitadel Cloud is wrong; self-hosted is sufficient.** Bonus: SCIM's `externalId` field round-trips and is filterable, giving Rolodex a clean, Rolodex-owned join key — **better than the email-correlation approach Decision 5 originally specified.**

### What's broken today and must be fixed before Phase 1 (four gaps)

1. **Cross-app token isolation is currently absent (security).** Zitadel puts every client in the project into a token's `aud` array — a token minted for the Yellow Pages client verified successfully against Rolodex's configured audience. "One client per app" (already decided) does not by itself give isolation under Zitadel's actual behavior. **`verify.ts` needs an `azp`/`client_id` equality check added.** This is a real, small code change, not configuration.
2. **The identity-correlation gap is real, and worse than assumed.** `jitProvisionUser` creates a silent duplicate `users` row for anyone who already has a Supabase-era account and then authenticates via Zitadel — confirmed with real before/after DB rows. Worse: the duplicate is created with `email=""`/`name=""` (see gap 3), so it isn't even retro-correlatable after the fact. **Fix: use SCIM's `externalId` (finding above) as the join key instead of email — set it to the existing Rolodex user id at provisioning time, and have `jitProvisionUser` look up by it before falling through to create.** This is cleaner than Decision 5's original email-correlation plan and should replace it.
3. **Email/name are not available at the point `jitProvisionUser` runs, and this is not a Zitadel bug — it's an undocumented dependency on Supabase's non-standard behavior.** Zitadel's access token is spec-compliant OIDC: identity claims stay off it even with `scope=openid profile email` granted. Supabase puts `email` on the access token's top level, which is a Supabase-specific convenience this codebase has silently relied on. Confirmed the web client never sends the ID token, only the access token, so this isn't a client-side fix. **One of three fixes is needed:** call Zitadel's `/oidc/v1/userinfo` per request (verified working, costs a round-trip — cache it), have the web client also send the ID token, or use a Zitadel custom action to append email to the access token (risks the same claim-parsing boundary as gap 4). Pick one before Phase 1; this plan doesn't recommend which without knowing the latency/complexity trade-off the team wants.
4. **Two latent, not-yet-hit claim-parsing fragilities in `@cogs/auth`**, worth hardening proactively rather than waiting to hit them: `getNestedClaim`'s dot-notation splitter would silently return `undefined` for any future namespaced claim that contains a literal dot (not an issue for Zitadel's native URN claims today, but would be if a custom action ever appends a dotted claim — relevant if gap 3 is fixed via a custom action); and `extractStrings` returns `[]` (fails open to the default role, not closed) if Zitadel's role claim is ever array-wrapped instead of the flat-object shape it uses today — Zitadel's own docs show both shapes across versions.

### Checked and cleared — no live RLS issue

Checking the plan's own "any RLS keyed on `auth.uid()`" question initially looked like it surfaced a live security bug across 4 of the 5 apps (a first grep found a `user_devices` policy using `auth.uid()` in rolodex/chorus/helmsman, matching a bug yellow-pages had already found and fixed in itself). **On closer inspection this was a false alarm — all 5 apps are actually safe today**, just via three different valid mechanisms: yellow-pages drops the policy entirely (RLS-zero-policies, like every other table); rolodex and helmsman revoke the default `anon`/`authenticated` grants in the *same* migration that creates the policy; chorus revokes them in an immediate follow-up migration (`0008`, whose own comment independently describes the identical bug and fixes it); warden never created the policy at all. All five land on the same effective default-deny posture. **No action needed here** — this is left in the plan doc only so a future reader doesn't have to re-derive it after seeing the same grep result this spike did.

### The Cloud-vs-self-hosted framing needs correcting

Decision 1's justification and this section's original open question both implicitly assumed Zitadel Cloud. Every finding above was proven against **self-hosted** Zitadel v4.17.1, and self-hosted's SCIM support is fully sufficient. Cloud vs. self-hosted is now a cost/ops decision for whoever owns infrastructure, not a capability gate on SCIM. State the deployment target explicitly before Phase 1.

### Open Questions — now answered

- ~~Which Zitadel claim carries multi-tenant **org scope**~~ — **answered:** the flat URN claim `urn:zitadel:iam:org:project:roles` (and its project-scoped sibling `urn:zitadel:iam:org:project:{projectId}:roles`) carries roles; org scope for a multi-tenant app maps from the org id already present in that claim's value (`{role: {orgId: primaryDomain}}` shape) — confirmed via a real decoded token.
- ~~Is Zitadel Cloud's SCIM v2 support mature enough~~ — **answered, and the premise was wrong:** self-hosted SCIM v2 is fully proven working; no Cloud dependency exists. One caveat: SCIM here is users-only (no `/Groups` endpoint) — group/entitlement provisioning still needs the management API regardless of Cloud vs. self-hosted.
- ~~Do any apps use Supabase RLS keyed on `auth.uid()`~~ — **answered:** rolodex, chorus, and helmsman have (or had) a `user_devices` policy keyed on `auth.uid()`; all three are already safe today via a revoked default grant (same migration for rolodex/helmsman, an immediate follow-up for chorus). Warden never created the policy; yellow-pages dropped it entirely. No live issue, but this specific policy (in the 3 apps that still have it) is exactly the kind of thing that would need re-deriving or dropping once `sub` changes meaning under a Zitadel migration — worth a deliberate pass in Phase 1, not urgent before it.
- ~~One Zitadel OIDC client per app vs. a shared client~~ — **the per-app decision (already made) is confirmed correct, but insufficient alone:** Zitadel's actual `aud` behavior (every client in the project, not just the token's own client) means per-app clients don't give isolation without the `azp` check in gap 1 above. Both are needed together.

### Cross-app identity-correlation survey — 2026-08-24

Full reasoning and revision history: `.omc/plans/identity-correlation-externalid-decision.md`
(went through 3 rounds of codex critic review — REJECT, REVISE, APPROVED — before this
section was written; the first two rounds caught a real value-conflation bug and a real
cardinality gap, both fixed in what follows).

**The corrected two-step mapping (rolodex, Decision 5, Phase 1 — this is what's now locked):**
SCIM `externalId` (set to rolodex's own existing `users.id` at proactive provisioning time)
*locates the correct local row* during a one-time backfill; the Zitadel user's own `id`/`sub`
— never the `externalId` itself — is what gets written into `zitadel_subject`. After that
one-time backfill, the already-shipped runtime JIT lookup (`zitadel_subject` →
`providerSubject` → legacy id-as-sub → create, rolodex `fbbcd82`) works unmodified: it compares
an incoming token's real `sub` against `zitadel_subject`, with no runtime `externalId` lookup
needed.

**Explicitly deferred, not resolved: chorus/helmsman/warden's Phase 4 correlation source.** One
Zitadel user has exactly one `externalId` field. The same person has four independently-
generated local user IDs across rolodex/chorus/helmsman/warden's four separate databases — a
single `externalId` value cannot equal all four simultaneously. The naive "reuse rolodex's
exact mechanism suite-wide" framing does not work without a separate per-app mapping design
(most likely per-app Zitadel user *metadata* keyed by app name, e.g.
`metadata['chorus_user_id']` — **not yet confirmed available** on this suite's self-hosted
Zitadel v4.17.1). Whoever picks up each app's Phase 4 sub-task must make this decision
explicitly, informed by this note, rather than repeating the cardinality mistake this section's
source plan made and had corrected by review.

**Per-app survey findings** (chorus, helmsman, warden — all already ship the `providerSubject`
column + 3-tier JIT-lookup shape that rolodex's Gap 2 just added):

- **chorus** — `packages/db/src/schema.ts:44-55` (`users.providerSubject`, nullable, indexed);
  JIT lookup at `apps/api/src/auth/middleware.ts:113-141`; org membership lives in a separate
  `orgMembers` table (`schema.ts:74-84`), so a duplicate row gets zero org rows and floors to
  role-less/unaffiliated — silent access loss until an admin manually re-grants.
- **helmsman** — `packages/db/src/schema.ts:71-78` (`users.providerSubject`, not-null); JIT
  lookup at `apps/api/src/auth/middleware.ts:147-175`; documented prior art for this exact
  pattern used in a real prior Zitadel-to-Supabase migration
  (`docs/adr/0003-supabase-backend-migration.md:29`). Org membership in a separate `org_members`
  table (`schema.ts:29-45`); a duplicate row additionally fragments `audit_events.actorId` and
  several `createdBy` columns across the app's domain tables — a wider blast radius than the
  other two apps.
- **warden** — `packages/db/src/schema.ts:26-37` (`users.providerSubject`, nullable, indexed);
  JIT lookup at `apps/api/src/auth/middleware.ts:133-161`, gated on every `/api/*` route
  (`apps/api/src/index.ts:90`), so a duplicated identity surfaces immediately and universally,
  not on some code paths only. Org membership in a separate `orgMembers` table
  (`schema.ts:41-59`); same silent-role-floor consequence as chorus.

None of the three apps' `jitProvisionUser` paths currently query any external-identity/
`oauth_accounts`-style table as part of correlation — whatever mechanism Phase 4 designs for
the cardinality problem above must wire into the actual lookup path to have any effect; simply
storing a link somewhere unread does not prevent a duplicate row.
