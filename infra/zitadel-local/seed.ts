// Fleetworks Zitadel local seed script.
//
// Node >=22 ESM, zero npm dependencies (uses global fetch + node:child_process).
// Run with: node seed.ts   (from infra/zitadel-local, after `docker compose up -d --wait`)
//
// What this does, in order:
//   1. Reads the seed-bot's Personal Access Token out of the running
//      zitadel-api container (written there by ZITADEL_FIRSTINSTANCE_PATPATH).
//   2. Finds the "Fleetworks" org created by FIRSTINSTANCE bootstrap.
//   3. Creates (or reuses) one Project: "Fleetworks Suite".
//   4. Creates (or reuses) two project roles: admin, member.
//   5. Creates (or reuses) 5 OIDC applications, one per Fleetworks app, each
//      a public Auth-Code+PKCE client scoped to that app's own localhost port.
//   6. Creates (or reuses) 2 test users and grants them project roles.
//   7. Writes generated-client-env.md with the per-app env vars.
//
// Re-running this script is safe: every resource is looked up by name/key
// before being created. The one exception is role *grants* on users — those
// are created best-effort and a 409/already-exists response is treated as
// success, not re-verified against the requested role set.
//
// API notes / deviations from a "textbook" v1 Management API integration:
//   - Zitadel's v2 "resource" APIs (project/v2, application/v2, user/v2,
//     authorization/v2, org/v2) are Connect-RPC services. Over plain HTTP
//     (no grpc/connect client library) they are unary POST endpoints at
//     POST /<fully.qualified.package>.<Service>/<Method>, JSON in, JSON out,
//     Bearer auth — no separate REST path scheme like the deprecated v1
//     Management API (/management/v1/...) uses. That's the URL scheme this
//     script's `call()` helper builds.
//   - We authenticate with a PAT (ready-to-use bearer token), not the
//     machine's JSON key + JWT-profile assertion. Both are bootstrapped by
//     docker-compose.yml; the PAT needs no crypto/signing to use from a
//     throwaway script, so it's what `call()` actually sends.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(join(__dirname, '.env'));
} catch {
  // .env optional — ZITADEL_BASE_URL/etc. can still come from the shell env.
}

const BASE_URL =
  process.env.ZITADEL_BASE_URL ??
  `http://${process.env.ZITADEL_DOMAIN ?? 'localhost'}:${process.env.PROXY_HTTP_PUBLISHED_PORT ?? '8080'}`;
const ORG_NAME = process.env.FLEETWORKS_ORG_NAME ?? 'Fleetworks';
const PROJECT_NAME = 'Fleetworks Suite';
const COMPOSE_SERVICE = 'zitadel-api';
const PAT_BOOTSTRAP_PATH = '/zitadel/bootstrap/fleetworks-seed-bot.pat';

const ROLES = [
  { key: 'admin', displayName: 'Admin' },
  { key: 'member', displayName: 'Member' },
] as const;

interface AppSpec {
  key: string;
  name: string;
  port: number;
  // Overrides below default to the port-derived http://localhost:<port>
  // shape used by the 5 browser-based web apps. A native app (a custom URI
  // scheme, no port) needs both set explicitly.
  redirectUri?: string;
  postLogoutRedirectUri?: string;
  applicationType?: 'OIDC_APP_TYPE_USER_AGENT' | 'OIDC_APP_TYPE_WEB' | 'OIDC_APP_TYPE_NATIVE';
}

