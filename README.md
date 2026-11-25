# es-aggregates

A TypeScript library for event-sourced aggregates, following Domain-Driven Design (DDD) principles. An aggregate is stored as the list of events that happened to it, and is read by replaying them. The events can be in DynamoDB, in Cosmos DB, or in any other database that you write a store for.

> **This is the README of 2.0, which is not on npm yet.** npm has 1.x, as `es-aggregates`: see [the README of 1.1.1](https://github.com/ianhorton/es-aggregates/blob/v1.1.1/README.md).

## Features

- Aggregate roots and entities that change state only through events
- Type-safe event handlers
- Optimistic concurrency: a write that is based on old state is refused, so nothing is overwritten
- Field-level encryption of the properties that you choose
- The same aggregates on DynamoDB, Cosmos DB or a store of your own

## Packages

| Package | What it is | Install it |
| --- | --- | --- |
| [`@es-aggregates/core`](packages/core/README.md) | Aggregates, events, `Repository`, and the `EventStore` interface | always |
| [`@es-aggregates/dynamodb`](packages/dynamodb/README.md) | Stores events in DynamoDB | to use DynamoDB |
| [`@es-aggregates/cosmos`](packages/cosmos/README.md) | Stores events in Azure Cosmos DB for NoSQL | to use Cosmos DB |

Each database's package needs that database's SDK too. Its README has the command that installs everything.

Are you on 1.x? See [Migrating from 1.x](docs/migrating-from-1.x.md).

## Example

This needs a DynamoDB table called `events`, whose partition key is `aggregateId` (a string) and whose sort key is `aggregateVersion` (a number).

```typescript
import { AggregateRoot, EventBase } from "@es-aggregates/core";
import { DynamoDBClient, DynamoRepository } from "@es-aggregates/dynamodb";
import { randomUUID } from "node:crypto";

class UserCreated extends EventBase {
  static eventType = "UserCreated";

  constructor(readonly id: string, readonly name: string) {
    super();
  }
}

class UserRenamed extends EventBase {
  static eventType = "UserRenamed";

  constructor(readonly name: string) {
    super();
  }
}

class User extends AggregateRoot {
  id = "";
  name = "";

  constructor() {
    super();
    this.register(UserCreated.eventType, (e: UserCreated) => {
      this.id = e.id;
      this.name = e.name;
    });
    this.register(UserRenamed.eventType, (e: UserRenamed) => {
      this.name = e.name;
    });
  }

  static create(id: string, name: string): User {
    const user = new User();
    user.applyChange(new UserCreated(id, name));
    return user;
  }

  rename(name: string): void {
    this.applyChange(new UserRenamed(name));
  }
}

const users = new DynamoRepository(
  "events", // the table
  () => new User(), // makes an empty user, for a read to fill
  new DynamoDBClient({}) // takes the region and the credentials from the environment
);

async function main(): Promise<void> {
  const id = randomUUID();
  await users.writeAsync(User.create(id, "John"));

  const user = await users.readAsync(id);
  if (user === undefined) {
    throw new Error("There is no such user.");
  }
  user.rename("Jane");
  await users.writeAsync(user);

  const renamed = await users.readAsync(id);
  console.log(renamed?.name); // Jane
}

main().catch(console.error);
```

On Cosmos DB, only `users` differs. This needs a container called `events`, whose partition key path is `/aggregateId`.

```typescript
import { CosmosClient } from "@azure/cosmos";
import { Repository } from "@es-aggregates/core";
import { CosmosEventStore } from "@es-aggregates/cosmos";

const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
  consistencyLevel: "Session", // to read what this client wrote
});
const container = client.database("app").container("events");

const users = new Repository(
  new CosmosEventStore(container),
  () => new User()
);
```

If two processes change the same user at once, the second write is rejected with a `ConcurrencyError`. See [how to retry](packages/core/README.md#concurrencyerror-and-how-to-retry).

## Development

You need:

- Node.js 22 or 24, which are the versions that CI tests on
- Yarn 1
- Java, for DynamoDB Local, which the tests of `packages/dynamodb` use
- Docker, if you want to run the tests that use the Cosmos DB emulator

```bash
git clone https://github.com/ianhorton/es-aggregates.git
cd es-aggregates
yarn install
yarn build
yarn test
```

`yarn test` runs the tests of every package. The first time, it downloads DynamoDB Local. The tests that need the Cosmos DB emulator are skipped if nothing answers at `http://localhost:8081`. To start it, and to stop it afterwards:

```bash
yarn workspace @es-aggregates/cosmos emulator
docker stop es-cosmos-emulator
```

To run the tests of one package, such as core:

```bash
yarn build:tsc
yarn workspace @es-aggregates/core test
```

To add a package for another database, see [Writing a store](packages/core/README.md#writing-a-store).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
