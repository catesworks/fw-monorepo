-- OPTIONAL, separate from the ADR 0005 Q1-Q4 decision. Run only if the SCIM
-- externalId / employeeNumber policy question needs sizing.
-- Context (infra/zitadel-local/scim-findings.md): Zitadel SCIM does not store the
-- enterprise employeeNumber (tier 1 of the match ladder does not exist) and SCIM
-- PATCH/PUT from a customer IdP overwrites or deletes externalId. The reconciler now
-- matches by tier email / sam / manual (ZITADEL_MATCH_TIERS). externalId and
-- employeeNumber live in Zitadel metadata, not in this DB, so this DB can only size
-- how many directory users would depend on each tier. Counts only.
-- Needs migration 0014_zitadel_directory_links applied; a missing table aborts the
-- run (ON_ERROR_STOP) with a clean error and nothing is written.
-- Output (psql -At): "<tag>|<link_state>|<match_tier>|<count>" for S1, "<tag>|<count>" otherwise.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

-- S1: Zitadel users linked to the directory, by link_state and match_tier.
-- Outcome: the 'email'/'sam' counts are users whose link survives without
-- employeeNumber or externalId (unaffected by the policy). 'manual' links are
-- operator-resolved and also independent of externalId. 'unmatched'/'ambiguous'
-- are the population that a stable external key (externalId) would have helped,
-- i.e. the users the policy decision affects most.
SELECT 'S1_links', link_state, coalesce(match_tier, 'none'), count(*)
FROM public.zitadel_directory_links
GROUP BY link_state, match_tier
ORDER BY link_state, match_tier;

-- S2: directory users total, and those carrying a populated employee_number.
-- Outcome: employee_number is the directory-side value a tier 1 would have matched.
-- with_employee_number = how many directory users could have matched via tier 1;
-- since Zitadel cannot store it, these must match by email/sam or manually.
SELECT 'S2_directory_users_total', count(*) FROM public.directory_users;
SELECT 'S2_with_employee_number', count(*)
FROM public.directory_users
WHERE employee_number IS NOT NULL AND employee_number <> '';

-- S3: directory users that the email tier cannot match (no mail and no work_email).
-- Outcome: these depend on sam/manual only; they are the users at risk if the email
-- tier is also weakened. Expect small.
SELECT 'S3_directory_users_no_email', count(*)
FROM public.directory_users
WHERE coalesce(mail, '') = '' AND coalesce(work_email, '') = '';

ROLLBACK;
