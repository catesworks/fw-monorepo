# ADR 0005 read-only production queries (fw-k4iu)

Queries for the "Checklist: removing legacy subject matching" in
[../0005-supabase-auth-decommission.md](../0005-supabase-auth-decommission.md).
**Run 2026-10-02 by the coordinator (results in the ADR).** Every file is a single
`BEGIN READ ONLY` transaction (`statement_timeout` 10s, `lock_timeout` 1s) that ends in
`ROLLBACK` and prints counts only: no emails, names, ids or tokens.

## Which DB for which query

| Query                                          | chorus           | rolodex                | helmsman           | Meaning                                                              |
| ---------------------------------------------- | ---------------- | ---------------------- | ------------------ | -------------------------------------------------------------------- |
| Q1 provider_subject unset                      | yes              | yes (+ Q1r refinement) | yes (empty string) | rows only the `id === sub` fallback can reach                        |
| Q2 provider_subject uuid-shaped                | yes              | yes                    | yes                | informational: never re-keyed to a Zitadel sub                       |
| Q3 id differs from provider_subject, non-uuid  | yes              | yes (precise variant)  | yes                | the exact case the fallback fires on                                 |
| Q4 zitadel_subject unset                       | not relevant     | yes                    | not relevant       | no `zitadel_subject` column in chorus or helmsman                    |
| Q5 backfill-clobber signature                  | not relevant     | yes                    | not relevant       | rolodex has two keys; see below                                      |
| Qdup shared emails                             | yes              | yes                    | yes                | duplicate-user symptom                                               |
| Optional SCIM sizing (`rolodex.scim-optional`) | not relevant     | yes                    | not relevant       | the only DB with directory/link tables; chorus/helmsman have no SCIM |
| fw-yellow-pages, fw-warden                     | not in this task | not in this task       |                    | yellow-pages has no users-table correlation; warden is blocked       |

Decision rule (ADR): delete the `id === sub` branch in a repo only if **Q1 and Q3 are
both 0** in that repo's production DB. In rolodex use **Q1r and Q3** (the middleware
looks up `zitadel_subject` first, so a row with `provider_subject` NULL but a matching
`zitadel_subject` is not fallback-only; literal Q1 and Q3a are printed for comparison).
Q3 here uses `IS DISTINCT FROM`, so NULL `provider_subject` rows are counted (the ADR
text's `<>` skips NULLs); in chorus a NULL row therefore shows up in both Q1 and Q3.
Q2, Q4, Q5 and Qdup are informational and do not gate deletion.

## Rolodex backfill guard (fw-k4iu / fw-7til)

The bead text says the rolodex backfill at `middleware.ts` ~195 is unguarded. At the
repo head it is already compare-and-set (`WHERE id = sub AND provider_subject IS NULL`,
and it throws `SubjectConflictError` for a row bound to another subject), so no code
fix is needed at head. What is unknown is whether production runs a build that has it.
Q5 counts the data signature an unguarded backfill leaves behind (a row with
`zitadel_subject` set whose `provider_subject` is again its own uuid `id`). Q5 > 0 is
not proof (a Supabase-era row later given a `zitadel_subject` looks the same); it means
review those rows by hand. Deleting the fallback removes the clobbering UPDATE entirely.

## Files

- `chorus.sql`, `helmsman.sql`, `rolodex.sql`: Q0 (sanity row count), Q1-Q3 variants, Qdup.
- `rolodex.scim-optional.sql`: **optional, separate** from Q1-Q4. Sizes the SCIM
  `externalId` / `employeeNumber` policy question: links by `link_state`/`match_tier`,
  directory users with an `employee_number`, directory users with no email. Counts only.
  `externalId` and `employeeNumber` are not stored in any of these DBs (Zitadel SCIM
  keeps `externalId` as user metadata and drops `employeeNumber`; see
  `infra/zitadel-local/scim-findings.md`), so this can only show how many directory
  users depend on each match tier. It needs rolodex migration 0014 applied; if the
  table is missing the run stops with an error and writes nothing.

## Credential reference (names only, nothing was read or run)

The three prod databases are the Supabase Postgres projects behind each API service.
Each API's `DATABASE_URL` lives in the 1Password vault `app-secrets`, in the item named
by the repo's `secrets.manifest.yml` `source:` plus the env suffix (env-sync convention
`<source>/<env>`, field name = env var name):

| DB       | Vault         | Item title (inferred)           | Field          | op:// reference                                               |
| -------- | ------------- | ------------------------------- | -------------- | ------------------------------------------------------------- |
| chorus   | `app-secrets` | `fw-chorus/chorus-api/prod`     | `DATABASE_URL` | `op://app-secrets/fw-chorus/chorus-api/prod/DATABASE_URL`     |
| rolodex  | `app-secrets` | `fw-rolodex/rolodex-api/prod`   | `DATABASE_URL` | `op://app-secrets/fw-rolodex/rolodex-api/prod/DATABASE_URL`   |
| helmsman | `app-secrets` | `fw-helmsman/helmsman-api/prod` | `DATABASE_URL` | `op://app-secrets/fw-helmsman/helmsman-api/prod/DATABASE_URL` |

