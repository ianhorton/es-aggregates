/*
 * What the Prepare release and Publish workflows check, and how Prepare release
 * sets the version (see .github/RELEASE.md). Run it at the root of the repository:
 *
 *   node scripts/release.js prepare 2.0.0
 *     Checks that 2.0.0 can be released. If it can, it sets it as the version of
 *     core, dynamodb, cosmos and postgres, and removes "private" from their
 *     package.json. Nothing else in the files changes.
 *   node scripts/release.js version
 *     Prints the version of the four packages, but fails if the versions differ
 *     or if one of the packages is private, as Prepare release has not run then.
 *   node scripts/release.js on-npm @es-aggregates/core 2.0.0
 *     Prints yes if that version is on npm, or no if npm answers 404. It fails if
 *     npm answers anything else.
 *
 * It only reads from npm, and it uses no package.
 */
"use strict";

const { readFileSync, writeFileSync } = require("fs");
const { join } = require("path");

// the packages that are released, in the order in which they are published, as
// the adapters need core
const FOLDERS = [
  "packages/core",
  "packages/dynamodb",
  "packages/cosmos",
  "packages/postgres",
];

// a version of the form X.Y.Z, without a pre-release or build, such as 2.0.0
class Version {
  static parse(text) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text);
    return match ? new Version(match.slice(1).map(Number)) : undefined;
  }

  // why the text is not a version that can be released
  static problemWith(text) {
    return /^\d+\.\d+\.\d+-/.test(text)
      ? `${text} is a pre-release, and a peer range such as ^2.0.0 accepts no pre-release. Give a version of the form X.Y.Z, such as 2.0.0.`
      : `"${text}" is not a version of the form X.Y.Z, such as 2.0.0.`;
  }

  constructor(parts) {
    this.parts = parts;
  }

  // below 0 if this version is lower than the other, and 0 if it is the same
  compare(other) {
    const index = this.parts.findIndex((part, i) => part !== other.parts[i]);
    return index < 0 ? 0 : this.parts[index] - other.parts[index];
  }

  toString() {
    return this.parts.join(".");
  }
}

// a caret range of a version of the form X.Y.Z, such as ^2.0.0
class CaretRange {
  static parse(text) {
    const lowest = /^\^/.test(text) ? Version.parse(text.slice(1)) : undefined;
    return lowest ? new CaretRange(lowest) : undefined;
  }

  constructor(lowest) {
    this.lowest = lowest;
  }

  // as npm has it: the versions from the lowest one up that keep its parts up to
  // the first one that is not 0. So ^2.1.0 accepts 2.1.0 up to 2.x.y, and ^0.2.1
  // accepts 0.2.1 up to 0.2.y
  accepts(version) {
    const { parts } = this.lowest;
    const first = parts.findIndex((part) => part !== 0);
    const kept = first < 0 ? parts.length : first + 1;
    return (
      version.compare(this.lowest) >= 0 &&
      parts.slice(0, kept).every((part, i) => part === version.parts[i])
    );
  }

  // whether the version is higher than every version that the range accepts
  isBelow(version) {
    return version.compare(this.lowest) > 0 && !this.accepts(version);
  }
}

// the package.json of one of the packages
class Manifest {
  static stringify(json) {
    return `${JSON.stringify(json, null, 2)}\n`;
  }

  constructor(root, folder) {
    this.file = `${folder}/package.json`;
    this.path = join(root, this.file);
    this.text = readFileSync(this.path, "utf8");
    this.json = JSON.parse(this.text);
  }

  get name() {
    return this.json.name;
  }

  get version() {
    return this.json.version;
  }

  get isPrivate() {
    return Boolean(this.json.private);
  }

  // why this package cannot be given the version, or nothing if it can
  problemsWith(version) {
    const problems = [];
    if (this.text !== Manifest.stringify(this.json)) {
      problems.push(
        `${this.file} is not formatted as JSON.stringify(json, null, 2) formats it, with a newline at the end, so setting the version would change other lines too.`
      );
    }
    const current = Version.parse(this.version);
    if (!current) {
      problems.push(
        `${this.name} has the version ${this.version}, which is not of the form X.Y.Z, so it cannot be compared with ${version}.`
      );
    } else if (version.compare(current) <= 0) {
      problems.push(
        `${version} is not higher than ${current}, the version of ${this.name}.`
      );
    }
    return problems;
  }

