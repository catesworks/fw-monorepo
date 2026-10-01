# SAML brokering through Zitadel: local proof (2026-10-01, Zitadel v4.17.1)

Tracks `fw-prs` (Phase 3: SAML brokering for SAML-only enterprise IdPs), under
epic `fw-cte`. Builds on the Phase 2 SCIM gate in `scim-findings.md`.

**Question.** Can Zitadel act as the SAML SP/broker for a customer's SAML-only
IdP, so the Fleetworks apps stay OIDC-only?

**Answer: yes, proven end to end on the local stack.** A SAML 2.0 IdP
(SimpleSAMLphp) authenticated a user. Zitadel consumed the signed assertion
on its own ACS, linked the identity to a Zitadel user in a per-customer org,
and issued normal OIDC tokens to rolodex's local web client (`iss
http://localhost:8089`, `azp` = rolodex web client id). Nothing on the
rolodex side touched SAML. The client id, redirect URI, scopes, PKCE
exchange, JWKS and userinfo are the same as for a password login.

Reproduce with `./saml-broker-demo.sh` (about 15 s, cleans up after itself).
It passed 4 full runs in a row at the end of the session.

## What was run

| Piece        | Value                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Zitadel      | local stack in this directory, `http://localhost:8089`, v4.17.1                                                              |
| SAML IdP     | `kenchan0130/simplesamlphp:latest` (SimpleSAMLphp 1.x), container `saml-broker-idp`, `127.0.0.1:18080`                       |
| IdP users    | `alice` / `bob` (password `password`), attributes `uid, email, givenName, sn, displayName, groups` (multi-valued)            |
| NameID       | `persistent`, value = directory `uid` (via `saml:AttributeNameID`), which is what Entra/Okta send when asked for persistent  |
| Bindings     | AuthnRequest over HTTP-Redirect (unsigned); Response over HTTP-POST, Response and Assertion both signed RSA-SHA256           |
| Customer org | throwaway `saml-broker-<epoch>`, created per run and deleted by cleanup                                                      |
| OIDC client  | rolodex web (`387742353890321411`, `http://localhost:3013/auth/callback`, PKCE, public)                                      |
| Credentials  | seed-bot PAT (admin RPCs), login-client PAT (intent/session/callback RPCs), both read via `docker compose cp`, never printed |

## Proven end to end

1. **The SP side is all Zitadel.** Creating the IdP gives Zitadel SP metadata at
   `GET /idps/{idpId}/saml/metadata`, with entityID = that same URL and ACS =
   `/idps/{idpId}/saml/acs` (HTTP-POST and Artifact). We registered those
   two values at the IdP. That is all the customer IdP needs.
2. **Headless federated login (script).** `StartIdentityProviderIntent`
   returns a redirect `authUrl` to the IdP. curl acts as the browser: it logs
   in at the IdP and POSTs the `SAMLResponse` to Zitadel's ACS. Zitadel
   validates it and redirects to `successUrl?id=<intentId>&token=<intentToken>`.
   `RetrieveIdentityProviderIntent` then returns the external id (`alice`) and
   all SAML attributes under `idpInformation.rawInformation.attributes`.
3. **JIT user + link.** `AddHumanUser` in the customer org with `idpLinks`
   creates the user already linked. `CreateSession` with
   `checks.user` + `checks.idpIntent`, then `/oauth/v2/authorize` (PKCE),
   `OIDCService/CreateCallback`, and `/oauth/v2/token` produce a normal ID
   token and access token:
   - `iss=http://localhost:8089`, `azp=387742353890321411`, `aud` contains the
     rolodex client id (plus the project's other app ids, same as for
     password users), `sub` = the new Zitadel user id.
   - `/oidc/v1/userinfo` returns `email=alice@acme.example`,
     `email_verified=true`, `name=Alice Anderson`, and
     `preferred_username=alice@acme.example`.
4. **Returning user.** The second SAML login for `alice` gets an intent whose
   `userId` is already the linked Zitadel user, with no re-create. The
   resulting token has the same `sub`.
5. **Intent binding.** A valid intent for `bob` cannot open a session for
   `alice`'s user id: `CreateSession` fails with `Intent meant for another
user (COMMAND-O8xk3w)`.
6. **Hosted Login UI v2 path (browser).** Run separately with a throwaway
   local Playwright script. The Playwright MCP failed to start
   (`ENOENT playwright-app-storage-init`), so I used the
   `@playwright/test` from `fw-rolodex/node_modules` with headless Chromium,
   against localhost only.
   - Authorizing with scope `urn:zitadel:iam:org:id:<customerOrg>` makes the
     Login UI show "sign in with Acme SAML (SimpleSAMLphp)".
   - Click, IdP login as `bob`, Login UI → **"Complete your data"** form with
     empty Username/First/Last/E-mail. After it was filled and submitted, the
     browser reached `http://localhost:3013/auth/callback?code=…`.
   - Exchanging that code gave `iss=http://localhost:8089`,
     `azp=<rolodex web>`, userinfo `email=bob@acme.example`, `name=Bob Brown`,
     and resourceowner = the customer org.
   - Second UI login for `bob`: IdP login → straight to the rolodex callback
     with no form, because the link was reused.

