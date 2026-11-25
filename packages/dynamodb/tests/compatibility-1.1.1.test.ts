import {
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AggregateRoot,
  ConcurrencyError,
  Repository,
} from "@es-aggregates/core";
import { TestAggregateRoot } from "@es-aggregates/store-tests";
import * as es1 from "es-aggregates-1";
import crypto from "node:crypto";
import { v4 } from "uuid";

import { App } from "./test-objects/app";
import { golden } from "./test-objects/golden-data";
import { LocalEventTable } from "./test-objects/local-event-table";
import { Answer, StubbedDynamoDB } from "./test-objects/stubbed-dynamodb";

// Apps have stored events with 1.1.1. They must be able to go to 2.0, and back, with
// no change to what is stored. So these tests run the same app on both, with 1.1.1 as
// it was published.
describe("Compatibility with es-aggregates 1.1.1", () => {
  const published = App.onPublished();
  const current = App.onCurrent();

  const key = golden.testEncryptionKey;
  const keys: Array<[string, string | undefined]> = [
    ["with the key", key],
    ["without a key", undefined],
  ];

  const table = new LocalEventTable();
  const ok: Answer = { status: 200, body: {} };
  const cancelled: Answer = {
    status: 400,
    body: {
      __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    },
  };

  let logged: jest.SpyInstance;
  let ivCount: number;

  // gives each run the same ivs and timestamps
  const startRun = () => {
    ivCount = 0;
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  };

  beforeEach(() => {
    // each envelope that cannot be decrypted is logged
    logged = jest.spyOn(console, "error").mockImplementation(() => {});
    // the app has old-style events, and each kind of those is warned about
    jest.spyOn(console, "warn").mockImplementation(() => {});

    jest
      .spyOn(crypto, "randomBytes")
      .mockImplementation((size: number) => Buffer.alloc(size, ++ivCount));
    jest.useFakeTimers({
      // fake nothing but Date
      doNotFake: [
        "clearImmediate",
        "clearInterval",
        "clearTimeout",
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "setInterval",
        "setTimeout",
      ],
    });
    startRun();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // what the app does to an aggregate. The changes in each list are written together
  const changes: Array<Array<(ar: TestAggregateRoot) => void>> = [
    [
      (ar) => ar.createSecret("a secret", "not declared in encryptedProps"),
      (ar) =>
        ar.recordDetails({
          text: "Zoë Åström, 東京",
          emptyText: "",
          whole: 3,
          fraction: -1.5,
          big: BigInt("12345678901234567890"),
          yes: true,
          no: false,
          nothing: null,
          dropped: undefined,
          droppedToo: () => {},
          list: ["a", undefined, 1, null, ["nested", undefined], { b: "c" }],
          emptyList: [],
          map: { kept: "kept", dropped: undefined, nested: { a: undefined } },
          emptyMap: {},
          texts: new Set(["a", undefined, "b"]),
          numbers: new Set([1, 2.5]),
          bytes: new Uint8Array([0, 1, 255]),
        }),
    ],
    [
      (ar) => ar.createMessage("こんにちは"), // imageUrl is undefined
      (ar) => ar.createMessage(null!, "https://example.com/image.png"),
      (ar) => ar.createSecret("", ""),
      (ar) => ar.changeName("an event that declares no encryptedProps"),
    ],
  ];

  const writeAsync = async (
    app: App,
    client: DynamoDBClient,
    id: string,
    encryptionKey?: string
  ) => {
    const repo = app.repository(table.name, client);
    const ar = app.TestAggregateRoot.create(id, "a name");
    for (const changesOfWrite of changes) {
      for (const change of changesOfWrite) {
        jest.advanceTimersByTime(1);
        change(ar);
      }
      await repo.writeAsync(ar, encryptionKey);
    }
  };

  const readAsync = async (
    app: App,
    client: DynamoDBClient,
    id: string,
    encryptionKey?: string
  ) => {
    const events: Array<Array<[string, unknown]>> = [];
    const repo = app.repository(table.name, client, () => {
      const ar = app.TestAggregateRoot.factory();
      const initialize = ar.initialize;
      ar.initialize = (replayed) => {
        // as entries, so that the order of properties counts
        events.push(...replayed.map((event) => Object.entries(event)));
        initialize(replayed);
      };
      return ar;
    });

    logged.mockClear();
    const ar = await repo.readAsync(id, encryptionKey);
    return { state: ar?.state, events, logged: [...logged.mock.calls] };
  };

  it("should run the app on the published package and on this repository", () => {
    expect(require("es-aggregates-1/package.json").version).toBe("1.1.1");

    const ar1 = published.TestAggregateRoot.factory();
    const repo1 = published.repository(table.name, table.client);
    expect(ar1).toBeInstanceOf(es1.AggregateRoot);
    expect(ar1).not.toBeInstanceOf(AggregateRoot);
    expect(repo1).toBeInstanceOf(es1.Repository);

    const ar2 = current.TestAggregateRoot.factory();
    const repo2 = current.repository(table.name, table.client);
    expect(ar2).toBeInstanceOf(AggregateRoot);
    expect(ar2).not.toBeInstanceOf(es1.AggregateRoot);
    expect(repo2).toBeInstanceOf(Repository);
  });

  describe("Requests to DynamoDB", () => {
    // what each app sends, and what it makes of the answers
    const runBothAsync = async <T>(
      answers: Answer[],
      act: (app: App, client: DynamoDBClient) => Promise<T>
    ) => {
      const runs = [];
      for (const app of [published, current]) {
        const dynamo = new StubbedDynamoDB([...answers]);
        startRun();
        const result = await act(app, dynamo.client);
        const sent = dynamo.requests.map(({ operation, body }) => {
          // the SDK makes up a token for each write
          const { ClientRequestToken, ...input } = JSON.parse(body);
          return { operation, input };
        });
        runs.push({ sent, result });
      }
      return runs;
    };

    it.each(keys)(
      "should be the same when writing %s",
      async (_, encryptionKey) => {
        // act
        const [run1, run2] = await runBothAsync([ok, ok], (app, client) =>
          writeAsync(app, client, "some id", encryptionKey)
        );

        // assert
        expect(run2.sent).toEqual(run1.sent);
        // as JSON too, so that the order of properties counts
        const json = JSON.stringify(run1.sent);
        expect(JSON.stringify(run2.sent)).toBe(json);

        // and these are the requests that were to be compared
        expect(run1.sent).toMatchObject([
          {
            operation: "TransactWriteItems",
            input: { TransactItems: { length: 3 } },
          },
          {
            operation: "TransactWriteItems",
            input: { TransactItems: { length: 4 } },
          },
        ]);
        const envelopes = json.match(/ENC1\./g) ?? [];
        expect(envelopes).toHaveLength(encryptionKey ? 5 : 0);
      }
    );

    it("should be the same when writing 100 changes, as many as there can be", async () => {
      // act
      const [run1, run2] = await runBothAsync([ok], async (app, client) => {
        const ar = app.TestAggregateRoot.create("some id", "name 0");
        for (let version = 1; version < 100; version++) {
          ar.changeName(`name ${version}`);
        }

        let refusal: string | undefined;
        try {
          ar.changeName("name 100");
        } catch (error) {
          refusal = (error as Error).message;
        }

        await app.repository(table.name, client).writeAsync(ar);
        return refusal;
      });

      // assert
      expect(run2).toEqual(run1);
      expect(JSON.stringify(run2.sent)).toBe(JSON.stringify(run1.sent));

      // and this is the request that was to be compared
      expect(run1.sent).toMatchObject([
        {
          operation: "TransactWriteItems",
          input: { TransactItems: { length: 100 } },
        },
      ]);
      expect(run1.result).toContain("limit of 100");
    });

    // none of these makes a change during a write
    it.each<
      [string, Answer[], (app: App, client: DynamoDBClient) => Promise<any>]
    >([
      [
        "a write is made again after it has failed",
        [new Error("socket hang up"), ok, ok],
        async (app, client) => {
          const repo = app.repository(table.name, client);
          const ar = app.TestAggregateRoot.create("some id", "0");
          const error = await repo.writeAsync(ar).catch((e) => e);
          ar.changeName("1");
          await repo.writeAsync(ar);
          ar.changeName("2");
          await repo.writeAsync(ar);
          return [error.message, ar.state, ar.getChanges()];
        },
      ],
      [
        "an object is written twice at once",
        [ok, cancelled, ok],
        async (app, client) => {
          const repo = app.repository(table.name, client);
          const ar = app.TestAggregateRoot.create("some id", "0");
          ar.changeName("1");
          const writes = [repo.writeAsync(ar), repo.writeAsync(ar)];
          const areRejected = await Promise.all(
            writes.map((write) =>
              write.then(
                () => false,
                () => true
              )
            )
          );
          ar.changeName("2");
          await repo.writeAsync(ar);
          return [areRejected, ar.state, ar.getChanges()];
        },
      ],
      [
        "an object is written to two tables at once",
        [ok, ok, ok, ok],
        async (app, client) => {
          const repos = ["a table", "another table"].map((tableName) =>
            app.repository(tableName, client)
          );
          const ar = app.TestAggregateRoot.create("some id", "0");
          ar.changeName("1");
          await Promise.all(repos.map((repo) => repo.writeAsync(ar)));
          ar.changeName("2");
          await Promise.all(repos.map((repo) => repo.writeAsync(ar)));
          return [ar.state, ar.getChanges()];
        },
      ],
      [
        "an app uses the aggregate's own methods",
        [ok, ok],
        async (app, client) => {
          const repo = app.repository(table.name, client);
          const ar = app.TestAggregateRoot.factory();
          const [e0, e1, e2, e3] = ["0", "1", "2", "3"].map(
            (name) =>
              app.TestAggregateRoot.create("some id", name).getChanges()[0]
          );
          ar.initialize([e0]);
          [[e1, e2], [], [e3]].forEach(ar.initialize);
          const changes = ar.getChanges();
          ["4", "5"].forEach(ar.changeName);
          ar.clearChanges();
          ar.clearChanges();
          ["6", "7"].forEach(ar.changeName);
          const write = repo.writeAsync(ar);
          ar.clearChanges();
          await write;
          ar.changeName("8");
          await repo.writeAsync(ar);
          return [ar.state, changes, changes === ar.getChanges()];
        },
      ],
    ])("should be the same when %s", async (_, answers, act) => {
      // act
      const [run1, run2] = await runBothAsync(answers, act);

      // assert
      expect(run2).toEqual(run1);
      expect(JSON.stringify(run2)).toBe(JSON.stringify(run1));

      // and these are the requests that were to be compared
      expect(run1.sent).toHaveLength(answers.length);
    });

    it.each([
      ["a date", new Date(0)],
      ["an instance of a class", new (class Thing {})()],
      ["an empty set", new Set()],
      ["a number that is not a number", NaN],
      ["a number that is not safe", Number.MAX_SAFE_INTEGER + 1],
    ])("should not be made for an event that has %s", async (_, value) => {
      // act
      const [run1, run2] = await runBothAsync([], async (app, client) => {
        const ar = app.TestAggregateRoot.create("some id", "a name");
        ar.recordDetails({ value });
        const repo = app.repository(table.name, client);
        return repo.writeAsync(ar).catch((e) => e.message);
      });

      // assert
      expect(run2).toEqual(run1);
      expect(run1).toEqual({ sent: [], result: expect.any(String) });
    });

    describe.each(golden.aggregates)(
      "for the golden data: $description",
      ({ aggregateId, items }) => {
        it.each(keys)(
          "should be the same when reading %s",
          async (_, encryptionKey) => {
            // arrange
            // each page has one item, and all but the last have another after them
            const lastKeys = items
              .slice(0, -1)
              .map(({ aggregateId, aggregateVersion }) => ({
                aggregateId,
                aggregateVersion,
              }));
            const pages = items.map((item, index) => ({
              status: 200,
              body: { Items: [item], LastEvaluatedKey: lastKeys[index] },
            }));

            // act
            const [run1, run2] = await runBothAsync(pages, (app, client) =>
              readAsync(app, client, aggregateId, encryptionKey)
            );

            // assert
            expect(run2).toEqual(run1);
            expect(JSON.stringify(run2.sent)).toBe(JSON.stringify(run1.sent));

            // and these are the requests that were to be compared
            expect(
              run1.sent.map(({ operation, input }) => [
                operation,
                input.ExclusiveStartKey,
              ])
            ).toEqual([undefined, ...lastKeys].map((key) => ["Query", key]));
            expect(run1.result.events).toHaveLength(items.length);
          }
        );
      }
    );
  });

  // writing with 2.0 and reading with 1.1.1 is what happens after a rollback
  describe.each([
    [published, current],
    [current, published],
  ])("Events written by %s", (writer, reader) => {
    describe.each(keys)("%s", (_, writeKey) => {
      it.each(keys)(
        `should read back identically through ${reader} %s`,
        async (_, readKey) => {
          // arrange
          const id = v4();
          await writeAsync(writer, table.client, id, writeKey);

          // act
          const own = await readAsync(writer, table.client, id, readKey);
          const other = await readAsync(reader, table.client, id, readKey);

          // assert
          expect(other).toEqual(own);

          // and this is what was to be read
          const isReadable = writeKey === undefined || readKey !== undefined;
          expect(own.events).toHaveLength(7);
          expect(own.state).toMatchObject({
            version: 7,
            id,
            name: "an event that declares no encryptedProps",
            created: "2026-01-01T00:00:00.000Z",
            secret: isReadable ? "" : expect.stringMatching(/^ENC1\./),
            plain: "",
            messageText: null,
            details: { list: ["a", 1, null, ["nested"], { b: "c" }] },
          });
          expect(own.logged).toHaveLength(isReadable ? 0 : 5);
        }
      );
    });
  });

  describe.each(golden.aggregates)(
    "Golden data: $description",
    ({ aggregateId, items }) => {
      it.each(keys)(
        "should read back identically through both %s",
        async (_, encryptionKey) => {
          // arrange
          for (const item of items) {
            await table.putAsync(item);
          }

          // act
          const [by1, by2] = [
            await readAsync(
              published,
              table.client,
              aggregateId,
              encryptionKey
            ),
            await readAsync(current, table.client, aggregateId, encryptionKey),
          ];

          // assert
          expect(by2).toEqual(by1);
          expect(by1.events).toHaveLength(items.length);
        }
      );
    }
  );

  describe("Both in use at once", () => {
    it.each(keys)(
      "should be able to take turns at writing to an aggregate %s",
      async (_, encryptionKey) => {
        // arrange
        const id = v4();
        await writeAsync(published, table.client, id, encryptionKey);

        // act
        for (const app of [current, published, current, published]) {
          const repo = app.repository(table.name, table.client);
          const ar = (await repo.readAsync(id, encryptionKey))!;
          ar.createSecret(`the secret of ${app}`);
          ar.changeName(`changed by ${app}`);
          await repo.writeAsync(ar, encryptionKey);
        }

        // assert
        const by1 = await readAsync(published, table.client, id, encryptionKey);
        const by2 = await readAsync(current, table.client, id, encryptionKey);
        expect(by2).toEqual(by1);
        expect(by1.state).toMatchObject({
          version: 7 + 8,
          name: "changed by 1.1.1",
          secret: "the secret of 1.1.1",
        });
        expect(await table.itemsAsync(id)).toMatchObject(
          by1.events.map((_, version) => ({
            aggregateVersion: { N: `${version}` },
          }))
        );
      }
    );

    it.each([
      [published, current],
      [current, published],
    ])(
      "should have a write by %s stop a write of the same version by %s",
      async (first, second) => {
        // arrange
        const id = v4();
        await writeAsync(first, table.client, id);
        const [firstRepo, secondRepo] = [first, second].map((app) =>
          app.repository(table.name, table.client)
        );
        const firstAr = (await firstRepo.readAsync(id))!;
        const secondAr = (await secondRepo.readAsync(id))!;
        firstAr.changeName("first");
        secondAr.changeName("second");

        // act
        await firstRepo.writeAsync(firstAr);
        const error = await secondRepo.writeAsync(secondAr).catch((e) => e);

        // assert
        const cancelled = second === current ? error.cause : error;
        expect(cancelled).toBeInstanceOf(TransactionCanceledException);
        expect(cancelled.CancellationReasons).toMatchObject([
          { Code: "ConditionalCheckFailed" },
        ]);
        expect(error instanceof ConcurrencyError).toBe(second === current);
        expect((await firstRepo.readAsync(id))!.name).toBe("first");
      }
    );
  });

  describe.each([published, current])("Other behaviour of %s", (app) => {
    it("should write the events as they were when the write began", async () => {
      // arrange
      const dynamo = new StubbedDynamoDB([ok]);
      const repo = app.repository(table.name, dynamo.client);
      const ar = app.TestAggregateRoot.create("some id", "a name");
      const list = ["before"];
      ar.recordDetails({ list });

      // act
      const write = repo.writeAsync(ar);
      list.push("during");
      await write;

      // assert
      const [, { Put }] = JSON.parse(dynamo.requests[0].body).TransactItems;
      expect(Put.Item.data.M.details.M.list.L).toEqual([{ S: "before" }]);
    });

    // the rest are quirks: not to be relied on, but 2.0 does not change them

    it("should expect the version to be the number of events", async () => {
      // arrange
      // versions 1 to 3 are missing
      const id = v4();
      const repo = app.repository(table.name, table.client);
      await repo.writeAsync(app.TestAggregateRoot.create(id, "a name"));
      const [created] = await table.itemsAsync(id);
      await table.putAsync({ ...created, aggregateVersion: { N: "4" } });

      // act
      const ar = (await repo.readAsync(id))!;
      ar.changeName("another name");
      await repo.writeAsync(ar);

      // assert
      expect(await table.itemsAsync(id)).toMatchObject(
        ["0", "2", "4"].map((N) => ({ aggregateVersion: { N } }))
      );
    });

    it("should reset the translateConfig of the client that it is given", async () => {
      // arrange
      const dynamo = new StubbedDynamoDB([ok, ok]);
      const repo = app.repository(table.name, dynamo.client);
      const { config } = dynamo.client as { config: { translateConfig?: {} } };

      // act / assert
      DynamoDBDocumentClient.from(dynamo.client, { marshallOptions: {} });
      expect(config.translateConfig).toBeDefined();
      await repo.writeAsync(app.TestAggregateRoot.create("some id", "a name"));
      expect(config.translateConfig).toBeUndefined();

      DynamoDBDocumentClient.from(dynamo.client, { marshallOptions: {} });
      expect(config.translateConfig).toBeDefined();
      await repo.readAsync("some id");
      expect(config.translateConfig).toBeUndefined();
    });
  });

  // the rest are faults of 1.1.1, which 2.0 does not have

  // the version of each of an aggregate's items, and the name in it
  const storedAsync = async (id: string) => {
    const items = await table.itemsAsync(id);
    return items.map(({ aggregateVersion, data }) => [
      Number(aggregateVersion.N),
      data.M!.name.S,
    ]);
  };

  describe("A change that is made during a write", () => {
    const runAsync = async (app: App) => {
      const id = v4();
      const repo = app.repository(table.name, table.client);
      const ar = app.TestAggregateRoot.create(id, "before");

      const write = repo.writeAsync(ar);
      ar.changeName("during");
      await write;
      const pending = [...ar.getChanges()];
      const expectedVersion = ar.getExpectedVersion();

      ar.changeName("after");
      await repo.writeAsync(ar);
      return { pending, expectedVersion, stored: await storedAsync(id) };
    };

    it("should be lost by 1.1.1, which then skips its version", async () => {
      expect(await runAsync(published)).toEqual({
        pending: [],
        expectedVersion: 2,
        stored: [
          [0, "before"],
          [2, "after"],
        ],
      });
    });

    it("should be stored by 2.0, with the next write", async () => {
      expect(await runAsync(current)).toEqual({
        pending: [expect.objectContaining({ name: "during" })],
        expectedVersion: 1,
        stored: [
          [0, "before"],
          [1, "during"],
          [2, "after"],
        ],
      });
    });
  });
});
