# Force-SSO enforcement: who can bypass it, and an Actions V2 gate that closes it (fw-xw4, 2026-10-01, Zitadel v4.17.1)

Follows up the force-SSO paragraph in `saml-brokering-findings.md` (fw-mf9).
That doc showed that an org login policy with `allowUsernamePassword: false`
is enforced by the hosted Login UI only, and that the Session API still
creates password sessions for users in that org.

## Summary

- **The hole is bigger than force-SSO.** A credential that can call
  `SessionService/CreateSession` together with one that can call
  `OIDCService/CreateCallback` can get tokens for **any user in any org with
  no credential at all.** A session with only `checks.user` is enough:
  `CreateCallback` accepts it and `/oauth/v2/token` returns tokens. The
  `id_token` has the victim's `sub`, no `amr` and no `auth_time`, and
  userinfo works. Bypassing force-SSO with a password is the smaller problem.
- **Who can do it (proven).**
  - `CreateSession`: only `IAM_LOGIN_CLIENT` and `IAM_OWNER`.
  - `CreateCallback`: only `IAM_LOGIN_CLIENT`. `IAM_OWNER` gets 403 here, but
    an IAM owner can grant itself any role, so the difference only matters
    for accidents, not for an attacker.
  - Every org-level role, other IAM roles and end-user tokens are refused.
- **An Actions V2 gate closes both holes (proven).** It uses request
  executions with `restWebhook` targets, `interruptOnError: true`.
  - **Session gate** on `SessionService/CreateSession` and `SetSession`, v2
    and v2beta: deny any password check for a user whose org has
    `allowUsernamePassword: false`.
  - **Finalize gate** on `OIDCService/CreateCallback` (v2 and v2beta),
    `AuthorizeOrDenyDeviceAuthorization` and `SAMLService/CreateResponse`:
    deny sessions that have no authentication factor. For force-SSO orgs,
    also deny sessions without an IdP `intent` factor.
  - Results:
    - Password logins in force-SSO orgs are blocked on every transport
      (Connect RPC v2/v2beta, REST `/v2/sessions`, `/v2beta/sessions`,
      `/v2/oidc/auth_requests/{id}`).
    - Credential-less sessions can no longer be turned into tokens.
    - SAML logins into a force-SSO org still work (the `saml-broker-demo.sh`
      flow passes).
    - Password logins in normal orgs still work, including the apps'
      mint-route call pattern.
- **Function executions cannot do this.** The `preuserinfo` payload has no
  session, auth method or `amr`, so it cannot tell a password login from an
  SSO login.
- **The gate fails closed.** If the target is down, every `CreateSession`
  fails with 500, SSO logins included. It must be operated like part of the
  IdP.

## Setup (throwaway, torn down)

The shared `fleetworks-zitadel` stack (`:8089`) was **not used at all**. That
includes the read-only calls.

- A second v4.17.1 instance ran as compose project `fwxw4-zt`. It had its own
  Postgres and named volume, and the API published on `127.0.0.1:18289`. There
  was no proxy or Login UI.
- `ZITADEL_HTTPCLIENT_DENYLIST: 192.0.2.1`, as in fw-mf9, so that a target on
  `host.docker.internal` is allowed. FIRSTINSTANCE created `seed-bot` (IAM_OWNER
  plus ORG_OWNER of the default org) and `login-client` (IAM_LOGIN_CLIENT).
- Test data:
  - org `xw4-sso-*` with `allowUsernamePassword:false`, and user
    `alice@xw4sso.example` with a password;
  - org `xw4-pw-*` on the default policy (passwords allowed), and user
    `bob@xw4pw.example`;
  - one project and a public PKCE web client;
  - nine machine users with the roles listed below, each with its own PAT.