Rolodex was not running, so its own `/auth/callback` handler and API were not
exercised; the code was exchanged by hand. The point stands anyway: what
reaches the callback is a plain OIDC authorization code from the same issuer.

## Failures hit, and what they mean for real onboarding

| Symptom                                                                                    | Cause / fix                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACS redirected to `failureUrl` with `error=SAML-ajl3irfs`, `Errors.Intent.ResponseInvalid` | The real cause is only in the eventstore (`idpintent.failed` payload): `cannot validate signature on Response: Cert is not valid at this time`. The image's baked-in IdP cert expired 2020-01-22. **Zitadel enforces IdP signing-cert validity**, so customers must re-share metadata on cert rollover. The script mints a 2-day cert. |
| The ACS failure itself is not logged by `zitadel-api`                                      | Debug SAML failures with `select event_type, payload from eventstore.events2 where aggregate_type='idpintent' order by created_at desc limit 2`, or production equivalent: the intent event. The Login UI only shows the generic error.                                                                                                |
| IdP sends a `transient` NameID even though Zitadel requested `persistent`                  | SimpleSAMLphp's default. With transient, the external id changes every login, so linking breaks unless `transientMappingAttributeName` is set on the Zitadel IdP. Ask customers for a **persistent** NameID (immutable id, not email) or set the mapping attribute.                                                                    |
| `CreateSession` → 404 `QUERY-Dfbg2` immediately after `AddHumanUser`                       | Projection lag (eventual consistency). The script polls `GetUserByID` before creating the session.                                                                                                                                                                                                                                     |
| `ActionService/CreateTarget` → `Errors.Target.DeniedURL`                                   | See "Attribute mapping" below.                                                                                                                                                                                                                                                                                                         |

## Attribute mapping and JIT: the important caveat

**Zitadel v4.17.1's SAML provider maps no attributes.** In
`internal/idp/providers/saml/mapper.go`, `GetEmail`, `GetFirstName`,
`GetDisplayName` and the other getters all return `""`. Only the NameID becomes
the external user id. Every attribute is passed through raw in
`idpInformation.rawInformation.attributes`. As a result:

- `isAutoCreation: true` does **not** give silent JIT for SAML. The prefilled
  `addHumanUser` in `RetrieveIdentityProviderIntent` contains only
  `idpLinks` and an empty profile/email (observed). The hosted Login UI then
  shows "Complete your data" with blank fields (observed). That's fine for a
  demo, but enterprise users won't accept it.
- `autoLinking: AUTO_LINKING_OPTION_EMAIL` likely does nothing for SAML,
  because the provider never produces an email. This is inferred from source
  and was not tested.
