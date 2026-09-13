# Plan: Phase 2 — SCIM provisioning into Zitadel + Rolodex `directory_users` reconciliation (Decision 2)

**Status:** pending critic review · **Mode:** design plan (no code in this repo) · **Created:** 2026-09-05

**Scope:** resolve **Decision 2** of `.omc/plans/sso-saml-scim-platform-identity.md` — the join key and
reconciler design linking Zitadel users to Rolodex `directory_users` rows — and specify the Rolodex
`zitadel-directory` reconciler in enough detail that it can be implemented in the (not-present-here)
`rolodex` repo without re-deriving any design decision.

**This repo contains no Rolodex source.** `fleetworks-monorepo` is the planning/infra hub: it holds
`infra/zitadel-local` (a local Zitadel v4.17.1 Docker stack + `seed.ts`) and `.omc/plans/*.md`. This
plan therefore writes **no code** and touches **no file other than itself**. Every "step" below is a
specification for future work in `rolodex`, plus a small number of verification probes that can be
run against `infra/zitadel-local` here.

**Blocked on:** Phase 1 (rolodex production Zitadel cutover) landing first. Phase 1 is currently
REVISE-blocked (`rolodex/.omc/plans/zitadel-sso-phase1-cutover.md`, 5 codex-critic findings, tracked
in `.sessions/2026-08-24-zitadel-sso-phase1/FOLLOWUPS.md`). This plan **assumes** Phase 1's
`users.zitadel_subject` column and the amended-D5 JIT mechanism will exist, and **does not re-plan
them**. It does, however, surface one collision between Phase 1's mechanism and Phase 2's data flow
that Phase 1 must be told about (see "Cross-decision hazard" below) — that is a Phase 1 input, not a
Phase 1 redesign.

---

## Why D2 could not simply inherit D5's answer

`.omc/plans/identity-correlation-externalid-decision.md` deferred D2 explicitly, with a
forward-reference saying externalId-locates-a-row is *"likely applicable here too, since
`directory_users` also has a stable local ID"* — while also warning that `directory_users` is *"a
read-only AD/Workday mirror with different constraints that deserve their own explicit decision."*

**Re-derived here from scratch, the forward-reference's hypothesis does not survive.** Four
constraints differ, and three of them are individually disqualifying.

### Constraint 1 — Rolodex is not the provisioner in Phase 2 (disqualifying)

D5's mechanism works because **rolodex itself writes `externalId`.** Phase 1 is a one-time,
rolodex-driven proactive provisioning of its own existing users into Zitadel; rolodex chooses the
value and sets it to its own `users.id`.

In Phase 2 the direction reverses. Per D2, **the customer's IdP (Okta/Entra) is the SCIM client and
Zitadel is the service provider.** Rolodex is downstream of both and provisions nothing. Per
RFC 7643 §3.1, SCIM `externalId` is *"an identifier for the resource as defined by the provisioning
client"* — it is **the customer IdP's field, holding the customer IdP's own internal user id.**
Rolodex cannot choose that value, cannot require the customer to set it to a Rolodex id, and cannot
assume any semantics for it. Any D2 design keyed on `externalId` is keyed on a value a third party
owns.

### Constraint 2 — `externalId` is a single field with three claimants (disqualifying)

This is the same cardinality failure the identity-correlation plan's first draft was rejected for,
recurring in a new shape. One Zitadel user has exactly one `externalId`. Phase 2 would have three
parties wanting it:

| Claimant | Wants `externalId` to hold | Owns the write? |
|---|---|---|
| Phase 1 / D5 (rolodex proactive provisioning) | `rolodex.users.id` | yes, one-time, Phase 1 |
| Phase 2 / D2 (this plan, hypothetically) | `rolodex.directory_users.id` | no |
| Customer IdP SCIM client (Okta/Entra) | Okta's own user id | yes, on every create **and every update** |

Three values, one field. Worse, the third claimant writes continuously and last. This is not a
tiebreak — it is the same "one field cannot hold N independent local IDs" defect, and it must be
rejected for the same reason.

### Constraint 3 — `directory_users` is a sync target, so rolodex must not write into it (disqualifying for the column-on-the-mirror shape)

D5 could add `zitadel_subject` to `users` because rolodex owns that table end to end. `directory_users`
is the **LDAP Sync Cache mirror of Active Directory / Workday** (master plan, Grounded facts). It is
rewritten by an upstream sync process. Any correlation column rolodex writes into it is (a) liable to
be clobbered or orphaned by the next AD sync, and (b) a direct violation of D2's own anti-two-directories
rule, which says Rolodex-owned identity state must not be smuggled into the mirror.

There is also a representational failure: a column on `directory_users` **cannot represent a Zitadel
user who has no `directory_users` row at all** — which is the single most common Phase 2 state
(customer IdP provisions a new hire into Zitadel minutes or days before the AD mirror catches up).

### Constraint 4 — `directory_users.id` being stable is true but irrelevant

The forward-reference's stated reason for expecting D5's answer to transfer was that
`directory_users` rows "also have a stable local id." They do. But D5's mechanism never depended on
the *local* id being stable — it depended on rolodex being able to **push that id into a Zitadel
field it controlled**. Constraints 1 and 2 remove that ability. Stability of the local id is
necessary but nowhere near sufficient.

### What actually is true about D2's cardinality

