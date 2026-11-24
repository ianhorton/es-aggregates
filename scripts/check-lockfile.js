/*
 * Fails if yarn.lock lacks a dependency of any package.
 *
 * Given --frozen-lockfile, Yarn 1 checks the root's dependencies itself, but not
 * those of the packages in the workspace: it installs the latest version that
 * matches, as if there were no lockfile. Without --frozen-lockfile, Yarn has
 * already updated yarn.lock by the time this runs.
 */
"use strict";

const { existsSync, readdirSync, readFileSync } = require("fs");
const { join } = require("path");

class LockfileCheck {
  constructor(root) {
    const folder = join(root, "packages");
    this.packages = readdirSync(folder)
      .map((name) => join(folder, name, "package.json"))
      .filter((file) => existsSync(file))
      .map((file) => JSON.parse(readFileSync(file, "utf8")));
    this.lockfile = readFileSync(join(root, "yarn.lock"), "utf8");
  }

  run() {
    const missing = this.missingDependencies();
    for (const { name, dependency } of missing) {
      console.error(`yarn.lock lacks ${dependency}, a dependency of ${name}.`);
    }
    if (missing.length > 0) {
      console.error("To update it, run yarn install without --frozen-lockfile.");
      process.exitCode = 1;
    }
  }

  missingDependencies() {
    const locked = this.lockedDependencies();
    return this.packages.flatMap(({ name, ...manifest }) =>
      this.dependencies(manifest)
        .filter((dependency) => !locked.has(dependency))
        .map((dependency) => ({ name, dependency }))
    );
  }

  // in the form that yarn.lock uses, such as uuid@^8.3.2
  dependencies({ dependencies, devDependencies, optionalDependencies }) {
    const ranges = { ...devDependencies, ...optionalDependencies, ...dependencies };
    return Object.keys(ranges)
      .filter((name) => !this.isPackage(name))
      .map((name) => `${name}@${ranges[name]}`);
  }

  // Yarn links the packages to each other, so yarn.lock has no entries for them
  isPackage(name) {
    return this.packages.some((manifest) => manifest.name === name);
  }

  // an entry's first line lists what it locks, such as: uuid@^8.3.1, uuid@^8.3.2:
  lockedDependencies() {
    return new Set(
      this.lockfile
        .split(/\r?\n/)
        .filter((line) => /^[^\s#].*:$/.test(line))
        .flatMap((line) => line.slice(0, -1).split(", "))
        .map((dependency) => dependency.replace(/"/g, ""))
    );
  }
}

new LockfileCheck(join(__dirname, "..")).run();
