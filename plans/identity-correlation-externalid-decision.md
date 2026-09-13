# Plan: Lock rolodex's identity-correlation strategy (Decision 5) before Phase 1 executes

**Status:** pending approval · **Mode:** direct, revised after codex critic REJECT · **Created:** 2026-08-24

**Scope:** amend `sso-saml-scim-platform-identity.md`'s **Decision 5 only** (the `users`-table
JIT-provisioning correlation Gap 2 already touched in rolodex). This is a
**documentation/ADR change only** — no source code in chorus, helmsman, or warden changes as
a result of this plan, and rolodex's already-shipped Gap 2 code (`fbbcd82`) is not touched.
**Decision 2** (the separate `directory_users`/SCIM-reconciler correlation problem, Phase 2)
is explicitly out of scope — see "What this plan does NOT decide" below.

## Revision note (why this file changed)

A codex critic pass on the first draft of this plan returned **REJECT** with two real,
substantive bugs, not style nits:

1. **Conflated two different values.** SCIM `externalId` *locates an existing local user row*
   (it's a lookup key). The value that must actually be *written into* `zitadel_subject` /
   `providerSubject` — the column every app's unchanged JIT lookup compares against on every
   login — is the Zitadel user's own immutable `id`/`sub`. The first draft implied `externalId`
   itself gets stored in the subject column. Wrong. Fixed below with an explicit two-step
   mapping.
2. **Cardinality gap.** One Zitadel user has exactly one `externalId` field. But the same
   person has **four different, independently-generated local user IDs** across
   rolodex/chorus/helmsman/warden (four separate databases, four separate ID sequences). A
   single `externalId` value cannot simultaneously equal all four apps' local IDs for the same
   person. The first draft's "suite-wide" framing silently assumed it could. Fixed below by
   narrowing this plan's locked decision to rolodex only, and explicitly deferring (not
   falsely resolving) the cross-app version of the problem to Phase 4.

Also fixed per the same review: removed the `oauth_accounts` "reuse as-is" guidance for
chorus/warden (their JIT paths don't query that table today, so storing a link there wouldn't
actually prevent a duplicate row — the claim was misleading), and widened the "reconcile every
email reference" scope to the actual normative statements in the parent plan (D2's own join
key text, the architecture diagram, and the risk-mitigation table row), not just Decision 5
and the Phase 1 task line.

## Why this exists

Gap 2 (closed this session, rolodex `fbbcd82`) added a nullable `zitadel_subject` column +
JIT-lookup ordering to rolodex, matching Decision 5's original email-correlation text. But the
Phase 0 spike's own findings (plan lines 172-174) concluded a SCIM `externalId`-based
correlation is cleaner than email and "should replace" it — and the plan document was never
reconciled between these two positions. Before Phase 1 (rolodex production SSO, which includes
the real backfill) starts, Decision 5 needs to say one thing, correctly, not two things that
disagree with each other in the same document.

A cross-repo survey (chorus, helmsman, warden — 2026-08-24) additionally found that all three
already ship the same `providerSubject` column + 3-tier JIT-lookup shape that rolodex's Gap 2
just added, built for their own historical Supabase-era identity work — helmsman's is
documented prior art for an actual Zitadel-to-Supabase migration
(`helmsman/docs/adr/0003-supabase-backend-migration.md:29`). That survey is preserved below as
useful evidence for whoever picks up Phase 4, but — per the revision above — it does **not**
mean this plan can lock a working cross-app mechanism today. Only rolodex's Phase 1 is decided
here.

## What this plan DOES decide (rolodex, Decision 5, Phase 1)

**The corrected two-step mapping:**

1. **Proactive link (before Phase 1 backfill runs, one-time, per existing user):** when a
   rolodex user is provisioned into Zitadel, Zitadel's `externalId` attribute on that new
   Zitadel user is set to rolodex's own existing `users.id` for that person. `externalId` is
   *only ever used to locate the right local row* — it is never written into `zitadel_subject`.
