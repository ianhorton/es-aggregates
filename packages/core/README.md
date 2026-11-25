# @es-aggregates/core

Aggregates, events, `Repository`, and the `EventStore` interface. There is no database code in it: to store events, add [`@es-aggregates/dynamodb`](../dynamodb/README.md) or [`@es-aggregates/cosmos`](../cosmos/README.md), or [write a store](#writing-a-store).

- [Install](#install)
- [Events](#events)
- [Aggregates](#aggregates)
- [Entities](#entities)
- [Repository](#repository)
- [ConcurrencyError and how to retry](#concurrencyerror-and-how-to-retry)
- [Field encryption](#field-encryption)
- [EventStore](#eventstore)
- [Writing a store](#writing-a-store)

## Install

2.0 is [not on npm yet](../../README.md).

```bash
npm install @es-aggregates/core
```

The package of each database needs it too, as a peer dependency.

## Events

```typescript
// user-events.ts
import { EventBase } from "@es-aggregates/core";

export class UserCreated extends EventBase {
  static eventType = "UserCreated";
  static encryptedProps = ["name"]; // optional: see Field encryption

  constructor(readonly id: string, readonly name: string) {
    super();
  }
}

export class UserRenamed extends EventBase {
  static eventType = "UserRenamed";
  static encryptedProps = ["name"];

  constructor(readonly name: string) {
    super();
  }
}
```

- `eventType` is stored with each event, and it finds the handler when the event is read. So once there are stored events, do not change it.
- The event's other properties are its data. Use strings, numbers, booleans, `null`, arrays and plain objects. What else can be stored depends on the store. `undefined` is not stored.
- `timestamp` is when the event was made, in ISO 8601 and in UTC. The order of events comes from their versions, not from it. In a time zone that has daylight saving time, an event made in the hour that is repeated when the clocks go back can have a timestamp that is up to an hour wrong. If that matters, run in UTC (`TZ=UTC`).
- The older form, `super("UserCreated", ["name"])`, still works. It logs a warning, once for each event type.

## Aggregates

```typescript
// user.ts
import { AggregateRoot } from "@es-aggregates/core";

import { UserCreated, UserRenamed } from "./user-events";

export class User extends AggregateRoot {
  private _id = "";
  private _name = "";

  get id(): string {
    return this._id;
  }

  get name(): string {
    return this._name;
  }

  constructor() {
    super();
    this.register(UserCreated.eventType, (e: UserCreated) => {
      this._id = e.id;
      this._name = e.name;
    });
    this.register(UserRenamed.eventType, (e: UserRenamed) => {
      this._name = e.name;
    });
  }

  static create(id: string, name: string): User {
    const user = new User();
    user.applyChange(new UserCreated(id, name));
    return user;
  }

  rename(name: string): void {
    if (name === "") {
      throw new Error("A user must have a name.");
    }
    this.applyChange(new UserRenamed(name));
  }
}
```

- `applyChange` calls the event's handler, and records the event, to be written later.
- Put the rules in the methods, as `rename` does, and not in the handlers. The handlers run again whenever the aggregate is read, so they should only set state.
- When an aggregate is read, its handlers get plain objects that have the properties of the events. They are not instances of the event classes, so do not call methods on them.
- An event that has no handler is an error, both in `applyChange` and when the aggregate is read. So keep the handlers of old events.
- `id` must be set by the first event's handler, because the repository stores the events under it.
- `hasChanges()` and `getChanges()` tell what is not written yet. `getChanges()` returns the aggregate's own list, which a write empties. To use the events after the write, copy the list first: `[...user.getChanges()]`.
- `getExpectedVersion()` is how many events are stored, as far as the aggregate knows. The first event of an aggregate has version 0.
- Write at least every 100 changes. If there are 100 that are not written, `applyChange` throws. Its handler has run by then, so do not use that object any more.

## Entities

An entity is an object inside an aggregate, with an identity and event handlers of its own.

```typescript
// order.ts
import { AggregateRoot, Entity, EventBase, IEvent } from "@es-aggregates/core";

class OrderPlaced extends EventBase {
  static eventType = "OrderPlaced";

  constructor(readonly id: string) {
    super();
  }
}

class LineAdded extends EventBase {
  static eventType = "LineAdded";

  constructor(readonly lineId: string, readonly quantity: number) {
    super();
  }
}

class QuantityChanged extends EventBase {
  static eventType = "QuantityChanged";

  constructor(readonly lineId: string, readonly quantity: number) {
    super();
  }
}

export class Line extends Entity {
  id = "";
  quantity = 0;

  constructor(applier: (e: IEvent) => void) {
    super(applier);
    this.register(LineAdded.eventType, (e: LineAdded) => {
      this.id = e.lineId;
      this.quantity = e.quantity;
    });
    this.register(QuantityChanged.eventType, (e: QuantityChanged) => {
      this.quantity = e.quantity;
    });
  }

  changeQuantity(quantity: number): void {
    this.apply(new QuantityChanged(this.id, quantity));
  }
}

export class Order extends AggregateRoot {
  id = "";
  readonly lines = new Map<string, Line>();

  constructor() {
    super();
    this.register(OrderPlaced.eventType, (e: OrderPlaced) => {
      this.id = e.id;
    });
    this.register(LineAdded.eventType, (e: LineAdded) => {
      const line = new Line(this.applyChange);
      line.route(e);
      this.lines.set(e.lineId, line);
    });
    this.register(QuantityChanged.eventType, (e: QuantityChanged) => {
      this.lines.get(e.lineId)?.route(e);
    });
  }

  static place(id: string): Order {
    const order = new Order();
    order.applyChange(new OrderPlaced(id));
    return order;
  }

  addLine(lineId: string, quantity: number): void {
    this.applyChange(new LineAdded(lineId, quantity));
  }
}
```

`apply` in an entity hands the event to the aggregate, which records it. The aggregate needs a handler for it too, and that handler passes the event on with `route`.

## Repository

```typescript
// user-repository.ts
import { EventStore, Repository } from "@es-aggregates/core";

import { User } from "./user";

export const createUserRepository = (store: EventStore): Repository<User> =>
  new Repository(store, () => new User());
```

The arguments are:

| Argument | What it is |
| --- | --- |
| `store` | An `EventStore`, such as `new CosmosEventStore(container)`. For DynamoDB there is a shortcut, [`DynamoRepository`](../dynamodb/README.md) |
| `activator` | Makes an empty aggregate, for a read to fill |
| `debug` | `true` logs each read and write of this repository: ids, event types and versions, but no values. The default is `false` |

- `readAsync(id, encryptionKey?)` reads all the events of the aggregate and replays them. It returns `undefined` if there are none.
- `writeAsync(aggregate, encryptionKey?)` stores the aggregate's changes: all of them, or none. If there are none to store, it does nothing. If it fails, the aggregate still has its changes.
- `IRepository<T>` is the interface with these two methods, for your own code and tests to depend on.

Take care with these:

- **Wait for each write before you change the aggregate again.** A change that is made during a write is not stored. And the next write of that object then skips a version. After that, every write of that aggregate is rejected with a `ConcurrencyError`.
- **Never delete one of an aggregate's events, and do not let them expire.** The repository takes the number of events as the next version, so a gap has the same effect.
- **`debug` logs the ids of aggregates**, and the types and versions of their events. So if an id must not get into your logs, because it is an email address for example, leave `debug` off. It logs no other value of an event, and no key. Each repository has its own setting, which does not affect the others.

## ConcurrencyError and how to retry

A write is rejected with a `ConcurrencyError` if another write stored one of its versions first. Nothing of the rejected write is stored. Read the aggregate again, and make the change again:

```typescript
// rename-user.ts
import { ConcurrencyError, IRepository } from "@es-aggregates/core";

import { User } from "./user";

export async function renameUser(
  users: IRepository<User>,
  id: string,
  name: string,
  attempts = 5
): Promise<void> {
  const user = await users.readAsync(id);
  if (user === undefined) {
    throw new Error(`There is no user ${id}.`);
  }
  user.rename(name);

  try {
    await users.writeAsync(user);
  } catch (error) {
    if (!(error instanceof ConcurrencyError) || attempts <= 1) {
      throw error;
    }
    await renameUser(users, id, name, attempts - 1);
  }
}
```

- Writing the same object again does not help: its version is still taken.
- A `ConcurrencyError` for a new aggregate means that its id is already in use.
- The error has `aggregateId`, `expectedVersion`, and `cause`, which is what the database answered.
- `instanceof` needs a single copy of `@es-aggregates/core` in your app. If you may have more, check `error.name === "ConcurrencyError"`.
- **Any other error can mean that it is not known whether the events were stored.** After a timeout or a lost connection, for example, they may have been, or not. So read the aggregate again before you retry anything. If you make the change again without looking, it can be stored twice.

## Field encryption

`encryptedProps` names the properties of an event that are to be encrypted. Pass the key to each write and read:

```typescript
// encryption.ts
import { IRepository } from "@es-aggregates/core";

import { User } from "./user";

export async function copyNameAsync(
  users: IRepository<User>,
  id: string,
  key: string
): Promise<string | undefined> {
  await users.writeAsync(User.create(id, "John"), key);
  const user = await users.readAsync(id, key);
  return user?.name; // John
}
```

The values are encrypted with AES-256-GCM. The key can be any string, but it is hashed only once, with SHA-256. So use a long random one, such as `randomBytes(32).toString("base64")`, and not a password.

**What it protects:** the values of those properties, where they are stored.

**What it does not protect:**

- Other properties, or a property inside an object or an array. Only the event's own properties can be listed. A name that the event does not have is ignored, so check the spelling.
- Ids, event types, timestamps, the names of properties, and the length of each value.
- The aggregate in memory. `debug` logs none of its values but the id.
- Anything against someone who can change what is stored. If they alter an encrypted value, a read notices, and treats it like one that has the wrong key. But they can replace it by plain text, or by another value that was encrypted with the same key, and that is not noticed.

**Only strings are encrypted.** If a listed property has another kind of value, a write with a key is rejected, and stores nothing. `undefined` and `null` are left as they are.

**With no key, or the wrong one:**

| | No key | The wrong key |
| --- | --- | --- |
| Write | The values are stored as plain text, **without a warning** | The values are encrypted with that key |
| Read | Encrypted values are returned as they are stored, beginning with `ENC1.`, and an error is logged with `console.error` for each | The same |

- A value that was written without a key is plain text. It is read as it is, with any key or none.
- An aggregate that was read without the right key has encrypted text in its properties. Do not copy that into new events.
- An empty string counts as a key, and not as none. If yours comes from the environment, check that it is not empty.
- A read uses one key for all of the aggregate's events. There is no key rotation. If you lose the key, the values are lost.
- `encryptedProps` is stored with each event, and a read goes by that. So if you add a property to it, the events that are already stored stay as they are.
- An encrypted value has about 70 characters more than the value, plus a third of its size. That counts towards the store's size limits.

`encrypt`, `decrypt` and `isEncrypted` are exported too.

## EventStore

A repository keeps events in an `EventStore`. It has two methods:

| Method | What it does |
| --- | --- |
| `appendAsync(aggregateId, events, expectedVersion)` | Stores the events, all of them or none |
| `readAsync(aggregateId)` | Returns all of the aggregate's events |

Each event is an `IPersistedEvent`, which is how it is stored: `aggregateId`, `aggregateVersion`, `eventType`, `timestamp`, `encryptedProps` (if the event declares it), and `data`, which has the event's other properties.

A store keeps this contract, which is in the [doc comments](src/store/event-store.ts) and in the tests that every store must pass:

- An append has events of contiguous versions, and the first is `expectedVersion`. If any of those versions is already stored, or is being stored by someone else, the append is rejected with a `ConcurrencyError` that has a `cause`, and stores nothing.
- Any other rejection can mean that the outcome is not known: either all of the events were stored, or none. Then the aggregate must be read again before anything is retried. So a store rejects with a `ConcurrencyError` only if it is sure that the append has not stored the version itself.
- `undefined` is not stored, at any depth. A property that holds it is left out, and so is an array element.
- Any other value is read back as it was, or is refused: then the append is rejected with another error, and stores nothing. `Date`, `NaN`, `Infinity` and instances of classes must be refused.
- The events are stored as they were when the append was called. They are not modified.
- A read returns the events in the order of their versions, however they were appended. If there are none, it returns an empty array.
- Ids are compared exactly: case and spaces count.
- 100 events can be appended at once.
- A store does not encrypt or decrypt. The repository does that.

## Writing a store

This store keeps events in memory, which is also useful in tests. It passes the contract's tests.

```typescript
// in-memory-event-store.ts
import {
  ConcurrencyError,
  EventStore,
  IPersistedEvent,
} from "@es-aggregates/core";

export class InMemoryEventStore implements EventStore {
  // each aggregate's events, as JSON, by version
  private readonly aggregates = new Map<string, Map<number, string>>();

  async appendAsync(
    aggregateId: string,
    events: IPersistedEvent[],
    expectedVersion: number
  ): Promise<void> {
    const stored = this.eventsOf(aggregateId);
    const taken = events.find((event) => stored.has(event.aggregateVersion));
    if (taken !== undefined) {
      const cause = new Error(`Version ${taken.aggregateVersion} is taken.`);
      throw new ConcurrencyError(aggregateId, expectedVersion, cause);
    }

    // an event that is refused throws here, so before any is stored
    const appended = events.map((event): [number, string] => [
      event.aggregateVersion,
      this.toJson(event),
    ]);
    this.aggregates.set(aggregateId, new Map([...stored, ...appended]));
  }

  async readAsync(aggregateId: string): Promise<IPersistedEvent[]> {
    return [...this.eventsOf(aggregateId)]
      .sort(([version], [other]) => version - other)
      .map(([, json]) => JSON.parse(json));
  }

  private eventsOf(aggregateId: string): Map<number, string> {
    return this.aggregates.get(aggregateId) ?? new Map<number, string>();
  }

  private toJson(event: IPersistedEvent): string {
    const canBeStored = this.canBeStored;
    return JSON.stringify(event, function (name) {
      const value = this[name]; // as it was before toJSON, if it has that
      if (!canBeStored(value)) {
        throw new Error(`Cannot store ${name} of ${event.eventType}.`);
      }
      return Array.isArray(value)
        ? value.filter((element) => element !== undefined)
        : value;
    });
  }

  // what JSON keeps as it is, and undefined
  private canBeStored(value: unknown): boolean {
    if (typeof value === "object" && value !== null) {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === Array.prototype;
    }
    return typeof value === "number"
      ? Number.isFinite(value)
      : value === null || ["undefined", "boolean", "string"].includes(typeof value);
  }
}
```

In a database:

- Make the aggregate and the version together a unique key, and insert. Never overwrite.
- Insert all of the events in one transaction.
- Find out how the database tells that a key is already taken, and throw a `ConcurrencyError` for that, with the database's error as its `cause`. Throw other errors as they are.
- Find out whether the database's SDK sends an insert again by itself, if it does not know whether the first one was done. If it was, the key is taken, but by the append itself. That must not become a `ConcurrencyError`.
- Read until there are no more pages, and sort by version as a number.

### Run the contract's tests

`EventStoreContract` defines Jest tests for any store. It is in [`packages/store-tests`](../store-tests/src/event-store-contract.ts), which is not published, so your store's package must be in this repository (or in your copy of it).

1. Add a folder to `packages`, with a `package.json`, a `tsconfig.json` and a `jest.config.js` like those of [`packages/cosmos`](../cosmos/package.json), but for `globalSetup`, which is only for its emulator. Add the folder to `references` in the root [`tsconfig.json`](../../tsconfig.json).
2. In its `devDependencies`, have `"@es-aggregates/core": "*"` and `"@es-aggregates/store-tests": "*"`.
3. Add `tests/event-store-contract.test.ts`:

   ```typescript
   // event-store-contract.test.ts
   import { EventStoreContract } from "@es-aggregates/store-tests";

   import { InMemoryEventStore } from "../src";

   describe("InMemoryEventStore", () => {
     const store = new InMemoryEventStore();

     new EventStoreContract(() => store).define();
   });
   ```

4. At the root, run `yarn install` and `yarn build:tsc`, and then `yarn workspace <your package> test`.

The function that you pass is called for every append and read, as if each was made by another process. For a database, let it return a new store each time. Every test uses ids of its own, so the database may have other events in it.

If a test fails, fix the store. If your database cannot keep one of the unusual values that the tests use, and you cannot refuse it, name it in the second argument, as [`packages/dynamodb`](../dynamodb/tests/event-store-contract.test.ts) does, and tell the users of your store.
