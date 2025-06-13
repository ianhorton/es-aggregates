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
import { AggregateRoot, EventBase } from 'es-aggregates';
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
    this._name = newName;
    this.applyChange(nameChangedEvent);
  }
}

// Usage example
const userId = v4();
const user = User.create(userId, "John Doe");
console.log(user.name); // "John Doe"

user.changeName("Jane Doe");
console.log(user.name); // "Jane Doe"

// Get all pending changes
const changes = user.getChanges();
console.log(changes.length); // 2 (UserCreated and UserNameChanged events)
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
