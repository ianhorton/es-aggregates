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
- Comprehensive test coverage

## Installation

```bash
npm install es-aggregates
# or
yarn add es-aggregates
```

## Usage

```typescript
import { AggregateRoot, EventRouter, DynamoDBClient } from 'es-aggregates';

// Define your events
class UserCreatedEvent extends EventBase {
  constructor(public readonly userId: string, public readonly name: string) {
    super();
  }
}

// Create your aggregate
class User extends AggregateRoot {
  private name: string;

  constructor(id: string) {
    super(id);
  }

  create(name: string) {
    this.apply(new UserCreatedEvent(this.id, name));
  }

  onUserCreated(event: UserCreatedEvent) {
    this.name = event.name;
  }
}

// Set up event routing
const router = new EventRouter();
router.register(UserCreatedEvent, (event) => {
  // Handle the event
});
```

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
