// Force-SSO gate: Zitadel Actions V2 restWebhook target (fw-uwku).
// Design and proof: ../force-sso-enforcement-findings.md. Ops: ../force-sso-gate-ops.md.
//
// One endpoint (POST /force-sso) serves both gates, chosen by `fullMethod`:
//   session gate   (Create/SetSession, v2 + v2beta): deny a password check for a
//                  user whose org has allowUsernamePassword != true.
//   finalize gate  (CreateCallback v2 + v2beta, AuthorizeOrDenyDeviceAuthorization,
//                  SAML CreateResponse): deny sessions with no authentication
//                  factor; in force-SSO orgs deny sessions without an allowed factor.
// 2xx = allow, anything else = deny (Zitadel target with interruptOnError: true).
//
// Config (env; secrets are read from FILES, never from argv or committed):
//   ZITADEL_URL                 required, e.g. http://localhost:8089 (dev) or https://idp.example.com
//   ZITADEL_PAT_FILE            required, PAT of an IAM_OWNER_VIEWER machine user (lookups only)
//   GATE_SIGNING_KEY_FILE       required, target signingKey, one per line (2 lines during rotation)
//   GATE_MODE                   enforce (default) | shadow (log verdicts, always answer 200)
//   GATE_FAIL_MODE              closed (default) | open: what to do when a LOOKUP fails
//                               (Zitadel unreachable, 5xx, timeout, unexpected error). A bad or
//                               missing signature is always 401, in both modes.
//   GATE_FORCE_SSO_FACTORS      default "intent". Factors that satisfy a force-SSO org. Add
//                               "webAuthN" to allow passkeys there (owner policy decision).
//   GATE_SCOPE_ORG_IDS          optional comma list. Only enforce for these orgs; other orgs are
//                               allowed unchecked (staged rollout). Empty = all orgs. A password
//                               check whose org cannot be determined is DENIED even when a scope
//                               list is set (fail closed: we cannot show it is out of scope).
//   GATE_TS_WINDOW_S            signature timestamp tolerance in seconds, integer 1..3600, default 300
//   GATE_HOST / GATE_PORT       default 127.0.0.1 / 8787
//   GATE_TLS_CERT_FILE/KEY_FILE serve HTTPS directly. Binding a non-loopback address requires
//                               these, or GATE_BEHIND_TLS_PROXY=1 (a TLS-terminating proxy).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const SESSION_METHODS = new Set([
  '/zitadel.session.v2.SessionService/CreateSession',
  '/zitadel.session.v2.SessionService/SetSession',
  '/zitadel.session.v2beta.SessionService/CreateSession',
  '/zitadel.session.v2beta.SessionService/SetSession',
]);
const FINALIZE_METHODS = new Set([
  '/zitadel.oidc.v2.OIDCService/CreateCallback',
  '/zitadel.oidc.v2beta.OIDCService/CreateCallback',
  '/zitadel.oidc.v2.OIDCService/AuthorizeOrDenyDeviceAuthorization',
  '/zitadel.saml.v2.SAMLService/CreateResponse',
]);
export const GATED_METHODS = [...SESSION_METHODS, ...FINALIZE_METHODS];
const AUTHN_FACTORS = ['password', 'intent', 'webAuthN', 'totp', 'otpSms', 'otpEmail'];

// ZITADEL-Signature: t=<unix>,v1=<hex HMAC-SHA256(signingKey, "<t>.<raw body>")>
export function verifySignature(header, rawBody, keys, nowS = Date.now() / 1000, windowS = 300) {
  const parts = String(header ?? '')
    .split(',')
    .map((kv) => kv.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!/^\d+$/.test(t ?? '') || sigs.length === 0 || keys.length === 0) return false;
  if (Math.abs(nowS - Number(t)) > windowS) return false;
  let ok = false; // no early exit: every key x sig pair is compared
  for (const key of keys) {
    const mac = createHmac('sha256', key).update(`${t}.${rawBody}`).digest();
    for (const sig of sigs) {
      const given = Buffer.from(sig, 'hex');
      if (given.length === mac.length && timingSafeEqual(given, mac)) ok = true;
    }
  }
  return ok;
}

