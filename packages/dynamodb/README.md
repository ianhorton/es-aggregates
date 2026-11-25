# @es-aggregates/dynamodb

Stores the events of [`@es-aggregates/core`](../core/README.md) in DynamoDB.

If you are on 1.x, see [Migrating from 1.x](../../docs/migrating-from-1.x.md). What is stored has not changed.

## Install

2.0 is [not on npm yet](../../README.md).

```bash
npm install @es-aggregates/core @es-aggregates/dynamodb \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/util-dynamodb
```

Core and the three packages of the AWS SDK (version 3.485.0 or later) are peer dependencies, so your app decides which versions there are. Have one copy of each.

## Table

The partition key is `aggregateId`, a string. The sort key is `aggregateVersion`, a number. You can create the table with the AWS Console, the AWS CLI, CloudFormation or Terraform, or like this:

```typescript
// create-table.ts
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";

export async function createTable(
  client: DynamoDBClient,
  tableName: string
): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      KeySchema: [
        { AttributeName: "aggregateId", KeyType: "HASH" },
        { AttributeName: "aggregateVersion", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "aggregateId", AttributeType: "S" },
        { AttributeName: "aggregateVersion", AttributeType: "N" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    })
  );
}
```

Each event is an item with the attributes `aggregateId`, `aggregateVersion`, `eventType`, `timestamp`, `encryptedProps` (if the event declares it) and `data`.

**Global tables:** write to one Region only. With multi-Region eventual consistency, the condition that refuses a version that is already stored [looks only at its own Region](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html). So two Regions can store the same version, and DynamoDB then keeps one of the two events. A table with multi-Region strong consistency cannot be used, because it does not support transactions.

## DynamoRepository

`DynamoRepository` is a [`Repository`](../core/README.md#repository) that stores events in DynamoDB. `User` here is the [example in core](../core/README.md#aggregates).

```typescript
// users.ts
import { DynamoDBClient, DynamoRepository } from "@es-aggregates/dynamodb";

import { User } from "./user";

export const users = new DynamoRepository(
  "events",
  () => new User(),
  new DynamoDBClient({})
);

export async function renameAsync(id: string, name: string): Promise<void> {
  const user = await users.readAsync(id);
  if (user === undefined) {
    throw new Error(`There is no user ${id}.`);
  }
  user.rename(name);
  await users.writeAsync(user);
}
```

The arguments are the name of the table, the function that makes an empty aggregate, the client, and `debug`, which is `false` unless you set it.

**Give it a `DynamoDBClient` of its own.** Every read and write resets the `translateConfig` (`marshallOptions` and `unmarshallOptions`) of any `DynamoDBDocumentClient` that was made from the same client.

`DynamoDBClient` and `unmarshall` are exported too, so that you can import them from here.

## DynamoEventStore

`DynamoRepository` is short for a `Repository` with a `DynamoEventStore`. The client comes first here:

```typescript
// users-with-a-store.ts
import { Repository } from "@es-aggregates/core";
import { DynamoDBClient, DynamoEventStore } from "@es-aggregates/dynamodb";

import { User } from "./user";

const store = new DynamoEventStore(new DynamoDBClient({}), "events");

export const users = new Repository(store, () => new User());
```

- An append is one transaction, with a `Put` for each event, on the condition that its version is not stored yet.
- A read is a strongly consistent query, so it has every event that was stored before it. It reads all the pages.
- An append is rejected with a `ConcurrencyError` if a version is already stored, or is being stored by another transaction. Its `cause` is the `TransactionCanceledException`. Other errors are passed on as they are. One of those can be a `TransactionCanceledException` too, if the transaction was cancelled for another reason, such as throttling.

## Limits

- An append can have 100 events. DynamoDB allows [100 items, and 4 MB, in a transaction](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html#limits-dynamodb-transactions).
- An event, which is an item, can have [400 KB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html#limits-items). The names of attributes count too.
- An id can have from 1 to 2048 bytes.
- Data can be [nested 32 levels deep](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html#limits-attributes-nested-depth).
- Writing in a transaction takes [twice the write units](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html#transaction-capacity-handling), even if the transaction is cancelled.

## Values

These are read back as they were: strings, numbers that are not too large, booleans, `null`, arrays, plain objects, `Uint8Array`, and a `Set` of strings, of numbers or of `Uint8Array`. The order of a set is not kept.

`undefined` is left out, at any depth, and so is a property that is a function.

### Refused

An append that has one of these is rejected, and stores nothing:

- a `Date`, or another instance of a class
- `NaN`, `Infinity` or `-Infinity`
- a number above `Number.MAX_SAFE_INTEGER`, or below `Number.MIN_SAFE_INTEGER`
- a number other than 0 that is nearer to 0 than 1e-130, or a bigint of more than 38 digits
- an empty `Set`, or a `Set` of other things
- a property that has an empty name, or that is called `constructor` (unless its value is falsy, such as 0)
- a symbol

### Altered

**These are stored without an error, but read back as something else:**

- **A bigint** reads back as a number, if it is in the range of safe integers. If it is not, it is a bigint again.
- **A `Map`** reads back as a plain object.
- **A property called `__proto__`** is lost. With newer versions of the AWS SDK, the append is rejected instead.

The AWS SDK's `marshall` function does this. 1.x stored the same. Some rarer values are altered too:

- A `Buffer` reads back as a `Uint8Array`. Do not use other kinds of binary data, such as an `ArrayBuffer`, a `Blob` or a `Float64Array`. Depending on the version of the SDK they are refused, read back as a `Uint8Array`, or **stored empty**.
- The members of a `Set` that are not of the same kind as its first can be converted to it.
- `-0` reads back as `0`.

To be safe, turn such values into strings or plain objects in the event itself, as you would a `Date`: `date.toISOString()`.
