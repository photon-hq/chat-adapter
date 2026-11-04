# Changesets

Every pull request that changes the published package adds a changeset: run `pnpm changeset`, pick the bump, and describe the change for the changelog. Releasing is automatic. When changesets land on `main`, the Release workflow opens a "Version Packages" pull request, and merging that pull request publishes to npm.
