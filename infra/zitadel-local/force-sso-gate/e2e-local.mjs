// Local e2e for the force-SSO gate against a LOCAL Zitadel (fw-uwku).
//
// Usage (from anywhere; local stack up on :8089):
//   node e2e-local.mjs            run, then clean up
//   node e2e-local.mjs cleanup    remove leftover fw-uwku-gate-* orgs
// Env: ZITADEL_BASE_URL (default http://localhost:8089, localhost only).
//
// What it does NOT do: register any Actions V2 target/execution. Executions are
// instance-wide and would sit on every login of the shared stack, and its default
// HTTP denylist refuses a localhost target anyway. Instead it creates two throwaway
// orgs (one force-SSO, one password-allowed) with real users and real sessions via
// the Session API (like saml-broker-demo.sh), runs the gate's real Zitadel lookups
// in-process, and feeds the gate HMAC-signed payloads shaped like Zitadel's target
// calls. The full Zitadel->target path (EXEC-dra6yamk98 on deny) was proven on a
// throwaway instance in ../force-sso-enforcement-findings.md.
// The seed-bot PAT is used for setup AND as the gate's lookup PAT (local only; prod
// uses an IAM_OWNER_VIEWER PAT). Never prints PATs, tokens or passwords.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHandler, makeLookup } from './gate.mjs';

const ZITADEL_LOCAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ZITADEL_BASE_URL ?? 'http://localhost:8089';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) {
  throw new Error('ZITADEL_BASE_URL must be http://localhost:<port>');
}
if (process.env.DOCKER_HOST)
  throw new Error('DOCKER_HOST is set; unset it (local Docker engine only)');
const ctx = execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim();
if (!['default', 'desktop-linux', 'orbstack'].includes(ctx))
  throw new Error(
    `docker context must be a local engine: default, desktop-linux or orbstack (got ${ctx})`,
  );

const dir = mkdtempSync(join(tmpdir(), 'fw-uwku-gate-'));
let PAT;
try {
  execFileSync(
    'docker',
    [
      'compose',
      'cp',
      'zitadel-api:/zitadel/bootstrap/fleetworks-seed-bot.pat',
      join(dir, 'seed.pat'),
    ],
    {
      cwd: ZITADEL_LOCAL_DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  PAT = readFileSync(join(dir, 'seed.pat'), 'utf8').trim();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

async function rpc(path, body, { method = 'POST', org } = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${PAT}`,
      ...(org && { 'x-zitadel-orgid': org }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `${path} -> HTTP ${res.status}: ${text.replace(/"password":"[^"]*"/g, '"password":"<redacted>"')}`,
    );
  return JSON.parse(text);
}
const deleteOrg = (organizationId) =>
  rpc('zitadel.org.v2.OrganizationService/DeleteOrganization', { organizationId });
const PREFIX = 'fw-uwku-gate-';

async function cleanup() {
  const { result = [] } = await rpc('zitadel.org.v2.OrganizationService/ListOrganizations', {
    queries: [{ nameQuery: { name: PREFIX, method: 'TEXT_QUERY_METHOD_STARTS_WITH' } }],
  });
  for (const o of result) {
    await deleteOrg(o.id);
    console.log(`deleted org ${o.id}`);
  }
}
if (process.argv[2] === 'cleanup') {
  await cleanup();
  process.exit(0);
}

const KEY = randomBytes(24).toString('hex');
const sign = (body) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', KEY).update(`${t}.${body}`).digest('hex')}`;
};
const CS = '/zitadel.session.v2.SessionService/CreateSession';
const CB = '/zitadel.oidc.v2.OIDCService/CreateCallback';
let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got} (want ${want})`);
};

const orgs = [];
const servers = [];
const gate = async (cfg, url = BASE) => {
  const base = {
    keys: [KEY],
    tsWindowS: 300,
    mode: 'enforce',
    failMode: 'closed',
    scopeOrgIds: [],
    forceSsoFactors: ['intent'],
    ...cfg,
  };
  const s = http.createServer(
    makeHandler(base, makeLookup({ url, pat: PAT, timeoutMs: 2000 }), () => {}),
  );
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  servers.push(s);
  return async (fullMethod, request) => {
    const body = JSON.stringify({ fullMethod, request });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/force-sso`, {
      method: 'POST',
      body,
      headers: { 'zitadel-signature': sign(body) },
    });
    return r.status;
  };
};

