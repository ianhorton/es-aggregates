# Release Process

`@es-aggregates/core`, `@es-aggregates/dynamodb` and `@es-aggregates/cosmos` are released together, with the same version, by two workflows. Each of them runs from `main` only, and only when it is started by hand.

## To release

1. Run the **Prepare release** workflow with the version, such as `2.0.0`. It sets the version in the three packages, removes their `"private"`, and opens a pull request with that.
2. Review the pull request, and merge it.
3. Run the **Publish** workflow. Its first job, `build`, builds and tests `main`, and packs the three packages.
4. When `build` has passed, approve the second job, `publish`, in the `npm` environment. It publishes to npm the packages that `build` packed, tags the commit `vX.Y.Z`, and creates the GitHub release.

Prepare release refuses a version that is not of the form X.Y.Z (so no pre-release), that is not higher than the version of each package, that is on npm already, or that the adapters' peer range for `@es-aggregates/core` does not accept. For a new major version, change that range by hand first, in `packages/dynamodb/package.json` and `packages/cosmos/package.json`. Its checks are in `scripts/release.js`, which can be run locally: `node scripts/release.js prepare X.Y.Z`. If they pass, it changes the three `package.json` files, as the workflow does.

Publish has two jobs, so that the job that can publish runs no code from the packages' dependencies. `build` can only read the repository: it installs the dependencies, builds and tests, packs the three packages with `npm pack`, and uploads the files as the artifact `packages`, which is kept for 90 days. `publish` installs and builds nothing: it checks that each file holds the package and the version that it should, and publishes it with `npm publish`, unless that version is on npm already.

If Publish fails, it can be run again: it skips what is done already, and it never publishes anything twice. A run can be run again for 30 days after it started.

- If `publish` failed, use **Re-run failed jobs**. It runs only `publish` again, with the packages that `build` packed, so nothing is built again. If it cannot download them, use **Re-run all jobs**, which builds, tests and packs the same commit again.
- If `build` failed, nothing was published. Use **Re-run all jobs**, or, if the fault is in `main`, fix it there and run Publish again.

## Once, before the first release

1. Create the environment `npm` (**Settings → Environments**), with yourself as required reviewer, and `main` as its only deployment branch. If it is missing, a run of Publish creates it, but without a reviewer.
2. For each of the three packages, publish a placeholder `0.0.0` by hand, as npm adds a trusted publisher only to a package that exists. Run `npm publish --access public` in a folder that holds only a `package.json`, such as `{ "name": "@es-aggregates/core", "version": "0.0.0" }`.
3. Add the trusted publisher of each package. npm asks for your 2FA code.
   ```sh
   npm trust github @es-aggregates/core --repo ianhorton/es-aggregates --file publish.yml --env npm --allow-publish
   npm trust github @es-aggregates/dynamodb --repo ianhorton/es-aggregates --file publish.yml --env npm --allow-publish
   npm trust github @es-aggregates/cosmos --repo ianhorton/es-aggregates --file publish.yml --env npm --allow-publish
   ```
4. Run Publish within 2 days, or the trusted publishers expire.

`es-aggregates`, the package of 1.x, stays at 1.1.1 on npm. If 1.x needs a fix, a branch from the tag `v1.1.1` has the workflow that released it.
