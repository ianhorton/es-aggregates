# @es-aggregates/postgres

Stores the events of [`@es-aggregates/core`](../core/README.md) in PostgreSQL.

- [Install](#install)
- [Table](#table)
- [Use](#use)
- [In a transaction](#in-a-transaction)
- [Consistency](#consistency)
- [Limits](#limits)
- [Values that are refused](#values-that-are-refused)
- [Errors](#errors)
- [Tests with Postgres](#tests-with-postgres)

## Install

```bash
npm install @es-aggregates/core @es-aggregates/postgres pg
```

Core and [`pg`](https://node-postgres.com) (node-postgres, version 8.0.3 or later) are peer dependencies. With TypeScript, install `@types/pg` too.

## Table

```sql
CREATE TABLE "events" (
  aggregate_id text COLLATE "C" NOT NULL,
  aggregate_version integer NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (aggregate_id, aggregate_version)
);
```

The store never creates a table, or changes one. `PostgresEventStore.createTableSql()` returns this statement, for a migration, or to run it yourself:

```typescript
// create-table.ts
import { PostgresEventStore } from "@es-aggregates/postgres";
import { Pool } from "pg";

export async function createTable(pool: Pool): Promise<void> {
  await pool.query(PostgresEventStore.createTableSql());
}
```

- Each event is a row. The primary key is the aggregate's id and the event's version, so a version can be stored only once.
- Store nothing else in the table, and give it no other unique key. The store takes a unique violation for a version that is already stored.
- `COLLATE "C"` compares ids byte by byte, which is all that an id needs. Then the index does not depend on the locale of the operating system, which an upgrade can change.

The table is `events`, in the first schema of the [search path](https://www.postgresql.org/docs/current/ddl-schemas.html#DDL-SCHEMAS-PATH), which is usually `public`. For another, give its name, or its schema and its name with a dot between them, to the store and to `createTableSql` alike: `{ table: "app.events" }`. The names are quoted, so they are used exactly as they are written: `Events` is another table than `events`. A name cannot be empty, or have a dot or `\u0000` in it.

## Use

There is no repository class for Postgres. Give a [`Repository`](../core/README.md#repository) a `PostgresEventStore`. `User` here is the [example in core](../core/README.md#aggregates).

```typescript
// users.ts
import { Repository } from "@es-aggregates/core";
import { PostgresEventStore } from "@es-aggregates/postgres";
import { Pool } from "pg";

import { User } from "./user";

// it finds the server with PGHOST, PGUSER, PGPASSWORD and the like
const pool = new Pool();

export const users = new Repository(
  new PostgresEventStore(pool),
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

An append is one `INSERT`, with a row for each event, so it stores all of the events or none of them. An append of no events stores nothing, and resolves: nothing is sent to Postgres.

A read selects the aggregate's rows, sorted by version. It parses the events itself, so a parser for jsonb that you set in pg does not change them.

In TypeScript, the constructor takes a `Queryable`, which is exported too. It has only what the store uses, `query(text, values)`, so a `Pool`, a `Client` or a `PoolClient` of pg is one, and so is a wrapper of your own. The package does not load pg itself.

## In a transaction

Give the store a client that is in a transaction, and an append is part of the transaction. So you can store events together with other changes, or none of them:

```typescript
// sign-up.ts
import { Repository } from "@es-aggregates/core";
import { PostgresEventStore } from "@es-aggregates/postgres";
import { Pool } from "pg";

import { User } from "./user";

export async function signUpAsync(
  pool: Pool,
  id: string,
  name: string,
  email: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const users = new Repository(
      new PostgresEventStore(client),
      () => new User()
    );
    await users.writeAsync(User.create(id, name));
    await client.query("INSERT INTO emails (email, user_id) VALUES ($1, $2)", [
      email,
      id,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

- Until the transaction commits, only its own reads have the events.
- An append of the same version in another transaction waits until this one ends. If it commits, that append is rejected. If it rolls back, that append stores its events.
- When another transaction stored one of its versions first, an append is rejected with a `ConcurrencyError` at `READ COMMITTED`, which is the default, and at `REPEATABLE READ`. At `SERIALIZABLE`, if both transactions read the aggregate before they appended, it is rejected with the serialization failure of Postgres instead, whose SQLSTATE `40001` is the `code` of the error from pg. The store passes that error on as it is, as Postgres can report it for any statement of a serializable transaction. Roll the transaction back, and run it again from the read.
- After a `ConcurrencyError`, or any other error, the transaction can do nothing else: roll it back. Then read the aggregate again, in a new transaction.
- If the transaction rolls back after a write, its events are not stored, but the aggregate no longer has them as changes. So read it again, and do not write that object.

## Consistency

Give the store a pool that connects to the primary server. There, a read has the events of every append that has resolved.

A standby can be behind the primary, so a read there can miss events that were stored shortly before. Only a synchronous standby is not, and only if `synchronous_commit` is `remote_apply`: then the primary waits, at each commit, until the standby has applied it.

Events that a read missed cannot be overwritten. Every append goes to the primary, as a standby takes no writes. The next write expects a version that is already stored, so it is rejected with a `ConcurrencyError`, and stores nothing. Then [read and try again](../core/README.md#concurrencyerror-and-how-to-retry).

## Limits

- An append can have 32767 events. Each takes two parameters of the `INSERT`, which can have 65535.
- A version is an `integer`, so it can be at most 2147483647.
- An aggregate's id can have about 2600 bytes, or more if it compresses well. Postgres refuses a longer one, as its primary key's index cannot hold it.

## Values that are refused

Events are stored as `jsonb`. An append that has a value which JSON cannot hold, or would alter, or which jsonb cannot hold, is rejected before anything is sent. The message tells where the value is, such as `Cannot store UserCreated.data.born, because JSON cannot hold an instance of Date.`

- a `Date`, a `Map`, a `Set`, a `Buffer` or another instance of a class
- `NaN`, `Infinity` or `-Infinity`
- a bigint or a symbol
- a function in an array
- an object that contains itself
- `\u0000` in a string or a property name, which jsonb cannot hold
- a lone surrogate in a string or a property name, which jsonb refuses too. That is one half of a surrogate pair without the other, such as `"\ud83d"`, the first half of `"😀"`
- an event of another aggregate than the one that the append is for
- an aggregate's id that is not a string, or that has `\u0000` or a lone surrogate

A read refuses such an id too: Postgres cannot hold it in text, and pg would send a lone surrogate as `U+FFFD`, so the read would have the events of another aggregate.

Everything else is read back as it was, with these exceptions:

- `undefined` is left out, at any depth. So is a property that is a function, or whose name is a symbol.
- `-0` reads back as `0`.
- jsonb does not keep the order of an object's properties: it puts shorter names first. So `JSON.stringify` of an event that is read can differ from that of the event that was appended, but the two are equal.

Apart from names with `\u0000` or a lone surrogate, a plain object may have any property names, also `__proto__`.

## Errors

- `ConcurrencyError`: a version is already stored, or another transaction was storing it and has committed. That is a unique violation, whose SQLSTATE `23505` is the `code` of the error from pg, which is the `cause`. The append stored nothing.
- The serialization failure `40001` in place of a `ConcurrencyError`, in a `SERIALIZABLE` transaction, if both transactions read the aggregate before they appended. The error from pg is passed on as it is: see [In a transaction](#in-a-transaction). The append stored nothing.
- Any other error from pg is passed on as it is, such as `42P01` when there is no such table.
- More than 32767 events are refused before anything is sent.

**After any error other than a `ConcurrencyError`, read the aggregate again before you retry.** The events may have been stored, or not: if the connection is lost after the `INSERT` was sent, for example, it is not known whether it was committed. If you make the change again without looking, it can be stored twice. pg never sends a statement again by itself, so a version that the append itself has stored is never taken for one that another write has stored.

## Tests with Postgres

Postgres runs in Docker. This removes it, with its data, when it is stopped:

```bash
docker run -d --rm --name postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:19
```

Give each test ids of its own, such as random ones, and then the tests need not empty the table.

In this repository, `yarn workspace @es-aggregates/postgres db` starts it, and `docker stop es-postgres` stops it. The tests find it with the variables of libpq: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`, which are `localhost`, `5432`, `postgres`, `postgres` and `postgres` if they are not set. If nothing answers there, the tests that need it are skipped, but if `CI` is set they fail. Each test file has a schema of its own, which it drops at the end.