// One client per app — deliberate: NOT one shared client across all 5 web
// apps, and not shared with the mobile client below either.
const APPS: AppSpec[] = [
  { key: 'helmsman', name: 'Helmsman', port: 3025 },
  {
    key: 'chorus',
    name: 'Chorus',
    port: 3021,
    // WEB, not the USER_AGENT default — same reason as yellow-pages below.
    // chorus' Phase 4 cutover runs the code exchange server-side in Node
    // (chorus/apps/web/src/app/auth/callback/route.ts is a route handler, not
    // browser JS, and the plan's Decision 3 ports yellow-pages' BFF session
    // subsystem, keeping the exchange there), matching production's
    // zitadel_application_oidc.chorus_web in fleetworks-web/infra/zitadel.tf.
    applicationType: 'OIDC_APP_TYPE_WEB',
  },
  {
    key: 'warden',
    name: 'Warden',
    port: 3020,
    // WEB, not the USER_AGENT default — same reason as chorus above and
    // yellow-pages below. warden's Phase 4 cutover runs the code exchange
    // server-side in Node (warden/apps/web/src/app/auth/callback/route.ts is a
    // route handler, not browser JS), matching the
    // zitadel_application_oidc.warden_web that Phase 4's Terraform step will
    // register in fleetworks-web/infra/zitadel.tf. Still a public client
    // (authMethodType NONE below) — direct Auth Code + PKCE, no client secret.
    applicationType: 'OIDC_APP_TYPE_WEB',
  },
  { key: 'rolodex', name: 'Rolodex', port: 3013 },
  {
    key: 'yellow-pages',
    name: 'Yellow Pages',
    port: 3023,
    // WEB, not the USER_AGENT default the other web apps take: yellow-pages'
    // Phase 4 cutover runs the code exchange server-side in Node
    // (yellow-pages/apps/web/src/app/auth/callback/route.ts is a route
    // handler, not browser JS), matching production's
    // zitadel_application_oidc.yellow_pages_web in
    // fleetworks-web/infra/zitadel.tf. Kept in step deliberately — the
    // WEB-vs-USER_AGENT axis was a real caught bug in rolodex's own plan.
    applicationType: 'OIDC_APP_TYPE_WEB',
  },
  {
    key: 'rolodex-mobile',
    name: 'Rolodex Mobile',
    port: 0, // unused — native client, no localhost port; redirectUri below is authoritative.
    // Matches apps/mobile's real makeRedirectUri({ path: 'auth/callback' })
    // output with scheme 'rolodex' — pinned exactly by
    // apps/mobile/src/lib/__tests__/fleetworks-oauth.test.ts's own mock.
    redirectUri: 'rolodex://auth/callback',
    postLogoutRedirectUri: 'rolodex://',
    applicationType: 'OIDC_APP_TYPE_NATIVE',
  },
  {
    key: 'helmsman-mobile',
    name: 'Helmsman Mobile',
    port: 0, // unused — native client, no localhost port; redirectUri below is authoritative.
    // Matches apps/mobile's makeRedirectUri({ path: 'auth/callback' }) output
    // with scheme 'helmsman' (helmsman/apps/mobile/app.config.ts:10).
    redirectUri: 'helmsman://auth/callback',
    postLogoutRedirectUri: 'helmsman://',
    applicationType: 'OIDC_APP_TYPE_NATIVE',
  },
  {
    key: 'chorus-mobile',
    name: 'Chorus Mobile',
    port: 0, // unused — native client, no localhost port; redirectUri below is authoritative.
    // Matches apps/mobile's makeRedirectUri({ path: 'auth/callback' }) output
    // with scheme 'chorus' (chorus/apps/mobile/app.json:8).
    redirectUri: 'chorus://auth/callback',
    postLogoutRedirectUri: 'chorus://',
    applicationType: 'OIDC_APP_TYPE_NATIVE',
  },
  {
    key: 'yellow-pages-mobile',
    name: 'Yellow Pages Mobile',
    port: 0, // unused — native client, no localhost port; redirectUri below is authoritative.
    // Matches apps/mobile's makeRedirectUri({ path: 'auth/callback' }) output
    // with scheme 'yellowpages' (yellow-pages/apps/mobile/app.config.js:11).
    redirectUri: 'yellowpages://auth/callback',
    postLogoutRedirectUri: 'yellowpages://',
    applicationType: 'OIDC_APP_TYPE_NATIVE',
  },
];