2. **One-time backfill script (Phase 1, not yet executed):** enumerate provisioned Zitadel
   users (SCIM or management API), read each one's `externalId`, look up the matching rolodex
   `users.id` row, and write **that Zitadel user's own `id`/`sub`** (not the `externalId`) into
   `zitadel_subject` on that row. After this one-time pass, the already-shipped runtime JIT
   lookup (`zitadel_subject` match, then `providerSubject`, then legacy id-as-sub, then create
   — Gap 2, unchanged) works exactly as built: it compares an incoming token's real `sub`
   against `zitadel_subject`, with no runtime `externalId` lookup needed at all.

This resolves the actual bug Gap 2's own scope note flagged (no backfill = still creates
duplicates today) with a join key stronger than email, without any code change beyond writing
that one-time backfill script when Phase 1 executes.

## What this plan does NOT decide (explicitly deferred, not silently resolved)

- **Chorus/helmsman/warden's Phase 4 correlation source.** The same `externalId`-locates-a-row
  mechanism cannot extend to all three apps simultaneously using a single Zitadel `externalId`
  field, because each app has its own independent local user ID for the same person — one
  field can't hold four different values. A real mechanism (most likely per-app Zitadel user
  *metadata* keyed by app name, e.g. `metadata['chorus_user_id']`, rather than the single
  `externalId` field — **not yet confirmed available** on this suite's self-hosted Zitadel
  v4.17.1) needs its own investigation when each app's Phase 4 sub-task actually starts. This
  plan records *why* the naive extension doesn't work, so Phase 4 doesn't have to rediscover
  the cardinality problem from scratch, but it does not claim to solve it.
- **Decision 2 (`directory_users` / SCIM-reconciler correlation, Phase 2).** D2's join key
  (`email` as default; `employeeNumber`/`objectGUID` where available) links a Zitadel user to a
  `directory_users` row — a different table, a different phase, and a different reconciler
  than Decision 5's `users`-table JIT-provisioning problem this plan actually fixes. D2 is
  flagged with a dated forward-reference to this plan's reasoning (externalId-locates-a-row is
  likely applicable there too, since `directory_users` also has a stable local ID) but is not
  itself resolved here — Phase 2 hasn't started, and `directory_users` is a read-only AD/Workday
  mirror with different constraints that deserve their own explicit decision.
- **The `oauth_accounts` tables in chorus/warden.** The first draft suggested reusing these
  as-is to store a `provider='zitadel'` externalId link. Removed: neither app's current
  JIT-lookup path (`jitProvisionUser`) queries `oauth_accounts`, so storing a link there
  wouldn't actually prevent a duplicate row without also changing the lookup — which is exactly
  the code change this plan is scoped to avoid making today. Whatever Phase 4 designs must
  either wire into that table for real or use a different mechanism; not decided here.

## Acceptance Criteria (testable)

- [ ] Decision 5 is amended to state the corrected two-step mapping (externalId locates the
      row during a one-time backfill; the Zitadel user's own `id`/`sub` — not the externalId —
      is what gets written into `zitadel_subject`), superseding the original single-sentence
      email-correlation text, which stays visible and struck through with a dated note (not
      deleted).
- [ ] Phase 1's task list (plan line ~102, "Add `zitadel_subject`... backfill via email
      correlation") is corrected to reference the amended Decision 5 and the two-step mapping,
      not "email correlation."
- [ ] D2's join-key text (plan line ~420) gets a dated forward-reference note: this is a
      separate correlation problem (`directory_users`, not `users`; Phase 2, not Phase 1) that
      this plan does not resolve, with a pointer to this plan's reasoning for whoever picks up
      Phase 2.
- [ ] The architecture diagram's "join on email/employeeNumber" annotation (plan line ~456) is
      corrected or dated-noted to match — it currently describes the reconciler flow (a D2/Phase
      2 concern) and should not be read as describing Decision 5's Phase 1 mechanism.
- [ ] The risk-mitigation table row for "Identity `sub` change breaks FKs / RLS" (plan line
      ~141, "Add `zitadel_subject` + email correlation") is corrected to reference the amended
      Decision 5 instead of restating superseded email-correlation language.
