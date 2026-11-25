# @es-aggregates/cosmos

Stores the events of [`@es-aggregates/core`](../core/README.md) in Azure Cosmos DB for NoSQL.

- [Install](#install)
- [Container](#container)
- [Use](#use)
- [Consistency](#consistency)
- [One write region](#one-write-region)
- [Limits](#limits)
- [Values that are refused](#values-that-are-refused)
- [Errors](#errors)
- [Tests with the emulator](#tests-with-the-emulator)

## Install

2.0 is [not on npm yet](../../README.md).

```bash
npm install @es-aggregates/core @es-aggregates/cosmos @azure/cosmos
```

Core and `@azure/cosmos` (version 4.5.0 or later) are peer dependencies. `@azure/cosmos` needs Node.js 20 or later, and from 4.10.0 on, Node.js 22 or later.

## Container

```typescript
// create-container.ts
import { Container, CosmosClient } from "@azure/cosmos";

export async function createContainer(
  client: CosmosClient
): Promise<Container> {
  const { database } = await client.databases.createIfNotExists({ id: "app" });
  const { container } = await database.containers.createIfNotExists({
    id: "events",
    partitionKey: { paths: ["/aggregateId"] },
  });
  return container;
}
```

- The partition key path must be `/aggregateId`.
- Store nothing else in the container. The id of each item is the version of an event, and a read returns every item that has the aggregate's id.
- Do not set a [time to live](https://learn.microsoft.com/azure/cosmos-db/time-to-live), or events will be deleted.
- `/aggregateVersion/?` must have a range index. A read sorts by it, and [fails without one](https://learn.microsoft.com/azure/cosmos-db/index-overview#range-index).
- `/aggregateId/?` should have one too. Without it a read scans, which costs more. Excluding all paths also excludes [the partition key](https://learn.microsoft.com/azure/cosmos-db/index-policy#includeexclude-strategy).

The default indexing policy indexes everything, so it needs no changes. But you will pay for indexing the data, which a read does not use. With this policy, you do not:

```typescript
// create-container-with-fewer-indexes.ts
import { Container, CosmosClient } from "@azure/cosmos";

export async function createContainer(
  client: CosmosClient
): Promise<Container> {
  const { database } = await client.databases.createIfNotExists({ id: "app" });
  const { container } = await database.containers.createIfNotExists({
    id: "events",
    partitionKey: { paths: ["/aggregateId"] },
    indexingPolicy: {
      includedPaths: [
        { path: "/aggregateId/?" },
        { path: "/aggregateVersion/?" },
      ],
      excludedPaths: [{ path: "/*" }],
    },
  });
  return container;
}
```

## Use

There is no repository class for Cosmos DB. Give a [`Repository`](../core/README.md#repository) a `CosmosEventStore`. `User` here is the [example in core](../core/README.md#aggregates).

```typescript
// users.ts
import { CosmosClient } from "@azure/cosmos";
import { Repository } from "@es-aggregates/core";
import { CosmosEventStore } from "@es-aggregates/cosmos";

import { User } from "./user";

const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  key: process.env.COSMOS_KEY!,
  consistencyLevel: "Session", // see Consistency
});
const container = client.database("app").container("events");

export const users = new Repository(
  new CosmosEventStore(container),
  () => new User()
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

An append is one transactional batch. Each event is an item. Its id is its version, as a string, so a version cannot be stored twice.

In TypeScript, the constructor takes an `EventContainer`, which is exported too. It has only what the store uses, so the SDK's `Container` is one in an ES module and in CommonJS alike. If you pass a container of your own, such as a wrapper or a fake, it needs `database.client.getDatabaseAccount()`, to [check the account](#one-write-region), as well as `items.batch` and `items.query`.

## Consistency

A read can miss events that were stored shortly before it. What it can miss depends on the [consistency level](https://learn.microsoft.com/azure/cosmos-db/consistency-levels) of the account:

| Account | `consistencyLevel` of the client | A read can miss |
| --- | --- | --- |
| Session, which is the default | `"Session"` | what another client stored |
| Session | not set | what any client stored, itself included |
| Strong | not set | nothing |

- **With Session, set `consistencyLevel: "Session"` on the client. Otherwise it may not see what it wrote itself**, because the SDK sends its session token only then.
- Use one `CosmosClient` for the whole process. The session belongs to it.
- A client [can only weaken](https://learn.microsoft.com/azure/cosmos-db/how-to-manage-consistency#override-the-default-consistency-level) the account's level. So with a Strong account, leave it out. An account with Consistent prefix or Eventual cannot give you Session.

Events that a read missed cannot be overwritten. The next write expects a version that is already stored, so it is rejected with a `ConcurrencyError`, and stores nothing. Then [read and try again](../core/README.md#concurrencyerror-and-how-to-retry). Wait a little first, because the next read may miss the same events.

## One write region

**The account must have a single write region.** It can have more regions to read from.

Cosmos DB refuses a version that is already stored, but only in the region that the append goes to. With more than one write region, two of them can store the same version at the same time. Cosmos DB [then keeps one of the two](https://learn.microsoft.com/azure/cosmos-db/conflict-resolution-policies), and the other event, whose append had succeeded, is lost.

So if [multi-region writes](https://learn.microsoft.com/azure/cosmos-db/how-to-manage-database-account#configure-multiple-write-regions) are enabled for the account, an append is rejected with an `Error` that says so, and stores nothing. Reads are not refused.

- The store checks this before the first append with a `CosmosClient`, and remembers the answer for that client. If you enable or disable multi-region writes later, restart the app, because the store does not notice.
- If the account cannot be read, the append goes ahead unchecked, and the next one tries again. Before that, the SDK itself can try several times, such as for 10 seconds after a lost connection. The first time that this happens with a `CosmosClient`, the store logs it with `console.error`, with the reason and what to check.
- To read the account, a [custom data plane role](https://learn.microsoft.com/azure/cosmos-db/reference-data-plane-security#required-metadata) needs the `Microsoft.DocumentDB/databaseAccounts/readMetadata` action. The built-in roles have it.

## Limits

- An append can have [100 events, and 2 MB, and must be done in 5 seconds](https://learn.microsoft.com/azure/cosmos-db/transactional-batch#limitations).
- An event, which is an item, can have 2 MB, and can be nested 128 levels deep. These and the next two are [limits of Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/concepts-limits).
- An aggregate's id can have 2048 bytes, or 101 if large partition keys are not enabled.
- All the events of an aggregate are in one logical partition, which can have 20 GB.

## Values that are refused

Events are stored as JSON. An append that has a value which JSON cannot hold, or would alter, is rejected before anything is sent. The message tells where the value is, such as `Cannot store UserCreated.data.born, because JSON cannot hold an instance of Date.`

- a `Date`, a `Map`, a `Set`, a `Buffer` or another instance of a class
- `NaN`, `Infinity` or `-Infinity`
- a bigint or a symbol
- a function in an array
- an object that contains itself
- an id that is not a string

Everything else is read back as it was, with these exceptions:

- `undefined` is left out, at any depth. So is a property that is a function, or whose name is a symbol.
- `-0` reads back as `0`.

A plain object may have any property names, also `id`, `_ts` and `__proto__`.

## Errors

- `ConcurrencyError`: a version is already stored (409), or another request is storing it (449). Its `cause` is the response to the batch, or the error from the SDK.
- If [it is not known](#when-the-outcome-is-not-known) whether it was the append itself that stored the version, it is an `Error` that says so. It has the same `cause`.
- A batch that failed for another reason, such as throttling or size, is an `Error`. If the SDK returned a response for it, that is the `cause`, and the message has its status codes. If the SDK threw, the error is passed on as it is.
- More than 100 events are refused before anything is sent.
- If [multi-region writes](#one-write-region) are enabled for the account, appends are refused.

### When the outcome is not known

**After any error other than a `ConcurrencyError`, read the aggregate again before you retry.** The events may have been stored, or not: after a timeout, a lost connection or a 503, [the SDK cannot know](https://learn.microsoft.com/azure/cosmos-db/conceptual-resilient-sdk-applications#timeouts-and-connectivity-related-failures-http-408503). If you make the change again without looking, it can be stored twice. Wait a little before you read, because [a read can miss](#consistency) what was stored just before it.

The SDK does not pass on every such failure. It can send a batch again by itself, such as after a 503 if the account has [per-partition automatic failover](https://learn.microsoft.com/azure/cosmos-db/how-to-configure-per-partition-automatic-failover). If the first attempt stored the events, the second finds that their versions are taken. That looks as if another write came first, but after a `ConcurrencyError` you would make the change again. So the append is rejected with an `Error` instead. Its message begins with `It is not known whether the events`.

It is a `ConcurrencyError` nevertheless if the earlier attempts are known to have stored nothing. They are if they were throttled (429), or refused by a region that does not take writes (403). They also are if it is a later event of the append that has the 409, and not the first.

## Tests with the emulator

Microsoft's [emulator](https://learn.microsoft.com/azure/cosmos-db/emulator-linux) runs in Docker. This removes it, with its data, when it is stopped:

```bash
docker run -d --rm --name cosmos-emulator -p 8081:8081 \
  mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-latest
```

```typescript
// emulator-client.ts
import { CosmosClient } from "@azure/cosmos";

export const client = new CosmosClient({
  endpoint: "http://localhost:8081",
  // every emulator has this key, and Microsoft publishes it, so it is not a secret
  key: "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==",
  consistencyLevel: "Session",
});
```

Give each test ids of its own, such as random ones, and then the tests need not empty the container.

The emulator is not the service:

- It does not check keys, [does not apply indexing policies](https://learn.microsoft.com/azure/cosmos-db/emulator-linux#indexing-support), and does not apply all of the limits.
- Its account has Strong consistency, so reads do not miss events.
- It returns all the results of a read on one page, where Cosmos DB uses more pages.

In this repository, `yarn workspace @es-aggregates/cosmos emulator` starts it, and `docker stop es-cosmos-emulator` stops it.
