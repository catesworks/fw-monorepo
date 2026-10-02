# Force-SSO gate: operations, fail mode and rollout runbook (fw-uwku)

Artifacts: `force-sso-gate/gate.mjs` (webhook service), `force-sso-gate/terraform/`
(target + 8 executions), `force-sso-gate/gate.test.mjs` (unit), `force-sso-gate/e2e-local.mjs`
(local Zitadel). Design and proof: `force-sso-enforcement-findings.md`.
Decision: Zitadel Actions V2 "two-part gate" (session gate + finalize gate), chosen by the owner.

**Status: nothing here is applied to production or any shared system.** The prod apply remains
needs-user (bead fw-uwku stays open). Tested only as unit tests and against the local stack.

## Behaviour summary

- One HTTPS endpoint, `POST /force-sso`, receives both gates (routed by `fullMethod`).
- Verifies `ZITADEL-Signature` (`t=<unix>,v1=<hex HMAC-SHA256(signingKey, "<t>.<raw body>")>`):
  constant-time compare over every configured key (rotation), timestamp window 300 s.
  A bad, missing or stale signature is always 401, in every mode.
- Session gate: password check for a user in an org with `allowUsernamePassword != true` -> deny.
- Finalize gate: session with no authentication factor -> deny in every org; in a force-SSO org
  also deny unless it has an allowed factor (`GATE_FORCE_SSO_FACTORS`, default `intent`).
- Unknown `fullMethod` -> deny. Request bodies (they contain plaintext passwords) are never logged.
- Secrets are read from files at start (`ZITADEL_PAT_FILE`, `GATE_SIGNING_KEY_FILE`); none are committed.
- Dev guard: binds `127.0.0.1` by default. A non-loopback bind requires TLS files
  (`GATE_TLS_CERT_FILE`/`GATE_TLS_KEY_FILE`) or an explicit `GATE_BEHIND_TLS_PROXY=1`.
  `ZITADEL_URL` must be https unless it is localhost.
- Lookup PAT: an **IAM_OWNER_VIEWER** machine user (proven sufficient). Never an IAM_OWNER or
  IAM_LOGIN_CLIENT PAT.
- `GET /healthz` (process up, mode, counters) and `GET /readyz` (a real Zitadel lookup succeeds).

Tests, from `infra/zitadel-local`: `npm run test:gate` (no Zitadel needed) and `npm run e2e:gate`
(local stack on :8089; creates and removes two `fw-uwku-gate-*` orgs;
`node force-sso-gate/e2e-local.mjs cleanup` removes leftovers). The e2e does not register any
execution: executions are instance-wide, and the shared stack's denylist rejects localhost targets.
It feeds the gate signed payloads and lets the gate do its real lookups against the local Zitadel.

## Fail-open vs fail-closed

`GATE_FAIL_MODE` covers only the case where the gate cannot decide because a lookup failed
(Zitadel unreachable, 5xx, timeout, unexpected error). Separately, if the **gate itself** is down,
Zitadel applies the target's `interrupt_on_error`: `true` blocks the call (fail closed), `false`
ignores the target (fail open). Keep both consistent.

| Aspect                    | Fail-closed (default)                                                                | Fail-open                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Gate or lookup outage     | Every `CreateSession` and callback fails, **including password-org and SSO logins**  | Logins keep working, **unenforced** while down                               |
| Security during outage    | Holds: force-SSO and the credential-less-session block stay enforced                 | Gone: any IAM_LOGIN_CLIENT/IAM_OWNER credential can again impersonate anyone |
| Customer impact           | Total login outage until the gate recovers (all orgs: the target is instance-wide)   | None visible; silent exposure                                                |
| Detectability             | Loud (login errors, 5xx)                                                             | Silent unless alerted on `lookup-error-fail-open` log lines                  |
| Error text to API callers | Zitadel puts the target URL in the 500 on connect errors (findings): not secret-free | n/a                                                                          |
| Right when                | Force-SSO is a contractual/security promise; you have HA and on-call                 | Availability outranks enforcement and the window is bounded and alerted      |

**Recommended default: fail-closed, with the HA and monitoring below, and break-glass.** Fail-open
re-opens exactly the hole the gate exists to close, so use it only as a time-boxed, alerted,
owner-approved incident switch (`GATE_FAIL_MODE=open` plus `interrupt_on_error=false`), then revert.
Rollout stage 0 runs the gate in shadow, which is effectively fail-open by design.

## HA and monitoring

When the gate is down and fail-closed, **no one logs in** (instance-wide, not just force-SSO orgs,
because a user-only `CreateSession` also hits the target). Operate it as part of the IdP:

- **Redundancy:** at least 2 replicas in different failure domains behind one load balancer and one
  stable HTTPS URL. The service is stateless (no shared state, no cache), so scale horizontally.
  Run it in the same region as Zitadel; no scale-to-zero, no free-tier idling, not on a dev box.
- **Timeouts:** gate to Zitadel lookups 3 s (`makeLookup`); Zitadel to gate 5 s (`timeout` in
  terraform; keep it larger than the lookup timeout so the gate answers via its own fail mode).
  Each login pays one extra round trip plus 1 to 3 lookups; measure p95 in the shadow stage.
