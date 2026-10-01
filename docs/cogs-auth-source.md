# `@cogs/auth` source location and consumption (fw-jq4)

Verified 2026-10-01.

## Source

- Repo: `catesworks/cogs` (local clone: `/Volumes/dev-ssd/repos/catesworks/cogs`, remote `git@catesworks.github.com:catesworks/cogs.git`).
- Path: `packages/auth` (package name `@cogs/auth`, version `0.7.0`, MIT).
- Sibling: `@cogs/auth-events` (`packages/auth-events`) lives in the same repo.
- Not `fleetworks-monorepo`: that repo only publishes `@fleet-works/suite-nav` and `@fleet-works/ui`.
- npm metadata still lists `repository.url` as `git+https://github.com/catesandrew/cogs.git` (pre-migration owner; commit `9d04836` migrated to `catesworks/cogs`). GitHub resolves both names to `catesworks/cogs`.

## Publishing

- Public npm registry, `publishConfig.access: public`, no install token needed (`cogs/.npmrc`).
- Changesets (`cogs/.changeset/`) + `cogs/.github/workflows/release.yml`, using npm trusted publishing (OIDC).
- `npm view @cogs/auth` latest = `0.7.0`, equal to the source version. Note a pending changeset (`auth-role-floor.md`, commit `1185f69`) is not yet released, so source `main` is ahead of the registry.

## Consumption in fw-* repos

Consumed as a normal registry dependency, not via workspace/link/file. The lockfiles resolve `@cogs/auth@x.y.z` with a registry integrity hash. There is no `.npmrc` or `pnpm-workspace.yaml` entry mapping `@cogs` anywhere, and the `overrides` blocks in `package.json` do not touch `@cogs/auth`.

| Repo | Range |
| --- | --- |
| fw-chorus | `^0.7.0` |
| fw-helmsman | `^0.7.0` |
| fw-rolodex | `^0.7.0` |
| fw-yellow-pages | `^0.7.0` |
| fw-warden | `^0.6.0` (behind) |
| fw-monorepo, fw-web | not a consumer |

To change `@cogs/auth`: edit `cogs/packages/auth`, add a changeset, release via the cogs workflow, then bump the range in each consumer. Editing a consumer's `node_modules` or linking locally is not how the fleet consumes it.