// Pure policy. `lookup` = { userOrg(userCheck), sessionOrgAndFactors(session), sessionOrg(id),
// allowsPassword(orgId) }; it throws on infrastructure errors (the caller applies GATE_FAIL_MODE).
// Returns { allow, reason, orgId? }.
export async function decide(payload, lookup, cfg) {
  const { fullMethod: method, request: req = {} } = payload;
  const scoped = (orgId) => cfg.scopeOrgIds.length === 0 || cfg.scopeOrgIds.includes(orgId);

  if (SESSION_METHODS.has(method)) {
    if (!req.checks?.password) return { allow: true, reason: 'no-password-check' };
    const orgId = req.checks.user
      ? await lookup.userOrg(req.checks.user)
      : req.sessionId
        ? await lookup.sessionOrg(req.sessionId)
        : undefined;
    if (!orgId) return { allow: false, reason: 'org-unresolved' };
    if (!scoped(orgId)) return { allow: true, reason: 'out-of-scope', orgId };
    return (await lookup.allowsPassword(orgId))
      ? { allow: true, reason: 'password-allowed', orgId }
      : { allow: false, reason: 'password-in-force-sso-org', orgId };
  }

  if (FINALIZE_METHODS.has(method)) {
    if (!req.session?.sessionId) return { allow: true, reason: 'no-session' }; // error/deny path
    const { orgId, factors } = await lookup.sessionOrgAndFactors(req.session);
    if (!AUTHN_FACTORS.some((f) => factors.includes(f))) {
      // credential-less sessions are the fleet-wide hole: refuse them in every org
      return { allow: false, reason: 'no-authn-factor', orgId };
    }
    if (!scoped(orgId)) return { allow: true, reason: 'out-of-scope', orgId };
    if (
      !(await lookup.allowsPassword(orgId)) &&
      !cfg.forceSsoFactors.some((f) => factors.includes(f))
    ) {
      return { allow: false, reason: 'force-sso-factor-missing', orgId };
    }
    return { allow: true, reason: 'authn-ok', orgId };
  }
  return { allow: false, reason: 'unknown-method' };
}