- **Retry:** Zitadel does not retry a failed target call, and the gate does not retry lookups (a
  retry inside the budget only delays the same deny). Rely on replicas plus the load balancer's
  retry-on-connect-failure to the next replica. Known ceiling: no cache, so Zitadel sees about
  3 reads per login; add a short TTL cache of `allowsPassword(orgId)` if that shows in its metrics.
- **Health checks:** LB checks `/healthz` (liveness, cheap) and `/readyz` (needs Zitadel and a valid
  viewer PAT); pull a replica on `/readyz` failure. An external synthetic check runs a signed round
  trip or a real test login every minute.
- **Alerting, page:** all replicas not ready; `lookup-error-*` log events above a small rate; a
  `bad-signature` burst (key drift after rotation, or probing); login success rate drop; gate p95
  above 2 s. **Ticket:** `GATE_MODE=shadow`, `GATE_FAIL_MODE=open` or `interrupt_on_error=false` in
  production beyond the planned window; `shadowWouldDeny` (`/healthz`) rising.
- **Key and PAT rotation:** add the new signing key as a second line in `GATE_SIGNING_KEY_FILE` (the
  gate accepts any listed key), rotate in Zitadel (target `expiration_signing_key` keeps the old key
  valid for the overlap), then drop the old line. Rotate the viewer PAT on the admin-credential schedule.
- **Break-glass** (owner-approved, logged, does not depend on the gate), fastest first:
  1. `GATE_FAIL_MODE=open` and redeploy the gate (minutes).
  2. `terraform apply -var interrupt_on_error=false` (Zitadel ignores a failing target).
  3. Remove the 8 executions (`ActionService/SetExecution` with empty `targets`), which takes the gate
     out of the path entirely.
     Reverse after recovery and record it. Confirm during the shadow stage that an IAM owner can still
     sign in to the Console while the gate is down (not assumed here); keep that owner credential
     outside the gate's dependency chain.
- **State and secrets:** the signing key is in Terraform state: encrypted remote backend, restricted access.

## Rollout runbook (proposal; NOT applied to production)

Owner approval is required before each stage. Roles: operator (applies) and a second person
(reviews the plan output, watches the dashboards). Preconditions: ADR 0001 amendment read; the mint
routes moved to a dedicated IAM_LOGIN_CLIENT test-mint user (findings recommendations 2-3); two
gate replicas deployed behind HTTPS with `/readyz` green; alerts above wired; viewer PAT and
signing key in the secret store.

**Stage 0: shadow / log-only (at least 7 days, no enforcement)**

1. `terraform plan`, review (1 target + 8 executions, nothing else) with `interrupt_on_error = false`;
   gate `GATE_MODE=shadow`.
2. Apply. Expect every login to succeed. The gate logs a verdict per call.
3. Review the log: each `deny` must be an expected force-SSO password attempt or the credential-less
   session pattern. Unexpected denies (Login UI's own sessions, mint routes, device flow, SAML-SP
   finalize, passkey/OTP sessions; all **unproven** in the findings) are fixed in the gate first.
4. Proceed only if: 0 unexplained would-deny verdicts for 7 days; gate p95 under 500 ms and p99
   under 2 s; 0 `lookup-error` events outside a drill; login success rate unchanged versus the
   previous 7 days (within noise); a failover drill (kill one replica) causes no failed logins.

**Stage 1: enforce on ONE low-risk org (7 day soak)**

1. Pick one internal or test org, not a customer. Set `GATE_SCOPE_ORG_IDS=<org id>`,
   `GATE_MODE=enforce`, `GATE_FAIL_MODE=closed`; terraform `interrupt_on_error = true`.
   The scoped mode still denies credential-less sessions in every org (that rule is global); stage 0
   must have shown none were legitimate.
2. Verify with that org's users: password login blocked once the org is force-SSO, SSO login works,
   the mint routes (Fleetworks org, passwords allowed) still mint.
3. Metrics: those of stage 0, plus 0 customer-visible login errors, 0 support tickets attributable
   to the gate, `/readyz` availability of 99.9 percent, and a proven paging pipeline (drill: stop one
   replica, then both in a maintenance window; confirm the page and the break-glass time).

**Stage 2: all orgs.** Unset `GATE_SCOPE_ORG_IDS`. Record the passkey/OTP policy decision first
(`GATE_FORCE_SSO_FACTORS`). Offer force-SSO to customers only after 14 days of soak.

**Rollback (any stage), fastest first**

1. `GATE_FAIL_MODE=open` or `GATE_MODE=shadow`, redeploy the gate (minutes; the gate still answers).
2. `terraform apply -var interrupt_on_error=false`.
3. Remove the executions: `terraform destroy -target 'zitadel_action_execution_request.gate'`
   (or `SetExecution` with empty targets per method). The gate leaves the login path.
4. `terraform destroy` the target.

Rollback restores pre-gate behaviour, including the known impersonation hole, so follow it with the
PAT hygiene items (findings recommendations 2-3).

**Not proven yet (check in stage 0):** hosted Login UI v2 through the gates; device flow and SAML-SP
finalize paths actually exercised; passkey/OTP sessions; a network/path restriction; behaviour under
target latency; the `AuthorizeOrDenyDeviceAuthorization` and `CreateResponse` request shape (assumed
to carry `session.{sessionId,sessionToken}` like `CreateCallback`).