- [ ] The parent plan's own **Acceptance Criteria** section (line ~128, "Identity migration: an
      existing user is correlated to a Zitadel subject by email; `zitadel_subject` is
      populated...") is a live, normative testable criterion — not historical text — and is
      corrected to state the two-step mapping (correlated via `externalId`-locates-the-row,
      `zitadel_subject` populated with the Zitadel user's own `sub`), not email.
- [ ] Phase 0's task list (line ~95, "Prove identity migration on ONE user: correlate an
      existing Supabase user to a Zitadel subject by email; confirm `directory_users` join
      works") is dated as historical spike-era text describing what Phase 0 actually did, with
      a note that it blends D5 (`users`/subject correlation) and D2 (`directory_users` join)
      language loosely and should not be read as current guidance for either.
- [ ] A new dated section (mirroring the existing "Phase 0 GO/NO-GO" and "Checked and cleared —
      no live RLS issue" sections' append-don't-replace style) records: the corrected two-step
      mapping for rolodex; the explicit Phase 4 cardinality deferral with its reasoning; and the
      cross-app survey findings (each of chorus/helmsman/warden's existing column, JIT-lookup
      file:line, and concrete duplicate-row blast radius — org membership loss via a separate
      `orgMembers`/`org_members` table in all three; helmsman additionally fragments
      `audit_events.actorId` and several `createdBy` columns).
- [ ] No file under `chorus/`, `helmsman/`, or `warden/` (source, schema, migrations) is
      modified by this plan. Only `fleetworks-monorepo/.omc/plans/sso-saml-scim-platform-identity.md`
      changes.
- [ ] Rolodex's `fbbcd82` (Gap 2) is referenced, not modified — no diff in the rolodex repo.

## Implementation Steps

1. Read the current `sso-saml-scim-platform-identity.md` Decision 2 (lines ~416-420),
   Decision 5 (lines ~428-429), architecture diagram (lines ~434-459), Phase 1 task list (line
   ~102 in the phased-steps section), and the risk-mitigation table row (line ~141) in full
   before editing, to preserve exact context around each edit point — line numbers have already
   drifted once in this document (see its own "Citation drift" precedent in the sequencing map)
   so re-verify each against the live file, not this plan's cached line numbers.
2. Amend Decision 5 with the corrected two-step mapping (see "What this plan DOES decide"
   above), striking through the original email-correlation sentence with a dated superseded
   note rather than deleting it.
3. Add the dated forward-reference note to D2, marking it explicitly out of scope for this
   plan.
4. Correct or date-note the architecture diagram's join-key annotation.
5. Correct the Phase 1 task list line, the risk-mitigation table row, and the parent plan's
   own "Identity migration" acceptance criterion (line ~128) to reference the amended
   Decision 5 and the two-step mapping — this AC is live/normative, not historical, and must
   not be missed.
6. Date-note Phase 0's task list line (~95) as historical spike-era text that loosely blends
   D5 and D2 language, without rewriting what it says Phase 0 did.
7. Append the new dated section with the corrected mapping, the explicit Phase 4 deferral +
   reasoning, and the cross-app survey findings.
8. Before editing, `cp sso-saml-scim-platform-identity.md /tmp/sso-plan-before-edit.md` (or
   equivalent) as a snapshot; after editing, `diff --no-index /tmp/sso-plan-before-edit.md
   sso-saml-scim-platform-identity.md` to review the exact diff precisely, in addition to (not
   instead of) `git status --short`/`git diff --name-only` for the sibling-repo checks below —
   `--stat`/`--name-only` alone were flagged by review as an insufficient proof that only the
   intended sections changed.
9. Verify no other repo's files changed.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Silently editing away the original email-correlation reasoning loses the record of why it was first chosen. | Strike-through + dated amendment note, not deletion — matches this doc's own established pattern for the Cloud-vs-self-hosted and RLS sections. |
| A future reader conflates this plan's rolodex-only decision with a suite-wide one (the exact bug in this plan's first draft). | The "What this plan does NOT decide" section and the explicit Phase 4 deferral note are structural, not incidental — a reader hitting Decision 5 sees the scope boundary immediately. |
| Someone re-derives the Phase 4 cardinality problem from scratch. | The dated section records the reasoning (one `externalId` field, four independent local IDs) so it doesn't need re-deriving, even though the fix itself is deferred. |
| A future reader assumes this plan changed code in chorus/helmsman/warden because the plan document mentions all four apps. | Explicit acceptance criterion + verification step confirming zero diff outside `fleetworks-monorepo/.omc/plans/`. |

## Verification Steps

1. `diff --no-index` between the pre-edit snapshot and the post-edit
   `sso-saml-scim-platform-identity.md` (per Implementation Step 8) is read in full — every
   changed line is one of: Decision 5, D2's forward-reference note, the architecture diagram's
   join-key annotation, the Phase 1 task line, the risk-mitigation row, the parent plan's
   "Identity migration" acceptance criterion, Phase 0's historical date-note, or the new
   appended dated section. Any other changed line is a scope violation and must be reverted.
2. `git status --short` and `git diff --name-only` in `fleetworks-monorepo` corroborate exactly
   one file changed: `.omc/plans/sso-saml-scim-platform-identity.md`.
3. `git status --short` in `chorus`, `helmsman`, `warden`, and `rolodex` all show no changes
   from this plan's execution.
4. Manual read-through of the amended Decision 5, D2 forward-reference, architecture diagram,
   Phase 1 task line, risk-mitigation row, and the parent plan's "Identity migration"
   acceptance criterion confirms: original text struck through and dated (not deleted) where
   superseded; the two-step mapping is stated precisely (externalId locates the row, Zitadel's
   own sub is what's stored) everywhere it's referenced, including the AC; the Phase 4 deferral
   is explicit, not framed as resolved; Phase 0's historical line is dated, not rewritten; and
   the new survey section cites real file:line evidence per app matching this session's actual
   survey findings.
5. Confirm the revised plan does not repeat the rejected draft's error anywhere: grep the
   amended sections for any sentence implying `externalId` itself is written into
   `zitadel_subject`/`providerSubject` — there should be none.

## ADR

- **Decision:** Rolodex's Decision 5 correlation (Phase 1 only) uses a two-step mapping: SCIM
  `externalId` (set to rolodex's own existing `users.id` at proactive provisioning time) locates
  the correct local row during a one-time backfill; the Zitadel user's own `id`/`sub` — not the
  externalId — is what gets written into `zitadel_subject`. No schema or JIT-lookup code changes
  in rolodex as a result of this decision (Gap 2 stays as shipped) — only the one-time backfill
  script's data source, which does not exist yet and is Phase 1 work.
- **Drivers:** (1) the Phase 0 spike found email correlation weak and recommended `externalId`;
  (2) a duplicate-row bug from a weak join key concretely means silent org-membership loss, not
  a cosmetic issue; (3) the codex critic review of this plan's first draft proved the naive
  "same mechanism works suite-wide" framing doesn't hold, so honesty about scope is itself a
  requirement, not an optional nicety.
- **Alternatives considered:** (A) keep raw email correlation as originally planned — weak join
  key, real duplicate-row risk on any email mismatch, rejected. (B) extend this exact mechanism
  to chorus/helmsman/warden's Phase 4 today — rejected for now: the cardinality gap (one
  `externalId` field, four independent local IDs) means it doesn't actually work without a
  separate per-app mapping mechanism that hasn't been designed or confirmed feasible on this
  Zitadel version. (C) store `externalId` directly in `zitadel_subject` — rejected: conflates a
  lookup key with the value every login actually compares against; would silently break the
  first real login for anyone backfilled this way, since `zitadel_subject` would hold
  `externalId` rather than the token's real `sub` and would never match.
- **Why chosen:** the two-step mapping is the only option that is both correct (stores the
  right value) and honest about what it actually covers (rolodex only, not a suite-wide claim
  this plan can't back up yet).
- **Consequences:** Phase 1's rolodex backfill (not yet executed) must implement the two-step
  mapping exactly as specified, not the single-step version the first draft implied. Phase 4's
  per-app correlation mechanism for chorus/helmsman/warden remains an open decision, recorded
  with its reasoning so it starts from an informed position rather than zero.
- **Follow-ups:** when Phase 4 for any of chorus/helmsman/warden actually starts, its own
  sub-task must explicitly decide the cross-app correlation mechanism (most likely per-app
  Zitadel user metadata, pending confirmation of that capability on self-hosted Zitadel
  v4.17.1) before repeating this plan's first-draft mistake. When Phase 2 starts, D2's
  `directory_users` correlation needs its own explicit decision, informed by but not identical
  to this one.
