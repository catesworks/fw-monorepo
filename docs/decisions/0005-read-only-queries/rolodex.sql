-- ADR 0005 read-only production queries: fw-rolodex database (rolodex-api DATABASE_URL)
-- SELECT-only, counts/aggregates only. No emails, names or ids are selected.
-- Run: see README.md (credential only in the single psql command's environment).
-- Output (psql -At): one line per query, "<tag>|<count>".
-- Schema source: fw-rolodex/packages/db/src/schema.ts (users.provider_subject text NULL,
-- users.zitadel_subject text NULL). JIT lookup order in middleware.ts jitProvisionUser:
-- (1) zitadel_subject = sub, (2) provider_subject = sub, (3) id = sub (legacy fallback).
-- A row is reachable ONLY through (3) when id = sub but neither (1) nor (2) match.
-- NOTE: the backfill at (3) is already compare-and-set at the repo head (fw-7til:
-- WHERE id = sub AND provider_subject IS NULL; it also refuses rows bound to another
-- subject). The bead text calling it "unguarded" describes an older build; Q5 below
-- checks the data for the clobber signature regardless of which build is deployed.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

-- Q0: sanity. Total users rows. 0 or an error means wrong database.
SELECT 'Q0_total', count(*) FROM public.users;

-- Q1: ADR literal: provider_subject unset (NULL or empty). Expect 0, BUT in rolodex a
-- row correlated only by zitadel_subject legitimately has no provider_subject, so a
-- non-zero Q1 is not by itself a blocker here: use Q1r for the delete decision.
SELECT 'Q1_provider_subject_unset', count(*)
FROM public.users
WHERE provider_subject IS NULL OR provider_subject = '';

-- Q1r: rolodex refinement of Q1: neither provider_subject nor zitadel_subject set.
-- Such a row can only be found by the id===sub fallback. Expect 0.
-- Outcome: 0 = no row relies on the fallback's backfill. >0 = deleting the fallback
-- would orphan these rows (JIT would insert a duplicate user). Delete rule (rolodex):
-- Q1r AND Q3 == 0.
SELECT 'Q1r_no_subject_at_all', count(*)
FROM public.users
WHERE (provider_subject IS NULL OR provider_subject = '')
  AND (zitadel_subject IS NULL OR zitadel_subject = '');

-- Q3: rows reachable ONLY through id===sub for a Zitadel-style (non-uuid) sub: id is
-- not uuid-shaped, and neither provider_subject nor zitadel_subject equals id.
-- IS DISTINCT FROM so NULLs count (the ADR text's "<>" skips NULLs). Expect 0.
-- Outcome: 0 = the id lookup never rescues a Zitadel token. Part of the delete rule.
SELECT 'Q3_fallback_only_nonuuid_id', count(*)
FROM public.users
WHERE id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND provider_subject IS DISTINCT FROM id
  AND zitadel_subject IS DISTINCT FROM id;

-- Q3a: ADR-literal Q3 variant (id <> provider_subject AND id not uuid-shaped), kept
-- for comparison. It over-counts versus Q3 (rows found by zitadel_subject are fine).
-- Outcome: informational. Q3 == 0 with Q3a > 0 means those rows are matched by
-- zitadel_subject first, so the fallback is still unnecessary for them.
SELECT 'Q3a_adr_literal', count(*)
FROM public.users
WHERE id <> provider_subject
  AND id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Q2: rows never re-keyed to a Zitadel sub (provider_subject still uuid-shaped, i.e. a
-- Supabase sub). Informational, NOT part of the delete rule. Non-zero = users who have
-- not logged in since the cutover; their id is a Supabase uuid, so the fallback cannot
-- rescue them for a Zitadel token; they need a rewrite or must accept re-provisioning.
SELECT 'Q2_provider_subject_uuid_shaped', count(*)
FROM public.users
WHERE provider_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Q4: rows with no Zitadel correlation yet (zitadel_subject NULL or empty).
-- Outcome: informational. Not a delete blocker (Q1r/Q3 decide that). Non-zero = users
-- who have not logged in via Zitadel since the zitadel_subject column was added.
SELECT 'Q4_zitadel_subject_unset', count(*)
FROM public.users
WHERE zitadel_subject IS NULL OR zitadel_subject = '';

-- Q5: backfill-clobber signature. Rows that carry a Zitadel correlation
-- (zitadel_subject set) while provider_subject is uuid-shaped AND equals id: the shape
-- an unguarded "SET provider_subject = sub WHERE id = sub" leaves behind when a stale
-- Supabase token hits the id fallback on a re-keyed row. Expect 0 if rows were
-- re-keyed; non-zero may also be benign (Supabase-era row later given a
-- zitadel_subject). Outcome: >0 means check whether the deployed build predates the
-- fw-7til guard; it does not block deleting the fallback (deleting it removes the
-- clobbering UPDATE entirely) but any such row needs a manual provider_subject review.
SELECT 'Q5_clobber_signature', count(*)
FROM public.users
WHERE zitadel_subject IS NOT NULL AND zitadel_subject <> ''
  AND provider_subject = id
  AND provider_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Qdup: duplicate-user symptom. Number of non-empty emails (case-insensitive) shared by
-- more than one row. Expect 0. Non-zero = JIT re-created a user under another key;
-- investigate before deleting the fallback.
SELECT 'Qdup_shared_email_groups', count(*)
FROM (
  SELECT 1 FROM public.users WHERE email <> '' GROUP BY lower(email) HAVING count(*) > 1
) d;

ROLLBACK;
