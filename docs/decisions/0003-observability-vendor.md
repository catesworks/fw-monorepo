# ADR 0003: Observability vendor (fw-2n4)

- Status: Proposed
- Date: 2026-10-01
- Bead: fw-2n4 (parent epic fw-sd6)
- Scope: fw-rolodex, fw-chorus, fw-helmsman, fw-warden, fw-yellow-pages (web, api, mobile), fw-web (apex)
- Companion: ADR 0004 (OTel conventions)

## Context

Research input: `personal/docs/observability-evaluation.md` (2026-08-01, research phase, no vendor committed). Its working recommendation: Sentry for errors and mobile crashes, plus Axiom or Grafana Cloud free tier for logs/traces/metrics, trialled in parallel.

State of the fleet on 2026-10-01 (from code, `git grep` across all fw-* repos):

- No error-tracking or telemetry SDK anywhere. Zero hits for `@sentry/*`, `@vercel/otel`, `@opentelemetry/*`, `@axiomhq/*` in any `package.json`.
- `apps/web/src/instrumentation.ts` exists in rolodex, chorus and yellow-pages, but only runs `assertValidRuntimeEnvironment()` at boot. Warden web has none (see ADR 0002 table).
- Hosting changed since the evaluation was written. Web apps are on Vercel. APIs moved off Render to CapRover on the shared Hostinger box (e.g. warden `bdc198e`, "remove dead Render deploy CI/config"). Zitadel moved off Fly to Hostinger. The evaluation's section 4.1 ("Vercel serverless, no sidecar") now applies to the web tier only; the APIs are long-lived containers.
- The Hostinger platform role already runs Uptime Kuma, Diun and netdata (`hostinger/docs/runbook.md`), so uptime and host metrics are covered. Missing: application errors, mobile crashes, request traces, structured app logs.
- Helmsman ADR 0006 already lists OTEL spans as one of six retention sinks with an owner in `docs/DATA-INVENTORY.md`, so any trace export must respect that retention rule.

Unverified inputs (recalled in the evaluation, not fetched; not re-fetched here):

- Sentry free-tier limits and Team price (evaluation recalls ~5k errors/mo free, ~$26/mo Team).
- Supabase log drains gated to Team plan (~$599/mo).
- Vercel log drains require a paid Vercel plan.

The Axiom and Grafana Cloud numbers in the evaluation were fetched on 2026-08-01 and may have changed.

## Options

| Option | Cost | Ops load | Hostinger/CapRover fit |
|---|---|---|---|
| A. Sentry SaaS (errors + mobile crashes + low-rate tracing) | Free tier, then ~Team (unverified) | None | SDK only; nothing to run on the box |
| B. A + Axiom or Grafana Cloud free tier for logs/traces | $0 at current volume (5-20 GB/mo estimated) | None | Exporter only |
| C. Self-host GlitchTip (Sentry-SDK-compatible) on CapRover | $0 cash | Postgres + Redis + workers to patch, back up and watch | Competes for RAM with ~30 services on one shared box; one more thing that goes down with the box it is meant to watch |
| D. Self-host OpenObserve / SigNoz / Grafana LGTM on CapRover | $0 cash | High (SigNoz needs ClickHouse) | Poor on a single shared VPS, same correlated-failure problem |

## Decision (proposed)

Conservative default, smallest step first:

1. **Errors and crashes: Sentry SaaS (option A), one org, one project per runtime per app** (web, api, mobile; desktop later). Start on the free tier. This is the layer that tells you a real user hit a broken flow.
2. **Do not add a second vendor yet.** Turn on Sentry tracing at a low sample rate (ADR 0004) and see if it answers the questions that come up. Run the Axiom vs Grafana Cloud trial (evaluation section 6) only when there is a concrete need Sentry does not cover, typically searchable structured logs from the CapRover APIs.
3. **Instrument against OpenTelemetry conventions (ADR 0004), not vendor-specific APIs, wherever the SDK allows.** That keeps option B a config change, not a rewrite.
4. **Do not self-host telemetry on the Hostinger box.** The thing that watches the box should not share its failure domain or its RAM. GlitchTip (option C) stays as the exit path if Sentry pricing becomes a problem, because it accepts the same SDK.
5. **No Supabase or Vercel log drains.** Instrument at the app layer instead. Revisit only if a paid plan is bought for other reasons.

## Consequences

- Monthly cost stays at $0 until Sentry's free quota is exceeded. The first paid step is Sentry Team (price to be verified).
- Five web + five API + five mobile projects is 15 Sentry projects. Whether the free tier allows that many projects and seats is **unverified** and is the first thing to check. If it does not, use one project per app with a `runtime` tag instead.
- Source-map upload needs a Sentry auth token in CI for each web app, and Expo symbolication ties into the existing fastlane lanes. Both are new secrets and follow the 1Password source-of-truth flow.
- Logs from the CapRover APIs stay in container stdout (visible via CapRover/netdata) until the second-vendor trial happens.
- Mobile: Expo + OTel is immature (evaluation 4.4), so mobile uses the Sentry React Native SDK directly.

## Before moving to Accepted

- Verify Sentry pricing, project and seat limits, and data residency at sentry.io/pricing.
- Confirm Sentry's data-scrubbing settings can enforce ADR 0004's PII rules server-side as a second layer.
- Pick one pilot app (suggest rolodex: has `instrumentation.ts`, a prod boot guard, and the most PII), wire web + api, and look at a week of real volume.