try {
  const stamp = Date.now();
  const mkOrg = async (kind, allowPassword) => {
    const org = (
      await rpc('zitadel.org.v2.OrganizationService/AddOrganization', {
        name: `${PREFIX}${kind}-${stamp}`,
      })
    ).organizationId;
    orgs.push(org);
    if (!allowPassword) {
      await rpc(
        'management/v1/policies/login',
        {
          allowUsernamePassword: false,
          allowExternalIdp: true,
          allowRegister: false,
          passwordlessType: 'PASSWORDLESS_TYPE_NOT_ALLOWED',
        },
        { org },
      );
    }
    const password = `Throwaway-${randomBytes(8).toString('hex')}-1!`; // never printed
    const username = `${kind}@gate${stamp}.example`;
    const { userId } = await rpc('zitadel.user.v2.UserService/AddHumanUser', {
      organization: { orgId: org },
      username,
      profile: { givenName: kind, familyName: 'Gate' },
      email: { email: username, isVerified: true },
      password: { password, changeRequired: false },
    });
    return { org, username, password, userId };
  };
  const sso = await mkOrg('sso', false);
  const pw = await mkOrg('pw', true);
  // Session API and policy reads go through projections: wait for them.
  for (const u of [sso, pw]) {
    for (let i = 0; ; i++) {
      try {
        const r = await rpc('zitadel.settings.v2.SettingsService/GetLoginSettings', {
          ctx: { orgId: u.org },
        });
        await rpc('zitadel.user.v2.UserService/GetUserByID', { userId: u.userId });
        if ((r.settings?.allowUsernamePassword === true) === (u === pw)) break;
      } catch {
        /* projection not ready */
      }
      if (i > 40) throw new Error('projections did not settle');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log('setup: force-SSO org + password org with one user each');

  const session = async (u, withPassword) => {
    const checks = {
      user: { loginName: u.username },
      ...(withPassword && { password: { password: u.password } }),
    };
    const s = await rpc('zitadel.session.v2.SessionService/CreateSession', { checks }); // ungated shared stack
    return { sessionId: s.sessionId, sessionToken: s.sessionToken };
  };
  // the hole the gate closes: the Session API happily creates these
  const ssoPw = await session(sso, true);
  const ssoOnly = await session(sso, false);
  const pwPw = await session(pw, true);
  const pwOnly = await session(pw, false);

  const g = await gate({});
  const pwCheck = (u) => ({
    checks: { user: { loginName: u.username }, password: { password: 'not-printed' } },
  });
  check('session gate: password in force-SSO org', await g(CS, pwCheck(sso)), 403);
  check('session gate: password in password org', await g(CS, pwCheck(pw)), 200);
  check(
    'session gate: user-only in force-SSO org',
    await g(CS, { checks: { user: { loginName: sso.username } } }),
    200,
  );
  check(
    'session gate: SetSession password, org via GetSession',
    await g('/zitadel.session.v2.SessionService/SetSession', {
      sessionId: ssoOnly.sessionId,
      checks: { password: { password: 'x' } },
    }),
    403,
  );
  check(
    'finalize gate: credential-less session (password org)',
    await g(CB, { authRequestId: 'x', session: pwOnly }),
    403,
  );
  check(
    'finalize gate: credential-less session (force-SSO org)',
    await g(CB, { authRequestId: 'x', session: ssoOnly }),
    403,
  );
  check(
    'finalize gate: password session in password org (mint-route analogue)',
    await g(CB, { authRequestId: 'x', session: pwPw }),
    200,
  );
  check(
    'finalize gate: password session in force-SSO org',
    await g(CB, { authRequestId: 'x', session: ssoPw }),
    403,
  );
  check(
    'finalize gate: no session (error path)',
    await g(CB, { authRequestId: 'x', error: { error: 'ACCESS_DENIED' } }),
    200,
  );

  const shadow = await gate({ mode: 'shadow' });
  check('shadow mode: would-deny answers 200', await shadow(CS, pwCheck(sso)), 200);
  const scoped = await gate({ scopeOrgIds: [pw.org] });
  check('scope list: force-SSO org out of scope is allowed', await scoped(CS, pwCheck(sso)), 200);
  check('scope list: credential-less still denied', await scoped(CB, { session: pwOnly }), 403);

  const down = 'http://127.0.0.1:1'; // nothing listens: lookups fail
  check(
    'fail-closed default: Zitadel unreachable',
    await (
      await gate({}, down)
    )(CS, pwCheck(pw)),
    403,
  );
  check(
    'fail-open switch: Zitadel unreachable',
    await (
      await gate({ failMode: 'open' }, down)
    )(CS, pwCheck(pw)),
    200,
  );

  for (const s of [ssoPw, ssoOnly, pwPw, pwOnly]) {
    await rpc('zitadel.session.v2.SessionService/DeleteSession', s).catch(() => {});
  }
} finally {
  for (const s of servers) s.close();
  for (const o of orgs)
    await deleteOrg(o).then(
      () => console.log(`cleaned up org ${o}`),
      (e) => console.error(`CLEANUP FAILED for org ${o}: ${e.message}`),
    );
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
