# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`es-aggregates` is a TypeScript library implementing Event Sourcing and Aggregate patterns, following Domain-Driven Design (DDD) principles. It stores events in DynamoDB or Cosmos DB, or in any other database for which there is an `EventStore`. The library provides a foundation for building event-driven systems where aggregates serve as consistency boundaries.

The repository is a Yarn 1 workspace, and dev tooling that all packages share is at the root. The packages are:
- `packages/core` (`@es-aggregates/core`) - The library. It must not depend on a database's SDK
- `packages/cosmos` (`@es-aggregates/cosmos`) - Stores events in Cosmos DB for NoSQL. Its SDK (`@azure/cosmos`) and core are its peer dependencies
- `packages/dynamodb` (`@es-aggregates/dynamodb`) - Stores events in DynamoDB. The AWS SDK and core are its peer dependencies
- `packages/store-tests` (`@es-aggregates/store-tests`) - The test aggregates that the other packages' tests share. It is never published, and it is used as TypeScript source, so it builds nothing

## Key Commands

### Development
Run these at the root; they cover every package.
- `yarn test` - Run each package's test suite with Jest, one package at a time (uses `--runInBand --detectOpenHandles --forceExit`). Runs `tsc -b` first, so that no package is tested against an old build of another package
- `yarn build` - Build every package, in dependency order (runs clean → `tsc -b`). A new package needs an entry in `references` in the root `tsconfig.json`
- `yarn clean` - Remove dist, coverage, and tsconfig build info from every package

### Testing
- Tests are located in each package's `tests/` directory mirroring its `src/` structure
- Uses Jest. Only the tests of `packages/dynamodb` need DynamoDB (`@shelf/jest-dynamodb`), and only `emulator.test.ts` in `packages/cosmos` needs the Cosmos DB emulator
- Test configuration in each package's `jest.config.js` and in `packages/dynamodb/jest-dynamodb-config.js`
- `yarn workspace @es-aggregates/core test` - Run one package's tests. Those of `packages/cosmos` and `packages/dynamodb` use the build of core, so run `yarn build:tsc` first if core has changed
- `yarn workspace @es-aggregates/cosmos emulator` - Start the Cosmos DB emulator, with Docker. `docker stop es-cosmos-emulator` stops and removes it. The tests expect it at `COSMOS_EMULATOR_ENDPOINT`, or else at `http://localhost:8081`. If nothing answers there, they are skipped, but if `CI` is set they fail

### Publishing & Release
- `yarn version --patch` in `packages/core` - Creates new patch version (runs tests first)
- Releases are automated via GitHub Actions (see `.github/workflows/release.yml`)
- Use GitHub Actions "Release" workflow to create releases with proper semver versioning
- Supports patch, minor, major, and prerelease version bumps
- The Release workflow does not support workspaces yet. Until it does, the root `package.json` must have no version, so that the workflow stops before it tags anything, and the packages are `private`, so that they cannot be published

## Architecture

### Core Components

**AggregateRoot** (`packages/core/src/aggregate/aggregate-root.ts`)
- Abstract base class for domain aggregates
- Manages event recording and routing internally
- Tracks expected version for optimistic concurrency
- Uses EventRecorder for change tracking and EventRouter for event handling

**Repository** (`packages/core/src/aggregate/repository.ts`)  
- Generic repository implementation that persists events through an `EventStore`
- Handles event sourcing read/write operations
- Supports optional field-level encryption
- Requires factory function for aggregate instantiation

**EventStore** (`packages/core/src/store/event-store.ts`)
- Interface that each database's package implements. Its doc comments are the contract
- Appends all of the events or none of them, and rejects with `ConcurrencyError` (`packages/core/src/store/concurrency-error.ts`) if a version is already stored

**Cosmos DB** (`packages/cosmos/src`)
- `CosmosEventStore` - The `EventStore` for Cosmos DB. Uses transactional batches for consistency. There is no repository for it: use `new Repository(new CosmosEventStore(container), activator)`

**DynamoDB** (`packages/dynamodb/src`)
- `DynamoEventStore` - The `EventStore` for DynamoDB. Uses DynamoDB transactions for consistency
- `DynamoRepository` - A `Repository` with a `DynamoEventStore`. Its constructor is that of `Repository` in 1.x

**Event System**
- `EventBase` - Base class for domain events with encryption support
- `EventRouter` - Routes events to registered handlers
- `EventRecorder` - Tracks uncommitted changes

### DynamoDB Schema
Events are stored with:
- `aggregateId` (HASH key)
- `aggregateVersion` (RANGE key) 
- Uses conditional writes to prevent version conflicts
- Apps have events that 1.x stored, so what is stored must not change. The tests of `packages/dynamodb` compare it with the published 1.1.1

### Cosmos DB Schema
Events are stored as items with:
- `aggregateId` (partition key)
- `id`, which is the `aggregateVersion` as a string, so that a version can be stored only once
- Nothing else but the properties of `IPersistedEvent`, and those that Cosmos DB adds (their names start with an underscore)
- Only values that JSON can hold. Others are refused, so that what is read is what was appended

### Key Patterns
- Aggregates register event handlers in constructor using `this.register(EventType.typename, handler)`
- Domain changes use `this.applyChange(event)` to both apply and record events
- Repository uses activator pattern - requires factory function that returns new aggregate instance
- Optimistic concurrency control via version checking

## GitHub Actions Workflows

### CI Pipeline
- **ci.yml**: Runs tests and builds on push/PR to main/develop branches
- **pr-validation.yml**: Validates PRs with coverage reporting and build verification
- **dependabot-auto-merge.yml**: Auto-merges patch/minor dependency updates

### Release Process
- **release.yml**: Manual workflow for semantic versioning and publishing
- Supports patch, minor, major, and prerelease version bumps
- Creates git tags, GitHub releases, and publishes to npm
- Requires `NPM_TOKEN` secret for publishing
## OO-First Principle

**Business logic belongs with the object it operates on — as a method on the class — not in free-floating helper functions beside it.**

When logic operates on a class's data (a domain entity, an adapter, a service), it belongs as a method on that class, not as:
- Standalone / module-level helper functions hanging next to the class
- Utility modules
- Infrastructure adapters (for domain logic)

Fold single-use helpers into the class as **private methods** (or inline them if trivial). Don't leave a `const isFoo = (x) => ...` sitting beside the class it serves.

**Example — WRONG (a free-floating predicate beside the class that uses it):**
```typescript
const isUserNotFoundError = (error: unknown): boolean =>
  (error as { name?: string })?.name === "UserNotFoundException";

class CognitoKeyService {
  async mintKey(userId: string) {
    // ... catches err, calls isUserNotFoundError(err) ...
  }
}
```

**Example — RIGHT (folded onto the class as a private method):**
```typescript
class CognitoKeyService {
  async mintKey(userId: string) {
    // ... catches err, calls this.isUserNotFoundError(err) ...
  }

  private isUserNotFoundError(error: unknown): boolean {
    return (error as { name?: string })?.name === "UserNotFoundException";
  }
}
```

**The test:** if a function takes a class's data as input and produces output meaningful to that class, it probably belongs on the class.

**Exceptions:**
- Pure, context-free transforms (e.g. XML → DTO parsing) may live in infrastructure.
- Cross-cutting concerns (logging, metrics) stay in infrastructure.
- External API calls go through ports/adapters.
