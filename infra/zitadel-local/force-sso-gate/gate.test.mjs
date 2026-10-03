// Unit tests: no Zitadel needed. Run: node --test (from this directory).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { decide, makeHandler, makeLookup, verifySignature } from './gate.mjs';

const KEY = 'test-signing-key';
const sign = (body, key = KEY, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;

test('verifySignature: valid, tampered, wrong key, stale, malformed, rotation', () => {
  const body = '{"a":1}';
  const now = 1_000_000;
  const h = sign(body, KEY, now);
  assert.equal(verifySignature(h, body, [KEY], now), true);
  assert.equal(verifySignature(h, body + ' ', [KEY], now), false);
  assert.equal(verifySignature(h, body, ['other'], now), false);
  assert.equal(verifySignature(h, body, [], now), false);
  assert.equal(verifySignature(h, body, [KEY], now + 301), false);
  assert.equal(verifySignature(h, body, [KEY], now - 301), false);
  assert.equal(verifySignature(h, body, [KEY], now + 299), true);
  for (const bad of [
    undefined,
    '',
    'garbage',
    `t=${now}`,
    `v1=abcd`,
    `t=x,v1=zz`,
    `t=${now},v1=abcd`,
  ]) {
    assert.equal(verifySignature(bad, body, [KEY], now), false, String(bad));
  }
  // rotation: either key verifies
  assert.equal(verifySignature(h, body, ['old', KEY], now), true);
});

// fake lookup: org A allows passwords, org SSO does not
const lookup = (over = {}) => ({
  userOrg: async ({ loginName, userId }) =>
    ({ 'alice@sso': 'SSO', 'bob@pw': 'A' })[loginName ?? userId],
  sessionOrg: async (id) => ({ s1: 'SSO' })[id],
  sessionOrgAndFactors: async ({ sessionId }) =>
    ({
      userOnly: { orgId: 'A', factors: [] },
      pw: { orgId: 'A', factors: ['password'] },
      ssoPw: { orgId: 'SSO', factors: ['password'] },
      ssoIdp: { orgId: 'SSO', factors: ['intent'] },
      ssoPasskey: { orgId: 'SSO', factors: ['webAuthN'] },
    })[sessionId],
  allowsPassword: async (org) => org === 'A',
  ...over,
});
const cfg = { scopeOrgIds: [], forceSsoFactors: ['intent'] };
const CS = '/zitadel.session.v2.SessionService/CreateSession';
const CB = '/zitadel.oidc.v2.OIDCService/CreateCallback';
const run = (fullMethod, request, c = cfg, l = lookup()) => decide({ fullMethod, request }, l, c);

test('session gate', async () => {
  const pw = { password: { password: 'x' } };
  assert.equal(
    (await run(CS, { checks: { user: { loginName: 'alice@sso' }, ...pw } })).reason,
    'password-in-force-sso-org',
  );
  assert.equal((await run(CS, { checks: { user: { userId: 'alice@sso' }, ...pw } })).allow, false);
  assert.equal((await run(CS, { checks: { user: { loginName: 'bob@pw' }, ...pw } })).allow, true);
  assert.equal(
    (await run(CS, { checks: { user: { loginName: 'alice@sso' } } })).reason,
    'no-password-check',
  );
  assert.equal(
    (await run(CS, { checks: { user: { loginName: 'nobody' }, ...pw } })).reason,
    'org-unresolved',
  );
  assert.equal(
    (await run(CS.replace('CreateSession', 'SetSession'), { sessionId: 's1', checks: pw })).allow,
    false,
  );
  assert.equal(
    (
      await run(CS.replace('v2.', 'v2beta.'), {
        checks: { user: { loginName: 'alice@sso' }, ...pw },
      })
    ).allow,
    false,
  );
});

test('finalize gate', async () => {
  const s = (sessionId) => ({ session: { sessionId, sessionToken: 't' } });
  assert.equal((await run(CB, s('userOnly'))).reason, 'no-authn-factor');
  assert.equal((await run(CB, s('pw'))).allow, true);
  assert.equal((await run(CB, s('ssoPw'))).reason, 'force-sso-factor-missing');
  assert.equal((await run(CB, s('ssoIdp'))).allow, true);
  assert.equal((await run(CB, s('ssoPasskey'))).allow, false);
  assert.equal(
    (await run(CB, s('ssoPasskey'), { ...cfg, forceSsoFactors: ['intent', 'webAuthN'] })).allow,
    true,
  );
  assert.equal((await run(CB, {})).reason, 'no-session');
  assert.equal(
    (await run('/zitadel.saml.v2.SAMLService/CreateResponse', s('userOnly'))).allow,
    false,
  );
});

test('scope list limits enforcement but never the credential-less rule', async () => {
  const scoped = { ...cfg, scopeOrgIds: ['OTHER'] };
  const pw = { password: { password: 'x' } };
  assert.equal(
    (await run(CS, { checks: { user: { loginName: 'alice@sso' }, ...pw } }, scoped)).reason,
    'out-of-scope',
  );
  assert.equal((await run(CB, { session: { sessionId: 'ssoPw' } }, scoped)).allow, true);
  assert.equal((await run(CB, { session: { sessionId: 'userOnly' } }, scoped)).allow, false);
});

test('unknown method is denied', async () => {
  assert.equal((await run('/zitadel.user.v2.UserService/ListUsers', {})).reason, 'unknown-method');
});

async function post(handlerCfg, l, body, header, logs = []) {
  const server = http.createServer(makeHandler(handlerCfg, l, (o) => logs.push(o)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const r = await fetch(`http://127.0.0.1:${server.address().port}/force-sso`, {
    method: 'POST',
    body,
    headers: header ? { 'zitadel-signature': header } : {},
  });
  server.close();
  return r.status;
}

test('handler: fail-closed vs fail-open on lookup error, bad signature always 401, shadow', async () => {
  const body = JSON.stringify({
    fullMethod: CS,
    request: { checks: { user: { loginName: 'bob@pw' }, password: { password: 'secret-pw' } } },
  });
  const boom = lookup({
    userOrg: async () => {
      throw new Error('zitadel down');
    },
  });
  const base = { ...cfg, keys: [KEY], tsWindowS: 300, mode: 'enforce', failMode: 'closed' };
  const logs = [];
  assert.equal(await post(base, lookup(), body, sign(body), logs), 200);
  assert.equal(await post(base, boom, body, sign(body)), 403);
  assert.equal(await post({ ...base, failMode: 'open' }, boom, body, sign(body)), 200);
  assert.equal(await post({ ...base, failMode: 'open' }, boom, body, 'bad'), 401);
  assert.equal(await post(base, lookup(), body, undefined), 401);
  const denyBody = body.replace('bob@pw', 'alice@sso');
  assert.equal(await post(base, lookup(), denyBody, sign(denyBody)), 403);
  assert.equal(
    await post({ ...base, mode: 'shadow' }, lookup(), denyBody, sign(denyBody), logs),
    200,
  );
  assert.ok(logs.some((l) => l.verdict === 'deny' && l.mode === 'shadow'));
  assert.ok(!JSON.stringify(logs).includes('secret-pw'), 'passwords must never be logged');
});

test('loadConfig guards: loopback by default, TLS off-loopback, fail-closed default, https upstream', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig } = await import('./gate.mjs');
  const d = mkdtempSync(join(tmpdir(), 'gate-cfg-'));
  try {
    writeFileSync(join(d, 'pat'), 'p\n');
    writeFileSync(join(d, 'keys'), 'k1\nk2\n');
    const env = {
      ZITADEL_URL: 'http://localhost:8089',
      ZITADEL_PAT_FILE: join(d, 'pat'),
      GATE_SIGNING_KEY_FILE: join(d, 'keys'),
    };
    const c = loadConfig(env);
    assert.deepEqual(
      [c.mode, c.failMode, c.host, c.keys],
      ['enforce', 'closed', '127.0.0.1', ['k1', 'k2']],
    );
    assert.throws(() => loadConfig({ ...env, GATE_HOST: '0.0.0.0' }), /requires GATE_TLS/);
    assert.equal(
      loadConfig({ ...env, GATE_HOST: '0.0.0.0', GATE_BEHIND_TLS_PROXY: '1' }).host,
      '0.0.0.0',
    );
    assert.throws(
      () => loadConfig({ ...env, ZITADEL_URL: 'http://idp.example.com' }),
      /must be https/,
    );
    assert.throws(() => loadConfig({ ...env, GATE_FAIL_MODE: 'maybe' }), /GATE_FAIL_MODE/);
    // the upstream check must not depend on the gate's own TLS listener
    const tls = { GATE_TLS_CERT_FILE: join(d, 'pat'), GATE_TLS_KEY_FILE: join(d, 'pat') };
    assert.throws(
      () => loadConfig({ ...env, ...tls, ZITADEL_URL: 'http://idp.example.com' }),
      /must be https/,
    );
    for (const bad of ['abc', '0', '-5', '1.5', '3601', '']) {
      assert.throws(
        () => loadConfig({ ...env, GATE_TS_WINDOW_S: bad }),
        /GATE_TS_WINDOW_S/,
        `window ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(loadConfig({ ...env, GATE_TS_WINDOW_S: '60' }).tsWindowS, 60);
    assert.throws(
      () => loadConfig({ ...env, GATE_SIGNING_KEY_FILE: undefined }),
      /GATE_SIGNING_KEY_FILE is required/,
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('scope list set + unresolvable org: password check is denied (fail closed)', async () => {
  const scoped = { ...cfg, scopeOrgIds: ['OTHER'] };
  const pw = { password: { password: 'x' } };
  const r = await run(CS, { checks: { user: { loginName: 'nobody' }, ...pw } }, scoped);
  assert.deepEqual([r.allow, r.reason], [false, 'org-unresolved']);
});

test('login-name lookup is case-insensitive', async () => {
  let sent;
  const l = makeLookup({
    url: 'http://x',
    pat: 'p',
    fetchImpl: async (_u, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ result: [{ details: { resourceOwner: 'O1' } }] }) };
    },
  });
  assert.equal(await l.userOrg({ loginName: 'Alice@SSO' }), 'O1');
  assert.equal(sent.queries[0].loginNameQuery.method, 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE');
});
