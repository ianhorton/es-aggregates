# es-aggregates

A TypeScript library for implementing Event Sourcing and Aggregate patterns with DynamoDB integration, following Domain-Driven Design (DDD) principles.

## Description

`es-aggregates` is a lightweight, type-safe library that helps you implement Event Sourcing and Aggregate patterns in your TypeScript applications, following Domain-Driven Design principles. It provides a robust foundation for building event-driven systems with DynamoDB as the event store, where aggregates serve as consistency boundaries and encapsulate domain logic.

## Features

- Domain-Driven Design (DDD) Aggregate Root implementation
- Event Sourcing implementation with TypeScript
- Aggregate pattern support with consistency boundaries
- DynamoDB integration for event persistence
- Type-safe event routing
- Built-in entity management
- **Snapshot support for performance optimization** (new!)
- Field-level encryption support
- Comprehensive test coverage

## Installation

```bash
npm install es-aggregates
# or
yarn add es-aggregates
```

## Setup

### DynamoDB Table

The library requires a DynamoDB table with the following schema:

```typescript
{
  TableName: "your-events-table-name",
  KeySchema: [
    { AttributeName: "aggregateId", KeyType: "HASH" },
    { AttributeName: "aggregateVersion", KeyType: "RANGE" }
  ],
  AttributeDefinitions: [
    { AttributeName: "aggregateId", AttributeType: "S" },
    { AttributeName: "aggregateVersion", AttributeType: "N" }
  ]
}
```

You can create this table using the AWS Console, AWS CLI, or Infrastructure as Code tools like CloudFormation or Terraform.

## Usage

```typescript
import { AggregateRoot, EventBase, Repository } from 'es-aggregates';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { v4 } from 'uuid';

// Define your events
class UserCreated extends EventBase {
  public static typename = "UserCreated";
  constructor(public readonly id: string, public readonly name: string) {
    super(UserCreated.typename, ["name"]);
  }
}

class UserNameChanged extends EventBase {
  public static typename = "UserNameChanged";
  constructor(public readonly id: string, public readonly name: string) {
    super(UserNameChanged.typename, ["name"]);
  }
}

// Create your aggregate root
class User extends AggregateRoot {
  private _id: string;
  public get id(): string {
    return this._id;
  }

  private _name: string;
  public get name(): string {
    return this._name;
  }

  constructor() {
    super();
    
    // Register event handlers
    this.register(UserCreated.typename, (e: UserCreated) => {
      this._id = e.id;
      this._name = e.name;
    });

    this.register(UserNameChanged.typename, (e: UserNameChanged) => {
      this._id = e.id;
      this._name = e.name;
    });
  }

  // Factory method to create a new user
  public static create(id: string, name: string): User {
    const user = new User();
    const userCreated = new UserCreated(id, name);
    user.applyChange(userCreated);
    return user;
  }

  // Domain method to change user's name
  public changeName(newName: string) {
    const nameChangedEvent = new UserNameChanged(this.id, newName);
    this.applyChange(nameChangedEvent);
  }
}

// Set up DynamoDB client
const dynamoClient = new DynamoDBClient({
  region: 'your-region',
  // Add your AWS credentials or use environment variables
});

// Create repository
const userRepository = new Repository<User>(
  'your-events-table-name',
  User.create, // Factory function
  dynamoClient
);

// Usage example
async function example() {
  // Create a new user
  const userId = v4();
  const user = User.create(userId, "John Doe");
  
  // Save the user to DynamoDB
  await userRepository.writeAsync(user);
  
  // Read the user back
  const savedUser = await userRepository.readAsync(userId);
  console.log(savedUser?.name); // "John Doe"
  
  // Make changes
  savedUser?.changeName("Jane Doe");
  
  // Save changes
  await userRepository.writeAsync(savedUser!);
  
  // Read again to verify changes
  const updatedUser = await userRepository.readAsync(userId);
  console.log(updatedUser?.name); // "Jane Doe"
}

// Handle concurrent modifications
async function handleConcurrentModifications() {
  const userId = v4();
  const user1 = User.create(userId, "John");
  await userRepository.writeAsync(user1);
  
  // Simulate concurrent access
  const user2 = await userRepository.readAsync(userId);
  const user3 = await userRepository.readAsync(userId);
  
  // Make changes to both instances
  user2?.changeName("Jane");
  user3?.changeName("Bob");
  
  // First save succeeds
  await userRepository.writeAsync(user2!);
  
  // Second save fails due to version mismatch
  try {
    await userRepository.writeAsync(user3!);
  } catch (error) {
    console.log("Concurrent modification detected!");
  }
}
```

## Snapshots

Snapshots are an optimization technique that dramatically improves aggregate loading performance for aggregates with large event histories. Instead of replaying all events from the beginning, the library can load from the latest snapshot and only replay events that occurred after it.

### Why Use Snapshots?

- **Performance**: Reduce load times by 80-99% for aggregates with 1000+ events
- **Cost Efficiency**: Fewer DynamoDB read operations
- **Scalability**: Handle aggregates with very large event histories

### Enabling Snapshots

Snapshots are disabled by default to ensure backwards compatibility. To enable them, use the new configuration object format:

