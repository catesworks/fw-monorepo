-- ADR 0005 read-only production queries: fw-chorus database (chorus-api DATABASE_URL)
-- SELECT-only, counts/aggregates only. No emails, names or ids are selected.
-- Run: see README.md (credential only in the single psql command's environment).
-- Output (psql -At): one line per query, "<tag>|<count>".
-- Schema source: fw-chorus/packages/db/src/schema.ts (users.provider_subject text NULL, no zitadel_subject)
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

-- Q0: sanity. Total users rows. 0 or an error means wrong database.
SELECT 'Q0_total', count(*) FROM public.users;

-- Q1: rows the id===sub fallback could still be the only path to (provider_subject
-- unset: NULL or empty). Expect 0.
-- Outcome: 0 = no row relies on the id lookup to get its provider_subject backfilled.
-- >0 = such a row exists; deleting the fallback would re-create it under a new
-- identity and orphan its memberships. Part of the delete rule (Q1 AND Q3 == 0).
SELECT 'Q1_provider_subject_unset', count(*)
FROM public.users
WHERE provider_subject IS NULL OR provider_subject = '';

-- Q3: rows whose id differs from provider_subject AND whose id is not uuid-shaped
-- (id equals a Zitadel sub but provider_subject disagrees, the exact case the
-- fallback fires on). Expect 0. Uses IS DISTINCT FROM, so a NULL provider_subject
-- is counted here too (the ADR text's "<>" silently skips NULLs).
-- Outcome: 0 = no row is reachable only through id===sub. Part of the delete rule.
SELECT 'Q3_id_differs_nonuuid_id', count(*)
FROM public.users
WHERE id IS DISTINCT FROM provider_subject
  AND id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Q2: rows never re-keyed to a Zitadel sub (provider_subject still uuid-shaped,
-- i.e. a Supabase sub). Zitadel subs are numeric strings.
-- Outcome: informational, NOT part of the delete rule. Non-zero = users who have
-- not logged in since the cutover (or inactive accounts). Their id is a Supabase
-- uuid, so the id===sub fallback cannot rescue them for a Zitadel token; they need
-- a provider_subject rewrite or must accept re-provisioning.
SELECT 'Q2_provider_subject_uuid_shaped', count(*)
FROM public.users
WHERE provider_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Qdup: duplicate-user symptom. Number of non-empty emails (case-insensitive)
-- shared by more than one row. Expect 0. Non-zero = JIT re-created a user that
-- already existed under another key; investigate before deleting the fallback.
SELECT 'Qdup_shared_email_groups', count(*)
FROM (
  SELECT 1 FROM public.users WHERE email <> '' GROUP BY lower(email) HAVING count(*) > 1
) d;

ROLLBACK;