interface TestUserSpec {
  username: string;
  firstName: string;
  lastName: string;
  password: string;
  role: (typeof ROLES)[number]['key'];
}

const TEST_USERS: TestUserSpec[] = [
  {
    username: 'test-admin@fleetworks.dev',
    firstName: 'Test',
    lastName: 'Admin',
    password: 'TestAdmin1!',
    role: 'admin',
  },
  {
    username: 'test-member@fleetworks.dev',
    firstName: 'Test',
    lastName: 'Member',
    password: 'TestMember1!',
    role: 'member',
  },
  {
    // A THIRD generic fleet-wide identity, added for apps whose RBAC ladder has
    // three rungs rather than two: helmsman's `permissions.spec.ts` /
    // `settings.spec.ts` drive org:admin, org:contributor AND org:viewer in the
    // same run, and two seeded accounts cannot express three roles.
    //
    // Deliberately NOT app-branded (no `viewer@helmsman.local`): every existing
    // account here is fleet-generic and reusable by any app, and the per-app
    // role mapping lives in each app's own DEV_SEED_ACCOUNTS, not in this file.
    // The Zitadel `role` below is "member" because this instance only models
    // two Zitadel-level roles — an app's third rung is its own org_members
    // role, which Zitadel neither knows nor needs to know.
    username: 'test-viewer@fleetworks.dev',
    firstName: 'Test',
    lastName: 'Viewer',
    password: 'TestViewer1!',
    role: 'member',
  },
];

// --- HTTP plumbing ---------------------------------------------------------