  // why the peer range of this adapter for core does not accept the version, or
  // nothing if it does
  peerProblemsWith(core, version) {
    const text = this.json.peerDependencies?.[core];
    const range = CaretRange.parse(text);
    if (text === undefined) {
      return [`${this.name} has no peer dependency on ${core}.`];
    }
    if (!range) {
      return [
        `${this.name} accepts ${core} ${text}, which is not a caret range of the form ^X.Y.Z, so it cannot be checked.`,
      ];
    }
    if (range.accepts(version)) {
      return [];
    }
    const major = range.isBelow(version)
      ? ` For a new major version, change the range in ${this.file} by hand first.`
      : "";
    return [
      `${this.name} accepts ${core} ${text}, which does not include ${version}.${major}`,
    ];
  }

  // sets the version, and removes "private"
  release(version) {
    const json = { ...this.json, version: version.toString() };
    delete json.private;
    writeFileSync(this.path, Manifest.stringify(json));
  }
}

// npm's registry, which the script only reads
class Registry {
  constructor(url) {
    this.url = url;
  }

  // true if npm has that version of the package, or false if npm answers 404.
  // Any other answer throws, as it does not say that the version is not there
  async has(name, version) {
    // a scoped name keeps its @, and its / is encoded, as npm itself asks
    const url = `${this.url}/${name.replace("/", "%2f")}/${version}`;
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      await response.arrayBuffer(); // so that the connection is not kept open
    } catch (error) {
      throw new Error(`npm did not answer ${url}`, { cause: error });
    }
    if (response.status === 404) {
      return false;
    }
    if (response.ok) {
      return true;
    }
    throw new Error(
      `npm answered ${response.status} ${response.statusText} to ${url}`
    );
  }
}

class Release {
  constructor(root) {
    this.manifests = FOLDERS.map((folder) => new Manifest(root, folder));
    this.registry = new Registry("https://registry.npmjs.org");
  }

  async run(args) {
    try {
      await this.command(args);
    } catch (error) {
      this.fail([this.describe(error)]);
    }
  }

  async command([command, ...args]) {
    if (command === "prepare" && args.length === 1) {
      await this.prepare(args[0]);
    } else if (command === "version" && args.length === 0) {
      this.printVersion();
    } else if (command === "on-npm" && args.length === 2) {
      await this.printOnNpm(args[0], args[1]);
    } else {
      this.fail([
        "Usage: node scripts/release.js prepare X.Y.Z | version | on-npm NAME X.Y.Z",
      ]);
    }
  }

  async prepare(text) {
    const version = Version.parse(text);
    const problems = version
      ? await this.problemsWith(version)
      : [Version.problemWith(text)];
    if (problems.length > 0) {
      this.fail(problems);
      return;
    }
    for (const manifest of this.manifests) {
      manifest.release(version);
    }
    const names = this.manifests.map(({ name }) => name).join(", ");
    console.log(
      `Set ${version} as the version of ${names}, and removed their "private".`
    );
  }

  // why the version cannot be released, or nothing if it can
  async problemsWith(version) {
    const [core, ...adapters] = this.manifests;
    const problems = [
      ...this.manifests.flatMap((manifest) => manifest.problemsWith(version)),
      ...adapters.flatMap((adapter) =>
        adapter.peerProblemsWith(core.name, version)
      ),
    ];
    for (const { name } of this.manifests) {
      if (await this.registry.has(name, version)) {
        problems.push(`${name}@${version} is on npm already.`);
      }
    }
    return problems;
  }

  // the version that Prepare release has set in the packages
  printVersion() {
    const problems = this.manifests
      .filter((manifest) => manifest.isPrivate)
      .map(({ name }) => `${name} is private: run Prepare release first.`);
    if (new Set(this.manifests.map(({ version }) => version)).size > 1) {
      const versions = this.manifests
        .map(({ name, version }) => `${name} ${version}`)
        .join(", ");
      problems.push(
        `The versions differ (${versions}): run Prepare release first.`
      );
    }
    if (problems.length > 0) {
      this.fail(problems);
    } else {
      console.log(this.manifests[0].version);
    }
  }

  async printOnNpm(name, text) {
    const version = Version.parse(text);
    if (!version) {
      this.fail([Version.problemWith(text)]);
    } else {
      console.log((await this.registry.has(name, version)) ? "yes" : "no");
    }
  }

  // the error's message, and those of its causes, as fetch says why in a cause
  describe(error) {
    const messages = [];
    for (let cause = error; cause; cause = cause.cause) {
      messages.push(cause.message);
    }
    return messages.join(": ");
  }

  // in GitHub Actions, each problem is an error that the run's page shows
  fail(problems) {
    const prefix = process.env.GITHUB_ACTIONS === "true" ? "::error::" : "";
    for (const problem of problems) {
      console.error(`${prefix}${problem}`);
    }
    process.exitCode = 1;
  }
}

new Release(join(__dirname, "..")).run(process.argv.slice(2));
