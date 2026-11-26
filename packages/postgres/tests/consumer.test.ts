import { Consumer } from "@es-aggregates/store-tests/src/consumer";
import { readFileSync } from "fs";
import { join } from "path";

describe("Apps that use the package", () => {
  const consumer = new Consumer("postgres");

  const kinds = [
    ["an ES module", "mts", true],
    ["an ES module, with skipLibCheck off", "mts", false],
    ["a CommonJS module", "cts", true],
    ["a CommonJS module, with skipLibCheck off", "cts", false],
  ] as const;

  const app = `
    import { EventStore } from "@es-aggregates/core";
    import {
      PostgresEventStore,
      PostgresEventStoreOptions,
      Queryable,
    } from "@es-aggregates/postgres";
    import { Client, Pool, PoolClient } from "pg";

    const pool = new Pool();
    const options: PostgresEventStoreOptions = { table: "app.events" };
    export const store: EventStore = new PostgresEventStore(pool);
    export const withClient: EventStore = new PostgresEventStore(new Client(), options);
    export const sql: string = PostgresEventStore.createTableSql(options);
    export const queryable: Queryable = pool;

    export async function inTransactionAsync(): Promise<EventStore> {
      const client: PoolClient = await pool.connect();
      return new PostgresEventStore(client, {});
    }

    // @ts-expect-error: this is not a pool
    new PostgresEventStore({ query: () => 1 });

    // @ts-expect-error: a table is a name
    new PostgresEventStore(pool, { table: 1 });
  `;

  it.each(kinds)("should compile as %s", (_, extension, skipLibCheck) => {
    expect(consumer.errorsOf(`app.${extension}`, app, skipLibCheck)).toEqual(
      []
    );
  });

  describe("the samples of the README", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");

    // each sample has its file's name on its first line
    const samples: Array<{ name: string; source: string }> = [];
    const sample = /```typescript\n\/\/ ([\w-]+)\.ts\n([\s\S]*?)```/g;
    for (let found = sample.exec(readme); found; found = sample.exec(readme)) {
      samples.push({ name: found[1], source: found[2] });
    }

    // the User of core's README
    const user = `
      import { AggregateRoot } from "@es-aggregates/core";

      class User extends AggregateRoot {
        id = "";

        static create(id: string, name: string): User {
          return new User();
        }

        rename(name: string): void {}
      }
    `;

    it("should be there", () => {
      expect(samples.map(({ name }) => name)).toEqual([
        "create-table",
        "users",
        "sign-up",
      ]);
    });

    describe.each(samples)("$name", ({ name, source }) => {
      it.each(kinds)("should compile as %s", (_, extension, skipLibCheck) => {
        // arrange
        const app = source.replace('import { User } from "./user";', user);

        // act / assert
        expect(
          consumer.errorsOf(`${name}.${extension}`, app, skipLibCheck)
        ).toEqual([]);
      });
    });
  });
});
