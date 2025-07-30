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

1. **Tests Run**: All tests must pass
2. **Build**: Project is built and verified
3. **Version Bump**: package.json version is updated according to semver
4. **Git Tag**: A new git tag is created (e.g., v0.3.14)
5. **GitHub Release**: A GitHub release is created with changelog
6. **NPM Publish**: Package is published to npm registry

### Prerequisites

Before using the release workflow, ensure these secrets are configured in GitHub:

- `NPM_TOKEN`: Your npm authentication token for publishing

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