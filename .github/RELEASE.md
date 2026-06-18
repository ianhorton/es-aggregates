# Release Process

This repository uses GitHub Actions for automated releases following semantic versioning (semver).

## How to Release

### Manual Release (Recommended)

1. Go to the **Actions** tab in GitHub
2. Select the **Release** workflow
3. Click **Run workflow**
4. Choose the version bump type:
   - **patch**: Bug fixes (0.1.0 → 0.1.1)
   - **minor**: New features (0.1.0 → 0.2.0)
   - **major**: Breaking changes (0.1.0 → 1.0.0)
   - **prerelease**: Pre-release versions (0.1.0 → 0.1.1-0)

### What Happens During Release

The flow makes **zero direct pushes to `main`** (which is branch-protected with
`enforce_admins=true`):

1. **Determine version**: the next version is derived from npm's published latest
   (the higher of npm latest and `package.json`), then bumped by the chosen type.
   This avoids republishing an existing version when `main`'s `package.json` lags npm.
   The run is refused only if that version is already published to npm.
2. **Build & Test**: project is built and the full suite must pass.
3. **Establish immutable refs first**: push only the tag `vX.Y.Z` (tags are not
   covered by the branch protection / ruleset on `main`) plus a short-lived
   `release/vX.Y.Z` branch, create the **GitHub Release**, and open the reconcile
   **auto-merging PR** for the `package.json` bump.
4. **Reconcile `main`**: the PR updates `main`'s `package.json` to the published
   version (0 approvals → merges once the required checks pass). The release job
   dispatches `ci.yml` / `pr-validation.yml` on the branch so the bot-opened PR
   gets its required checks. It is **merged, not squashed**, so the tagged commit
   stays reachable from `main` (`git describe` / bisect / provenance). `main` is
   never pushed to directly.
5. **NPM Publish (last)**: package is published to npm via **OIDC Trusted
   Publishing** (no `NPM_TOKEN`), with provenance. Publish is the final,
   most failure-prone step: if it fails, the tag/Release/PR already exist and a
   re-run re-publishes the same version (it checks out the existing tag).

### Prerequisites

- **OIDC Trusted Publishing** must be configured for this package on npmjs.com
  (one-time). No `NPM_TOKEN` secret is required.
- Repo setting **Allow auto-merge** must be enabled (Settings → General →
  Pull Requests) so the reconcile PR can auto-merge.

### Versioning Strategy

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Incompatible API changes
- **MINOR**: Backwards-compatible functionality additions
- **PATCH**: Backwards-compatible bug fixes
- **PRERELEASE**: Pre-release versions for testing

### Branch Protection

The `main` branch should be protected with the following rules:
- Require pull request reviews
- Require status checks to pass (CI workflow)
- Restrict pushes to the main branch (except for release commits)

### CI/CD Pipeline

- **PR Validation**: Every PR is tested and built
- **Continuous Integration**: Push to main/develop triggers tests
- **Automated Release**: Manual trigger with version selection
- **Dependabot**: Automatic dependency updates with auto-merge for patch/minor versions

### Emergency Hotfix Process

For critical hotfixes:
1. Create a hotfix branch from the latest release tag
2. Make necessary changes
3. Open PR to main branch
4. After merge, trigger a **patch** release
5. The hotfix will be included in the next release