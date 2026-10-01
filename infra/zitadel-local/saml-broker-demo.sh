#!/usr/bin/env bash
# Local proof (fw-prs, Phase 3): Zitadel as SAML SP/broker for a SAML-only IdP.
#
# Spins up a throwaway SimpleSAMLphp IdP on 127.0.0.1:18080, creates a
# throwaway `saml-broker-*` org with a SAML IdP in the local Zitadel
# (http://localhost:8089 ONLY), drives the federated login headlessly (curl
# plays the browser at the IdP), then completes a normal OIDC Auth Code + PKCE
# flow for rolodex's local web client and prints the decoded ID token claims.
# Rolodex never sees SAML: it gets a plain Zitadel OIDC token.
#
# Usage:  ./saml-broker-demo.sh            run the demo, then clean up
#         KEEP=1 ./saml-broker-demo.sh     run, leave org + IdP container up
#         ./saml-broker-demo.sh cleanup    remove every saml-broker-* leftover
#
# HOOK=1 also starts a local Node attribute mapper registered as an Actions V2
# response target on RetrieveIdentityProviderIntent, and adds steps 10-12
# (SCIM user + SAML login, SCIM deactivate, force-SSO). Zitadel's default
# HTTPClient deny-list rejects a localhost target, so HOOK=1 needs a Zitadel
# started with ZITADEL_HTTPCLIENT_DENYLIST overridden: use a throwaway second
# instance, never the shared one (saml-brokering-findings.md, "fw-mf9"):
#   HOOK=1 ZITADEL_BASE=http://localhost:18189 ZITADEL_COMPOSE_DIR=<its dir> \
#     ROLODEX_CLIENT_ID=<its client> IDP_PORT=18180 ./saml-broker-demo.sh
#
# Needs: docker, curl, jq, openssl, python3 (+ node for HOOK=1). Never prints PATs or tokens.
set -euo pipefail

