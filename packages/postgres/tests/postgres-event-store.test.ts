import {
  ConcurrencyError,
  IPersistedEvent,
  Repository,
} from "@es-aggregates/core";
import { TestAggregateRoot } from "@es-aggregates/store-tests";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { Client, Pool, types } from "pg";
import { v4 } from "uuid";

import { PostgresEventStore, Queryable } from "../src";

import { Postgres } from "./test-objects/postgres";
import { RecordingPool } from "./test-objects/recording-pool";

jest.setTimeout(90000);

describe("PostgresEventStore", () => {
  const event = (
    aggregateId: string,
    aggregateVersion: number,
    data: unknown = { text: `event ${aggregateVersion}` }
  ): IPersistedEvent => ({
    aggregateId,
    eventType: "SomethingHappened",
    timestamp: "2026-01-01T00:00:00.000Z",
    aggregateVersion,
    data,
  });

  const eventsOf = (
    aggregateId: string,
    versions: number[],
    data?: unknown
  ): IPersistedEvent[] =>
    versions.map((version) => event(aggregateId, version, data));

  // from the first to the last, which is included
  const range = (first: number, last: number): number[] =>
    [...Array(last - first + 1).keys()].map((index) => first + index);

  // what a text can have that Postgres cannot hold, and how the store names it
  const flaws: Array<[string, string, string]> = [
    ["\\u0000", "a\u0000b", "\\u0000"],
    ["a lone high surrogate", "a\ud83db", "a lone surrogate"],
    ["a lone low surrogate", "a\ude00", "a lone surrogate"],
    ["a high surrogate at the end", "a\ud83d", "a lone surrogate"],
    ["two high surrogates", "\ud83d\ud83d\ude00", "a lone surrogate"],
    ["a low surrogate after a pair", "\ud83d\ude00\ude00", "a lone surrogate"],
  ];

  describe("without a database", () => {
    const id = "aggregate id";
    const events = [event(id, 7), event(id, 8), event(id, 9)];

    // a store whose pool answers every statement with this
    const setup = (answer?: () => Promise<{ rows: unknown[] }>) => {
      const pool = new RecordingPool(answer);
      return { pool, store: new PostgresEventStore(pool) };
    };

    describe("appendAsync", () => {
      it("should send the events in one INSERT", async () => {
        // arrange
        const { pool, store } = setup();

        // act
        await store.appendAsync(id, events, 7);

        // assert
        expect(pool.sent).toEqual([
          {
            text:
              'INSERT INTO "events" (aggregate_id, aggregate_version, event) ' +
              "VALUES ($1, $2, $3), ($1, $4, $5), ($1, $6, $7)",
            values: [
              id,
              7,
              JSON.stringify(events[0]),
              8,
              JSON.stringify(events[1]),
              9,
              JSON.stringify(events[2]),
            ],
          },
        ]);
      });

      it("should send as many as 32767 events, but no more", async () => {
        // arrange
        const { pool, store } = setup();
        const most = eventsOf(id, range(0, 32766));

        // act
        await store.appendAsync(id, most, 0);
        const error = await store
          .appendAsync(id, [...most, event(id, 32767)], 0)
          .catch((e) => e);

        // assert
        // which are as many parameters as a statement can have
        expect(pool.sent).toHaveLength(1);
        expect(pool.sent[0].values).toHaveLength(65535);
        expect(pool.sent[0].text).toMatch(/, \(\$1, \$65534, \$65535\)$/);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(
          `Cannot append 32768 events to aggregate "${id}" at once. The limit is 32767.`
        );
      });

      it("should send nothing, and resolve, when there are no events", async () => {
        // arrange
        const { pool, store } = setup();

        // act / assert
        await expect(store.appendAsync(id, [], 7)).resolves.toBeUndefined();
        expect(pool.sent).toEqual([]);
      });

      it("should reject with a ConcurrencyError when a version is already stored, or is being stored", async () => {
        // arrange
        // what pg throws for a unique violation
        const thrown = Object.assign(
          new Error(
            'duplicate key value violates unique constraint "events_pkey"'
          ),
          { code: "23505", constraint: "events_pkey" }
        );
        const { store } = setup(() => Promise.reject(thrown));

        // act
        const error = await store.appendAsync(id, events, 7).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(ConcurrencyError);
        expect(error).toMatchObject({
          name: "ConcurrencyError",
          aggregateId: id,
          expectedVersion: 7,
        });
        expect(error.cause).toBe(thrown);
      });

      it.each<[string, unknown]>([
        [
          "a table that is missing",
          Object.assign(new Error('relation "events" does not exist'), {
            code: "42P01",
          }),
        ],
        [
          "a deadlock",
          Object.assign(new Error("deadlock detected"), { code: "40P01" }),
        ],
        ["a lost connection", new Error("Connection terminated unexpectedly")],
        ["something that is not an error", "a text"],
        ["nothing", undefined],
      ])("should pass on %s as it is", async (_, thrown) => {
        // arrange
        const { store } = setup(() => Promise.reject(thrown));

        // act / assert
        await expect(store.appendAsync(id, events, 7)).rejects.toBe(thrown);
      });

      describe("what it sends", () => {
        // what is sent for an event's data
        const sentForAsync = async (data: unknown) => {
          const { pool, store } = setup();
          await store.appendAsync(id, [event(id, 7, data)], 7);
          return JSON.parse(pool.sent[0].values[2] as string).data;
        };

        it("should keep what JSON can hold", async () => {
          // arrange
          const data = {
            text: "Zoë Åström, 東京 😀",
            emptyText: "",
            escaped: "\"'\\/\b\f\n\r\t\u0001\u001f\u007f\u2028\ufeff\uffff",
            pair: "\ud83d\ude00",
            zero: 0,
            negative: -1.5,
            fraction: 0.1 + 0.2,
            big: 2 ** 53 + 2,
            biggest: Number.MAX_VALUE,
            smallest: Number.MIN_VALUE,
            yes: true,
            no: false,
            nothing: null,
            list: ["a", 1, null, ["nested", []], { b: "c" }],
            emptyList: [],
            map: { nested: { deeper: ["deepest"] } },
            emptyMap: {},
            "": "a property without a name",
            "東京 😀": "a property with an unusual name",
            aggregateVersion: "not the version of the event",
            toJSON: "not a function",
          };

          // act / assert
          expect(await sentForAsync(data)).toStrictEqual(data);
        });

        it("should keep a property called __proto__", async () => {
          // arrange
          const json = '{"__proto__":{"a":1},"b":2}';

          // act
          const sent = await sentForAsync(JSON.parse(json));

          // assert
          expect(JSON.stringify(sent)).toBe(json);
        });

        it("should keep objects and lists of another realm, and objects without a prototype", async () => {
          // arrange
          const withoutPrototype = Object.assign(Object.create(null), { a: 1 });
          const ofAnotherRealm = structuredClone({ b: { c: [2] } });
          expect(ofAnotherRealm).not.toBeInstanceOf(Object);
          expect(ofAnotherRealm.b.c).not.toBeInstanceOf(Array);

          // act / assert
          expect(
            await sentForAsync({ withoutPrototype, ofAnotherRealm })
          ).toStrictEqual({
            withoutPrototype: { a: 1 },
            ofAnotherRealm: { b: { c: [2] } },
          });
        });

        it("should leave out undefined values, at any depth", async () => {
          expect(
            await sentForAsync({
              dropped: undefined,
              map: { kept: 1, dropped: undefined, nested: { a: undefined } },
              list: [undefined, "a", undefined, ["b", undefined], undefined],
              objects: [{ kept: 1, dropped: undefined }, undefined],
              onlyUndefined: [undefined],
              holes: [, 1, , 2],
              "\u0000": undefined,
            })
          ).toStrictEqual({
            map: { kept: 1, nested: {} },
            list: ["a", ["b"]],
            objects: [{ kept: 1 }],
            onlyUndefined: [],
            holes: [1, 2],
          });
        });

        it("should leave out the event's own properties that are undefined", async () => {
          // arrange
          const { pool, store } = setup();
          const withUndefined = { ...event(id, 7), encryptedProps: undefined };

          // act
          await store.appendAsync(id, [withUndefined], 7);

          // assert
          expect(
            Object.keys(JSON.parse(pool.sent[0].values[2] as string))
          ).toEqual([
            "aggregateId",
            "eventType",
            "timestamp",
            "aggregateVersion",
            "data",
          ]);
        });

        // as DynamoEventStore does
        it("should leave out properties that are functions, and those with a symbol for a name", async () => {
          expect(
            await sentForAsync({
              kept: 1,
              method: () => "dropped",
              map: { toJSON: () => "must not be called", kept: 2 },
              [Symbol("dropped")]: 3,
            })
          ).toStrictEqual({ kept: 1, map: { kept: 2 } });
        });

        // as DynamoEventStore does
        it("should send 0 for -0", async () => {
          expect(await sentForAsync({ zeros: [-0, 0] })).toStrictEqual({
            zeros: [0, 0],
          });
        });

        it("should send the events as they were when the append began", async () => {
          // arrange
          const { pool, store } = setup();
          const data: Record<string, unknown> = { list: ["before"] };
          const appended = [event(id, 7, data)];

          // act
          const append = store.appendAsync(id, appended, 7);
          (data.list as unknown[]).push("during");
          data.added = "during";
          appended.push(event(id, 8));
          await append;

          // assert
          const { values } = pool.sent[0];
          expect(values).toHaveLength(3);
          expect(JSON.parse(values[2] as string).data).toEqual({
            list: ["before"],
          });
        });

        it("should not change the events that it is given", async () => {
          // arrange
          const { store } = setup();
          const data = { list: [1, undefined], map: { a: undefined, b: {} } };
          const appended = [
            { ...event(id, 7, data), encryptedProps: undefined },
          ];

          // act
          await store.appendAsync(id, appended, 7);

          // assert
          expect(appended).toStrictEqual([
            {
              ...event(id, 7, {
                list: [1, undefined],
                map: { a: undefined, b: {} },
              }),
              encryptedProps: undefined,
            },
          ]);
        });
      });

      describe("what it refuses", () => {
        class Thing {
          public readonly a = 1;
        }

        class ThingWithJson {
          public toJSON = () => "JSON";
        }

        class Things extends Array {}

        const refused: Array<[string, unknown, string]> = [
          ["a date", new Date(0), "an instance of Date"],
          ["an invalid date", new Date(NaN), "an instance of Date"],
          ["a map", new Map([["a", 1]]), "an instance of Map"],
          ["a set", new Set([1]), "an instance of Set"],
          ["an empty set", new Set(), "an instance of Set"],
          ["a buffer", Buffer.from("a"), "an instance of Buffer"],
          ["a byte array", new Uint8Array([1]), "an instance of Uint8Array"],
          ["an array buffer", new ArrayBuffer(1), "an instance of ArrayBuffer"],
          [
            "a data view",
            new DataView(new ArrayBuffer(1)),
            "an instance of DataView",
          ],
          [
            "a float array",
            new Float64Array([1.5]),
            "an instance of Float64Array",
          ],
          ["a blob", new Blob(["a"]), "an instance of Blob"],
          ["an instance of a class", new Thing(), "an instance of Thing"],
          [
            "one that has toJSON",
            new ThingWithJson(),
            "an instance of ThingWithJson",
          ],
          ["one of a subclass of Array", new Things(), "an instance of Things"],
          [
            "one of a class without a name",
            new (class {})(),
            "an instance of ",
          ],
          [
            "a list without a prototype",
            Object.setPrototypeOf([1], null),
            "an instance of undefined",
          ],
          [
            "an object with inherited properties",
            Object.create({ a: 1 }),
            "an instance of Object",
          ],
          ["a regular expression", /a/, "an instance of RegExp"],
          ["an error", new Error("a"), "an instance of Error"],
          ["a promise", Promise.resolve(1), "an instance of Promise"],
          ["a URL", new URL("https://example.com"), "an instance of URL"],
          ["a boxed number", new Number(1), "an instance of Number"],
          ["a boxed text", new String("a"), "an instance of String"],
          ["a boxed boolean", new Boolean(false), "an instance of Boolean"],
          ["NaN", NaN, "NaN"],
          ["Infinity", Infinity, "Infinity"],
          ["-Infinity", -Infinity, "-Infinity"],
          ["a bigint", BigInt(1), "a bigint"],
          ["a symbol", Symbol("a"), "a symbol"],
        ];

        // appends an event that is fine and then this one
        const appendAndCatchAsync = async (refused: IPersistedEvent) => {
          const { pool, store } = setup();
          const error = await store
            .appendAsync(id, [event(id, 7), refused], 7)
            .catch((e) => e);
          return { error, pool };
        };

        it.each(refused)(
          "should send nothing when there is %s",
          async (_, value, description) => {
            // act
            const { error, pool } = await appendAndCatchAsync(
              event(id, 8, { value })
            );

            // assert
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe(
              `Cannot store SomethingHappened.data.value, because JSON cannot hold ${description}.`
            );
            expect(pool.sent).toEqual([]);
          }
        );

        it.each(refused)(
          "should send nothing when there is %s in a list",
          async (_, value, description) => {
            // act
            const { error, pool } = await appendAndCatchAsync(
              event(id, 8, [[1], [2, value]])
            );

            // assert
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe(
              `Cannot store SomethingHappened.data[1][1], because JSON cannot hold ${description}.`
            );
            expect(pool.sent).toEqual([]);
          }
        );

        it.each(flaws)(
          "should send nothing when a string has %s",
          async (_, text, flaw) => {
            // act
            const { error, pool } = await appendAndCatchAsync(
              event(id, 8, { list: ["fine", text] })
            );

            // assert
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe(
              `Cannot store SomethingHappened.data.list[1], because jsonb cannot hold a string with ${flaw}.`
            );
            expect(pool.sent).toEqual([]);
          }
        );

        it.each(flaws)(
          "should send nothing when a property name has %s",
          async (_, name, flaw) => {
            // act
            const { error, pool } = await appendAndCatchAsync(
              event(id, 8, { map: { fine: 1, [name]: 2 } })
            );

            // assert
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe(
              `Cannot store SomethingHappened.data.map, because jsonb cannot hold a property name with ${flaw}.`
            );
            expect(pool.sent).toEqual([]);
          }
        );

        it("should send nothing when the event's own string has \\u0000", async () => {
          // act
          const { error, pool } = await appendAndCatchAsync({
            ...event(id, 8),
            timestamp: "2026-01-01\u0000",
          });

          // assert
          expect(error.message).toBe(
            "Cannot store SomethingHappened.timestamp, because jsonb cannot hold a string with \\u0000."
          );
          expect(pool.sent).toEqual([]);
        });

        it("should name the path to the value", async () => {
          // act
          const { error, pool } = await appendAndCatchAsync(
            event(id, 8, {
              details: {
                list: [1, undefined, { "a.b": [{ when: new Date(0) }] }],
              },
            })
          );

          // assert
          expect(error.message).toBe(
            "Cannot store SomethingHappened.data.details.list[2].a.b[0].when, because JSON cannot hold an instance of Date."
          );
          expect(pool.sent).toEqual([]);
        });

        it.each<[string, Partial<IPersistedEvent>]>([
          ["data", { data: new Date(0) }],
          ["timestamp", { timestamp: new Date(0) as unknown as string }],
          [
            "encryptedProps[1]",
            { encryptedProps: ["a", new Date(0) as unknown as string] },
          ],
        ])(
          "should send nothing when %s is a date",
          async (path, properties) => {
            // act
            const { error, pool } = await appendAndCatchAsync({
              ...event(id, 8),
              ...properties,
            });

            // assert
            expect(error.message).toBe(
              `Cannot store SomethingHappened.${path}, because JSON cannot hold an instance of Date.`
            );
            expect(pool.sent).toEqual([]);
          }
        );

        it("should send nothing when the event itself is an instance of a class", async () => {
          // arrange
          class PersistedEvent {}

          // act
          const { error, pool } = await appendAndCatchAsync(
            Object.assign(new PersistedEvent(), event(id, 8))
          );

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe(
            "Cannot store SomethingHappened, because JSON cannot hold an instance of PersistedEvent."
          );
          expect(pool.sent).toEqual([]);
        });

        // as DynamoEventStore does
        it("should send nothing when there is a function in a list", async () => {
          // act
          const { error, pool } = await appendAndCatchAsync(
            event(id, 8, [1, () => 2])
          );

          // assert
          expect(error.message).toBe(
            "Cannot store SomethingHappened.data[1], because JSON cannot hold a function."
          );
          expect(pool.sent).toEqual([]);
        });

        it("should send nothing when a value contains itself", async () => {
          // arrange
          const value: Record<string, unknown> = {};
          value.list = [value];

          // act
          const { error, pool } = await appendAndCatchAsync(
            event(id, 8, value)
          );

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(pool.sent).toEqual([]);
        });

        it("should send nothing when an event is of another aggregate", async () => {
          // act
          const { error, pool } = await appendAndCatchAsync(
            event("another id", 8)
          );

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          expect(error.message).toBe(
            'Cannot append SomethingHappened to aggregate "aggregate id", because it is an event of aggregate "another id".'
          );
          expect(pool.sent).toEqual([]);
        });

        it.each([[undefined], [null], [7], [{}]])(
          "should send nothing when the aggregate's id is %p",
          async (notAnId) => {
            // arrange
            const { pool, store } = setup();

            // act / assert
            await expect(
              store.appendAsync(notAnId as unknown as string, events, 7)
            ).rejects.toThrow("An aggregate's id must be a string");
            expect(pool.sent).toEqual([]);
          }
        );

        it.each(flaws)(
          "should send nothing when the aggregate's id has %s",
          async (_, badId, flaw) => {
            // arrange
            const { pool, store } = setup();

            // act / assert
            await expect(
              store.appendAsync(badId, eventsOf(badId, [0]), 0)
            ).rejects.toThrow(
              `An aggregate's id cannot have ${flaw}, because Postgres cannot hold it in a text.`
            );
            expect(pool.sent).toEqual([]);
          }
        );
      });
    });

    describe("readAsync", () => {
      // a row as pg returns it
      const row = (event: IPersistedEvent) => ({
        event: JSON.stringify(event),
      });

      it("should ask for the aggregate's events in the order of their versions", async () => {
        // arrange
        const { pool, store } = setup(() =>
          Promise.resolve({ rows: [row(event(id, 0))] })
        );

        // act
        await store.readAsync(id);

        // assert
        expect(pool.sent).toEqual([
          {
            text:
              'SELECT event::text AS event FROM "events" ' +
              "WHERE aggregate_id = $1 ORDER BY aggregate_version",
            values: [id],
          },
        ]);
      });

      it("should return the events as they were appended", async () => {
        // arrange
        const data = JSON.parse('{"__proto__":{"a":1},"b":2}');
        const { store } = setup(() =>
          Promise.resolve({
            rows: [
              row(event(id, 0)),
              row({ ...event(id, 1), encryptedProps: ["a"] }),
              row(event(id, 2, data)),
            ],
          })
        );

        // act / assert
        expect(await store.readAsync(id)).toStrictEqual([
          event(id, 0),
          { ...event(id, 1), encryptedProps: ["a"] },
          event(id, 2, data),
        ]);
      });

      it("should return an empty array when there are no events", async () => {
        // arrange
        const { store } = setup();

        // act / assert
        expect(await store.readAsync(id)).toEqual([]);
      });

      it("should pass on an error as it is", async () => {
        // arrange
        const thrown = Object.assign(new Error("permission denied"), {
          code: "42501",
        });
        const { store } = setup(() => Promise.reject(thrown));

        // act / assert
        await expect(store.readAsync(id)).rejects.toBe(thrown);
      });

      it.each([[undefined], [null], [7], [{}]])(
        "should ask for nothing when the aggregate's id is %p",
        async (notAnId) => {
          // arrange
          const { pool, store } = setup();

          // act / assert
          await expect(
            store.readAsync(notAnId as unknown as string)
          ).rejects.toThrow("An aggregate's id must be a string");
          expect(pool.sent).toEqual([]);
        }
      );

      it.each(flaws)(
        "should ask for nothing when the aggregate's id has %s",
        async (_, badId, flaw) => {
          // arrange
          const { pool, store } = setup();

          // act / assert
          await expect(store.readAsync(badId)).rejects.toThrow(
            `An aggregate's id cannot have ${flaw}, because Postgres cannot hold it in a text.`
          );
          expect(pool.sent).toEqual([]);
        }
      );
    });

    describe("the table", () => {
      it.each<[string | undefined, string]>([
        [undefined, '"events"'],
        ["events", '"events"'],
        ["Events", '"Events"'],
        ["app.events", '"app"."events"'],
        ['my "events"', '"my ""events"""'],
        ['x"; DROP TABLE users; --', '"x""; DROP TABLE users; --"'],
        ["é 東京.😀", '"é 東京"."😀"'],
        [" . ", '" "." "'],
      ])("should use the table %p as %s", async (table, sql) => {
        // arrange
        const pool = new RecordingPool();
        const store = new PostgresEventStore(pool, { table });

        // act
        await store.appendAsync(id, [event(id, 7)], 7);
        await store.readAsync(id);

        // assert
        expect(pool.sent.map(({ text }) => text)).toEqual([
          `INSERT INTO ${sql} (aggregate_id, aggregate_version, event) VALUES ($1, $2, $3)`,
          `SELECT event::text AS event FROM ${sql} WHERE aggregate_id = $1 ORDER BY aggregate_version`,
        ]);
        expect(
          PostgresEventStore.createTableSql({ table }).split("\n")[0]
        ).toBe(`CREATE TABLE ${sql} (`);
      });

      it.each([
        [""],
        ["."],
        ["app."],
        [".events"],
        ["app.events.old"],
        ["a\u0000b"],
        ["app.\u0000"],
      ])("should refuse the table %p", (table) => {
        // arrange
        const message = `Cannot use the table ${JSON.stringify(table)}.`;

        // act / assert
        expect(
          () => new PostgresEventStore(new RecordingPool(), { table })
        ).toThrow(message);
        expect(() => PostgresEventStore.createTableSql({ table })).toThrow(
          message
        );
      });

      it.each([[null], [7]])("should refuse a table that is %p", (table) => {
        // arrange
        const options = { table: table as unknown as string };

        // act / assert
        expect(
          () => new PostgresEventStore(new RecordingPool(), options)
        ).toThrow("A table's name must be a string");
      });

      it("should create a table with the aggregate's id and the version for its primary key", () => {
        expect(PostgresEventStore.createTableSql({ table: "app.events" })).toBe(
          'CREATE TABLE "app"."events" (\n' +
            '  aggregate_id text COLLATE "C" NOT NULL,\n' +
            "  aggregate_version integer NOT NULL,\n" +
            "  event jsonb NOT NULL,\n" +
            "  PRIMARY KEY (aggregate_id, aggregate_version)\n" +
            ");"
        );
      });

      it("should create the table that the README shows", () => {
        // arrange
        const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");

        // act / assert
        expect(readme).toContain(
          "```sql\n" + PostgresEventStore.createTableSql() + "\n```"
        );
      });
    });
  });

  Postgres.describe("in Postgres", () => {
    const postgres = new Postgres();
    let table: string;
    let store: PostgresEventStore;

    beforeAll(async () => {
      await postgres.startAsync();
      table = await postgres.createTableAsync();
      store = new PostgresEventStore(postgres.pool, { table });
    });
    afterAll(postgres.stopAsync);

    describe("appendAsync and readAsync", () => {
      it("should read back what was appended", async () => {
        // arrange
        const id = v4();
        const events = [
          event(id, 0, {
            text: "Zoë Åström, 東京 😀",
            emptyText: "",
            date: "2026-01-01T00:00:00.000Z",
            numeric: "1.0",
            escaped: "\"'\\/\b\f\n\r\t\u0001\u001f\u007f\u2028\ufeff\uffff",
            pair: "\ud83d\ude00",
            long: "x".repeat(100000),
          }),
          event(id, 1, {
            zero: 0,
            negative: -1,
            fraction: 0.1 + 0.2,
            third: 1 / 3,
            small: 1e-7,
            safe: Number.MAX_SAFE_INTEGER,
            unsafe: 2 ** 53 + 2,
            large: 1e21,
            biggest: Number.MAX_VALUE,
            smallest: Number.MIN_VALUE,
          }),
          event(id, 2, {
            yes: true,
            no: false,
            nothing: null,
            list: ["a", 1, null, true, ["nested", [], [[]]], { b: [{}] }],
            emptyList: [],
            map: { b: 1, a: 2, 10: 3, 9: 4, A: 5 },
            emptyMap: {},
            "": "a property without a name",
            'a.b/c "d" é': "one with an unusual name",
            aggregateVersion: 99,
            constructor: "not a function",
          }),
          event(id, 3, null),
          event(id, 4, "a text"),
          event(id, 5, [1, 2, 3]),
          event(id, 6, JSON.parse('{"__proto__":{"a":1},"b":2}')),
          { ...event(id, 7), encryptedProps: ["text"] },
          { ...event(id, 8), encryptedProps: [] },
          { ...event(id, 9), data: undefined },
          event(id, 10, {
            deep: JSON.parse("[".repeat(1000) + "]".repeat(1000)),
          }),
        ];

        // act
        await store.appendAsync(id, events, 0);
        const read = await store.readAsync(id);

        // assert
        // a property that is undefined is not read back
        const { data, ...withoutData } = events[9];
        expect(read).toStrictEqual([
          ...events.slice(0, 9),
          withoutData,
          events[10],
        ]);
        expect(Object.keys(read[6].data).sort()).toEqual(["__proto__", "b"]);
        expect(Object.getPrototypeOf(read[6].data)).toBe(Object.prototype);
      });

      it("should store each event in a row, with the aggregate's id and the event's version", async () => {
        // arrange
        const id = v4();
        const events = [
          event(id, 0),
          { ...event(id, 1), encryptedProps: ["text"] },
          { ...event(id, 2), encryptedProps: undefined },
        ];

        // act
        await store.appendAsync(id, events, 0);
        const rows = await postgres.rowsAsync("events", id);

        // assert
        expect(
          rows.map((row) => ({ ...row, event: JSON.parse(row.event) }))
        ).toStrictEqual([
          { aggregate_id: id, aggregate_version: 0, event: event(id, 0) },
          {
            aggregate_id: id,
            aggregate_version: 1,
            event: { ...event(id, 1), encryptedProps: ["text"] },
          },
          { aggregate_id: id, aggregate_version: 2, event: event(id, 2) },
        ]);
      });

      it("should not store undefined values, at any depth", async () => {
        // arrange
        const id = v4();
        const data = {
          dropped: undefined,
          map: { kept: 1, dropped: undefined },
          list: [undefined, "a", undefined, ["b", undefined], { c: undefined }],
          holes: [, 1, , 2],
        };

        // act
        await store.appendAsync(id, [event(id, 0, data)], 0);
        const [row] = await postgres.rowsAsync("events", id);
        const read = await store.readAsync(id);

        // assert
        const kept = {
          map: { kept: 1 },
          list: ["a", ["b"], {}],
          holes: [1, 2],
        };
        expect(JSON.parse(row.event).data).toStrictEqual(kept);
        expect(read).toStrictEqual([event(id, 0, kept)]);
      });

      // jsonb keeps the shorter of two names first, as Postgres documents
      it("should not keep the order of the properties", async () => {
        // arrange
        const id = v4();

        // act
        await store.appendAsync(id, [event(id, 0, { bb: 1, a: 2, c: 3 })], 0);
        const [read] = await store.readAsync(id);

        // assert
        expect(Object.keys(read.data)).toEqual(["a", "c", "bb"]);
        expect(read.data).toEqual({ bb: 1, a: 2, c: 3 });
      });

      it("should read the events in the order of their versions, as numbers, however they were appended", async () => {
        // arrange
        const id = v4();

        // act
        for (const versions of [[100], [10, 11], [2], [9], [0, 1]]) {
          await store.appendAsync(id, eventsOf(id, versions), versions[0]);
        }

        // assert
        expect(await store.readAsync(id)).toStrictEqual(
          eventsOf(id, [0, 1, 2, 9, 10, 11, 100])
        );
      });

      it("should store nothing, and send nothing, when there are no events", async () => {
        // arrange
        const id = v4();
        const missing = new PostgresEventStore(postgres.pool, {
          table: postgres.tableOf("missing"),
        });

        // act / assert
        await expect(store.appendAsync(id, [], 0)).resolves.toBeUndefined();
        // the table is not even looked at
        await expect(missing.appendAsync(id, [], 0)).resolves.toBeUndefined();
        expect(await postgres.rowsAsync("events", id)).toEqual([]);
      });

      it("should read an empty array for an aggregate without events", async () => {
        expect(await store.readAsync(v4())).toEqual([]);
      });

      it("should parse the events itself, whatever parser for jsonb the pool has", async () => {
        // arrange
        const id = v4();
        // 3802 is jsonb
        const appTypes = {
          getTypeParser: (oid: number) =>
            oid === 3802 ? () => "parsed by the app" : types.getTypeParser(oid),
        };
        const pool = new Pool({ ...Postgres.config, types: appTypes });

        try {
          const withParser = new PostgresEventStore(pool, { table });
          await withParser.appendAsync(id, eventsOf(id, [0, 1]), 0);

          // act
          const read = await withParser.readAsync(id);

          // assert
          expect(read).toStrictEqual(eventsOf(id, [0, 1]));
          const { rows } = await pool.query(
            `SELECT event FROM ${postgres.sqlOf(
              "events"
            )} WHERE aggregate_id = $1`,
            [id]
          );
          expect(rows.map(({ event }) => event)).toEqual([
            "parsed by the app",
            "parsed by the app",
          ]);
        } finally {
          await pool.end();
        }
      });
    });

    describe("limits", () => {
      it("should append 32767 events at once", async () => {
        // arrange
        const id = v4();
        const events = eventsOf(id, range(0, 32766), {});

        // act
        await store.appendAsync(id, events, 0);

        // assert
        expect(await store.readAsync(id)).toStrictEqual(events);
      });

      it("should store a version up to 2147483647, and pass on the error for a greater one", async () => {
        // arrange
        const id = v4();
        const largest = 2 ** 31 - 1;

        // act
        await store.appendAsync(id, [event(id, largest)], largest);
        const error = await store
          .appendAsync(id, [event(id, largest + 1)], largest + 1)
          .catch((e) => e);

        // assert
        expect(await store.readAsync(id)).toStrictEqual([event(id, largest)]);
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        // numeric_value_out_of_range
        expect(error).toMatchObject({ code: "22003", severity: "ERROR" });
      });

      it("should pass on the error for an id that is too long for the primary key", async () => {
        // arrange
        // in characters that do not compress
        const idOf = (length: number) =>
          randomBytes(length).toString("base64").slice(0, length);
        const [long, tooLong] = [idOf(2600), idOf(3000)];

        // act
        await store.appendAsync(long, eventsOf(long, [0]), 0);
        const error = await store
          .appendAsync(tooLong, eventsOf(tooLong, [0]), 0)
          .catch((e) => e);

        // assert
        expect(await store.readAsync(long)).toStrictEqual(eventsOf(long, [0]));
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        // program_limit_exceeded
        expect(error).toMatchObject({ code: "54000", severity: "ERROR" });
      });
    });

    describe("what it refuses", () => {
      it.each<[string, unknown]>([
        ["a date", new Date(0)],
        ["a map", new Map([["a", 1]])],
        ["a set", new Set(["a"])],
        ["bytes", new Uint8Array([1])],
        ["an instance of a class", new (class Thing {})()],
        ["NaN", NaN],
        ["Infinity", Infinity],
        ["-Infinity", -Infinity],
        ["a bigint", BigInt(1)],
        ["a symbol", Symbol("a")],
        ...flaws.map(([name, text]): [string, unknown] => [
          `a string with ${name}`,
          text,
        ]),
      ])("should store nothing of an append that has %s", async (_, value) => {
        // arrange
        const id = v4();
        const events = [event(id, 0), event(id, 1, { list: [{ value }] })];

        // act
        const error = await store.appendAsync(id, events, 0).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        expect(error.message).toContain("SomethingHappened.data.list[0].value");
        expect(await postgres.rowsAsync("events", id)).toEqual([]);
      });

      it.each(flaws)(
        "should store nothing of an append that has a property name with %s",
        async (_, name) => {
          // arrange
          const id = v4();
          const events = [event(id, 0), event(id, 1, { map: { [name]: 1 } })];

          // act
          const error = await store.appendAsync(id, events, 0).catch((e) => e);

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toContain("SomethingHappened.data.map");
          expect(await postgres.rowsAsync("events", id)).toEqual([]);
        }
      );

      it("should store nothing of an append in which an event is of another aggregate", async () => {
        // arrange
        const [id, otherId] = [v4(), v4()];
        const events = [event(id, 0), event(otherId, 1), event(id, 2)];

        // act
        const error = await store.appendAsync(id, events, 0).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        expect(await postgres.rowsAsync("events", id)).toEqual([]);
        expect(await postgres.rowsAsync("events", otherId)).toEqual([]);
      });

      it("should not read the events of another aggregate for an id with a lone surrogate", async () => {
        // arrange
        // pg would send the lone surrogate as U+FFFD, which is this id
        const suffix = v4();
        const replaced = `a\ufffd${suffix}`;
        await store.appendAsync(replaced, eventsOf(replaced, [0]), 0);

        // act
        const error = await store.readAsync(`a\ud800${suffix}`).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(
          "An aggregate's id cannot have a lone surrogate, because Postgres cannot hold it in a text."
        );
      });
    });

    describe("when a version is already stored", () => {
      it.each([[1], [2], [3]])(
        "should store none of events 1 to 3 when that is version %i",
        async (takenVersion) => {
          // arrange
          const id = v4();
          await store.appendAsync(id, [event(id, 0)], 0);
          await store.appendAsync(
            id,
            [event(id, takenVersion, "first")],
            takenVersion
          );
          const before = await postgres.rowsAsync("events", id);

          // act
          const error = await store
            .appendAsync(id, eventsOf(id, [1, 2, 3], "second"), 1)
            .catch((e) => e);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.aggregateId).toBe(id);
          expect(error.expectedVersion).toBe(1);
          // the unique violation, on the primary key
          expect(error.cause).toBeInstanceOf(Error);
          expect(error.cause).toMatchObject({
            code: "23505",
            severity: "ERROR",
            constraint: "events_pkey",
          });
          expect(await postgres.rowsAsync("events", id)).toEqual(before);
        }
      );

      it("should store an append only once", async () => {
        // arrange
        const id = v4();
        const events = eventsOf(id, [0, 1]);
        await store.appendAsync(id, events, 0);

        // act
        const error = await store.appendAsync(id, events, 0).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(ConcurrencyError);
        expect(await store.readAsync(id)).toStrictEqual(events);
      });
    });

    describe("when appends are made at once", () => {
      it("should store only one of two appends of the same versions, made at once from two pools", async () => {
        // arrange
        const id = v4();
        const pools = [new Pool(Postgres.config), new Pool(Postgres.config)];
        const appends = pools.map((pool, index) => ({
          store: new PostgresEventStore(pool, { table }),
          events: eventsOf(id, [0, 1], `from pool ${index}`),
        }));
        // a lock on the table holds both back until both wait for it
        const holder = await postgres.pool.connect();

        try {
          await holder.query("BEGIN");
          await holder.query(
            `LOCK TABLE ${postgres.sqlOf("events")} IN EXCLUSIVE MODE`
          );

          // act
          const outcomes = appends.map(({ store, events }) =>
            store.appendAsync(id, events, 0).then(
              () => undefined,
              (error) => error
            )
          );
          await postgres.waitUntilBlockedAsync(holder, 2);
          await holder.query("COMMIT");
          const errors = await Promise.all(outcomes);

          // assert
          const winners = appends.filter((_, index) => !errors[index]);
          expect(winners).toHaveLength(1);
          const [loser] = errors.filter((error) => error);
          expect(loser).toBeInstanceOf(ConcurrencyError);
          expect(loser).toMatchObject({ aggregateId: id, expectedVersion: 0 });
          expect(loser.cause).toMatchObject({ code: "23505" });
          expect(await store.readAsync(id)).toStrictEqual(winners[0].events);
        } finally {
          holder.release();
          await Promise.all(pools.map((pool) => pool.end()));
        }
      });

      it("should wait for a transaction that is storing the version, and reject with a ConcurrencyError when it commits", async () => {
        // arrange
        const id = v4();
        const first = eventsOf(id, [0, 1], "first");
        const holder = await postgres.pool.connect();

        try {
          await holder.query("BEGIN");
          await new PostgresEventStore(holder, { table }).appendAsync(
            id,
            first,
            0
          );

          // act
          const append = store
            .appendAsync(id, eventsOf(id, [1, 2], "second"), 1)
            .catch((e) => e);
          await postgres.waitUntilBlockedAsync(holder, 1);
          await holder.query("COMMIT");
          const error = await append;

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error).toMatchObject({ aggregateId: id, expectedVersion: 1 });
          expect(error.cause).toMatchObject({ code: "23505" });
          expect(await store.readAsync(id)).toStrictEqual(first);
        } finally {
          holder.release();
        }
      });

      it("should store the events when the transaction that was storing the version rolls back", async () => {
        // arrange
        const id = v4();
        const second = eventsOf(id, [0], "second");
        const holder = await postgres.pool.connect();

        try {
          await holder.query("BEGIN");
          await new PostgresEventStore(holder, { table }).appendAsync(
            id,
            eventsOf(id, [0, 1], "first"),
            0
          );

          // act
          const append = store.appendAsync(id, second, 0);
          await postgres.waitUntilBlockedAsync(holder, 1);
          await holder.query("ROLLBACK");
          await append;

          // assert
          expect(await store.readAsync(id)).toStrictEqual(second);
        } finally {
          holder.release();
        }
      });
    });

    describe("with a client", () => {
      it("should append and read with a Client", async () => {
        // arrange
        const id = v4();
        const client = new Client(Postgres.config);
        await client.connect();

        try {
          const withClient = new PostgresEventStore(client, { table });

          // act
          await withClient.appendAsync(id, eventsOf(id, [0, 1]), 0);

          // assert
          expect(await withClient.readAsync(id)).toStrictEqual(
            eventsOf(id, [0, 1])
          );
        } finally {
          await client.end();
        }
      });

      it("should append in the transaction of the client that it is given", async () => {
        // arrange
        const id = v4();
        const events = eventsOf(id, [0, 1]);
        const client = await postgres.pool.connect();

        try {
          const inTransaction = new PostgresEventStore(client, { table });
          await client.query("BEGIN");

          // act
          await inTransaction.appendAsync(id, events, 0);
          const readInside = await inTransaction.readAsync(id);
          const readOutside = await store.readAsync(id);
          await client.query("COMMIT");

          // assert
          expect(readInside).toStrictEqual(events);
          expect(readOutside).toEqual([]);
          expect(await store.readAsync(id)).toStrictEqual(events);
        } finally {
          client.release();
        }
      });

      it("should store nothing of a write whose transaction rolls back, though the aggregate has no changes left", async () => {
        // arrange
        const id = v4();
        const ar = TestAggregateRoot.create(id, "a name");
        const client = await postgres.pool.connect();

        try {
          const repository = new Repository(
            new PostgresEventStore(client, { table }),
            TestAggregateRoot.factory
          );
          await client.query("BEGIN");

          // act
          await repository.writeAsync(ar);
          await client.query("ROLLBACK");

          // assert
          expect(ar.getChanges()).toHaveLength(0);
          expect(await store.readAsync(id)).toEqual([]);
        } finally {
          client.release();
        }
      });

      it("should abort the transaction of the client when it rejects with a ConcurrencyError", async () => {
        // arrange
        const id = v4();
        await store.appendAsync(id, eventsOf(id, [0]), 0);
        const client = await postgres.pool.connect();

        try {
          const inTransaction = new PostgresEventStore(client, { table });
          await client.query("BEGIN");

          // act
          const error = await inTransaction
            .appendAsync(id, eventsOf(id, [0]), 0)
            .catch((e) => e);
          const next = await client.query("SELECT 1").catch((e) => e);
          await client.query("ROLLBACK");

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          // in_failed_sql_transaction
          expect(next).toMatchObject({ code: "25P02" });
        } finally {
          client.release();
        }
      });
    });

    describe("when two transactions at the same isolation level append the same version", () => {
      // Two transactions at the level, each with a client of its own. Both begin, and
      // each reads the aggregate, which is at version 0, if it is to. The first appends
      // version 1. The second appends versions 1 and 2, while the first is open, so that
      // it waits until the first commits, or after the first has committed. Then the
      // second commits, which Postgres turns into a rollback if its append was rejected.
      const appendInTwoTransactionsAsync = async (options: {
        level: string;
        firstReads: boolean;
        secondReads: boolean;
        secondWaits: boolean;
      }) => {
        const id = v4();
        // the event that is stored before, and the one that the first appends
        const stored = [event(id, 0), event(id, 1, "first")];
        await store.appendAsync(id, [stored[0]], 0);
        const first = new Client(Postgres.config);
        const second = new Client(Postgres.config);
        const firstStore = new PostgresEventStore(first, { table });
        // what pg rejects with in the second transaction
        const thrown: unknown[] = [];
        const secondStore = new PostgresEventStore(
          {
            query: (text, values) =>
              second.query(text, values).catch((error) => {
                thrown.push(error);
                throw error;
              }),
          },
          { table }
        );
        await first.connect();
        await second.connect();

        try {
          await first.query(`BEGIN ISOLATION LEVEL ${options.level}`);
          await second.query(`BEGIN ISOLATION LEVEL ${options.level}`);
          if (options.firstReads) {
            await firstStore.readAsync(id);
          }
          if (options.secondReads) {
            await secondStore.readAsync(id);
          }
          await firstStore.appendAsync(id, [stored[1]], 1);

          const appendSecondAsync = () =>
            secondStore
              .appendAsync(id, eventsOf(id, [1, 2], "second"), 1)
              .catch((e) => e);
          let error;
          if (options.secondWaits) {
            const append = appendSecondAsync();
            await postgres.waitUntilBlockedAsync(first, 1);
            await first.query("COMMIT");
            error = await append;
          } else {
            await first.query("COMMIT");
            error = await appendSecondAsync();
          }
          await second.query("COMMIT");

          return { id, error, thrown, stored };
        } finally {
          await first.end();
          await second.end();
        }
      };

      describe.each([
        {
          timing: "while the first is open, so that it waits",
          secondWaits: true,
        },
        { timing: "after the first has committed", secondWaits: false },
      ])("and the second appends $timing", ({ secondWaits }) => {
        it.each([
          ["READ COMMITTED", "both have", true, true],
          ["REPEATABLE READ", "both have", true, true],
          ["SERIALIZABLE", "only the first has", true, false],
          ["SERIALIZABLE", "only the second has", false, true],
        ])(
          "should reject the second with a ConcurrencyError at %s, when %s read the aggregate",
          async (level, _, firstReads, secondReads) => {
            // act
            const { id, error, stored } = await appendInTwoTransactionsAsync({
              level,
              firstReads,
              secondReads,
              secondWaits,
            });

            // assert
            expect(error).toBeInstanceOf(ConcurrencyError);
            expect(error).toMatchObject({
              aggregateId: id,
              expectedVersion: 1,
            });
            expect(error.cause).toMatchObject({ code: "23505" });
            // the second stored nothing
            expect(await store.readAsync(id)).toStrictEqual(stored);
          }
        );

        it("should reject the second with the serialization failure of Postgres at SERIALIZABLE, when both have read the aggregate", async () => {
          // act
          const { id, error, thrown, stored } =
            await appendInTwoTransactionsAsync({
              level: "SERIALIZABLE",
              firstReads: true,
              secondReads: true,
              secondWaits,
            });

          // assert
          // the error from pg, as it is, and not a ConcurrencyError
          expect(thrown).toHaveLength(1);
          expect(error).toBe(thrown[0]);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          // serialization_failure
          expect(error).toMatchObject({ code: "40001", severity: "ERROR" });
          // the second stored nothing
          expect(await store.readAsync(id)).toStrictEqual(stored);
        });
      });
    });

    describe("the table", () => {
      it("should be the one that createTableSql creates", async () => {
        expect(await postgres.columnsAsync("events")).toEqual([
          "aggregate_id text collate C not null",
          "aggregate_version integer not null",
          "event jsonb not null",
        ]);
        expect(await postgres.uniqueKeysAsync("events")).toEqual([
          "PRIMARY KEY (aggregate_id, aggregate_version)",
        ]);
      });

      it("should be events, in the first schema of the search_path, if none is given", async () => {
        // arrange
        const id = v4();
        const client = new Client(Postgres.config);
        await client.connect();

        try {
          await client.query(
            `SET search_path TO ${Postgres.quote(postgres.schema)}`
          );

          // act
          await new PostgresEventStore(client).appendAsync(
            id,
            eventsOf(id, [0]),
            0
          );

          // assert
          expect(await postgres.rowsAsync("events", id)).toHaveLength(1);
        } finally {
          await client.end();
        }
      });

      it("should be used as it is named, in a schema as it is named, whatever the names hold", async () => {
        // arrange
        const odd = new Postgres(`Odd "Schema" é ${v4()}`);
        const names = [
          "events",
          "EVENTS",
          'my "events"',
          'x"; DROP TABLE events; --',
          "東京 😀",
          " ",
        ];
        const id = v4();

        try {
          await odd.startAsync();
          for (const name of names) {
            await odd.createTableAsync(name);
          }

          // act
          for (const name of names) {
            const oddStore = new PostgresEventStore(odd.pool, {
              table: odd.tableOf(name),
            });
            await oddStore.appendAsync(id, eventsOf(id, [0], name), 0);
          }

          // assert
          // each table has its own event, and no other table was made or dropped
          for (const name of names) {
            const oddStore = new PostgresEventStore(odd.pool, {
              table: odd.tableOf(name),
            });
            expect(await oddStore.readAsync(id)).toStrictEqual(
              eventsOf(id, [0], name)
            );
            expect(await odd.rowsAsync(name, id)).toHaveLength(1);
          }
          expect((await odd.tablesAsync()).sort()).toEqual([...names].sort());
          expect(await postgres.tablesAsync()).toEqual(["events"]);
        } finally {
          await odd.stopAsync();
        }
      });

      it.each([
        ["table", () => postgres.tableOf("missing")],
        ["schema", () => `missing-${v4()}.events`],
      ])(
        "should pass on the error when there is no such %s",
        async (_, tableOf) => {
          // arrange
          const id = v4();
          // what pg rejects with
          const thrown: unknown[] = [];
          const pool: Queryable = {
            query: (text, values) =>
              postgres.pool.query(text, values).catch((error) => {
                thrown.push(error);
                throw error;
              }),
          };
          const missing = new PostgresEventStore(pool, { table: tableOf() });

          // act
          const errors = [
            await missing.appendAsync(id, eventsOf(id, [0]), 0).catch((e) => e),
            await missing.readAsync(id).catch((e) => e),
          ];

          // assert
          expect(errors).toHaveLength(2);
          errors.forEach((error, index) => {
            expect(error).toBe(thrown[index]);
            // undefined_table
            expect(error).toMatchObject({ code: "42P01", severity: "ERROR" });
          });
        }
      );
    });
  });
});
