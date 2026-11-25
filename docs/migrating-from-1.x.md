# Migrating from 1.x

For an app that uses `es-aggregates` 1.x, which stores events in DynamoDB. 2.0 [is not on npm yet](../README.md).

In short: the packages have new names, `Repository` becomes `DynamoRepository`, and a lost race is a `ConcurrencyError`. Your aggregates, your events and your stored data stay as they are.

If you are on a version before 1.1.1, update to that first. This guide compares 2.0 with 1.1.1. Take care if you used encryption before 1.1.0: that release changed how values are encrypted, so neither 1.1 nor 2.0 decrypts what an older version encrypted. They return it as it is stored.

## Steps

### 1. Change the packages

```bash
npm uninstall es-aggregates
npm install @es-aggregates/core @es-aggregates/dynamodb \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/util-dynamodb
```

In 1.x the AWS SDK came with the library. Now it is a peer dependency, as core is, so your app needs all five packages. The SDK must be version 3.485.0 or later. If your app has it already, keep the version that you have.

### 2. Change the imports

| 1.x, from `es-aggregates` | 2.0 |
| --- | --- |
| `Repository` | `DynamoRepository`, from `@es-aggregates/dynamodb` |
| `DynamoDBClient`, `unmarshall` | the same, from `@es-aggregates/dynamodb` |
| everything else, such as `AggregateRoot`, `Entity`, `EventBase`, `IEvent` and `IRepository` | the same, from `@es-aggregates/core` |

Change them all at once. An aggregate that extends the `AggregateRoot` of 1.x does not fit a repository of 2.0: TypeScript sees two different classes.

### 3. Use DynamoRepository

It takes the same arguments as `Repository` did. This

```typescript
// users-1.x.ts
import { DynamoDBClient, Repository } from "es-aggregates";

import { User } from "./user";

export const users = new Repository<User>(
  "events",
  () => new User(),
  new DynamoDBClient({})
);
```

becomes this:

```typescript
// users.ts
import { DynamoDBClient, DynamoRepository } from "@es-aggregates/dynamodb";

import { User } from "./user";

export const users = new DynamoRepository<User>(
  "events",
  () => new User(),
  new DynamoDBClient({})
);
```

The name `Repository` is still there, in core, but its arguments are different: a store, the activator and `debug`. TypeScript tells you if you pass it the old ones. Plain JavaScript does not: the first read or write fails, with `this.store.readAsync is not a function` or the like.

`DynamoRepository` extends that `Repository`, so you can use `Repository<User>` as a type.

### 4. Catch ConcurrencyError

When another write came first, 1.x rejected with the AWS SDK's `TransactionCanceledException`. 2.0 rejects with a `ConcurrencyError`, and the exception is its `cause`.

```typescript
// save.ts
import { ConcurrencyError, IRepository } from "@es-aggregates/core";

import { User } from "./user";

export async function saveAsync(
  users: IRepository<User>,
  user: User
): Promise<boolean> {
  try {
    await users.writeAsync(user);
    return true;
  } catch (error) {
    // 1.x: error.name === "TransactionCanceledException"
    if (error instanceof ConcurrencyError) {
      return false; // read the user again, and then make the change again
    }
    throw error;
  }
}
```