**Unknowns (not determinable from docs, ask the owner / check in the 1Password UI):**

- The exact env suffix of the item (`prod` is the env-sync convention; no doc names the
  literal item for these three). The item titles contain `/`, which `op://` parsing may
  reject (`op read` returned empty); use the `op item get` form below (env-sync itself reads
  items with `op item get --vault <vault> -- <item>`).
- That the `*-api` item actually holds a `DATABASE_URL` field (the manifests do not list
  field names) and that it points at the production project.
- Which role it connects as and which pooler port. fw-chorus's runbook shows the
  transaction pooler (`:6543`) for `DATABASE_URL` and the session pooler (`:5432`) for
  `DATABASE_URL_DIRECT`; `BEGIN` / `SET LOCAL` work on both, since the whole file is one
  transaction.

**Read-only role: none is documented in any of these repos or in the portfolio docs.**
The only credential found is the app's own `DATABASE_URL` (a `postgres.<ref>` owner-level
Supabase role per the chorus runbook). The queries are still safe on it: `BEGIN READ ONLY`
makes any write fail. Recommended owner follow-up: create a dedicated `SELECT`-only role
(for example `adr0005_ro` with `GRANT SELECT ON public.users` and, for the optional
rolodex block, `zitadel_directory_links` and `directory_users`), store its URL as a
separate `DATABASE_URL_RO` field, and switch to it.

## Exact invocation

The credential must exist only in the environment of the single command, never be echoed,
and `set -x` must not be on. Do **not** write `DATABASE_URL=... psql "$DATABASE_URL"`:
the shell expands `"$DATABASE_URL"` before the assignment takes effect, so psql would get
an empty argument and silently connect to a local socket. Wrap psql in `sh -c` so the
expansion happens inside the command's environment. `-X` skips `~/.psqlrc`; no `-a`/`-e`
flags (they would echo statements); `-q` hides the `BEGIN`/`SET`/`ROLLBACK` tags.

Confirmed working 2026-10-02. `op read` returned empty for these items because the item
titles contain `/`, so use `op item get` (flags **before** the `--`, item title after it):

```bash
cd docs/decisions/0005-read-only-queries
DATABASE_URL="$(op item get --vault app-secrets --fields label=DATABASE_URL --reveal -- 'fw-chorus/chorus-api/prod')" \
  sh -c 'psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -At -f "$0"' chorus.sql
```

Per DB, change the item and the file:

| DB       | item (vault `app-secrets`, field label `DATABASE_URL`) | file                                                  |
| -------- | ------------------------------------------------------ | ----------------------------------------------------- |
| chorus   | `fw-chorus/chorus-api/prod`                            | `chorus.sql`                                          |
| rolodex  | `fw-rolodex/rolodex-api/prod`                          | `rolodex.sql`, optionally `rolodex.scim-optional.sql` |
| helmsman | `fw-helmsman/helmsman-api/prod`                        | `helmsman.sql`                                        |

Never print or echo the value; paste only the count lines back, never the connection string. If `op` is rate limited,
retry; do not rotate tokens.

## Output format and how to read it

`psql -At` prints one line per query, `<tag>|<count>` (the optional file prints
`S1_links|<link_state>|<match_tier>|<count>`). Example shape (stub data, not real):

```text
Q0_total|4
Q1_provider_subject_unset|1
Q3_id_differs_nonuuid_id|2
Q2_provider_subject_uuid_shaped|1
Qdup_shared_email_groups|0
```

| Tag                     | Expect         | If non-zero                                                                          |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `Q0_total`              | greater than 0 | 0 means wrong database                                                               |
| `Q1_*`, `Q1r_*`, `Q3_*` | 0              | the fallback is still load-bearing for that many rows: do **not** delete it          |
| `Q3a_adr_literal`       | any            | informational (rolodex): over-counts rows found by `zitadel_subject` first           |
| `Q2_*`                  | any            | users not logged in since cutover: plan a `provider_subject` rewrite or re-provision |
| `Q4_*`                  | any            | rolodex users without a Zitadel correlation yet                                      |
| `Q5_*`                  | 0              | review those rows by hand, and check the deployed build has the guard                |
| `Qdup_*`                | 0              | JIT created duplicate users; investigate before changing middleware                  |

A statement error or timeout aborts the run (`ON_ERROR_STOP`), and the transaction is
rolled back when the connection closes. Nothing is ever written.

## Validation done

Each file was run against a throwaway `postgres:16-alpine` container on a random
localhost port (no other database), against stub `users` (and for the optional file
`zitadel_directory_links`, `directory_users`) tables shaped like each repo's
`schema.ts` with a few made-up rows: all four files exited 0 and printed the lines
above; an `INSERT` inside a `BEGIN READ ONLY` transaction was rejected; a grep for
`INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT` outside comments finds nothing.
The container was removed afterwards. Not validated against any real database.