export function makeLookup({ url, pat, timeoutMs = 3000, fetchImpl = fetch }) {
  const rpc = async (path, body) => {
    const r = await fetchImpl(`${url}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  };
  const getSession = (sessionId, sessionToken) =>
    rpc('zitadel.session.v2.SessionService/GetSession', { sessionId, sessionToken }).then(
      (r) => r.session,
    );
  return {
    async userOrg({ userId, loginName }) {
      if (userId) {
        return (await rpc('zitadel.user.v2.UserService/GetUserByID', { userId })).user?.details
          ?.resourceOwner;
      }
      if (!loginName) return undefined;
      const { result = [] } = await rpc('zitadel.user.v2.UserService/ListUsers', {
        queries: [
          { loginNameQuery: { loginName, method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } },
        ],
      });
      return result.length === 1 ? result[0].details?.resourceOwner : undefined;
    },
    async sessionOrg(sessionId) {
      return (await getSession(sessionId)).factors?.user?.organizationId;
    },
    async sessionOrgAndFactors({ sessionId, sessionToken }) {
      const f = (await getSession(sessionId, sessionToken)).factors ?? {};
      return { orgId: f.user?.organizationId, factors: AUTHN_FACTORS.filter((k) => f[k]) };
    },
    async allowsPassword(orgId) {
      const r = await rpc('zitadel.settings.v2.SettingsService/GetLoginSettings', {
        ctx: { orgId },
      });
      return r.settings?.allowUsernamePassword === true; // absent (proto3 false) = force-SSO
    },
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env = process.env) {
  const need = (k) =>
    env[k] ||
    (() => {
      throw new Error(`${k} is required`);
    })();
  const oneOf = (k, allowed, dflt) => {
    const v = env[k] ?? dflt;
    if (!allowed.includes(v)) throw new Error(`${k} must be one of ${allowed.join('|')}`);
    return v;
  };
  const list = (v, dflt = '') =>
    (v ?? dflt)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const cfg = {
    url: need('ZITADEL_URL').replace(/\/$/, ''),
    pat: readFileSync(need('ZITADEL_PAT_FILE'), 'utf8').trim(),
    keys: readFileSync(need('GATE_SIGNING_KEY_FILE'), 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    mode: oneOf('GATE_MODE', ['enforce', 'shadow'], 'enforce'),
    failMode: oneOf('GATE_FAIL_MODE', ['closed', 'open'], 'closed'),
    forceSsoFactors: list(env.GATE_FORCE_SSO_FACTORS, 'intent'),
    scopeOrgIds: list(env.GATE_SCOPE_ORG_IDS),
    tsWindowS: Number(env.GATE_TS_WINDOW_S ?? 300),
    host: env.GATE_HOST ?? '127.0.0.1',
    port: Number(env.GATE_PORT ?? 8787),
    tls:
      env.GATE_TLS_CERT_FILE && env.GATE_TLS_KEY_FILE
        ? { cert: readFileSync(env.GATE_TLS_CERT_FILE), key: readFileSync(env.GATE_TLS_KEY_FILE) }
        : undefined,
  };
  if (cfg.keys.length === 0) throw new Error('GATE_SIGNING_KEY_FILE has no key');
  if (!Number.isInteger(cfg.tsWindowS) || cfg.tsWindowS < 1 || cfg.tsWindowS > 3600) {
    throw new Error('GATE_TS_WINDOW_S must be an integer between 1 and 3600');
  }
  if (!LOOPBACK.has(cfg.host) && !cfg.tls && env.GATE_BEHIND_TLS_PROXY !== '1') {
    throw new Error(
      'non-loopback GATE_HOST requires GATE_TLS_CERT_FILE/GATE_TLS_KEY_FILE or GATE_BEHIND_TLS_PROXY=1',
    );
  }
  // cfg.tls is the gate's own listener, unrelated to the upstream: the PAT goes to ZITADEL_URL
  if (!LOOPBACK.has(new URL(cfg.url).hostname) && new URL(cfg.url).protocol !== 'https:') {
    throw new Error('ZITADEL_URL must be https unless it is localhost (the PAT is sent to it)');
  }
  return cfg;
}

export function makeHandler(cfg, lookup, log = (o) => console.log(JSON.stringify(o))) {
  const stats = { allow: 0, deny: 0, lookupError: 0, badSignature: 0, shadowWouldDeny: 0 };
  const handler = (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, mode: cfg.mode, failMode: cfg.failMode, stats }));
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      // end-to-end dependency check: can we still read login settings from Zitadel?
      lookup.allowsPassword('').then(
        () => res.writeHead(200).end('ready'),
        () => res.writeHead(503).end('not ready'),
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/force-sso') return res.writeHead(404).end();
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1 << 20) req.destroy();
    });
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (
        !verifySignature(
          req.headers['zitadel-signature'],
          body,
          cfg.keys,
          Date.now() / 1000,
          cfg.tsWindowS,
        )
      ) {
        stats.badSignature++;
        log({ event: 'gate', verdict: 'deny', reason: 'bad-signature' });
        return res.writeHead(401).end();
      }
      let payload;
      let v;
      try {
        payload = JSON.parse(body);
        v = await decide(payload, lookup, cfg);
      } catch (e) {
        stats.lookupError++;
        v =
          cfg.failMode === 'open'
            ? { allow: true, reason: 'lookup-error-fail-open' }
            : { allow: false, reason: 'lookup-error-fail-closed' };
        log({ event: 'gate', level: 'error', err: e.message });
      }
      // never log the body: it carries plaintext passwords
      log({
        event: 'gate',
        method: payload?.fullMethod,
        verdict: v.allow ? 'allow' : 'deny',
        reason: v.reason,
        orgId: v.orgId,
        mode: cfg.mode,
      });
      if (!v.allow && cfg.mode === 'shadow') stats.shadowWouldDeny++;
      const allow = v.allow || cfg.mode === 'shadow';
      stats[allow ? 'allow' : 'deny']++;
      // generic body: Zitadel does not forward it, and nothing internal should leak
      res
        .writeHead(allow ? 200 : 403, { 'content-type': 'application/json' })
        .end(allow ? '{}' : '{"error":"denied"}');
    });
  };
  return handler;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const server = cfg.tls
    ? https.createServer(cfg.tls, makeHandler(cfg, makeLookup(cfg)))
    : http.createServer(makeHandler(cfg, makeLookup(cfg)));
  server.requestTimeout = 10_000;
  server.listen(cfg.port, cfg.host, () =>
    console.log(
      JSON.stringify({
        event: 'listening',
        host: cfg.host,
        port: cfg.port,
        tls: Boolean(cfg.tls),
        mode: cfg.mode,
        failMode: cfg.failMode,
      }),
    ),
  );
}