- `isAutoUpdate` likewise has nothing to update. Also inferred, not tested.
- **Zitadel's documented fix** (see the OneLogin SAML guide) is an
  **Actions V2 response target** on
  `/zitadel.user.v2.UserService/RetrieveIdentityProviderIntent`. A small HTTP
  service rewrites `addHumanUser.{username,profile,email}` and
  `idpInformation.userName` from the raw attributes. This is Zitadel-side
  infra, not app code. A Python version of the mapper was written and was
  reachable from containers. Creating the target failed with
  `Errors.Target.DeniedURL`: the default `HTTPClient.DenyList` blocks
  `localhost`, `0.0.0.0/8` (OrbStack's `host.docker.internal` is in it),
  RFC1918 and loopback. Making it work locally means overriding
  `ZITADEL_HTTPCLIENT_DENYLIST` and restarting the shared stack, which was out
  of scope here. **Not proven.** In production the target would be a public
  HTTPS endpoint, and the payload should be verified with the target's
  signing key.
- Executions are **instance-wide**, keyed on the method and not on the IdP. A
  single mapper therefore serves every customer IdP, and must branch on
  `idpInformation.idpId` (or org) for per-customer attribute names
  (Entra's `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`
  vs Okta's `email`, etc.).
- The script does the mapping itself in step 6, the way a custom login UI or
  the action would. `groups` arrive as a multi-valued attribute but are **not**
  turned into Zitadel roles/grants by anything. Role assignment remains the
  SCIM/authorization path's job (below).

## Org-per-customer implications

- An org-level IdP (`/management/v1/idps/saml` with `x-zitadel-orgid`) is
  visible only to that org's login policy. The login must be org-scoped:
  either the app sends `urn:zitadel:iam:org:id:<orgId>` (or
  `urn:zitadel:iam:org:domain:primary:<domain>`), or domain discovery is used
  so the Login UI routes `@customer.com` to the right org/IdP.
  - **This is the one app-visible change:** a scope string or `login_hint` on
    the authorize request. It is not SAML code.
  - Without org scope, the Login UI shows the instance default login, which
    has no customer IdP button.
- Users created through the IdP land in the customer org (resourceowner =
  customer org), so tenant isolation follows from where the IdP lives.
- Each customer org needs a custom login policy (`allowExternalIdp: true`)
  with the IdP added to it. The script does this.
  - **Not tested:** whether `allowUsernamePassword: false` (forcing SSO) blocks
    password fallback for that org.
- Access to the rolodex project for users of another org relied on this
  local project having no role-check / project-check flags. A real setup will
  want project grants to the customer org plus authorizations. See SCIM
  below.
- **Cert/metadata lifecycle is per customer.** Inline `metadataXml` was used.
  `metadataUrl` exists, but Zitadel fetching it is subject to the same
  outbound deny-list, and nothing auto-refreshes rotated certs (inferred). An
  expired IdP cert hard-fails every login with only the eventstore reason
  shown above.

## SCIM interplay (Phase 2, `scim-findings.md`)

- SCIM and SAML resolve users differently.
  - SCIM-provisioned users are matched by `userName` / `externalId`, and
    `externalId` gets clobbered by PATCH/PUT (Phase 2 finding (e)).
  - SAML users are matched only by an **IdP link** (idpId + NameID).
  - A SCIM-created user has no IdP link. So for a customer that pushes users
    via SCIM _and_ logs in via SAML, the first SAML login will **not** find
    the SCIM user: the intent comes back with `userId` empty, and email
    auto-linking can't help (no mapped email). The result is a duplicate user
    or a "Complete your data" registration.
- Options, in order of preference:
  1. A login layer (Actions V2 response target or a custom login) that maps
     NameID/email to the SCIM user and adds the IdP link
     (`UserService/AddIDPLink {userId, idpLink:{idpId, userId:<NameID>, userName}}`).
  2. Have SCIM create the IdP link at provisioning time. **Not available:**
     the Zitadel SCIM endpoint has no idp-link field. Inferred from the Phase
     2 schema (`GET /scim/v2/{org}/Schemas` only advertises `core:2.0:User`).
  3. Agree with the customer that SAML NameID = SCIM `userName` (email), and
     link on email in the mapper.
- **Not tested here:** a SCIM-provisioned user followed by a SAML login. This
  is the next experiment if both are offered to one customer.
- Deprovisioning: SCIM `DELETE`/deactivate in Zitadel blocks the next SAML
  login (no active user), which is the desired behavior. Not exercised here.
- Phase 2 found SCIM enterprise `employeeNumber` is void on this version. SAML
  attributes are not stored at all (only the raw intent payload), so neither
  path gives a durable employee-number match key today.

## Exact API shapes used (no secrets)

`RPC` = `POST /<package>.<Service>/<Method>`, JSON, `Authorization: Bearer <PAT>`.
`seed` = seed-bot PAT (IAM_OWNER + ORG_OWNER). `login` = login-client PAT.

```text
seed  RPC zitadel.org.v2.OrganizationService/AddOrganization   {"name":"saml-broker-<epoch>"} -> {organizationId}

seed  POST /management/v1/idps/saml        header x-zitadel-orgid: <orgId>
      {"name":"Acme SAML (SimpleSAMLphp)",
       "metadataXml":"<base64 of IdP metadata XML>",
       "binding":"SAML_BINDING_REDIRECT", "withSignedRequest":false,
       "nameIdFormat":"SAML_NAME_ID_FORMAT_PERSISTENT",
       // optional: "transientMappingAttributeName":"<attr>" when the IdP only sends transient
       "providerOptions":{"isLinkingAllowed":true,"isCreationAllowed":true,"isAutoCreation":true,
                          "isAutoUpdate":true,"autoLinking":"AUTO_LINKING_OPTION_EMAIL"}}  -> {id}
      (update: PUT /management/v1/idps/saml/{id}, same body. No v2 create-IdP RPC on v4.17.1;
       zitadel.idp.v2 is read-only GetIDPByID. Instance-wide IdPs: /admin/v1/idps/saml.)

      GET  /idps/{id}/saml/metadata  -> SP metadata (entityID = this URL, ACS = /idps/{id}/saml/acs)

seed  POST /management/v1/policies/login        (x-zitadel-orgid)
      {"allowUsernamePassword":true,"allowExternalIdp":true,"allowRegister":true,
       "passwordlessType":"PASSWORDLESS_TYPE_NOT_ALLOWED"}
seed  POST /management/v1/policies/login/idps   (x-zitadel-orgid)
      {"idpId":"<id>","ownerType":"IDP_OWNER_TYPE_ORG"}

login RPC zitadel.user.v2.UserService/StartIdentityProviderIntent
      {"idpId":"<id>","urls":{"successUrl":"…","failureUrl":"…"}}  -> {authUrl}   (POST binding returns postForm instead)
      browser: authUrl -> IdP login -> POST SAMLResponse+RelayState to /idps/{id}/saml/acs
            -> 302 successUrl?id=<intentId>&token=<intentToken>   (or failureUrl?error=…&error_description=…)
login RPC zitadel.user.v2.UserService/RetrieveIdentityProviderIntent
      {"idpIntentId":"…","idpIntentToken":"…"}
      -> {userId? , idpInformation:{idpId, userId:<NameID>, rawInformation:{attributes:{k:[v…]}}},
          addHumanUser:{idpLinks:[{idpId,userId}], profile:{}, email:{sendCode:{}}}}

seed  RPC zitadel.user.v2.UserService/AddHumanUser
      {"organization":{"orgId":"<orgId>"},"username":"<email>",
       "profile":{"givenName","familyName","displayName"},"email":{"email","isVerified":true},
       "idpLinks":[{"idpId":"<id>","userId":"<NameID>","userName":"<email>"}]}  -> {userId}

login RPC zitadel.session.v2.SessionService/CreateSession
      {"checks":{"user":{"userId":"<userId>"},"idpIntent":{"idpIntentId":"…","idpIntentToken":"…"}}}
      -> {sessionId, sessionToken}
      GET /oauth/v2/authorize?client_id&redirect_uri&response_type=code&scope&code_challenge(S256)
      -> 302 /ui/v2/login/login?authRequest=<id>   (don't follow)
login RPC zitadel.oidc.v2.OIDCService/CreateCallback
      {"authRequestId":"<id>","session":{"sessionId","sessionToken"}}  -> {callbackUrl (with code)}
      POST /oauth/v2/token  grant_type=authorization_code, code, redirect_uri, client_id, code_verifier

seed  RPC zitadel.action.v2.ActionService/CreateTarget       (FAILED locally: DeniedURL)
      {"name":"saml-broker-attr-map","restCall":{"interruptOnError":true},
       "endpoint":"http://host.docker.internal:18090/call","timeout":"10s"}
seed  RPC zitadel.action.v2.ActionService/SetExecution      (not reached)
      {"condition":{"response":{"method":"/zitadel.user.v2.UserService/RetrieveIdentityProviderIntent"}},
       "targets":["<targetId>"]}

seed  RPC zitadel.org.v2.OrganizationService/ListOrganizations
      {"queries":[{"nameQuery":{"name":"saml-broker-","method":"TEXT_QUERY_METHOD_STARTS_WITH"}}]}
seed  RPC zitadel.org.v2.OrganizationService/DeleteOrganization {"organizationId":"…"}  (removes IdP, policy, users)
```

## What a real customer onboarding needs

1. A Zitadel org for the customer, with optional verified domains for domain
   discovery.
2. An org-level SAML IdP created from the customer's IdP metadata (XML
   upload). Send them our SP metadata URL `/idps/{id}/saml/metadata`.
   - Ask for: persistent/immutable NameID; attributes `email`, given name,
     surname, and display name (their claim URIs recorded per customer);
     signed assertions; and a cert-expiry date for the calendar.
3. An org login policy with the IdP enabled, optionally disabling passwords
   for that org. Decide whether the apps send the org scope or rely on
   domain discovery.
4. An instance-wide Actions V2 response target mapping per-IdP attribute
   names to the Zitadel profile/email (and optionally linking to SCIM-created
   users). **Required for real JIT. Not yet proven.**
5. Authorization: project grant to the customer org plus role assignment.
   SAML `groups` are not mapped by anything today.
   - Either SCIM (Phase 2: `CreateAuthorization` works) or the same action
     creates the authorizations.
6. Support runbook: on login failure, read the `idpintent.failed` event
   reason. Track the customer's cert expiry.

## Cleanup / side effects

Every run deletes all `saml-broker-*` orgs (with their IdPs, policies and
users), the `saml-broker-idp` container, and its temp files. It verified
nothing was left behind. No Actions V2 target or execution was created (the
create was rejected). The temporary Playwright script and webhook lived in
`/tmp`, were never committed, and were removed. The shared stack's own
config and seeded objects were not modified. The pulled images
`kenchan0130/simplesamlphp` and `curlimages/curl` (used for one reachability
check) remain in the local Docker image cache.
