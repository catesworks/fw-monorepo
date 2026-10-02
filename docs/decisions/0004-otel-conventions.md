# ADR 0004: OpenTelemetry conventions — service.name, PII scrubbing, sampling (fw-eif)

- Status: Accepted
- Accepted 2026-10-02; approver: the user (decision relayed by fw-beads-6e)
- Date: 2026-10-01
- Bead: fw-eif (parent epic fw-sd6)
- Scope: every fw-* runtime that will emit telemetry (web, api, mobile, desktop) and fw-web (apex)
- Companion: ADR 0003 (vendor)

## Context

No fw-* app emits telemetry today (no `@sentry/*`, `@vercel/otel` or `@opentelemetry/*` dependency in any repo, checked 2026-10-01). These three choices have to be fixed before the first app is instrumented: renaming `service.name` later splits history, and PII that reaches a third-party store cannot be pulled back.

Facts that shape the rules:

- Runtimes per app: Next.js web on Vercel, Hono API in a container on CapRover (Hostinger), Expo mobile, and in some repos a Tauri desktop app. Container images already use `fw-<app>-api` naming (e.g. warden `723686a`, "shrink fw-warden-api image").
- Stage is selected by `ENV` (`dev`, `e2e`, `prod`) through the `@cogs` runtime-env pattern; `assertValidRuntimeEnvironment()` already runs in `apps/web/src/instrumentation.ts` in rolodex, chorus and yellow-pages.
- PII in play: rolodex serves `birthDate`, `telephoneNumber`, `mail`, `workEmail` from `directory_users`; every app handles Zitadel `sub` + email in JIT provisioning; helmsman stores agent run inputs/outputs (ADR 0006 already names OTEL spans as a retention sink); auth callbacks carry `code`/`state` in the URL.
- Secrets on the wire: `Authorization` bearer tokens, session cookies, PATs (`dg_` rolodex, `wl_` warden), `x-drain-token`, `x-cogs-signature`, `TESTING_DRAIN_TOKEN`.

## Decision (proposed)

### 1. Resource attributes

| Attribute                     | Value                                                                                     | Example                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `service.namespace`           | `fleetworks`                                                                              | `fleetworks`                                                |
| `service.name`                | `fw-<app>-<runtime>`, runtime ∈ `web`, `api`, `mobile`, `desktop`. Apex site is `fw-web`. | `fw-rolodex-api`, `fw-yellow-pages-web`, `fw-chorus-mobile` |
| `service.version`             | release-please version if the package has one, else short git SHA                         | `0.2.0`, `a1b2c3d`                                          |
| `deployment.environment.name` | the `ENV` value, unchanged                                                                | `prod`, `dev`, `e2e`                                        |
| `service.instance.id`         | leave to the SDK default                                                                  |                                                             |

Rules: lowercase, hyphenated, `<app>` is the repo name without `fw-` (so `yellow-pages`, not `yp`). The name never encodes the host (Vercel, CapRover); that goes in `cloud.*`/`host.*` attributes if needed. In Sentry, project slug = `service.name`, and `environment` = `ENV`.

Background workers inside an API container (pg-boss consumers, reconcilers, drains) keep the API's `service.name` and are distinguished by span name, not a new service.

### 2. PII and secret scrubbing

Scrub in the app, before export. Vendor-side scrubbing (Sentry data scrubber) is a second layer, not the control.

Never exported, in any signal:

- Request/response bodies. Off by default; no per-route opt-in without a follow-up ADR.
- Headers `authorization`, `cookie`, `set-cookie`, `x-drain-token`, `x-cogs-signature`, `x-cogs-timestamp`, `proxy-authorization`. Allowlist headers rather than denylist: only `user-agent`, `content-type`, `content-length`, `x-request-id`, `traceparent`.
- Any string matching a token shape: `Bearer `, JWT (`eyJ` + two dots), `dg_`/`wl_` PAT prefixes. Replace with `[redacted]`.
- URL query strings on auth routes (`/auth/*`, `/embed/*`, `/oauth/*`). Keep the path, drop the query. Elsewhere, keep only allowlisted query keys (pagination, sort, filter names; not filter values that are free text).
- Rolodex directory fields: `birthDate`, `telephoneNumber`, `mail`, `workEmail`, `employeeNumber`, `objectGUID`, `distinguishedName`, SSH key material.
- Helmsman agent run `input`/`output`/`error` payloads.
- SQL parameter values. Statement text with placeholders is fine.

User identity: set the Zitadel `sub` (or local user id) as `enduser.id` / Sentry `user.id`. Never email, name, or IP. Sentry `sendDefaultPii: false`.

Error messages: errors raised from validation (Zod) can echo input. Log the issue path and code, not the received value.

Each app ships one `scrubAttributes()`/`beforeSend` hook and one unit test that feeds it a fixture containing every item above and asserts none survive. That test is the gate for turning on prod export.

### 3. Sampling

Head-based, parent-based sampling. No tail sampling: it needs a collector, and ADR 0003 rules out running one on the Hostinger box, while Vercel functions cannot host one.

| `ENV`  | Traces                                          | Errors         |
| ------ | ----------------------------------------------- | -------------- |
| `prod` | parent-based ratio **0.1**                      | 100%           |
| `dev`  | 1.0, exported only if an endpoint is configured | 100%           |
| `e2e`  | exporter off                                    | off (CI noise) |

- Always drop `/health`, `/public/health`, `/openapi.json`, Next.js static assets and the Uptime Kuma checks before sampling.
- Mobile: errors and crashes 100%, traces 0 until Expo OTel matures (ADR 0003).
- The ratio is one env var per app (e.g. `OTEL_TRACES_SAMPLER_ARG`), so it can be raised during an incident without a code change.
- Propagate W3C `traceparent` web → api. Do not propagate to Zitadel or Supabase (third parties; no value for us, and it leaks internal span ids).

## Consequences

- Names are fixed now; dashboards and alerts can key on `service.name` from day one.
- At a 10% rate rare slow requests can be missed; errors are still 100%. Raise the rate for one app via env var if that bites.
- The scrubber test is new work in each repo (about one file plus one test). Prod export stays off until it passes.
- `enduser.id` is a pseudonymous id, still personal data under GDPR; retention follows helmsman's `docs/DATA-INVENTORY.md` pattern and the vendor's retention setting.

## Open

- Whether `@vercel/otel` flushes before function freeze on all route shapes (evaluation 4.1). Test on the pilot app.
- Desktop (Tauri) apps: include once any desktop app has real users.