- Webhook receiver: a dependency-free Node `http` server on
  `127.0.0.1:18290`. It verified `ZITADEL-Signature`
  (HMAC-SHA256 over `"<t>.<body>"` with each target's `signingKey`) and logged
  verdicts with `password` fields redacted. It did its lookups with its own
  **IAM_OWNER_VIEWER** PAT, which was enough for `GetSession`, `GetUserByID`,
  `ListUsers` and `GetLoginSettings`.

## (1) Credential matrix: `CreateSession` with `checks.user` and `checks.password`

Each row calls `zitadel.session.v2.SessionService/CreateSession`
`{"checks":{"user":{"loginName":…},"password":{"password":…}}}` with the given
bearer. alice is in the force-SSO org and bob is in the password org; both
gave the same result in every row. "Own CreateCallback" means the same
credential then finished an OIDC auth request with that session.

| Caller                                                                      | CreateSession (alice / bob)                | Own CreateCallback | Tokens via login-client CreateCallback |
| --------------------------------------------------------------------------- | ------------------------------------------ | ------------------ | -------------------------------------- |
| bootstrap `login-client` (IAM_LOGIN_CLIENT)                                 | 200 / 200                                  | OK                 | 200, `amr=["pwd"]`                     |
| extra machine user with IAM_LOGIN_CLIENT                                    | 200 / 200                                  | **OK**             | 200, `amr=["pwd"]`                     |
| `seed-bot` (IAM_OWNER + ORG_OWNER default org)                              | 200 / 200                                  | 403 AUTH-AWfge     | 200, `amr=["pwd"]`                     |
| machine user with IAM_OWNER only                                            | 200 / 200                                  | 403 AUTH-AWfge     | 200, `amr=["pwd"]`                     |
| IAM_OWNER_VIEWER / IAM_USER_MANAGER / IAM_ORG_MANAGER                       | 403 `No matching permissions` (AUTH-AWfge) | n/a                | n/a                                    |
| ORG_OWNER or ORG_USER_MANAGER **of alice's own org**                        | 404 `membership not found` (AUTHZ-cdgFk)   | n/a                | n/a                                    |
| ORG_OWNER of the default org                                                | 404 AUTHZ-cdgFk                            | n/a                | n/a                                    |
| machine user with no roles                                                  | 404 AUTHZ-cdgFk                            | n/a                | n/a                                    |
| end-user access token (bob), scope `openid profile email`                   | 401 `Errors.Token.Invalid`                 | n/a                | n/a                                    |
| end-user access token (bob), + `urn:zitadel:iam:org:project:id:zitadel:aud` | 404 AUTHZ-cdgFk                            | n/a                | n/a                                    |
| no `Authorization` header                                                   | 401                                        | n/a                | n/a                                    |

Also proven with the login-client PAT and no gate:

- Two steps work too: `CreateSession {checks:{user}}`, then `SetSession
{sessionId, checks:{password}}`. Both return 200.
- The REST gateway works too: `POST /v2/sessions` returns 201.
- **A credential-less session yields tokens.** `CreateSession {checks:{user:{loginName}}}`
  produces a session whose only factor is `user`. `CreateCallback` with it,
  then `/oauth/v2/token`, returns 200. The `id_token` `sub` is alice's id, with
  no `amr` and no `auth_time`, and `/oidc/v1/userinfo` returns her email.
  This holds for both the `login-client` and the `seed-bot`-created session.

What this means:

- "Can create a session" means IAM_LOGIN_CLIENT or IAM_OWNER. "Can get
  tokens" means IAM_LOGIN_CLIENT; IAM_OWNER can get there too, by granting
  itself the role.
- No org-scoped role can do either, so the capability cannot be limited to
  one org.
- A normal end user cannot do either.

## (2) Actions V2 gate

Discovery (`ActionService/ListExecutionMethods`, `ListExecutionFunctions`):

- Session methods exist in **both** `zitadel.session.v2` and
  `zitadel.session.v2beta`. Both must be gated, or v2beta is a bypass.
- Finalize methods: `/zitadel.oidc.v2.OIDCService/CreateCallback`,
  `/zitadel.oidc.v2beta.OIDCService/CreateCallback`,
  `/zitadel.oidc.v2.OIDCService/AuthorizeOrDenyDeviceAuthorization`,
  `/zitadel.saml.v2.SAMLService/CreateResponse`.
- Functions: `preuserinfo`, `preaccesstoken`, `presamlresponse`.
- There is no "pre-authentication" function in Actions V2.

### Request shapes (no secrets)

```text
seed RPC zitadel.action.v2.ActionService/CreateTarget
     {"name":"<n>","restWebhook":{"interruptOnError":true},
      "endpoint":"https://<gate-host>/force-sso","timeout":"10s"}   -> {id, signingKey}
seed RPC zitadel.action.v2.ActionService/SetExecution     (one per method; method-level, NOT service-level)
     {"condition":{"request":{"method":"/zitadel.session.v2.SessionService/CreateSession"}},"targets":["<id>"]}
     … same for /zitadel.session.v2.SessionService/SetSession,
       /zitadel.session.v2beta.SessionService/CreateSession, /zitadel.session.v2beta.SessionService/SetSession
     {"condition":{"request":{"method":"/zitadel.oidc.v2.OIDCService/CreateCallback"}},"targets":["<finalizeId>"]}
     … same for /zitadel.oidc.v2beta.OIDCService/CreateCallback,
       /zitadel.oidc.v2.OIDCService/AuthorizeOrDenyDeviceAuthorization, /zitadel.saml.v2.SAMLService/CreateResponse

target receives  POST, header ZITADEL-Signature: t=<unix>,v1=<hex HMAC-SHA256(signingKey, "<t>.<raw body>")>
     {"fullMethod":"/zitadel.session.v2.SessionService/CreateSession","instanceID","orgID","userID",  (orgID/userID = CALLER)
      "request":{"checks":{"user":{"loginName"|"userId"},"password":{"password":"<plaintext>"}}}, "headers":{…}}
     SetSession: "request":{"sessionId","checks":{"password":{…}}}
     CreateCallback: "request":{"authRequestId","session":{"sessionId","sessionToken"}}   (or "error":{…} on deny paths)

gate lookups (IAM_OWNER_VIEWER PAT)
     zitadel.user.v2.UserService/ListUsers {"queries":[{"loginNameQuery":{"loginName","method":"TEXT_QUERY_METHOD_EQUALS"}}]}
     zitadel.user.v2.UserService/GetUserByID {"userId"}                  -> user.details.resourceOwner
     zitadel.session.v2.SessionService/GetSession {"sessionId","sessionToken"} -> session.factors.{user.organizationId,password,intent,webAuthN,totp,otpSms,otpEmail}
     zitadel.settings.v2.SettingsService/GetLoginSettings {"ctx":{"orgId"}} -> settings.allowUsernamePassword (absent = false)

gate verdict  2xx = allow; any non-2xx = deny. The caller sees HTTP 400 "Execution failed (EXEC-dra6yamk98)";
              the target's own error body is not forwarded.
```

Gate logic:

- **Session gate.**
  - No `checks.password`: allow.
  - Otherwise resolve the user's org. Use `checks.user.userId` or
    `checks.user.loginName`; for `SetSession` without `checks.user`, use
    `GetSession(sessionId)`.
  - If the org cannot be resolved, deny.
  - If `allowUsernamePassword` is not `true`, deny.
- **Finalize gate.**
  - No `session` (the error/deny path): allow.
  - Otherwise call `GetSession`. Deny if it cannot be read, or if it has none
    of `password`, `intent`, `webAuthN`, `totp`, `otpSms`, `otpEmail`.
  - Deny if the user's org is force-SSO and the session has no `intent`.
- Signature mismatch: 401, which is a deny.

### Proven with the gate active

All 36 cases were run twice, once with the `login-client` PAT and once with
the `seed-bot` PAT, with identical results:

| Call (alice = force-SSO org, bob = password org)    | alice                   | bob |
| --------------------------------------------------- | ----------------------- | --- |
| v2 `CreateSession` loginName + password             | **400 EXEC-dra6yamk98** | 200 |
| v2 `CreateSession` userId + password                | **400**                 | 200 |
| v2 `CreateSession` user only                        | 200                     | 200 |
| v2 `SetSession` + password (after user-only create) | **400**                 | 200 |
| v2beta `CreateSession` loginName + password         | **400**                 | 200 |
| v2beta `SetSession` + password                      | **400**                 | 200 |
| REST `POST /v2/sessions` + password                 | **400**                 | 201 |
| REST `POST /v2beta/sessions` + password             | **400**                 | 201 |

Finalize gate:

- User-only session, then v2 `CreateCallback`: **400**. The gate log says
  `deny:no-authn-factor`, for sessions from both `login-client` and
  `seed-bot`.
- The same session via v2beta `CreateCallback` and via REST `POST
/v2/oidc/auth_requests/{id}`: **400** both times.
- Mint-route analogue (bob): `seed-bot` `CreateSession`(password), then
  `login-client` `CreateCallback`, then token. Token 200, `amr=["pwd"]`. The
  gate log says `allow` with factors `user+password`.

**SAML into a force-SSO org still works.**

- Run: a `/tmp` copy of `saml-broker-demo.sh` whose step-3 org policy was
  changed to `allowUsernamePassword:false`, so the org is force-SSO from the
  start. It ran against the throwaway instance with both gates on and printed
  `PASS`.
- First and second SAML logins issued tokens. The gate log has
  `CreateSession allow:no-password-check` and `CreateCallback user+intent
allow`.
- Steps 9 and 11 still failed the way they should: `Intent meant for another
user` and `Errors.User.NotActive`.
- Step 12 (password session on the force-SSO org) now prints `password login
rejected: Execution failed (EXEC-dra6yamk98)`. Before, it printed `STILL
issued tokens`.
- The unmodified demo also passed with the gates on. Its steps 5-11 run on a
  password-allowed org.

**Fail-closed (proven).** With the receiver stopped, every `CreateSession`
returned 500. That included user-only sessions in the password org, so every
login method broke. The 500 message includes the target URL
(`Post "http://host.docker.internal:18290/force-sso": … connection refused`),
so the error leaks the internal endpoint to API callers.

**Function executions (proven not usable).**

- The `preuserinfo` payload carries `function`, `userinfo.*`, `user.*`
  (id, state, username, human profile, `password_changed`), `org.{id,name,primary_domain}`
  and `application.client_id`.
- It has **no** session id, auth factors or `amr`, so it cannot tell a password
  login from an SSO login. It could only block every token for a whole org.
- `preaccesstoken` did not fire for this client's opaque (`BEARER`) access
  tokens, so its payload was not observed. Presumably it only runs for JWT
  access tokens; not proven.

## (3) Least-privilege options

| Option                                                                             | Status                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope a PAT to some methods or orgs                                                | **Not possible** (proven by the matrix) | Zitadel PATs carry no scopes; the user's roles are the permissions. No org-level role grants `CreateSession`/`CreateCallback`, so the login capability cannot be confined to one org.                                                                                                                                                                                                                                                                       |
| Separate login client per consumer                                                 | Possible (proven)                       | A second machine user with IAM_LOGIN_CLIENT can create sessions and finish auth requests independently. Each PAT can be revoked on its own and is attributable in audit logs. It does **not** reduce power: every IAM_LOGIN_CLIENT holder can impersonate any user unless the finalize gate is on.                                                                                                                                                          |
| Stop using `seed-bot` (IAM_OWNER) for app mint routes                              | Recommended                             | Proven equivalent for the mint flow: an IAM_LOGIN_CLIENT user can do both `CreateSession` and `CreateCallback`. A deployed app should never hold an IAM_OWNER PAT.                                                                                                                                                                                                                                                                                          |
| Actions V2 session + finalize gate                                                 | **Proven** (above)                      | The only control that makes the API itself enforce force-SSO and refuse credential-less sessions. Gate on v2 **and** v2beta. Use method-level conditions: a service-level `request.service` condition on SessionService would also catch the gate's own `GetSession` lookups.                                                                                                                                                                               |
| Network restriction (expose Session/OIDC v2/SAML v2 services only to the Login UI) | **Not proven**                          | The hosted Login UI reaches the API on the internal network (`ZITADEL_API_URL: http://zitadel-api:8080` in `docker-compose.yml`). So a reverse-proxy rule could reject `/zitadel.session.*`, `/zitadel.oidc.v2*`, `/zitadel.saml.v2*`, `/v2/sessions*`, `/v2beta/sessions*` and `/v2/oidc/*` from the public internet. This was not built or tested. It breaks the apps' mint routes and live Lighthouse unless their egress IPs are allowlisted (see (4)). |
| Keep SSO-only users password-less                                                  | Still advised (fw-mf9)                  | Defense in depth for the password vector only. Does nothing against the credential-less-session vector.                                                                                                                                                                                                                                                                                                                                                     |

## (4) What the apps' mint routes rely on

`POST /internal/testing/zitadel-session` in each app's API:

- `fw-rolodex/apps/api/src/routes/testing.ts:161`
- `fw-warden/apps/api/src/routes/testing.ts:207`
- `fw-chorus/apps/api/src/routes/testing.ts:169`
- `fw-yellow-pages/apps/api/src/routes/testing.ts:170`
- `fw-helmsman/apps/api/src/routes/testing.ts:215`

The route is mounted unconditionally. It is gated by `TESTING_DRAIN_TOKEN`
(`x-drain-token`) and returns 401 when that is unset. All five routes make the
same calls:

1. `SessionService/CreateSession` `{checks:{user:{loginName},password:{password}}}` with
   **`ZITADEL_SEED_BOT_PAT`** (IAM_OWNER).
2. `GET /oauth/v2/authorize` (PKCE), reading `authRequest` from `Location`.
3. `OIDCService/CreateCallback` with **`ZITADEL_LOGIN_CLIENT_PAT`**.
4. `POST /oauth/v2/token`.

The test users (`test-admin@`, `test-member@`, `test-viewer@fleetworks.dev`
and the LHCI user) live in the bootstrap **Fleetworks** org. That org allows
passwords, and no route touches a login policy. The web
`auth/testing-session` routes and `lighthouse-auth.cjs` / `lighthouserc.live.cjs`
only consume the minted tokens.

Impact of the recommended gate:

- **No change needed** while the Fleetworks org keeps
  `allowUsernamePassword:true`. Mint sessions carry a `password` factor, so
  both gates allow them; the bob analogue above proves this.
- **Breaks** if:
  - the Fleetworks org (or the instance default) is ever made force-SSO.
    Keep test users in a password-allowed org.
  - the gate target is down. It fails closed, so it is a dependency of
    local e2e and Lighthouse wherever the gate is configured. Local stacks
    without the gate are unaffected.
  - a network restriction is applied without allowlisting the hosts that run
    the mint routes. These are the app APIs on Render, which call the public
    `AUTH_ISSUER`.
- Worth doing anyway: switch step 1 from `ZITADEL_SEED_BOT_PAT` to the
  login-client PAT, or a dedicated IAM_LOGIN_CLIENT "test-mint" machine user.
  That removes an IAM_OWNER PAT from every deployed app API.

## Recommended production configuration (for the owner)

1. **Before offering force-SSO to any customer, deploy the two-gate Actions V2
   target.**
   - Configuration:
     - Session gate on v2 + v2beta `CreateSession` and `SetSession`.
     - Finalize gate on v2 + v2beta `CreateCallback`,
       `AuthorizeOrDenyDeviceAuthorization` and SAML `CreateResponse`.
     - Targets: `restWebhook`, `interruptOnError: true`, short timeout.
   - Hosting:
     - Public HTTPS. The production denylist stays at the default.
     - Verify `ZITADEL-Signature` on every request.
     - Do lookups with an **IAM_OWNER_VIEWER** PAT, which was proven
       sufficient.
   - It can be the same service as the fw-mf9 attribute mapper. It is on the
     login critical path either way, so run it with that service's
     availability and monitoring.
2. **Treat every IAM_LOGIN_CLIENT and IAM_OWNER credential as able to log in
   as anyone** until the finalize gate is on. That covers the login-client
   PAT, `seed-bot` and any app's `ZITADEL_*_PAT`.
   - Keep the count of IAM_LOGIN_CLIENT holders minimal: the hosted Login UI
     and one dedicated test-mint machine user.
   - Rotate them on the admin-credential schedule.
3. **Move app mint routes off `seed-bot`** to the test-mint IAM_LOGIN_CLIENT
   user (both calls). Keep `TESTING_DRAIN_TOKEN` unset in any environment
   that does not run Lighthouse/e2e.
4. Keep SSO-only users password-less, as fw-mf9 advised. It is a cheap second
   layer.
5. Optional: restrict the session/OIDC-v2/SAML-v2 RPC paths at the edge to
   the Login UI's internal network plus the mint hosts' egress. Not proven
   here; build it and test it before relying on it.
6. Decide the force-SSO factor rule before any customer has users with
   passkeys or OTP. The gate as tested requires an `intent` (IdP) factor in
   force-SSO orgs. That also rejects passkey-only sessions there. That is
   correct for strict SSO, but the policy decision is the owner's.

## Proven vs not proven

Proven on the throwaway instance:

- The role matrix for `CreateSession`/`CreateCallback`.
- That end-user tokens are refused.
- Credential-less sessions yield tokens.
- The v2beta and REST variants.
- The session and finalize gates deny exactly the intended cases on all
  transports, and allow password orgs, the mint pattern and SAML into a
  force-SSO org.
- Fail-closed behavior and the URL leak in the 500 message.
- The `preuserinfo` payload is not usable.
- IAM_OWNER_VIEWER is enough for the gate's lookups.

Not proven:

- The hosted Login UI v2 driven through the gates. The throwaway had no Login
  UI. It uses the same RPCs, including user-only `CreateSession` then
  `SetSession`, which the gate allows; that is inferred.
- The `preaccesstoken` payload with JWT access tokens.
- Device flow and SAML-SP (`CreateResponse`) finalize paths actually being
  exercised. The executions were set but not driven.
- Passkey/OTP sessions through the finalize gate.
- A network/path restriction.
- Other IAM_LOGIN_CLIENT powers, such as password reset and user-write RPCs.
- Behavior under target latency or timeouts.

## Cleanup

- Torn down:
  - the `fwxw4-zt` compose project (`zitadel-api`, `postgres`, the default
    network, the `bootstrap` volume), using `docker compose down -v`;
  - every demo-run `fwxw4-saml-idp` IdP container and `saml-broker-*` org,
    removed by the demo's own cleanup trap;
  - the Node receiver on `127.0.0.1:18290`.
- Deleted the `/tmp/fwxw4` work dir: the PAT copies, state file, scripts,
  logs and the modified demo copy.
- Verified afterwards:
  - `docker ps -a`, `docker network ls` and `docker volume ls` show nothing
    named `fwxw4*` or `*saml*`.
  - Nothing listens on 18290.
  - The four `fleetworks-zitadel-*` containers keep their original 2026-09-17
    start times.
  - The shared stack received no requests from this run.