log() { printf '\n== %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ZITADEL_BASE / ZITADEL_COMPOSE_DIR point the demo at a second, throwaway
# Zitadel (needed for HOOK=1, see saml-brokering-findings.md); localhost only.
BASE=${ZITADEL_BASE:-http://localhost:8089}
[[ $BASE =~ ^http://localhost:[0-9]+$ ]] || die "ZITADEL_BASE must be http://localhost:<port>"
IDP_PORT=${IDP_PORT:-18080}
IDP_BASE=http://localhost:$IDP_PORT
CONTAINER=${IDP_CONTAINER:-saml-broker-idp}
IMAGE=kenchan0130/simplesamlphp:latest
# rolodex web client (USER_AGENT, PKCE) as seeded by seed.ts; override after a re-seed
CLIENT_ID=${ROLODEX_CLIENT_ID:-387742353890321411}
REDIRECT_URI=http://localhost:3013/auth/callback
HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE_DIR=${ZITADEL_COMPOSE_DIR:-$HERE}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/saml-broker.XXXXXX")
chmod 700 "$WORK"
# bind-mounted into the IdP container, so it must outlive this run when KEEP=1
IDPDIR=${TMPDIR:-/tmp}/$CONTAINER

PAT=$WORK/seed.pat
LOGIN_PAT=$WORK/login.pat
(cd "$COMPOSE_DIR" &&
  docker compose cp zitadel-api:/zitadel/bootstrap/fleetworks-seed-bot.pat "$PAT" &&
  docker compose cp zitadel-api:/zitadel/bootstrap/login-client.pat "$LOGIN_PAT") >/dev/null 2>&1 ||
  die "could not read PATs from the local zitadel-api container (is the stack up?)"

# rpc <pat-file> <path> <json> [extra curl args...]: POST, fail loudly on non-2xx
rpc() {
  local pat=$1 path=$2 body=$3
  shift 3
  local out code
  out=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $(cat "$pat")" \
    -H 'Content-Type: application/json' "$@" -d "$body" "$BASE/$path")
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  [[ $code == 2* ]] || die "$path -> HTTP $code: $out"
  printf '%s' "$out"
}

HOOK_PORT=${HOOK_PORT:-18190}
HOOK_TARGET=saml-broker-attr-map
MAPPER_PID=${TMPDIR:-/tmp}/$CONTAINER.mapper.pid
MAPPER_LOG=${TMPDIR:-/tmp}/$CONTAINER.mapper.log
INTENT_METHOD=/zitadel.user.v2.UserService/RetrieveIdentityProviderIntent

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$IDPDIR"
  [[ -f $MAPPER_PID ]] && kill "$(cat "$MAPPER_PID")" 2>/dev/null; rm -f "$MAPPER_PID" "$MAPPER_LOG"
  local ids t
  # Actions V2 objects are instance-wide: drop the execution, then our target.
  t=$(rpc "$PAT" zitadel.action.v2.ActionService/ListTargets \
    "{\"filters\":[{\"targetNameFilter\":{\"targetName\":\"$HOOK_TARGET\"}}]}" | jq -r '.targets[]?.id')
  if [[ -n $t ]]; then
    rpc "$PAT" zitadel.action.v2.ActionService/SetExecution \
      "{\"condition\":{\"response\":{\"method\":\"$INTENT_METHOD\"}},\"targets\":[]}" >/dev/null
    for id in $t; do rpc "$PAT" zitadel.action.v2.ActionService/DeleteTarget "{\"id\":\"$id\"}" >/dev/null; done
    echo "deleted Actions V2 execution + target $HOOK_TARGET"
  fi
  ids=$(rpc "$PAT" zitadel.org.v2.OrganizationService/ListOrganizations \
    '{"queries":[{"nameQuery":{"name":"saml-broker-","method":"TEXT_QUERY_METHOD_STARTS_WITH"}}]}' |
    jq -r '.result[]?.id')
  for id in $ids; do
    rpc "$PAT" zitadel.org.v2.OrganizationService/DeleteOrganization "{\"organizationId\":\"$id\"}" >/dev/null
    echo "deleted org $id (and its IdP + users)"
  done
}

if [[ ${1:-} == cleanup ]]; then
  cleanup
  rm -rf "$WORK"
  exit 0
fi
trap '[[ -n ${KEEP:-} ]] || cleanup; rm -rf "$WORK"' EXIT
cleanup # idempotent: start from zero
mkdir -p "$IDPDIR"

log "1. IdP signing cert (the image's baked-in cert expired in 2020; Zitadel rejects it)"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=saml-broker-idp" \
  -keyout "$IDPDIR/server.pem" -out "$IDPDIR/server.crt" >/dev/null 2>&1
chmod 644 "$IDPDIR/server.pem" # container's apache user must read it; throwaway key

# Representative enterprise directory: stable uid + the usual profile attributes.
cat >"$IDPDIR/authsources.php" <<'PHP'
<?php
$config = [
  'admin' => ['core:AdminPassword'],
  'example-userpass' => [
    'exampleauth:UserPass',
    'alice:password' => ['uid' => ['alice'], 'email' => ['alice@acme.example'],
      'givenName' => ['Alice'], 'sn' => ['Anderson'], 'displayName' => ['Alice Anderson'],
      'groups' => ['fleet-admins', 'everyone']],
    'bob:password' => ['uid' => ['bob'], 'email' => ['bob@acme.example'],
      'givenName' => ['Bob'], 'sn' => ['Brown'], 'displayName' => ['Bob Brown'],
      'groups' => ['everyone']],
    'carol:password' => ['uid' => ['carol'], 'email' => ['carol@acme.example'],
      'givenName' => ['Carol'], 'sn' => ['Clark'], 'displayName' => ['Carol Clark'],
      'groups' => ['everyone']],
  ],
];
PHP
# Persistent NameID = the directory uid (what a real IdP like Entra/Okta sends
# when asked for persistent). Without this SimpleSAMLphp sends a random transient id.
cat >"$IDPDIR/saml20-sp-remote.php" <<'PHP'
<?php
$metadata[getenv('SIMPLESAMLPHP_SP_ENTITY_ID')] = [
  'AssertionConsumerService' => getenv('SIMPLESAMLPHP_SP_ASSERTION_CONSUMER_SERVICE'),
  'SingleLogoutService' => getenv('SIMPLESAMLPHP_SP_SINGLE_LOGOUT_SERVICE'),
  'NameIDFormat' => 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'authproc' => [10 => ['class' => 'saml:AttributeNameID', 'attribute' => 'uid',
    'Format' => 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent']],
];
PHP

start_idp() { # $1 = SP entity id, $2 = ACS, $3 = SLO
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p 127.0.0.1:$IDP_PORT:8080 \
    -e SIMPLESAMLPHP_SP_ENTITY_ID="$1" -e SIMPLESAMLPHP_SP_ASSERTION_CONSUMER_SERVICE="$2" \
    -e SIMPLESAMLPHP_SP_SINGLE_LOGOUT_SERVICE="$3" \
    -v "$IDPDIR/server.crt:/var/www/simplesamlphp/cert/server.crt:ro" \
    -v "$IDPDIR/server.pem:/var/www/simplesamlphp/cert/server.pem:ro" \
    -v "$IDPDIR/authsources.php:/var/www/simplesamlphp/config/authsources.php:ro" \
    -v "$IDPDIR/saml20-sp-remote.php:/var/www/simplesamlphp/metadata/saml20-sp-remote.php:ro" \
    "$IMAGE" >/dev/null
  for _ in $(seq 30); do
    curl -sf "$IDP_BASE/simplesaml/saml2/idp/metadata.php" -o "$WORK/idp-meta.xml" && return 0
    sleep 1
  done
  die "IdP container did not come up"
}

log "2. Start IdP (placeholder SP) and fetch its metadata"
start_idp placeholder http://localhost/acs http://localhost/slo
grep -o 'entityID="[^"]*"' "$WORK/idp-meta.xml"

log "3. Throwaway org + SAML IdP in Zitadel (management v1; there is no v2 create-IdP RPC on v4.17.1)"
ORG=$(rpc "$PAT" zitadel.org.v2.OrganizationService/AddOrganization \
  "{\"name\":\"saml-broker-$(date +%s)\"}" | jq -r .organizationId)
echo "org $ORG"
IDP_BODY=$(jq -nc --arg m "$(base64 <"$WORK/idp-meta.xml" | tr -d '\n')" '{
  name: "Acme SAML (SimpleSAMLphp)", metadataXml: $m,
  binding: "SAML_BINDING_REDIRECT", withSignedRequest: false,
  nameIdFormat: "SAML_NAME_ID_FORMAT_PERSISTENT",
  providerOptions: { isLinkingAllowed: true, isCreationAllowed: true, isAutoCreation: true,
                     isAutoUpdate: true, autoLinking: "AUTO_LINKING_OPTION_EMAIL" } }')
IDP=$(rpc "$PAT" management/v1/idps/saml "$IDP_BODY" -H "x-zitadel-orgid: $ORG" | jq -r .id)
echo "idp $IDP"
SP_ENTITY=$BASE/idps/$IDP/saml/metadata
ACS=$BASE/idps/$IDP/saml/acs
curl -sf "$SP_ENTITY" | grep -q "$ACS" || die "SP metadata does not list $ACS"
echo "SP metadata $SP_ENTITY lists ACS $ACS"

# Org login policy with the IdP enabled (what the hosted Login UI shows as a button).
rpc "$PAT" management/v1/policies/login '{"allowUsernamePassword":true,"allowExternalIdp":true,
  "allowRegister":true,"passwordlessType":"PASSWORDLESS_TYPE_NOT_ALLOWED"}' \
  -H "x-zitadel-orgid: $ORG" >/dev/null
rpc "$PAT" management/v1/policies/login/idps "{\"idpId\":\"$IDP\",\"ownerType\":\"IDP_OWNER_TYPE_ORG\"}" \
  -H "x-zitadel-orgid: $ORG" >/dev/null
echo "org login policy: external IdP enabled"

log "4. Re-register the SP (Zitadel's entity id/ACS) at the IdP"
start_idp "$SP_ENTITY" "$ACS" "$BASE/idps/$IDP/saml/slo"

if [[ -n ${HOOK:-} ]]; then
  log "4b. Actions V2 response hook: local attribute mapper on :$HOOK_PORT"
  # Reference mapper. Zitadel POSTs {fullMethod, instanceID, orgID, userID,
  # request, response} (orgID/userID are the CALLER's, i.e. the login client,
  # not the customer org) and uses the returned JSON as the new response.
  cat >"$WORK/mapper.mjs" <<'JS'
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
const { HOOK_PORT, SIGNING_KEY_FILE, ZITADEL_BASE, PAT_FILE } = process.env;
// read once: with KEEP=1 the files are deleted while the mapper keeps running
const KEY = fs.readFileSync(SIGNING_KEY_FILE, 'utf8').trim();
const PAT = fs.readFileSync(PAT_FILE, 'utf8').trim();
const rpc = async (path, body) => {
  const r = await fetch(`${ZITADEL_BASE}/${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${PAT}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};
// ZITADEL-Signature: t=<unix>,v1=<hex HMAC-SHA256(signingKey, "<t>.<body>")>
const verified = (header = '', body) => {
  const h = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const mac = crypto.createHmac('sha256', KEY).update(`${h.t}.${body}`).digest('hex');
  return h.v1?.length === mac.length && crypto.timingSafeEqual(Buffer.from(h.v1), Buffer.from(mac))
    && Math.abs(Date.now() / 1000 - Number(h.t)) < 300;
};
// First non-empty value among the IdP's possible attribute names. A real
// mapper keys this table on idpInformation.idpId (Entra sends claim URIs).
const CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/';
const pick = (a, ...names) => names.map((n) => a[n]?.[0]).find(Boolean);
async function map(r) {
  const i = r.idpInformation, a = i?.rawInformation?.attributes;
  if (!i?.saml || !a) return r; // only SAML intents need mapping
  const email = pick(a, 'email', `${CLAIM}emailaddress`);
  const givenName = pick(a, 'givenName', `${CLAIM}givenname`);
  const familyName = pick(a, 'sn', `${CLAIM}surname`);
  const displayName = pick(a, 'displayName', `${CLAIM}name`) ?? `${givenName} ${familyName}`;
  if (!email) return r;
  i.userName = email;
  const fill = (h = {}) => ({ ...h, profile: { ...h.profile, givenName, familyName, displayName },
    email: { email, isVerified: true }, // trusting the customer IdP's email
    idpLinks: (h.idpLinks ?? []).map((l) => ({ ...l, userName: email })) });
  r.addHumanUser = { ...fill(r.addHumanUser), username: email };
  // The hosted Login UI v2 reads createUser (oneof userAction) BEFORE the
  // deprecated addHumanUser: mapping only addHumanUser leaves its form blank.
  if (r.createUser) r.createUser = { ...r.createUser, username: email, human: fill(r.createUser.human) };
  if (!r.userId) {
    // SCIM overlap: a SCIM-provisioned user has no IdP link. Link it by email
    // inside the IdP's own org so the login resolves to it instead of a duplicate.
    const org = (await rpc('zitadel.idp.v2.IdentityProviderService/GetIDPByID', { id: i.idpId })).idp.details.resourceOwner;
    const found = (await rpc('zitadel.user.v2.UserService/ListUsers', { queries: [
      { emailQuery: { emailAddress: email } }, { organizationIdQuery: { organizationId: org } }] })).result ?? [];
    if (found.length === 1) {
      await rpc('zitadel.user.v2.UserService/AddIDPLink', { userId: found[0].userId,
        idpLink: { idpId: i.idpId, userId: i.userId, userName: email } });
      r.userId = found[0].userId;
      console.log(`linked existing user ${found[0].userId} to ${i.idpId}/${i.userId}`);
    }
  }
  return r;
}
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (!verified(req.headers['zitadel-signature'], body)) return res.writeHead(401).end();
    try {
      const out = await map(JSON.parse(body).response);
      console.log(`mapped intent for ${out.idpInformation?.userId}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      console.error(e.message);
      res.writeHead(500).end(); // interruptOnError: the login fails closed
    }
  });
}).listen(Number(HOOK_PORT), '127.0.0.1');
JS
  TARGET=$(rpc "$PAT" zitadel.action.v2.ActionService/CreateTarget "$(jq -nc --arg n "$HOOK_TARGET" \
    --arg e "http://host.docker.internal:$HOOK_PORT/call" \
    '{name:$n, restCall:{interruptOnError:true}, endpoint:$e, timeout:"10s"}')")
  jq -r .signingKey <<<"$TARGET" >"$WORK/signing.key"
  HOOK_PORT=$HOOK_PORT SIGNING_KEY_FILE=$WORK/signing.key ZITADEL_BASE=$BASE PAT_FILE=$PAT \
    node "$WORK/mapper.mjs" >"$MAPPER_LOG" 2>&1 &
  echo $! >"$MAPPER_PID"
  rpc "$PAT" zitadel.action.v2.ActionService/SetExecution "$(jq -nc --arg m "$INTENT_METHOD" \
    --arg t "$(jq -r .id <<<"$TARGET")" '{condition:{response:{method:$m}}, targets:[$t]}')" >/dev/null
  echo "target $(jq -r .id <<<"$TARGET") -> http://host.docker.internal:$HOOK_PORT/call, execution on $INTENT_METHOD"
  sleep 2 # mapper listen + execution cache
  kill -0 "$(cat "$MAPPER_PID")" 2>/dev/null || die "mapper exited (port $HOOK_PORT busy?): $(cat "$MAPPER_LOG")"
fi

# federate <user>: one SAML round trip; prints "<intentId> <intentToken>"
federate() {
  local jar=$WORK/jar.$1 auth login_url state resp relay redirect
  rm -f "$jar"
  auth=$(rpc "$LOGIN_PAT" zitadel.user.v2.UserService/StartIdentityProviderIntent \
    "{\"idpId\":\"$IDP\",\"urls\":{\"successUrl\":\"http://localhost:3013/idp/success\",\"failureUrl\":\"http://localhost:3013/idp/failure\"}}" |
    jq -r .authUrl)
  [[ $auth == "$IDP_BASE"/* ]] || die "unexpected authUrl"
  # browser -> IdP (HTTP-Redirect AuthnRequest) -> login form
  login_url=$(curl -s -c "$jar" -b "$jar" -L "$auth" -o "$WORK/login.html" -w '%{url_effective}')
  state=$(grep -oE 'name="AuthState" value="[^"]*"' "$WORK/login.html" | sed 's/.*value="//;s/"$//;s/&amp;/\&/g')
  curl -s -c "$jar" -b "$jar" "${login_url%%\?*}" --data-urlencode "username=$1" \
    --data-urlencode password=password --data-urlencode "AuthState=$state" -o "$WORK/post.html"
  # IdP auto-POST form -> Zitadel ACS (HTTP-POST binding)
  grep -q 'name="SAMLResponse"' "$WORK/post.html" || die "IdP did not return a SAMLResponse for $1 (docker logs $CONTAINER)"
  resp=$(grep -oE 'name="SAMLResponse" value="[^"]*"' "$WORK/post.html" | sed 's/.*value="//;s/"$//')
  relay=$(grep -oE 'name="RelayState" value="[^"]*"' "$WORK/post.html" | sed 's/.*value="//;s/"$//')
  redirect=$(curl -s -o /dev/null -w '%{redirect_url}' "$ACS" \
    --data-urlencode "SAMLResponse=$resp" --data-urlencode "RelayState=$relay")
  [[ $redirect == http://localhost:3013/idp/success* ]] || die "ACS redirected to failure: ${redirect%%&id=*}"
  python3 -c 'import sys,urllib.parse as u;q=u.parse_qs(u.urlparse(sys.argv[1]).query);print(q["id"][0],q["token"][0])' "$redirect"
}

retrieve() { # $1 intentId $2 intentToken
  rpc "$LOGIN_PAT" zitadel.user.v2.UserService/RetrieveIdentityProviderIntent \
    "{\"idpIntentId\":\"$1\",\"idpIntentToken\":\"$2\"}"
}

jwt_claims() { python3 -c 'import sys,json,base64;p=sys.argv[1].split(".")[1];print(json.dumps(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))))' "$1"; }

idp_checks() { # <userId> <intentId> <intentToken>
  printf '{"user":{"userId":"%s"},"idpIntent":{"idpIntentId":"%s","idpIntentToken":"%s"}}' "$1" "$2" "$3"
}

# oidc_login <session checks json>: session -> rolodex OIDC code+PKCE -> tokens
oidc_login() {
  local session verifier challenge loc auth_req cb code
  session=$(rpc "$LOGIN_PAT" zitadel.session.v2.SessionService/CreateSession "{\"checks\":$1}")
  verifier=$(openssl rand -hex 32)
  challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' -G "$BASE/oauth/v2/authorize" \
    --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "redirect_uri=$REDIRECT_URI" \
    --data-urlencode response_type=code --data-urlencode "scope=openid profile email" \
    --data-urlencode code_challenge_method=S256 --data-urlencode "code_challenge=$challenge")
  auth_req=$(python3 -c 'import sys,urllib.parse as u;print(u.parse_qs(u.urlparse(sys.argv[1]).query)["authRequest"][0])' "$loc")
  cb=$(rpc "$LOGIN_PAT" "zitadel.oidc.v2.OIDCService/CreateCallback" \
    "$(jq -nc --arg a "$auth_req" --argjson s "$session" '{authRequestId:$a,session:{sessionId:$s.sessionId,sessionToken:$s.sessionToken}}')" |
    jq -r .callbackUrl)
  [[ $cb == "$REDIRECT_URI"* ]] || die "unexpected callback url"
  code=$(python3 -c 'import sys,urllib.parse as u;print(u.parse_qs(u.urlparse(sys.argv[1]).query)["code"][0])' "$cb")
  curl -sS "$BASE/oauth/v2/token" -d grant_type=authorization_code -d "code=$code" \
    --data-urlencode "redirect_uri=$REDIRECT_URI" -d "client_id=$CLIENT_ID" -d "code_verifier=$verifier" >"$WORK/tokens.json"
  jq -e .id_token "$WORK/tokens.json" >/dev/null || die "token exchange failed: $(jq -c 'del(.access_token,.id_token,.refresh_token)' "$WORK/tokens.json")"
}

log "5. First SAML login for alice (no Zitadel user yet)"
read -r INTENT TOKEN < <(federate alice)
INFO=$(retrieve "$INTENT" "$TOKEN")
echo "$INFO" | jq -c '{userId, idpId: .idpInformation.idpId, externalUserId: .idpInformation.userId,
  attributes: .idpInformation.rawInformation.attributes, prefilledAddHumanUser: .addHumanUser}'
[[ $(echo "$INFO" | jq -r '.userId // ""') == "" ]] || die "expected no linked user on first login"

log "6. JIT-create the Zitadel user in the customer org, linked to the SAML identity"
if [[ -n ${HOOK:-} ]]; then
  # The hook filled addHumanUser from the SAML attributes: use it verbatim.
  [[ $(echo "$INFO" | jq -r '.addHumanUser.email.email') == alice@acme.example &&
    $(echo "$INFO" | jq -r '.addHumanUser.profile.givenName') == Alice ]] ||
    die "hook did not map email/name into addHumanUser"
  echo "hook mapped addHumanUser: $(echo "$INFO" | jq -c '.addHumanUser | {username, profile, email}')"
  USER_BODY=$(echo "$INFO" | jq -c --arg org "$ORG" '.addHumanUser + {organization: {orgId: $org}}')
else
  # Zitadel's SAML provider does NOT map attributes itself, so without the hook
  # the mapping lives here (or in a custom login UI), not in the app.
  USER_BODY=$(echo "$INFO" | jq -c --arg org "$ORG" '.idpInformation as $i | $i.rawInformation.attributes as $a | {
    organization: { orgId: $org }, username: $a.email[0],
    profile: { givenName: $a.givenName[0], familyName: $a.sn[0], displayName: $a.displayName[0] },
    email: { email: $a.email[0], isVerified: true },
    idpLinks: [ { idpId: $i.idpId, userId: $i.userId, userName: $a.email[0] } ] }')
fi
USER=$(rpc "$PAT" zitadel.user.v2.UserService/AddHumanUser "$USER_BODY" | jq -r .userId)
echo "user $USER"
# Session API reads a projection; a just-created user 404s for a moment.
for _ in $(seq 20); do
  (rpc "$LOGIN_PAT" zitadel.user.v2.UserService/GetUserByID "{\"userId\":\"$USER\"}" >/dev/null 2>&1) && break
  sleep 0.5
done

log "7. Session from the SAML intent -> rolodex OIDC (code + PKCE) -> tokens"
oidc_login "$(idp_checks "$USER" "$INTENT" "$TOKEN")"
CLAIMS=$(jwt_claims "$(jq -r .id_token "$WORK/tokens.json")")
echo "$CLAIMS" | jq -c '{iss, aud, azp, sub, email, email_verified, name, preferred_username,
  org: ."urn:zitadel:iam:user:resourceowner:id", amr}'
[[ $(echo "$CLAIMS" | jq -r .iss) == "$BASE" ]] || die "iss is not $BASE"
[[ $(echo "$CLAIMS" | jq -r .sub) == "$USER" ]] || die "sub is not the JIT user"
echo "$CLAIMS" | jq -e --arg c "$CLIENT_ID" '.aud | index($c)' >/dev/null || die "aud lacks rolodex client"
curl -sf -H "Authorization: Bearer $(jq -r .access_token "$WORK/tokens.json")" "$BASE/oidc/v1/userinfo" |
  jq -c '{userinfo_sub: .sub, email, email_verified, name, preferred_username}'

log "8. Second SAML login for alice: intent now resolves to the linked user (no re-create)"
read -r INTENT2 TOKEN2 < <(federate alice)
LINKED=$(retrieve "$INTENT2" "$TOKEN2" | jq -r '.userId // ""')
echo "linked userId: $LINKED"
[[ $LINKED == "$USER" ]] || die "second login did not resolve to the linked user"
oidc_login "$(idp_checks "$LINKED" "$INTENT2" "$TOKEN2")"
[[ $(jwt_claims "$(jq -r .id_token "$WORK/tokens.json")" | jq -r .sub) == "$USER" ]] || die "second token sub differs"
echo "second id_token sub == $USER"

log "9. Negative: a SAML response for a different IdP user cannot open alice's session"
read -r INTENT3 TOKEN3 < <(federate bob)
if (rpc "$LOGIN_PAT" zitadel.session.v2.SessionService/CreateSession \
  "{\"checks\":{\"user\":{\"userId\":\"$USER\"},\"idpIntent\":{\"idpIntentId\":\"$INTENT3\",\"idpIntentToken\":\"$TOKEN3\"}}}") \
  >/dev/null 2>"$WORK/neg.err"; then
  die "bob's intent opened alice's session"
fi
echo "rejected as expected: $(grep -oE '"message":"[^"]*"' "$WORK/neg.err" | head -1)"

scim() { # scim <method> <path> [json]: SCIM call in the customer org
  curl -sS -X "$1" -H "Authorization: Bearer $(cat "$PAT")" -H 'Content-Type: application/scim+json' \
    "$BASE/scim/v2/$ORG/$2" ${3:+-d "$3"} -w '\n%{http_code}'
}

log "10. SCIM-provisioned carol (no IdP link), then her first SAML login"
OUT=$(scim POST Users '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"carol@acme.example",
  "name":{"givenName":"Carol","familyName":"Clark"},"emails":[{"value":"carol@acme.example","primary":true}],"active":true}')
[[ ${OUT##*$'\n'} == 201 ]] || die "SCIM create: $OUT"
CAROL=$(jq -r .id <<<"${OUT%$'\n'*}")
echo "SCIM user carol $CAROL"
for _ in $(seq 20); do
  (rpc "$LOGIN_PAT" zitadel.user.v2.UserService/GetUserByID "{\"userId\":\"$CAROL\"}" >/dev/null 2>&1) && break
  sleep 0.5
done
read -r INTENT4 TOKEN4 < <(federate carol)
RESOLVED=$(retrieve "$INTENT4" "$TOKEN4" | jq -r '.userId // ""')
if [[ -n ${HOOK:-} ]]; then
  [[ $RESOLVED == "$CAROL" ]] || die "hook did not link the SAML login to the SCIM user (got '$RESOLVED')"
  oidc_login "$(idp_checks "$CAROL" "$INTENT4" "$TOKEN4")"
  [[ $(jwt_claims "$(jq -r .id_token "$WORK/tokens.json")" | jq -r .sub) == "$CAROL" ]] || die "token sub is not the SCIM user"
  echo "hook linked the SAML identity to SCIM user $CAROL; id_token sub == $CAROL (no duplicate)"
else
  [[ -z $RESOLVED ]] || die "expected no link without the hook (got $RESOLVED)"
  echo "without the hook the intent has no userId: the login would register a duplicate user"
  # what the hook does, done by hand so steps 11+ have a linked SCIM user
  rpc "$PAT" zitadel.user.v2.UserService/AddIDPLink \
    "{\"userId\":\"$CAROL\",\"idpLink\":{\"idpId\":\"$IDP\",\"userId\":\"carol\",\"userName\":\"carol@acme.example\"}}" >/dev/null
fi

log "11. SCIM deactivate carol, then SAML login again"
OUT=$(scim PATCH "Users/$CAROL" '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations":[{"op":"replace","path":"active","value":false}]}')
[[ ${OUT##*$'\n'} == 204 ]] || die "SCIM deactivate: $OUT"
echo "state: $(rpc "$PAT" zitadel.user.v2.UserService/GetUserByID "{\"userId\":\"$CAROL\"}" | jq -r .user.state)"
if read -r INTENT5 TOKEN5 < <(federate carol 2>"$WORK/fed.err"); then
  echo "IdP round trip + ACS still succeed; intent userId: $(retrieve "$INTENT5" "$TOKEN5" | jq -r '.userId // "none"')"
  if (oidc_login "$(idp_checks "$CAROL" "$INTENT5" "$TOKEN5")") >/dev/null 2>"$WORK/neg.err"; then
    die "deactivated SCIM user still got tokens via SAML"
  fi
  echo "blocked: $(grep -oE '"message":"[^"]*"' "$WORK/neg.err" | head -1)"
else
  echo "blocked at the ACS: $(cat "$WORK/fed.err")"
fi

log "12. Force SSO: org login policy allowUsernamePassword=false, then a password session for alice"
PW="Throwaway-$(openssl rand -hex 8)-1!" # never printed
rpc "$PAT" zitadel.user.v2.UserService/SetPassword \
  "{\"userId\":\"$USER\",\"newPassword\":{\"password\":\"$PW\",\"changeRequired\":false}}" >/dev/null
rpc "$PAT" "management/v1/policies/login" '{"allowUsernamePassword":false,"allowExternalIdp":true,
  "allowRegister":false,"passwordlessType":"PASSWORDLESS_TYPE_NOT_ALLOWED"}' -X PUT -H "x-zitadel-orgid: $ORG" >/dev/null
echo "login settings: $(rpc "$LOGIN_PAT" zitadel.settings.v2.SettingsService/GetLoginSettings \
  "{\"ctx\":{\"orgId\":\"$ORG\"}}" | jq -c '.settings | {allowUsernamePassword: (.allowUsernamePassword // false),
  allowLocalAuthentication: (.allowLocalAuthentication // false), allowExternalIdp}')"
# The hosted Login UI hides the login-name form and refuses password logins for
# this org. The Session API is not policy-aware: anything holding a login-client
# PAT (e.g. a custom login UI) can still complete a password login.
if (oidc_login "{\"user\":{\"userId\":\"$USER\"},\"password\":{\"password\":\"$PW\"}}") >/dev/null 2>"$WORK/neg.err"; then
  echo "Session API + CreateCallback STILL issued tokens for a password login (policy is enforced by the Login UI only)"
else
  echo "password login rejected: $(grep -oE '"message":"[^"]*"' "$WORK/neg.err" | head -1)"
fi

log "PASS: SAML IdP -> Zitadel broker -> plain OIDC tokens for rolodex (iss $BASE)"
if [[ -n ${KEEP:-} ]]; then
  echo "KEEP=1: org $ORG, idp $IDP, container $CONTAINER left running; './saml-broker-demo.sh cleanup' removes them"
fi
