// Suite-level identity check (bead fleetworks-monorepo-e8s.5.2.15).
//
// Mints one real Auth Code + PKCE token per suite WEB client for ONE Zitadel
// identity (headless recipe from README.md "Verifying it works yourself"), then
// for every app given on the command line calls its `/api/me`:
//   - with the token minted for the app's OWN web client  -> expect 200
//   - with each token minted for ANOTHER app's web client -> expect 401
//
// Usage (from infra/zitadel-local, local stack up on :8089):
//   node suite-identity-check.mjs --app rolodex=http://localhost:4013 [--app chorus=http://localhost:4021 ...]
// Apps: rolodex chorus helmsman warden yellow-pages. Optional: --login <name>
// --password <pw> --me-path /api/me. Env: ZITADEL_BASE_URL (default
// http://localhost:8089). Client ids/redirect URIs come from
// generated-client-env.md, so a re-seed needs no edit here.
//
// Never prints tokens or PATs: only non-secret claims (sub, azp, aud, email).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ZITADEL_BASE_URL ?? 'http://localhost:8089';
const SECTIONS = {
  rolodex: 'Rolodex',
  chorus: 'Chorus',
  helmsman: 'Helmsman',
  warden: 'Warden',
  'yellow-pages': 'Yellow Pages',
};

const { values } = parseArgs({
  options: {
    app: { type: 'string', multiple: true, default: [] },
    login: { type: 'string', default: 'test-admin@fleetworks.dev' },
    password: { type: 'string', default: 'TestAdmin1!' }, // seeded local-only test user (README)
    'me-path': { type: 'string', default: '/api/me' },
  },
});

const targets = values.app.map((spec) => {
  const [name, url] = spec.split(/=(.*)/s);
  if (!SECTIONS[name] || !url) throw new Error(`bad --app "${spec}" (want <app>=<baseUrl>)`);
  return { name, url: url.replace(/\/$/, '') };
});
if (targets.length === 0) throw new Error('pass at least one --app <name>=<apiBaseUrl>');

// generated-client-env.md: "## <Section>" followed by KEY=VALUE lines.
function readClients() {
  const md = readFileSync(join(HERE, 'generated-client-env.md'), 'utf8');
  const out = {};
  for (const [name, section] of Object.entries(SECTIONS)) {
    const block = md.split(`\n## ${section}\n`)[1]?.split('\n## ')[0] ?? '';
    const get = (k) => block.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1].trim();
    const clientId = get('ZITADEL_CLIENT_ID');
    const redirectUri = get('ZITADEL_REDIRECT_URI');
    if (!clientId || !redirectUri)
      throw new Error(`no ${section} client in generated-client-env.md`);
    out[name] = { clientId, redirectUri };
  }
  return out;
}

function readPat(file) {
  const dir = mkdtempSync(join(tmpdir(), 'suite-idcheck-'));
  try {
    execFileSync(
      'docker',
      ['compose', 'cp', `zitadel-api:/zitadel/bootstrap/${file}`, join(dir, file)],
      {
        cwd: HERE,
        stdio: ['ignore', 'ignore', 'pipe'], // compose's progress noise; surfaced in the thrown error on failure
      },
    );
    return readFileSync(join(dir, file), 'utf8').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rpc(method, body, pat) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pat}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function mint({ clientId, redirectUri }, session, loginPat) {
  const verifier = randomBytes(32).toString('base64url');
  const authUrl = new URL(`${BASE}/oauth/v2/authorize`);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'suite-idcheck',
  }).toString();
  const loc = (await fetch(authUrl, { redirect: 'manual' })).headers.get('location');
  const authRequestId = loc && new URL(loc, BASE).searchParams.get('authRequest');
  if (!authRequestId)
    throw new Error(`authorize for ${clientId}: no authRequest in Location (${loc})`);
  const cb = await rpc(
    'zitadel.oidc.v2.OIDCService/CreateCallback',
    { authRequestId, session },
    loginPat,
  );
  const code = new URL(cb.callbackUrl).searchParams.get('code');
  const res = await fetch(`${BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token for ${clientId} -> HTTP ${res.status}: ${await res.text()}`);
  const { access_token } = await res.json();
  if (access_token?.split('.').length !== 3)
    throw new Error(`access token for ${clientId} is not a JWT`);
  return access_token;
}

async function me(url, token) {
  const res = await fetch(`${url}${values['me-path']}`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch((err) => ({ status: `ERR ${err.cause?.code ?? err.message}`, text: async () => '' }));
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

const clients = readClients();
const seedPat = readPat('fleetworks-seed-bot.pat');
const loginPat = readPat('login-client.pat');
const { sessionId, sessionToken } = await rpc(
  'zitadel.session.v2.SessionService/CreateSession',
  { checks: { user: { loginName: values.login }, password: { password: values.password } } },
  seedPat,
);

const tokens = {};
for (const [name, client] of Object.entries(clients)) {
  tokens[name] = await mint(client, { sessionId, sessionToken }, loginPat);
  const c = claims(tokens[name]);
  console.log(
    `[mint] ${name}: sub=${c.sub} azp=${c.azp ?? c.client_id} aud=${[c.aud].flat().join(',')}`,
  );
}

let failed = 0;
const results = [];
for (const { name, url } of targets) {
  const own = await me(url, tokens[name]);
  const ownOk = own.status === 200;
  const ownId = ownOk ? own.body.id : undefined;
  console.log(
    `\n[${name}] own (${clients[name].clientId}) -> ${own.status} ${JSON.stringify(own.body)}`,
  );
  if (!ownOk) failed++;
  const foreign = {};
  for (const other of Object.keys(clients).filter((n) => n !== name)) {
    const r = await me(url, tokens[other]);
    const audHasOwn = [claims(tokens[other]).aud].flat().includes(clients[name].clientId);
    foreign[other] = r.status;
    console.log(
      `[${name}] foreign ${other} (aud includes ${name} client: ${audHasOwn}) -> ${r.status}`,
    );
    if (r.status !== 401) failed++;
  }
  results.push({ app: name, url, own: own.status, userId: ownId, email: own.body?.email, foreign });
}

console.log(
  '\nSUMMARY ' + JSON.stringify({ login: values.login, sub: claims(tokens.rolodex).sub, results }),
);
process.exit(failed ? 1 : 0);
