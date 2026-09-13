# fleetworks-monorepo

**Topics:** `fw`

Shared npm packages for the Fleetworks suite (chorus, helmsman, rolodex,
warden, yellow-pages + the fleetworks.dev apex site).

## Packages

- [`@fleet-works/suite-nav`](packages/suite-nav) — zero-dependency registry of
  every app in the suite.
- [`@fleet-works/ui`](packages/ui) — shared design tokens, app switcher, logo
  lockup, footer.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Releasing

```bash
pnpm changeset        # describe your change
git commit -am "..."  # commit the changeset file with your change
```

Merging to `main` opens a "Version Packages" PR via Changesets; merging that
PR publishes to npm (Trusted Publishing / OIDC, no token required) and tags
the release.