- If the same object [was written twice at once](../packages/core/README.md#repository), do not make the changes again, or they can be stored twice. When both writes are over, the object still has the changes that neither of them has stored, so write it once more.
- The reasons that became a `ConcurrencyError` are `ConditionalCheckFailed` and `TransactionConflict`. A transaction that was cancelled for any other reason, such as throttling, is still a `TransactionCanceledException`.
- `CancellationReasons` and the rest are on `error.cause` now.
- The message is another one. Change log filters and alarms that look for the old message or name.

### 5. Build and test

Compile the app and run its tests. Nothing has to be done to the table.

## Your stored data does not change

2.0 stores the same items as 1.1.1, with the same attributes, in the same table, under the same keys. Encrypted values have the same format. So:

- 2.0 reads what 1.1.1 stored, and 1.1.1 reads what 2.0 stored.
- You can go back to 1.1.1 at any time.
- Both can run at once, on the same table and even on the same aggregate. If both write the same version, only one is stored, whichever of them it is.

Why you can trust this: [the tests](../packages/dynamodb/tests/compatibility-1.1.1.test.ts) run the same app on 2.0 and on 1.1.1 as npm has it. They compare the requests that the two send to DynamoDB, which are the same down to the order of the properties, but for a token that the SDK makes up, and for a [change that is made during a write](#every-other-difference). Each of the two reads what the other wrote, with and without encryption. They read [data that 1.1.1 stored](../packages/dynamodb/tests/golden-1.1.1.test.ts), tampered values included. And they take turns at writing to one aggregate. They run in CI.

## Every other difference

These are small. Most apps will not notice them.

- **A change that is made during a write** stays in the aggregate, and the next write stores it. 1.x lost it, and then skipped its version.
- **A new optional parameter.** `clearChanges` of an aggregate takes the version of the last event that is stored, and keeps the changes after it. The repository passes it after a write. If you override the method, pass it on: without it, all the changes are cleared, as in 1.x.
- **Debug logging.** With `debug`, a read or a write logs ids, event types and versions, and no values. 1.x logged the events with their values, those of a write before they were encrypted, so its logs can have them in plain text. It also logged the answer of DynamoDB to a write. `debug` is now each repository's own setting: in 1.x, the repository that was created last decided for the whole process. So pass `true` to each one that is to log. The messages are other ones, so change log filters that look for them. A format that your app sets with `Logger.initialize` of `@sailplane/logger` applies to the repositories that it creates after that. In 1.x, it had to be set before the library was loaded.
- **Warnings about `encryptedProps`.** A write with a key logs a warning, with `console.warn`, if an event does not have a property that its `encryptedProps` lists, or if a static `encryptedProps` is not used, because the constructor passes the event's type to `super` and no list. Either can mean that a value is stored as plain text that should be encrypted. 1.x stores the same, but it says nothing. Each warning is logged once per process for each event type (and name), and has no values in it. [Check what is encrypted](../packages/core/README.md#check-what-is-encrypted) tells what to do.
- **Which of two errors you get.** If one write has both an event that cannot be encrypted (a property in `encryptedProps` that is not a string) and another that DynamoDB cannot hold (such as a `Date`), 1.x reported whichever event came first. 2.0 encrypts all the events before it converts any, so it reports the encryption error. Neither stores anything.
- **A shortened authentication tag** no longer decrypts. Each encrypted value ends with a tag of 16 bytes, which shows whether the value was altered. 1.x did not insist on all 16, so tampering by cutting the tag short, to 4 bytes for example, could go unnoticed. 2.0 does, and it treats such a value like any other that was altered: `decrypt` throws, and a read leaves the value as it is and logs an error. Neither version has ever stored a short tag, so your stored data is not affected.
- **The error for an unsupported algorithm** is just `Unsupported envelope algorithm` now, both from `decrypt` and in what a read logs. In 1.x, a colon and the second part of the stored value followed, which is where the algorithm is. Neither version has ever encrypted with another one, but a plain text that looks like an encrypted value, such as `ENC1.a.b.c.d.e`, or a value that was tampered with, got a part of itself into the logs that way, with `debug` off too. What a read returns has not changed. Change log filters that look for what followed.
- **Private members.** `Repository` has the private members `store`, `appendEventsAsync` and `debugLogger`, and no longer has `eventTableName`, `dynamoDBClient` and `transactWriteAsync`. So if you extend the repository, do not call a member of your own class `store`, `appendEventsAsync` or `debugLogger`.
- **The class's name** is `DynamoRepository`, if you log or compare it.
- **Deep imports**, such as `es-aggregates/dist/aggregate/repository`, do not work. What you need is exported by the packages.
- **The AWS SDK** is not installed by the library any more, so do not count on it being there.
- **New exports** in core: `EventStore`, `ConcurrencyError` and the type [`EncryptedProps`](../packages/core/README.md#check-what-is-encrypted).

These have **not** changed: the rest of the aggregates, the entities and events, `IRepository`, the order in which events are read, how values are encrypted, the limit of 100 changes, and the deprecation warning for `super("UserCreated", ["name"])`.

The limits and the values that are altered are the same too. They are in the READMEs now: [of core](../packages/core/README.md) and [of dynamodb](../packages/dynamodb/README.md).