Both sides are independently sourced from the same upstream (the customer's AD/Workday), but neither
is derived from the other:

- Zitadel user with **no** `directory_users` row: common (new hire, AD-mirror lag, contractor
  provisioned in the IdP but not yet in AD, or a person the customer's IdP scopes in but the LDAP
  sync's filter scopes out).
- `directory_users` row with **no** Zitadel user: common (anyone in AD/Workday not in the SSO
  assignment scope; AD service/machine objects).
- Two Zitadel users → one human → potentially one `directory_users` row: plausible (an `adm-`
  privileged account plus a normal account). Whether the customer's AD models these as one or two AD
  objects is customer-specific and **not knowable in advance**.
- Two `directory_users` rows → one human: plausible (rehire, or an AD account plus a Workday
  contingent-worker record).

So the true relationship is **0..N : 0..N in the general case, expected 0..1 : 0..1 in the common
case.** A design that assumes 1:1 and silently picks a winner on violation is exactly the class of
bug that produces wrong downstream GitHub/ADO/GitLab access grants. The link must be an explicit,
inspectable, first-class object — not an inferred join.

---

## D2 — DECISION (this plan's locked answer)

> **Correlation between Zitadel and `directory_users` is materialized in a new
> rolodex-owned link table (`zitadel_directory_links`), keyed on the Zitadel user's own immutable
> `id`, and populated by a deterministic ordered match ladder over AD/Workday-native identifiers.
> SCIM `externalId` is NOT used as the D2 join key. Neither `directory_users` nor any other
> LDAP-mirror table is ever written by the reconciler. Unmatched Zitadel users produce a link row in
> an `unmatched` state — never a fabricated `directory_users` row.**

### D2.1 — The link is a table, not a column

```
zitadel_directory_links
  zitadel_user_id      text  NOT NULL  UNIQUE      -- Zitadel's own immutable user id
  directory_user_id    <fk>  NULL                  -- NULL when unmatched
  link_state           enum  NOT NULL              -- linked | unmatched | ambiguous | revoked
  match_tier           enum  NULL                  -- employee_number | ad_object_guid | upn | email | manual
  match_evidence       jsonb NOT NULL              -- redacted; see D2.5
  zitadel_state        enum  NOT NULL              -- active | inactive | absent
  first_linked_at      timestamptz NULL
  last_seen_at         timestamptz NOT NULL        -- last successful full enumeration that saw it
  last_reconciled_at   timestamptz NOT NULL
  resolved_by          text  NULL                  -- operator id, for manual links only
```

`UNIQUE(zitadel_user_id)` — one link row per Zitadel user. `directory_user_id` is deliberately **not**
unique: two Zitadel users legitimately resolving to one directory row (the `adm-` case) is
representable, surfaced, and reviewable rather than silently dropped.

Storing `zitadel_user_id` (not a subject string, not an externalId) is deliberate and mirrors D5's
hard-won lesson: **store the identifier the source system owns and never changes**, not a lookup key
borrowed from something else.

### D2.2 — The match ladder (ordered, first match wins, ambiguity never auto-resolves)

Each Zitadel user is matched against `directory_users` by trying tiers in order. A tier "hits" only
if it yields **exactly one** candidate row. Zero candidates → next tier. **Two or more candidates →
stop immediately, set `link_state='ambiguous'`, do not fall through to a weaker tier.**

| Tier | Key | Source on the Zitadel side | Why this rank |
|---|---|---|---|
| 1 | `employeeNumber` | SCIM enterprise extension `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber`, mapped by the customer IdP | The only identifier in the SCIM *standard* that is natively an HR/AD identifier. Survives rename, marriage, email change, and department move. Already a `directory_users` column. |
| 2 | AD `objectGUID` | a custom SCIM attribute or Zitadel user metadata, if the customer IdP can map it | AD's immutable per-object GUID — strictly stronger than tier 1 in AD-only shops, but ranked second because it is **non-standard in SCIM and unproven on Zitadel v4.17.1** (see Open Question OQ-2). If OQ-2 resolves favourably, tiers 1 and 2 swap. |
| 3 | `userName` / UPN | SCIM core `userName` | AD `userPrincipalName`. More stable than `mail` (an AD object can carry several proxy addresses; it has one UPN) and it is the field SCIM guarantees is present and unique on the service provider. |
| 4 | primary email, case-folded + trimmed | SCIM `emails[primary=true].value` matched against `directory_users.mail` **then** `workEmail` | **Last resort only.** This is the join key D5 rejected. It is retained solely because a customer IdP may map nothing else, and a tier-4 link is explicitly marked as such so its weakness is visible downstream. |
| — | no hit | — | `link_state='unmatched'`, `directory_user_id=NULL`. **No `directory_users` row is created.** |

Rationale for keying on AD-native identifiers rather than anything either side invents: **both sides
descend from the same upstream.** Okta/Entra sync from the customer's AD/Workday; rolodex's LDAP Sync
Cache mirrors the same AD/Workday. The correct join key is therefore the identifier the *shared
ancestor* assigns, which neither Zitadel nor rolodex is free to reassign. Tier 4 is the only tier
that violates this principle, which is precisely why it is last and flagged.

`match_tier` is persisted so that every downstream consumer, audit, and incident review can see how
strong a given link actually is. A tier-4 link and a tier-1 link are not the same fact and must not
be stored as if they were.

### D2.3 — Unmatched Zitadel users do NOT get a fabricated `directory_users` row

`directory_users` is an AD/Workday mirror. Writing a row into it that AD/Workday never emitted makes
Rolodex a second directory — the exact failure mode D2's anti-two-directories rule exists to prevent
— and it will be clobbered or orphaned by the next LDAP sync anyway.

> **⚠️ This contradicts a currently-written acceptance criterion in the master plan** (line ~133:
> *"…produces/updates a matching `directory_users` row in Rolodex on the join key"*). That AC assumes
> the reconciler may create mirror rows. This plan asserts it must not, and proposes the amendment in
> "Master-plan amendments required" below. **This conflict is called out rather than silently
> resolved**, and is a decision the critic pass should explicitly rule on.

Considered and rejected: creating `directory_users` rows with a `source='zitadel'` discriminator.
Rejected because (a) it still pollutes the mirror the LDAP sync owns, (b) it requires the LDAP sync —
code outside this plan's scope, possibly outside this suite — to learn to leave those rows alone, and
(c) it makes "is this person in AD?" unanswerable by reading the mirror, which is the mirror's entire
purpose.

### D2.4 — Zitadel state is authoritative for existence and platform groups only

Per D2's authoritative-field split, the reconciler's **entire** write set is:

- `zitadel_directory_links` (all columns) — new, rolodex-owned.
- `zitadel_platform_group_members` — new, rolodex-owned; the projection of Zitadel project-role
  authorizations onto link rows. **Not** `group_members`, which is the AD group mirror and belongs to
  the LDAP sync.
- A reconcile-run audit row (`zitadel_directory_reconcile_runs`) — new, rolodex-owned.

Everything else is read-only to this reconciler, including every column of `directory_users`,
`directory_groups`, and `group_members`.

### D2.5 — PII containment

Rolodex's own documented caveat is that `birthDate`, `telephoneNumber`, `mail`, `workEmail` are
exposed and the JWT gate is the only access control. This plan must not widen that.

- The match ladder is ordered so that **the strong tiers need no PII at all** — `employeeNumber`,
  `objectGUID`, and UPN are not sensitive personal data in the way `mail`/`birthDate` are. Email is
  reached only at tier 4.
- `match_evidence` stores the tier, the *name* of the field matched, and a salted hash or a
  first-3/last-2 redaction of the value — **never a raw email address, phone number, or birth date**.
- Reconciler logs carry `zitadel_user_id` and `directory_user_id` only. No name, no email.
- Any new operator-review endpoint (Step 6) sits behind the existing JWT gate **plus** an admin role
  check, and its response projection must exclude `birthDate`, `telephoneNumber`, `mail`, and
  `workEmail`. Review by `directory_user_id` + `employeeNumber` + `match_tier` is sufficient to
  adjudicate a link; the PII columns are not needed and must not be returned.

---

## Cross-decision hazard: Phase 1 and Phase 2 collide on `externalId` and on who creates Zitadel users

Not previously recorded anywhere in the plan set. Flagging it here because it is a **Phase 1 input**
and Phase 1 has not executed yet, so it is still cheap to handle.

1. **`externalId` overwrite.** Phase 1's D5 backfill sets `externalId = rolodex.users.id` on each
   proactively-provisioned Zitadel user. When a customer IdP is later connected as a SCIM client, its
   provisioning of that same person will write **its own** id into `externalId` — because that is
   what `externalId` means to a SCIM client. D5's stored value in `users.zitadel_subject` is safe
   (it holds Zitadel's own `sub`, per the corrected two-step mapping), so **login does not break.**
   But the `externalId` link itself is destroyed, so it cannot be relied on for any *re-run* of the
   backfill, for reconciliation, or for recovery. Phase 1's backfill must be documented as
   strictly one-time-and-then-disposable, not as a durable link.

2. **Duplicate Zitadel users.** More serious. If rolodex proactively created Zitadel users in Phase 1
   and the customer IdP later provisions the same humans, Okta/Entra will not know the existing
   Zitadel users exist and will **create second Zitadel users** for them — unless an explicit
   import/match step is performed on the IdP side first. Two Zitadel users for one human means two
   link rows, split platform-group state, and a user who may log in as "the wrong one" depending on
   which client they authenticate through.
   **Required rule:** once a customer IdP is connected as SCIM client for a Zitadel org, **rolodex
   must never create Zitadel users in that org again**, and connecting the IdP must be preceded by an
   IdP-side import/match against the already-provisioned users. This is a Phase 2 runbook item with a
   Phase 1 precondition, and it is not currently written down in either plan.

3. **Which org(s).** Zitadel's SCIM path is org-scoped (`/scim/v2/{org}/Users`) and the management
   API filters by organization. Rolodex is a **single-tenant global directory** (Grounded facts), so
   the reconciler must be configured with an explicit, finite set of Zitadel org ids to enumerate —
   not "all orgs," which would let an unrelated Zitadel org inject links into the global directory.
   Unconfigured org → refuse to start, not "enumerate everything."

---

## Read path: management API, not SCIM

**Decision: the reconciler reads Zitadel via the v2 resource / management API (Connect-RPC), not via
SCIM.** SCIM's role in this architecture is strictly **inbound** (customer IdP → Zitadel).

Four reasons, in descending order of force:

1. **The SCIM single-resource path is known-broken on this stack and not root-caused.**
   `GET`/`PATCH /scim/v2/{org}/Users/{id}` consistently 404 `Errors.User.NotFound` on a
   freshly-reseeded local Zitadel v4.17.1, while `GET /scim/v2/{org}/Users?filter=…` finds the same
   user (`.sessions/2026-08-24-zitadel-sso-phase1/LESSONS.md`). Building the reconciler's read path
   on an API whose by-id access is unexplained-broken is not acceptable.
2. **SCIM here is users-only — there is no `/Groups` endpoint** (master plan, Phase 0 answered open
   questions). Platform group/role membership *must* come from the management API regardless. Using
   SCIM for users and management for groups means two clients, two auth setups, and two paginations
   for no benefit.
3. **The management API path is already proven working in this repo.** `infra/zitadel-local/seed.ts`
   successfully drives `zitadel.org.v2.OrganizationService/ListOrganizations`,
   `zitadel.project.v2.ProjectService/ListProjects`, `zitadel.user.v2.UserService/ListUsers`,
   `zitadel.user.v2.UserService/CreateUser`, and
   `zitadel.authorization.v2.AuthorizationService/CreateAuthorization` against this exact instance.
   That is real evidence, not an assumption.
4. **Deactivation state is authoritative on the management API.** `USER_STATE_INACTIVE` is a Zitadel
   user-state concept; SCIM's `active:false` maps onto it, but the management API is where the state
   actually lives.

**Honest caveat — what is proven vs assumed:**

| Claim | Status |
|---|---|
| `UserService/ListUsers` works against this instance | **Proven** — `seed.ts` uses it successfully |
| `AuthorizationService/CreateAuthorization` works | **Proven** — `seed.ts` uses it successfully |
| `AuthorizationService/ListAuthorizations` (or equivalent read) exists and returns project-role grants per user | **ASSUMED — never exercised.** `seed.ts` only ever *creates*. Must be verified in Step 1. |
| `ListUsers` pagination + filtering is sufficient for a full-org enumeration | **ASSUMED.** The seed script lists a handful of seeded users; behaviour at scale, and the exact cursor semantics, are unverified. |
| SCIM-provisioned enterprise-extension `employeeNumber` is stored by Zitadel and readable back via the management API | **ASSUMED, and it is the single highest-risk assumption in this plan.** If false, tier 1 of the match ladder does not exist. Step 1 gates on this. |
| SCIM `externalId` round-trips and is filterable | Proven 2026-08-23, **then contradicted in part** by the 2026-08-24 by-id 404 finding. Irrelevant to this plan's chosen design, which does not use it. |

---

## Implementation Steps

Sequenced. Steps 2–6 are `rolodex`-repo work; Step 1 is runnable against `infra/zitadel-local` in
this repo (read-only probing plus a disposable test user — no plan-owned code lands here).

### Step 1 — Capability gate: verify the five assumptions before designing anything on top of them

Run against a Zitadel instance seeded to represent Phase 2's shape: a project with an OIDC client, a
handful of users provisioned **through the SCIM endpoint** (simulating the customer IdP) carrying an
enterprise-extension `employeeNumber`, and project-role authorizations granted.

**Acceptance criteria**
- [ ] A user created via `POST /scim/v2/{org}/Users` including
      `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User` with a non-empty `employeeNumber`
      is accepted (2xx), and that `employeeNumber` value is subsequently **readable back via
      `zitadel.user.v2.UserService/ListUsers`** (or a documented sibling read). Record the exact
      response field path. If it is not readable back, tier 1 of the match ladder is **void** and
      this plan returns for revision before Step 2 starts.
- [ ] A read API that returns each user's project-role grants is identified by name, called
      successfully, and its response shape recorded — or, if no such read exists on v4.17.1, an
      alternative is identified and recorded. Platform-group projection (Step 5) cannot be
      implemented until this is answered with a real request/response pair.
- [ ] `ListUsers` is driven through **at least two pages** with a recorded page size and cursor
      field, and the union of pages equals the known seeded set exactly (no dupes, no drops).
- [ ] The 2026-08-24 `GET/PATCH /scim/v2/{org}/Users/{id}` 404 is re-tested on the instance Phase 2
      will actually use and the result recorded either way. (This plan does not depend on it; the
      finding is recorded so the next reader does not have to re-derive it a third time.)
- [ ] The `externalId` overwrite hazard is demonstrated or refuted with a real request pair: set
      `externalId` on a user, then perform a SCIM create/update as a "customer IdP" would, then
      re-read `externalId`. Record the observed behaviour.
- [ ] Every result above is written into this plan file as a dated "Step 1 results" section with
      real request/response pairs, in the same evidence style as the Phase 0 GO/NO-GO section.
      **Assumptions marked ASSUMED in the read-path table are either promoted to Proven or the plan
      is revised. No Step-2 work starts on an unresolved ASSUMED row.**

### Step 2 — Rolodex schema + database-level enforcement of the authoritative-field split

**Acceptance criteria**
- [ ] Migrations create `zitadel_directory_links`, `zitadel_platform_group_members`, and
      `zitadel_directory_reconcile_runs` with the columns/constraints in D2.1, including
      `UNIQUE(zitadel_user_id)` and a **non-unique** index on `directory_user_id`.
- [ ] **Zero columns are added to, and zero migrations alter, `directory_users`, `directory_groups`,
      or `group_members`.** Asserted by a test that diffs the mirror tables' schema before/after the
      migration set.
- [ ] The reconciler connects as a database role whose grants on `directory_users`,
      `directory_groups`, and `group_members` are **`SELECT` only** — `INSERT`/`UPDATE`/`DELETE` are
      not granted. A test asserts this by attempting a write on each mirror table through the
      reconciler's own connection and requiring a permission error.
      *Rationale: "the reconciler simply doesn't write those columns" is a convention a future PR
      breaks silently. A missing grant fails loudly, in CI, forever. This is the enforcement
      mechanism for D2's authoritative-field split — code review is the backup, not the primary.*
- [ ] The suite's default-deny RLS/grant posture (master plan, "Checked and cleared") is preserved on
      the three new tables: no `anon`/`authenticated` grants.
- [ ] `pnpm typecheck` 0 errors, `pnpm test` green in `rolodex`.

### Step 3 — Zitadel read adapter with a completeness sentinel

A module that enumerates, for the configured org id(s), every Zitadel user and their project-role
grants, following the read-path decision above and the concrete API names recorded in Step 1.

**Acceptance criteria**
- [ ] The adapter is configured with an **explicit finite list of Zitadel org ids**; an empty or
      unset configuration causes a startup failure, not a full-instance enumeration.
- [ ] Enumeration is paginated to completion and returns a result carrying an explicit
      `complete: true|false` flag. Any page error, auth error, or truncation yields `complete:false`
      **with whatever partial data was read still attached** — the adapter never converts a partial
      read into a silently-short list.
- [ ] A test injects a mid-pagination failure and asserts the result is `complete:false` and that the
      caller (Step 6) refuses to act on it.
- [ ] The adapter emits no PII into logs (asserted by a log-capture test: no `@`-containing token, no
      value from a `mail`/`telephoneNumber`/`birthDate` field).
- [ ] Contract tests run against a recorded fixture of the Step 1 real responses, so a Zitadel
      version bump that changes the response shape fails a test rather than silently returning
      zero users.

### Step 4 — Match ladder and link resolution

**Acceptance criteria**
- [ ] The four tiers of D2.2 are implemented in order; each tier hits only on **exactly one**
      candidate; `>=2` candidates sets `link_state='ambiguous'` and **does not fall through** to a
      weaker tier. Table-driven tests cover: tier-1 hit, tier-1 miss → tier-3 hit, tier-4 hit,
      ambiguity at each tier, and no-match.
- [ ] A Zitadel user with no matching `directory_users` row produces exactly one link row with
      `link_state='unmatched'`, `directory_user_id IS NULL` — and **zero rows are inserted into
      `directory_users`** (asserted by row count before/after).
- [ ] Two Zitadel users resolving to the same `directory_user_id` both persist, both are queryable,
      and neither overwrites the other (the `adm-`-account case). A test asserts two link rows share
      one `directory_user_id` without error.
- [ ] `match_tier` and `match_evidence` are persisted on every linked row; `match_evidence` contains
      **no raw email, phone, or birth date** (asserted by a regex test over the persisted JSON).
- [ ] Email matching (tier 4) is case-folded and whitespace-trimmed on both sides, and is attempted
      against `mail` before `workEmail`, with the winning column recorded in `match_evidence`.
- [ ] A link, once established at a given tier, is **not silently downgraded**: a later reconcile that
      can only match at a weaker tier keeps the existing link and records the degradation, rather
      than re-pointing `directory_user_id` on weaker evidence.
- [ ] An operator-created `match_tier='manual'` link is never overwritten by an automatic tier.

### Step 5 — Write path: link upsert + platform-group projection, split enforced

Wire alongside the existing `/api/sync/*` reconciler pattern, matching its shape (pull reconciler,
same job/scheduling and observability conventions as the existing sync jobs).

**Acceptance criteria**
- [ ] **The master plan's headline Phase 2 AC passes:** creating a user in the customer IdP
      provisions them into Zitadel via SCIM and, on the next reconcile, produces or updates a
      correlation to a matching `directory_users` row **without overwriting any AD/Workday-sourced
      attribute column.** Concretely: snapshot every column of the target `directory_users` row
      before the reconcile and assert byte-equality after; assert the link row is created/updated.
- [ ] Zitadel project-role grants are projected into `zitadel_platform_group_members` keyed on the
      link row. **Zero rows are written to `group_members`** (asserted by row count and by the Step 2
      grant test).
- [ ] A reconcile is **idempotent**: running it twice with no Zitadel-side change produces no row
      mutations on the second pass other than `last_seen_at`/`last_reconciled_at`. Asserted by
      comparing all other columns before/after.
- [ ] Every run writes exactly one `zitadel_directory_reconcile_runs` row recording: org ids,
      enumerated count, `complete` flag, per-tier match counts, ambiguous count, unmatched count,
      revoked count, and duration.
- [ ] A single documented test enumerates the authoritative-field split explicitly — the Zitadel-owned
      field set versus the Rolodex-owned field set — and asserts the reconciler's write set is
      exactly the former (satisfies the master plan's "No competing directory" AC).

### Step 6 — Deprovisioning, the revocation chain, and the mass-revocation circuit breaker

**Acceptance criteria**
- [ ] SCIM `PATCH active:false` → Zitadel `USER_STATE_INACTIVE` → next reconcile sets
      `zitadel_state='inactive'` and removes that link's `zitadel_platform_group_members` rows.
- [ ] SCIM `DELETE` → user absent from enumeration → next reconcile sets `zitadel_state='absent'`,
      `link_state='revoked'`, and removes that link's platform-group rows. The link row itself is
      **retained** (not deleted) so the revocation is auditable and a re-provisioned user re-links to
      the same history.
- [ ] **The revocation chain is asserted end-to-end, not just at the link table:** after a
      deactivation reconcile, the subsequent `/api/access/*` pass computes zero platform entitlements
      for that person and removes the corresponding downstream access on the real target (GitHub;
      ADO/GitLab assert against their existing stubs). *This is the master plan's "deprovision
      revokes access" AC — asserting only that a link column flipped does not satisfy it.*
- [ ] **Circuit breaker:** revocation is applied **only** when the enumeration returned
      `complete:true` **and** the count of links that would be revoked in this run is below a
      configured threshold (absolute and/or a percentage of currently-linked rows). Exceeding it
      aborts the run with no revocations, writes a `complete:false`-equivalent run row, and alarms.
      Tested with an injected partial read (asserts zero revocations) **and** with a synthetic
      mass-disappearance (asserts abort + alarm, zero revocations).
      *Rationale: "source system returned fewer rows than expected" is the standard way reconcilers
      cause mass outages. `directory_users` here drives real GitHub/ADO/GitLab access.*
- [ ] `directory_users` rows are **never** deleted or modified by deprovisioning — a person leaving
      the SSO scope is not a person leaving AD. Asserted by row-count and column snapshot.
- [ ] An admin-gated operator surface lists `ambiguous` and `unmatched` links and permits a manual
      link (recording `resolved_by`, `match_tier='manual'`). Its response projection excludes
      `birthDate`, `telephoneNumber`, `mail`, `workEmail` (asserted by a response-shape test).
- [ ] A runbook section is written covering: connecting a customer IdP to a Zitadel org that already
      contains rolodex-provisioned users (the IdP-side import/match step, per "Cross-decision
      hazard" #2), the circuit-breaker threshold values and who may override them, and the
      first-connection dry-run procedure (Step 6 run with revocation disabled, output reviewed
      before enabling).

---

## Master-plan amendments required (to be applied only after this plan is approved)

Following the established append-and-date, strike-don't-delete convention of
`sso-saml-scim-platform-identity.md`:

- [ ] **D2's join-key sentence** (line ~40, *"email as default; `employeeNumber`/`objectGUID` where
      available"*) is struck through with a dated note superseding it with this plan's decision: a
      rolodex-owned link table plus the ordered match ladder, and an explicit statement that
      `externalId` is **not** the D2 join key and why (rolodex is not the provisioner; three
      claimants, one field).
- [ ] **The architecture diagram's** `join on email/employeeNumber` annotation (line ~78) is
      corrected to reference the link table + match ladder. Its existing 2026-08-24 note (line ~83)
      already correctly scopes it to D2/Phase 2 and stays.
- [ ] **The SCIM-provisioning AC** (line ~133, *"produces/updates a matching `directory_users` row"*)
      is amended to *"produces/updates a matching correlation link to a `directory_users` row, or an
      explicit `unmatched` link when no AD/Workday row exists yet"* — per D2.3. **This is a
      substantive change to a normative AC and must be ruled on by the critic pass, not applied
      silently.**
- [ ] **The SCIM-deprovisioning AC** (line ~134) is extended to require the end-to-end revocation
      chain through `/api/access/*` plus the circuit-breaker condition.
- [ ] **The Phase 2 step list** (lines ~109-112) is updated to reference this plan by filename.
- [ ] **`identity-correlation-externalid-decision.md`'s** "What this plan does NOT decide" bullet on
      D2 gets a dated pointer to this plan, noting that its forward-referenced hypothesis
      (externalId-locates-a-row likely applies) was **re-derived and rejected** here, with the
      reason — so no future reader re-adopts it from the forward-reference alone.
- [ ] **Phase 1's plan** (`rolodex/.omc/plans/zitadel-sso-phase1-cutover.md`, currently REVISE-blocked)
      is given the "Cross-decision hazard" findings as a Phase 1 input: the backfill's `externalId`
      link is one-time-and-disposable, and the no-rolodex-creates-Zitadel-users-after-IdP-connection
      rule.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Tier 1 does not exist** — Zitadel v4.17.1 does not store or return the SCIM enterprise-extension `employeeNumber`. The strongest tier vanishes and the ladder degrades toward UPN/email, i.e. toward exactly the weak correlation D5 rejected. | Step 1 is a hard gate that answers this with a real request/response before any schema work. If it fails, the plan returns for revision — candidate fallbacks: Zitadel user metadata written by a customer-IdP-side transform, or accepting UPN as tier 1 with the weakness documented. Not silently absorbed. |
| **Mass revocation from a partial read** — a truncated or errored enumeration read as "everyone was deleted," cascading through `/api/access/*` into real GitHub/ADO/GitLab access removal. | `complete` sentinel (Step 3) + circuit breaker with an explicit threshold (Step 6) + tests for both the partial-read and mass-disappearance paths + a dry-run-first runbook step on IdP connection. |
| **Duplicate Zitadel users** after a customer IdP is connected to an org rolodex already provisioned into. Split platform-group state, ambiguous login identity. | "Cross-decision hazard" #2: mandatory IdP-side import/match before connection; rolodex forbidden from creating Zitadel users in an IdP-connected org; two link rows sharing a `directory_user_id` are surfaced (not hidden) by D2.1's non-unique FK, which turns this into a visible review item instead of a silent corruption. |
| **Ambiguous matches auto-resolved wrongly** — two `directory_users` rows sharing an email (rehire, AD+Workday duplicate) silently linked to the wrong person, granting them the other person's downstream access. | Ambiguity **halts** the ladder rather than falling through or picking a winner; `link_state='ambiguous'` grants nothing; resolution is a deliberate, attributed operator action (`resolved_by`). |
| **PII scope creep** — a new reconciler and a new operator endpoint both touching a table whose only access control is the JWT gate. | Strong tiers need no PII; email is tier 4 only; `match_evidence` is redacted; logs carry ids only; operator endpoint is admin-gated with the four sensitive columns excluded from its projection — each with its own assertion. |
| **A future PR writes to the mirror tables**, quietly breaking the authoritative-field split that this whole decision rests on. | Enforcement is a **missing database grant**, not a code convention, with a test that asserts writes fail. Code review is the backup. |
| **`ListAuthorizations` (or equivalent) does not exist** on v4.17.1, so platform-group projection has no read source. | Explicitly marked ASSUMED and gated in Step 1. Note that the master plan already records "SCIM here is users-only — group provisioning needs the management API regardless," so if the management API also lacks a per-user grant read, **Phase 2's group half has no viable source at all** and that is a GO/NO-GO-grade finding, not a detail. |
| **Already-issued access tokens survive SCIM deactivation** until natural expiry — a deprovisioned user keeps API access for the token's remaining lifetime, regardless of how fast the reconciler runs. | Out of this reconciler's reach by construction. Documented as a real residual gap; mitigations (short access-token lifetime, or token introspection on sensitive routes) are a Phase 2 follow-up decision, **not** something this plan claims to solve. |
| **Zitadel API shape drift** on a version bump silently returning zero users → looks like a mass deprovision. | Contract tests against recorded real fixtures (Step 3) + the circuit breaker (Step 6) as independent defenses. |
| **Phase 1 slips or changes shape**, invalidating this plan's assumption about `users.zitadel_subject`. | This plan depends on Phase 1 only for the *login* path; the D2 link table is independent of `zitadel_subject` by construction. A Phase 1 redesign does not invalidate D2. |

---

## Open Questions (unresolved — deliberately not hand-waved)

- **OQ-1 (gates Step 2):** Does Zitadel v4.17.1 store a SCIM enterprise-extension `employeeNumber`
  and return it via the management API? If no, tier 1 is void. *Answered by Step 1.*
- **OQ-2 (affects tier ordering):** Can a customer IdP map AD `objectGUID` into a Zitadel-readable
  attribute or user metadata? If yes, tiers 1 and 2 swap. Note the identity-correlation plan already
  flagged Zitadel user *metadata* as **"not yet confirmed available"** on this version — the same
  unverified capability underlies both this question and the deferred Phase 4 correlation mechanism,
  so answering it once serves both.
- **OQ-3 (gates Step 5's group half):** Is there a management-API read returning per-user project-role
  grants on v4.17.1? `seed.ts` proves only the *create* side. If there is none, Phase 2's platform-group
  reconciliation has no source and the phase needs re-scoping.
- **OQ-4:** Which Zitadel org(s) does the reconciler enumerate, given rolodex is a single-tenant global
  directory but Zitadel is org-partitioned and SCIM is org-scoped? Needs an owner decision before
  Step 3's configuration is designed.
- **OQ-5 (needs a product/ops owner, not an engineer):** What are the circuit-breaker thresholds, and
  who may override an aborted run? Too consequential to default.
- **OQ-6:** Does the customer IdP's SCIM scope equal the LDAP sync's scope? If the two filters differ,
  a permanent population of `unmatched` links and of Zitadel-less `directory_users` rows is *normal*,
  not an error — and the operator surface must not present it as an alert backlog. Needs a stated
  expectation per customer.
- **OQ-7:** Is the SCIM by-id 404 (2026-08-24) still reproducible on the instance Phase 2 will use?
  This plan is designed not to depend on it, but an unexplained 404 on a core endpoint is a signal
  about instance health worth resolving. *Recorded by Step 1.*

*Per the requesting instruction to touch no file other than this one, these are recorded here rather
than appended to `.omc/plans/open-questions.md`. Promoting OQ-1 … OQ-7 into that file is a
follow-up action for whoever approves this plan.*

---

## Verification Steps

1. **Step 1 gate:** the dated "Step 1 results" section exists in this file with real request/response
   pairs, and every ASSUMED row in the read-path table is resolved to Proven or Void. No downstream
   step is started otherwise.
2. **Per touched repo (`rolodex`):** `pnpm typecheck` 0 errors, `pnpm test` green. DB-backed tests
   gate on `DATABASE_URL` as usual.
3. **Split enforcement:** the grant test (Step 2) is run and observed to fail writes on all three
   mirror tables through the reconciler's connection.
4. **Headline AC, executed manually once end-to-end:** provision a user in the IdP (or SCIM test
   client) → confirm in Zitadel → snapshot the target `directory_users` row → run the reconciler →
   assert a link row exists at the expected tier and the `directory_users` snapshot is byte-identical.
5. **Deprovision chain, executed manually once end-to-end:** deactivate via SCIM → run the reconciler
   → run `/api/access/*` → assert downstream access removed on the real GitHub target and the
   `directory_users` row untouched.
6. **Circuit breaker, executed manually once:** simulate a partial enumeration and confirm zero
   revocations plus an alarm.
7. **PII:** grep the reconciler's captured logs and persisted `match_evidence` for `@`, and inspect
   the operator endpoint's response shape for the four sensitive column names. Both must be clean.
8. **No unintended file changes in this repo:** snapshot-and-`diff --no-index` (not `git diff` —
   `.omc/` is gitignored suite-wide, per `FOLLOWUPS.md`) confirms only this file changed here.

---

## ADR

- **Decision:** D2's Zitadel↔`directory_users` correlation is materialized in a new rolodex-owned
  `zitadel_directory_links` table keyed on the Zitadel user's own immutable `id`, populated by an
  ordered match ladder (`employeeNumber` → AD `objectGUID` → UPN/`userName` → email-as-last-resort),
  where a tier hits only on exactly one candidate and ambiguity halts rather than falls through.
  SCIM `externalId` is **not** the join key. The reconciler reads Zitadel via the v2 management /
  resource API (not SCIM), writes only its three new rolodex-owned tables, holds **no write grant**
  on `directory_users`/`directory_groups`/`group_members`, and never fabricates a mirror row.
- **Drivers:** (1) In Phase 2 the SCIM client is the *customer's* IdP, so `externalId` is a
  third-party-owned field with third-party-owned semantics — rolodex cannot set or rely on it.
  (2) One `externalId` field, three claimants (D5's `users.id`, a hypothetical `directory_users.id`,
  and the customer IdP's own id), with the third writing last and continuously — the identical
  cardinality defect that got the D5 plan's first draft rejected. (3) `directory_users` is an
  LDAP-sync-owned mirror, so any rolodex-written column in it is both clobber-prone and a direct
  violation of the anti-two-directories rule. (4) `GET`/`PATCH /scim/v2/{org}/Users/{id}` is
  known-broken and un-root-caused on this stack, while the management API path is already
  demonstrably working in `infra/zitadel-local/seed.ts`.
- **Alternatives considered:**
  **(A) Inherit D5's `externalId`-locates-a-row mechanism** (the forward-reference's own hypothesis)
  — rejected on drivers 1 and 2; the hypothesis rested on `directory_users.id` being stable, which is
  true but irrelevant, since D5's mechanism actually depended on rolodex controlling the Zitadel-side
  field, which it does not in Phase 2.
  **(B) A `zitadel_user_id` column directly on `directory_users`** — rejected on driver 3, and
  additionally because it cannot represent a Zitadel user with no mirror row, which is Phase 2's most
  common state.
  **(C) Keep the master plan's "email as default" join key** — rejected for the same reasons D5
  rejected it (weak, mutable, duplicate-prone), and demoted to a flagged tier-4 last resort rather
  than deleted, because some customer IdPs will map nothing stronger.
  **(D) Reconciler creates `directory_users` rows for unmatched Zitadel users** (what the master
  plan's current AC literally says) — rejected: it makes rolodex a second directory, the rows are
  clobber-prone, and it destroys the mirror's ability to answer "is this person in AD?".
  **(E) A `source='zitadel'` discriminator on mirror rows** — rejected: still pollutes the mirror and
  requires cooperating changes in the LDAP sync, which is outside this plan's control.
  **(F) Read via SCIM instead of the management API** — rejected on driver 4 plus SCIM being
  users-only, which would force a second client for groups anyway.
- **Why chosen:** it is the only option that survives all four differing constraints simultaneously,
  it degrades honestly (a weak match is *recorded* as weak rather than being indistinguishable from a
  strong one), it makes the authoritative-field split enforceable by the database rather than by
  convention, and it fails safe on every ambiguity instead of guessing — which matters because this
  table drives real GitHub/ADO/GitLab access grants.
- **Consequences:** three new rolodex-owned tables and a dedicated reconciler DB role. Four master-plan
  amendments, one of which (the SCIM-provisioning AC, line ~133) is a substantive normative change
  that must be explicitly ruled on, not applied silently. An operator-review surface becomes a
  permanent operational requirement, because unmatched and ambiguous links are a *normal steady state*
  when the IdP's SCIM scope and the LDAP sync's scope differ (OQ-6) — not a transient backlog.
  Phase 1 gains two required inputs it does not currently have (the disposable-`externalId` note and
  the no-rolodex-creates-Zitadel-users rule). Tier ordering is provisional until OQ-1/OQ-2 are
  answered by Step 1's gate.
- **Follow-ups:** answer OQ-1 … OQ-7 (Step 1 answers 1, 2, 3, 7); promote them into
  `.omc/plans/open-questions.md`; feed the "Cross-decision hazard" findings into the REVISE-blocked
  Phase 1 plan before it is re-submitted; decide the already-issued-token-survives-deactivation
  mitigation (short lifetime vs. introspection) as its own Phase 2 follow-up; and note that OQ-2
  (Zitadel user metadata availability on v4.17.1) is the **same** unconfirmed capability the deferred
  Phase 4 cross-app correlation mechanism depends on — answering it here should be recorded where
  Phase 4 will find it.
