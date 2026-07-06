# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`es-aggregates` is a TypeScript library implementing Event Sourcing and Aggregate patterns with DynamoDB integration, following Domain-Driven Design (DDD) principles. The library provides a foundation for building event-driven systems where aggregates serve as consistency boundaries.

## Key Commands

### Development
- `yarn test` - Run the test suite with Jest (uses `--runInBand --detectOpenHandles --forceExit`)
- `yarn build` - Build the project (runs clean → tsc)
- `yarn clean` - Remove dist, coverage, and tsconfig build info

### Testing
- Tests are located in the `tests/` directory mirroring the `src/` structure
- Uses Jest with DynamoDB integration (`@shelf/jest-dynamodb`)
- Test configuration in `jest.config.js` and `jest-dynamodb-config.js`

### Publishing & Release
- `yarn version --patch` - Creates new patch version (runs tests first)
- Releases are automated via GitHub Actions (see `.github/workflows/release.yml`)
- Use GitHub Actions "Release" workflow to create releases with proper semver versioning
- Supports patch, minor, major, and prerelease version bumps

## Architecture

### Core Components

**AggregateRoot** (`src/aggregate/aggregate-root.ts`)
- Abstract base class for domain aggregates
- Manages event recording and routing internally
- Tracks expected version for optimistic concurrency
- Uses EventRecorder for change tracking and EventRouter for event handling

**Repository** (`src/aggregate/repository.ts`)  
- Generic repository implementation for DynamoDB persistence
- Handles event sourcing read/write operations
- Supports optional field-level encryption
- Uses DynamoDB transactions for consistency
- Requires factory function for aggregate instantiation

**Event System**
- `EventBase` - Base class for domain events with encryption support
- `EventRouter` - Routes events to registered handlers
- `EventRecorder` - Tracks uncommitted changes

### DynamoDB Schema
Events are stored with:
- `aggregateId` (HASH key)
- `aggregateVersion` (RANGE key) 
- Uses conditional writes to prevent version conflicts

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