class ConnectError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, path: string) {
    super(`${path} -> HTTP ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

function getPat(): string {
  // The zitadel-api image ships only the `/app/zitadel` binary — no shell, no
  // coreutils (`exec sh`/`exec cat` both fail with ENOENT). `docker compose cp`
  // talks to the container's filesystem directly through the daemon, so it
  // works regardless of what's installed inside the container.
  const dir = mkdtempSync(join(tmpdir(), 'fleetworks-zitadel-'));
  const localPath = join(dir, 'seed-bot.pat');
  try {
    execFileSync(
      'docker',
      ['compose', 'cp', `${COMPOSE_SERVICE}:${PAT_BOOTSTRAP_PATH}`, localPath],
      { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const pat = readFileSync(localPath, 'utf8').trim();
    if (!pat) {
      throw new Error(`Read an empty PAT from ${PAT_BOOTSTRAP_PATH} inside ${COMPOSE_SERVICE}`);
    }
    return pat;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeCaller(pat: string) {
  return async function call<T>(rpcPath: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${BASE_URL}/${rpcPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pat}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new ConnectError(res.status, json, rpcPath);
    }
    return json as T;
  };
}

type Call = ReturnType<typeof makeCaller>;

function isAlreadyExists(err: unknown): boolean {
  if (!(err instanceof ConnectError)) return false;
  if (err.status === 409) return true;
  const msg = JSON.stringify(err.body).toLowerCase();
  return msg.includes('already exist') || msg.includes('alreadyexists');
}

// --- Steps -------------------------------------------------------------

async function findOrgId(call: Call): Promise<string> {
  const res = await call<{ result?: Array<{ id: string; name: string }> }>(
    'zitadel.org.v2.OrganizationService/ListOrganizations',
    {},
  );
  const org = res.result?.find((o) => o.name === ORG_NAME);
  if (!org) {
    throw new Error(
      `Organization "${ORG_NAME}" not found. FIRSTINSTANCE bootstrap may not have run — check: docker compose logs zitadel-api`,
    );
  }
  console.log(`[org] "${ORG_NAME}" -> ${org.id}`);
  return org.id;
}

async function findOrCreateProject(call: Call, organizationId: string): Promise<string> {
  const list = await call<{ projects?: Array<{ projectId: string; name: string }> }>(
    'zitadel.project.v2.ProjectService/ListProjects',
    {},
  );
  const existing = list.projects?.find((p) => p.name === PROJECT_NAME);
  if (existing) {
    console.log(`[project] "${PROJECT_NAME}" already exists -> ${existing.projectId}`);
    return existing.projectId;
  }
  const created = await call<{ projectId: string }>(
    'zitadel.project.v2.ProjectService/CreateProject',
    { organizationId, name: PROJECT_NAME },
  );
  console.log(`[project] created "${PROJECT_NAME}" -> ${created.projectId}`);
  return created.projectId;
}

async function ensureRoles(call: Call, projectId: string): Promise<void> {
  const list = await call<{ projectRoles?: Array<{ key: string }> }>(
    'zitadel.project.v2.ProjectService/ListProjectRoles',
    { projectId },
  );
  const existingKeys = new Set((list.projectRoles ?? []).map((r) => r.key));
  for (const role of ROLES) {
    if (existingKeys.has(role.key)) {
      console.log(`[role] "${role.key}" already exists`);
      continue;
    }
    await call('zitadel.project.v2.ProjectService/AddProjectRole', {
      projectId,
      roleKey: role.key,
      displayName: role.displayName,
    });
    console.log(`[role] created "${role.key}"`);
  }
}

interface CreatedApp {
  key: string;
  name: string;
  port: number;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
}

async function findOrCreateApp(call: Call, projectId: string, app: AppSpec): Promise<CreatedApp> {
  const redirectUri = app.redirectUri ?? `http://localhost:${app.port}/auth/callback`;
  const postLogoutRedirectUri = app.postLogoutRedirectUri ?? `http://localhost:${app.port}`;
  const applicationType = app.applicationType ?? 'OIDC_APP_TYPE_USER_AGENT';

  const list = await call<{
    applications?: Array<{
      applicationId: string;
      name: string;
      oidcConfiguration?: { clientId?: string };
    }>;
  }>('zitadel.application.v2.ApplicationService/ListApplications', {
    filters: [{ projectIdFilter: { projectId } }],
  });
  const existing = list.applications?.find((a) => a.name === app.name);
  if (existing?.oidcConfiguration?.clientId) {
    console.log(`[app] "${app.name}" already exists -> ${existing.oidcConfiguration.clientId}`);
    return {
      key: app.key,
      name: app.name,
      port: app.port,
      clientId: existing.oidcConfiguration.clientId,
      redirectUri,
      postLogoutRedirectUri,
    };
  }

  const created = await call<{
    applicationId: string;
    oidcConfiguration?: { clientId: string };
  }>('zitadel.application.v2.ApplicationService/CreateApplication', {
    projectId,
    name: app.name,
    oidcConfiguration: {
      redirectUris: [redirectUri],
      responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
      grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
      // Public client, no client secret — browser Auth Code+PKCE
      // (USER_AGENT) for the 5 web apps, native Auth Code+PKCE (NATIVE,
      // custom URI scheme) for the mobile app.
      applicationType,
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      postLogoutRedirectUris: [postLogoutRedirectUri],
      // Required for http://localhost redirect URIs (non-TLS) to be
      // accepted; harmless for the mobile app's custom-scheme URI.
      developmentMode: true,
      // Zitadel defaults to opaque access tokens; every app's packages/auth
      // verifies via jose's jwtVerify(), which requires an actual JWT.
      accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
    },
  });
  const clientId = created.oidcConfiguration?.clientId;
  if (!clientId) {
    throw new Error(`CreateApplication for "${app.name}" did not return a clientId`);
  }
  console.log(`[app] created "${app.name}" -> ${clientId}`);
  return {
    key: app.key,
    name: app.name,
    port: app.port,
    clientId,
    redirectUri,
    postLogoutRedirectUri,
  };
}

async function findOrCreateUser(
  call: Call,
  organizationId: string,
  user: TestUserSpec,
): Promise<string> {
  const list = await call<{ result?: Array<{ userId: string; username: string }> }>(
    'zitadel.user.v2.UserService/ListUsers',
    {},
  );
  const existing = list.result?.find((u) => u.username === user.username);
  if (existing) {
    console.log(`[user] "${user.username}" already exists -> ${existing.userId}`);
    return existing.userId;
  }

  const created = await call<{ id: string }>('zitadel.user.v2.UserService/CreateUser', {
    organizationId,
    username: user.username,
    human: {
      profile: { givenName: user.firstName, familyName: user.lastName },
      email: { email: user.username, isVerified: true },
      password: { password: user.password, changeRequired: false },
    },
  });
  console.log(`[user] created "${user.username}" -> ${created.id}`);
  return created.id;
}

async function ensureGrant(
  call: Call,
  organizationId: string,
  projectId: string,
  userId: string,
  roleKey: string,
): Promise<void> {
  try {
    await call('zitadel.authorization.v2.AuthorizationService/CreateAuthorization', {
      userId,
      projectId,
      organizationId,
      roleKeys: [roleKey],
    });
    console.log(`[grant] "${roleKey}" -> user ${userId}`);
  } catch (err) {
    if (isAlreadyExists(err)) {
      console.log(`[grant] "${roleKey}" -> user ${userId} already exists (skipped)`);
      return;
    }
    throw err;
  }
}

async function fetchDiscovery(): Promise<{
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}> {
  const res = await fetch(`${BASE_URL}/.well-known/openid-configuration`);
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery document: HTTP ${res.status}`);
  }
  return res.json();
}

function writeGeneratedEnv(
  apps: CreatedApp[],
  discovery: Awaited<ReturnType<typeof fetchDiscovery>>,
): void {
  const lines: string[] = [];
  lines.push('# Generated by seed.ts — do not edit by hand.');
  lines.push(`# Regenerate with: node seed.ts (after docker compose up -d --wait)`);
  lines.push('');
  lines.push('This file is NOT wired into any app yet (see README.md). It documents the');
  lines.push("env vars each app's local `.env.local` would need once that wiring happens.");
  lines.push('');
  for (const app of apps) {
    lines.push(`## ${app.name}`);
    lines.push('');
    lines.push('```');
    lines.push(`ZITADEL_ISSUER=${discovery.issuer}`);
    lines.push(`ZITADEL_CLIENT_ID=${app.clientId}`);
    lines.push(`ZITADEL_JWKS_URI=${discovery.jwks_uri}`);
    lines.push(`ZITADEL_AUTHORIZATION_ENDPOINT=${discovery.authorization_endpoint}`);
    lines.push(`ZITADEL_TOKEN_ENDPOINT=${discovery.token_endpoint}`);
    lines.push(`ZITADEL_REDIRECT_URI=${app.redirectUri}`);
    lines.push(`ZITADEL_POST_LOGOUT_REDIRECT_URI=${app.postLogoutRedirectUri}`);
    lines.push('```');
    lines.push('');
  }
  const outPath = join(__dirname, 'generated-client-env.md');
  writeFileSync(outPath, lines.join('\n'));
  console.log(`[env] wrote ${outPath}`);
}

// --- Main ----------------------------------------------------------------

async function main() {
  console.log(`Seeding Zitadel at ${BASE_URL} ...`);
  const pat = getPat();
  const call = makeCaller(pat);

  const organizationId = await findOrgId(call);
  const projectId = await findOrCreateProject(call, organizationId);
  await ensureRoles(call, projectId);

  const apps: CreatedApp[] = [];
  for (const app of APPS) {
    apps.push(await findOrCreateApp(call, projectId, app));
  }

  for (const user of TEST_USERS) {
    const userId = await findOrCreateUser(call, organizationId, user);
    await ensureGrant(call, organizationId, projectId, userId, user.role);
  }

  const discovery = await fetchDiscovery();
  writeGeneratedEnv(apps, discovery);

  console.log('\nDone. Test users:');
  for (const user of TEST_USERS) {
    console.log(`  ${user.username} / ${user.password} (role: ${user.role})`);
  }
}

main().catch((err) => {
  console.error('\nSeed script failed:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