```typescript
import { Repository, IRepositoryConfig } from 'es-aggregates';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const dynamoClient = new DynamoDBClient({ region: 'your-region' });

// Configure repository with snapshots enabled
const config: IRepositoryConfig = {
  tableName: 'your-events-table-name',
  snapshot: {
    enabled: true,
    frequency: 100,  // Create snapshot every 100 events (default)
    retention: 3,    // Keep last 3 snapshots (default)
  }
};

const repository = new Repository<User>(
  config,
  () => new User(),  // Factory function
  dynamoClient
);
```

### How Snapshots Work

1. **Storage**: Snapshots are stored in the same DynamoDB table as events using negative version numbers (-1, -2, -3, etc.)
2. **Creation**: Snapshots are automatically created when the aggregate version is a multiple of the configured frequency
3. **Loading**: When reading an aggregate, the repository loads the latest snapshot and replays only subsequent events
4. **Retention**: Old snapshots are automatically deleted based on the retention policy

### Configuration Options

```typescript
interface ISnapshotConfig {
  enabled: boolean;        // Enable/disable snapshots (default: false)
  frequency?: number;      // Create snapshot every N events (default: 100)
  retention?: number;      // Keep last N snapshots (default: 3)
  autoSnapshot?: boolean;  // Auto-create snapshots on write (default: true)
  serializer?: ISnapshotSerializer; // Custom serializer (optional)
}
```

### Manual Snapshot Management

You can manually create or delete snapshots:

```typescript
// Manually create a snapshot for an aggregate
await repository.createManualSnapshotAsync(userId);

// Delete all snapshots for an aggregate
await repository.deleteSnapshotsAsync(userId);
```

### Custom Serialization

For aggregates with complex types (Dates, custom classes, etc.), you can provide a custom serializer:

```typescript
class User extends AggregateRoot {
  private _id: string;
  private _name: string;
  private _createdAt: Date;
  private _addresses: Address[];

  // ... constructor and methods ...

  // Define custom snapshot serialization
  toSnapshot(): Record<string, any> {
    return {
      _id: this._id,
      _name: this._name,
      _createdAt: this._createdAt.toISOString(),
      _addresses: this._addresses.map(a => ({
        street: a.street,
        city: a.city
      }))
    };
  }

  fromSnapshot(data: Record<string, any>): void {
    this._id = data._id;
    this._name = data._name;
    this._createdAt = new Date(data._createdAt);
    this._addresses = data._addresses.map(a =>
      new Address(a.street, a.city)
    );
  }
}

// Configure repository with custom serializer
const config: IRepositoryConfig = {
  tableName: 'users-table',
  snapshot: {
    enabled: true,
    serializer: {
      serialize: (user) => user.toSnapshot(),
      deserialize: (data, user) => user.fromSnapshot(data)
    }
  }
};
```

### Snapshot Performance Example

```typescript
// Without snapshots: Load 1000 events
// - Query all 1000 events from DynamoDB
// - Replay all 1000 events
// - Time: ~500ms

// With snapshots (frequency: 100):
// - Query latest snapshot (at version 1000)
// - Replay 0-99 events since snapshot
// - Time: ~50ms
// - Performance improvement: 90%
```

### Migration Guide

Existing aggregates can adopt snapshots without any data migration:

1. **Update repository configuration** to enable snapshots
2. **No changes to aggregate code** required (unless using custom serialization)
3. **First snapshot created** on next write after enabling
4. **Subsequent loads** automatically use snapshots

```typescript
// Before (still works!)
const repo = new Repository<User>(
  'users-table',
  () => new User(),
  dynamoClient
);

// After (with snapshots)
const repo = new Repository<User>(
  {
    tableName: 'users-table',
    snapshot: { enabled: true }
  },
  () => new User(),
  dynamoClient
);
```

### Best Practices

1. **Frequency**: Set based on your aggregate's event volume
   - High-volume aggregates: 50-100 events
   - Low-volume aggregates: 500-1000 events

2. **Retention**: Keep 2-3 snapshots for safety
   - Allows rollback if latest snapshot corrupted
   - Minimal storage overhead

3. **Testing**: Test snapshot serialization with your domain models
   - Ensure complex types serialize correctly
   - Verify encrypted fields work as expected

4. **Monitoring**: Track snapshot creation and loading
   - Monitor load time improvements
   - Watch for serialization errors

### Backwards Compatibility

Snapshots are fully backwards compatible:

- ✅ Disabled by default - existing code works unchanged
- ✅ Old constructor signature still supported
- ✅ No DynamoDB schema changes required
- ✅ Events remain the source of truth
- ✅ Failed snapshot operations don't break event sourcing

## Development

### Prerequisites

- Node.js (LTS version recommended)
- Yarn package manager

### Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/es-aggregates.git
cd es-aggregates
```

2. Install dependencies:
```bash
yarn install
```

### Available Scripts

- `yarn test` - Run the test suite
- `yarn build` - Build the project
- `yarn version --patch` - Create a new patch version
- `npm publish` - Publish to npm

### Testing

The project uses Jest for testing. Run the test suite with:

```bash
yarn test
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
