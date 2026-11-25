import { ConcurrencyError, IPersistedEvent } from "@es-aggregates/core";

import { CosmosEventStore } from "../src";

import { Answer, StubbedCosmos } from "./test-objects/stubbed-cosmos";

describe("CosmosEventStore Tests", () => {
  const id = "aggregate id";

  const event = (
    aggregateVersion: number,
    data: unknown = { version: aggregateVersion }
  ): IPersistedEvent => ({
    aggregateId: id,
    eventType: "SomethingHappened",
    timestamp: "2026-01-01T00:00:00.000Z",
    aggregateVersion,
    data,
  });

  const events = [event(7), event(8), event(9)];

  let cosmos: StubbedCosmos;

  const setupAsync = async (...answers: Answer[]) => {
    cosmos = await StubbedCosmos.startAsync(answers);
    const { container } = cosmos;
    return { container, store: new CosmosEventStore(container) };
  };

  afterEach(async () => {
    await cosmos.stopAsync();
  });

  describe("appendAsync", () => {
    // a response to a batch, with the status codes of its operations
    const batch = (status: number, ...statusCodes: unknown[]): Answer => ({
      status,
      body: statusCodes.map((statusCode) => ({ statusCode, requestCharge: 1 })),
    });

    const stored = batch(200, 201, 201, 201);

    const appendAndCatchAsync = (store: CosmosEventStore): Promise<any> =>
      store.appendAsync(id, events, 7).catch((e) => e);

    it("should send the events in one transactional batch", async () => {
      // arrange
      const { store } = await setupAsync(stored);

      // act
      const result = await store.appendAsync(id, events, 7);

      // assert
      expect(result).toBeUndefined();
      expect(cosmos.requests).toHaveLength(1);
      const [{ path, headers, body }] = cosmos.requests;
      expect(path).toBe("/dbs/db/colls/events/docs");
      expect(headers).toMatchObject({
        "x-ms-cosmos-is-batch-request": "true",
        "x-ms-cosmos-batch-atomic": "true",
        "x-ms-documentdb-partitionkey": '["aggregate id"]',
      });
      expect(body).toEqual(
        ["7", "8", "9"].map((version) => ({
          operationType: "Create",
          resourceBody: {
            id: version,
            aggregateId: id,
            eventType: "SomethingHappened",
            timestamp: "2026-01-01T00:00:00.000Z",
            aggregateVersion: Number(version),
            data: { version: Number(version) },
          },
        }))
      );
    });

    it("should send as many as 100 events, but no more", async () => {
      // arrange
      const versions = [...Array(101).keys()];
      const { store } = await setupAsync(
        batch(200, ...Array(100).fill(201)),
        batch(200, ...Array(101).fill(201))
      );
      const tooMany = versions.map((version) => event(version));

      // act
      await store.appendAsync(id, tooMany.slice(0, 100), 0);
      const error = await store.appendAsync(id, tooMany, 0).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        'Cannot append 101 events to aggregate "aggregate id" at once. The limit is 100.'
      );
      expect(cosmos.requests).toHaveLength(1);
      expect(
        cosmos.requests[0].body.map(({ resourceBody }: any) => resourceBody.id)
      ).toEqual(versions.slice(0, 100).map((version) => `${version}`));
    });

    describe("when a version is already stored", () => {
      it.each([
        [409, 424, 424],
        [424, 409, 424],
        [424, 424, 409],
      ])(
        "should reject with a ConcurrencyError when the operations have %i, %i and %i",
        async (...statusCodes) => {
          // arrange
          const { store } = await setupAsync(batch(207, ...statusCodes));

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.aggregateId).toBe(id);
          expect(error.expectedVersion).toBe(7);
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(error.cause.code).toBe(207);
          expect(error.cause.result).toMatchObject(
            statusCodes.map((statusCode) => ({ statusCode }))
          );
          expect(cosmos.requests).toHaveLength(1);
        }
      );

      it.each<[string, Answer]>([
        ["a message", { status: 409, body: { message: "It is taken." } }],
        ["no body", { status: 409 }],
      ])(
        "should reject with a ConcurrencyError when the SDK throws a 409 that has %s",
        async (_, answer) => {
          // arrange
          const { store } = await setupAsync(answer);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.aggregateId).toBe(id);
          expect(error.expectedVersion).toBe(7);
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(error.cause.message).toMatch(/^Batch request error: /);
        }
      );

      // what items.batch throws has diagnostics, in all versions of the SDK, and it has
      // the original error as its cause since 4.10.1
      it.each([
        ["the error", { code: 409 }],
        ["its cause", { cause: { code: 409 } }],
        [
          "its diagnostics",
          {
            diagnostics: {
              clientSideRequestStatistics: {
                gatewayStatistics: [{ statusCode: 429 }, { statusCode: 409 }],
              },
            },
          },
        ],
      ])(
        "should reject with a ConcurrencyError when the 409 is in %s",
        async (_, properties) => {
          // arrange
          const { container, store } = await setupAsync();
          const thrown = Object.assign(new Error("from the SDK"), properties);
          container.items.batch = () => Promise.reject(thrown);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.cause).toBe(thrown);
        }
      );

      it("should reject with a ConcurrencyError when the batch itself has a 409", async () => {
        // arrange
        const { container, store } = await setupAsync();
        const response = { code: 409, headers: {} };
        container.items.batch = () => Promise.resolve(response);

        // act
        const error = await appendAndCatchAsync(store);

        // assert
        expect(error).toBeInstanceOf(ConcurrencyError);
        expect(error.cause).toBe(response);
      });
    });

    describe("when the events were not stored, or might not have been", () => {
      it.each<[string, Answer, string]>([
        // the service's reasons
        ["400", batch(207, 400, 424, 424), "207 [400, 424, 424]"],
        ["403", batch(207, 424, 403, 424), "207 [424, 403, 424]"],
        ["404", batch(207, 424, 424, 404), "207 [424, 424, 404]"],
        ["408", batch(207, 408, 424, 424), "207 [408, 424, 424]"],
        ["412", batch(207, 412, 424, 424), "207 [412, 424, 424]"],
        ["413", batch(207, 424, 413, 424), "207 [424, 413, 424]"],
        ["429", batch(207, 424, 429, 424), "207 [424, 429, 424]"],
        ["449", batch(207, 424, 424, 449), "207 [424, 424, 449]"],
        ["500", batch(207, 500, 424, 424), "207 [500, 424, 424]"],
        ["503", batch(207, 503, 424, 424), "207 [503, 424, 424]"],
        ["only 424", batch(207, 424, 424, 424), "207 [424, 424, 424]"],
        ["424 in a 200", batch(200, 424, 424, 424), "200 [424, 424, 424]"],
        // operations that were not created
        ["a 200", batch(200, 201, 200, 201), "200 [201, 200, 201]"],
        ["a 202", batch(200, 201, 202, 201), "200 [201, 202, 201]"],
        ["a 204", batch(200, 204, 204, 204), "200 [204, 204, 204]"],
        ["a 304", batch(200, 201, 201, 304), "200 [201, 201, 304]"],
        ["a 0", batch(200, 201, 0, 201), "200 [201, 0, 201]"],
        ["a text", batch(200, 201, "201", 201), "200 [201, 201, 201]"],
        ["no code", batch(200, 201, undefined, 201), "200 [201, , 201]"],
        // results that are missing
        ["no results", batch(200), "200 []"],
        ["a result too few", batch(200, 201, 201), "200 [201, 201]"],
        [
          "one too many",
          batch(200, 201, 201, 201, 201),
          "200 [201, 201, 201, 201]",
        ],
        ["a null", { status: 200, body: [null, null, null] }, "200 [, , ]"],
        ["an object", { status: 200, body: { statusCode: 201 } }, "200 []"],
        ["an empty body", { status: 200 }, "200 []"],
        // batches that were not successful
        ["a 201 batch", batch(201, 201, 201, 201), "201 [201, 201, 201]"],
        ["a 202 batch", batch(202, 201, 201, 201), "202 [201, 201, 201]"],
        ["a 204 batch", { status: 204 }, "204 []"],
        ["a 207 batch", batch(207, 201, 201, 201), "207 [201, 201, 201]"],
        ["a 302 batch", batch(302, 201, 201, 201), "302 [201, 201, 201]"],
        ["a 304 batch", { status: 304 }, "304 []"],
      ])(
        "should reject with the response when it has %s",
        async (_, answer, codes) => {
          // arrange
          const { store } = await setupAsync(answer);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          const [batchCode, operationCodes] = codes.split(/ (?=\[)/);
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          expect(error.message).toBe(
            'Cannot append 3 events to aggregate "aggregate id" at version 7: the batch ' +
              `has status code ${batchCode}, and its operations have ${operationCodes}.`
          );
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(error.cause).toHaveProperty("code", Number(batchCode));
          expect(cosmos.requests).toHaveLength(1);
        }
      );

      // the SDK would not return these
      it.each<[string, any, string]>([
        ["is undefined", undefined, "undefined"],
        ["is null", null, "undefined"],
        ["is empty", {}, "undefined"],
        ["has only a code", { code: 200 }, "200"],
        [
          "has only results",
          { result: Array(3).fill({ statusCode: 201 }) },
          "undefined",
        ],
      ])(
        "should reject with the response when it %s",
        async (_, response, code) => {
          // arrange
          const { container, store } = await setupAsync();
          container.items.batch = () => Promise.resolve(response);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          expect(error.message).toContain(
            `the batch has status code ${code}, and its operations have [`
          );
          expect(error.cause).toBe(response);
        }
      );

      it.each<[string, Answer]>([
        ["400", { status: 400, body: { message: "It is wrong." } }],
        ["403", { status: 403, body: { message: "It is full." } }],
        ["404", { status: 404, body: { message: "There is none." } }],
        ["408", { status: 408, body: { message: "It took too long." } }],
        ["412", { status: 412, body: { message: "It has changed." } }],
        ["413", { status: 413, body: { message: "It is too large." } }],
        ["429", { status: 429, body: { message: "There is too much." } }],
        ["449", { status: 449, body: { message: "Try again." } }],
        ["500", { status: 500, body: { message: "It broke." } }],
        ["503", { status: 503, body: { message: "It is down." } }],
        ["no message", { status: 500 }],
        ["no response", "hang up"],
      ])(
        "should not change the error when the SDK throws because of %s",
        async (_, answer) => {
          // arrange
          const { store } = await setupAsync(answer);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          expect(error).toBe(cosmos.outcomes[0]);
          expect(cosmos.requests).toHaveLength(1);
        }
      );

      it.each([[undefined], [null], ["a text"]])(
        "should not change what is thrown when it is %p",
        async (thrown) => {
          // arrange
          const { container, store } = await setupAsync();
          container.items.batch = () => Promise.reject(thrown);

          // act / assert
          await expect(store.appendAsync(id, events, 7)).rejects.toBe(thrown);
        }
      );
    });

    describe("what it stores", () => {
      // what is sent for an event's data
      const sentForAsync = async (data: unknown) => {
        const { store } = await setupAsync(batch(200, 201));
        await store.appendAsync(id, [event(7, data)], 7);
        return cosmos.requests[0].body[0].resourceBody.data;
      };

      it("should keep what JSON can hold", async () => {
        // arrange
        const data = {
          text: "Zoë Åström, 東京",
          emptyText: "",
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
          id: "the id of something in the event",
          _ts: "not the _ts of the item",
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
        const { store } = await setupAsync(batch(200, 201));
        const withUndefined = { ...event(7), encryptedProps: undefined };

        // act
        await store.appendAsync(id, [withUndefined], 7);

        // assert
        expect(Object.keys(cosmos.requests[0].body[0].resourceBody)).toEqual([
          "aggregateId",
          "eventType",
          "timestamp",
          "aggregateVersion",
          "data",
          "id",
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
      it("should store 0 for -0", async () => {
        expect(await sentForAsync({ zeros: [-0, 0] })).toStrictEqual({
          zeros: [0, 0],
        });
      });

      it("should store the events as they were when the append began", async () => {
        // arrange
        const { store } = await setupAsync(batch(200, 201));
        const data: Record<string, unknown> = { list: ["before"] };
        const appended = [event(7, data)];

        // act
        const append = store.appendAsync(id, appended, 7);
        (data.list as unknown[]).push("during");
        data.added = "during";
        appended.push(event(8));
        await append;

        // assert
        const { body } = cosmos.requests[0];
        expect(body).toHaveLength(1);
        expect(body[0].resourceBody.data).toEqual({ list: ["before"] });
      });

      it("should not change the events that it is given", async () => {
        // arrange
        const { store } = await setupAsync(batch(200, 201));
        const data = { list: [1, undefined], map: { a: undefined, b: {} } };
        const appended = [{ ...event(7, data), encryptedProps: undefined }];

        // act
        await store.appendAsync(id, appended, 7);

        // assert
        expect(appended).toStrictEqual([
          {
            ...event(7, {
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
        ["one of a class without a name", new (class {})(), "an instance of "],
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
        const { store } = await setupAsync(batch(200, 201, 201));
        return store.appendAsync(id, [event(7), refused], 7).catch((e) => e);
      };

      it.each(refused)(
        "should send nothing when there is %s",
        async (_, value, description) => {
          // act
          const error = await appendAndCatchAsync(event(8, { value }));

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe(
            `Cannot store SomethingHappened.data.value, because JSON cannot hold ${description}.`
          );
          expect(cosmos.requests).toHaveLength(0);
        }
      );

      it.each(refused)(
        "should send nothing when there is %s in a list",
        async (_, value, description) => {
          // act
          const error = await appendAndCatchAsync(event(8, [[1], [2, value]]));

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe(
            `Cannot store SomethingHappened.data[1][1], because JSON cannot hold ${description}.`
          );
          expect(cosmos.requests).toHaveLength(0);
        }
      );

      it("should name the path to the value", async () => {
        // act
        const error = await appendAndCatchAsync(
          event(8, {
            details: {
              list: [1, undefined, { "a.b": [{ when: new Date(0) }] }],
            },
          })
        );

        // assert
        expect(error.message).toBe(
          "Cannot store SomethingHappened.data.details.list[2].a.b[0].when, because JSON cannot hold an instance of Date."
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it.each<[string, Partial<IPersistedEvent>]>([
        ["data", { data: new Date(0) }],
        ["timestamp", { timestamp: new Date(0) as unknown as string }],
        [
          "encryptedProps[1]",
          { encryptedProps: ["a", new Date(0) as unknown as string] },
        ],
      ])("should send nothing when %s is a date", async (path, properties) => {
        // act
        const error = await appendAndCatchAsync({ ...event(8), ...properties });

        // assert
        expect(error.message).toBe(
          `Cannot store SomethingHappened.${path}, because JSON cannot hold an instance of Date.`
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it("should send nothing when the event itself is an instance of a class", async () => {
        // arrange
        class PersistedEvent {}

        // act
        const error = await appendAndCatchAsync(
          Object.assign(new PersistedEvent(), event(8))
        );

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(
          "Cannot store SomethingHappened, because JSON cannot hold an instance of PersistedEvent."
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it.each([["id"], ["_ts"], ["_something"]])(
        "should send nothing when the event has a property called %s",
        async (name) => {
          // act
          const error = await appendAndCatchAsync({ ...event(8), [name]: "a" });

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe(
            `Cannot store SomethingHappened.${name}, because Cosmos DB uses that name.`
          );
          expect(cosmos.requests).toHaveLength(0);
        }
      );

      // as DynamoEventStore does
      it("should send nothing when there is a function in a list", async () => {
        // act
        const error = await appendAndCatchAsync(event(8, [1, () => 2]));

        // assert
        expect(error.message).toBe(
          "Cannot store SomethingHappened.data[1], because JSON cannot hold a function."
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it("should send nothing when a value contains itself", async () => {
        // arrange
        const value: Record<string, unknown> = {};
        value.list = [value];

        // act
        const error = await appendAndCatchAsync(event(8, value));

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(cosmos.requests).toHaveLength(0);
      });

      it.each([[undefined], [null], [7], [{}]])(
        "should send nothing when the aggregate's id is %p",
        async (notAnId) => {
          // arrange
          const { store } = await setupAsync(stored);

          // act / assert
          await expect(
            store.appendAsync(notAnId as unknown as string, events, 7)
          ).rejects.toThrow("An aggregate's id must be a string");
          expect(cosmos.requests).toHaveLength(0);
        }
      );
    });
  });

  describe("readAsync", () => {
    // an event as Cosmos DB returns it
    const item = (version: number) => ({
      ...event(version),
      id: `${version}`,
      _rid: "AgAAAIEAAAAPAAAAFz0AAAAAAAA=",
      _self: `dbs/db/colls/events/docs/${version}/`,
      _etag: '"1b38a98e-35de-4e19-93fc-f7fc7604774b"',
      _attachments: "attachments/",
      _ts: 1795567861,
      _something: "that Cosmos DB might add some day",
    });

    const page = (versions: number[], continuation?: string): Answer => ({
      status: 200,
      body: {
        _rid: "AgAAAIEAAAA=",
        Documents: versions.map(item),
        _count: versions.length,
      },
      headers: continuation ? { "x-ms-continuation": continuation } : {},
    });

    it("should ask for the aggregate's events in the order of their versions", async () => {
      // arrange
      const { store } = await setupAsync(page([0]));

      // act
      await store.readAsync(id);

      // assert
      expect(cosmos.requests).toHaveLength(1);
      const [{ path, headers, body }] = cosmos.requests;
      expect(path).toBe("/dbs/db/colls/events/docs");
      expect(headers["x-ms-documentdb-partitionkey"]).toBe('["aggregate id"]');
      expect(body).toEqual({
        query:
          "SELECT * FROM c WHERE c.aggregateId = @aggregateId ORDER BY c.aggregateVersion",
        parameters: [{ name: "@aggregateId", value: id }],
      });
    });

    it("should return the events as they were appended", async () => {
      // arrange
      const data = { id: "a", _ts: "b", _self: { _etag: ["c"] } };
      const { store } = await setupAsync({
        status: 200,
        body: {
          Documents: [
            item(0),
            { ...item(1), encryptedProps: ["a"] },
            { ...item(2), data },
          ],
        },
      });

      // act / assert
      expect(await store.readAsync(id)).toStrictEqual([
        event(0),
        { ...event(1), encryptedProps: ["a"] },
        event(2, data),
      ]);
    });

    it("should read until there are no more pages", async () => {
      // arrange
      const { store } = await setupAsync(
        page([0, 1], "after 1"),
        page([], "still after 1"),
        page([2], "after 2"),
        page([3, 4])
      );

      // act
      const result = await store.readAsync(id);

      // assert
      expect(result).toStrictEqual([0, 1, 2, 3, 4].map((v) => event(v)));
      expect(
        cosmos.requests.map(({ headers, body }) => [
          headers["x-ms-continuation"],
          headers["x-ms-documentdb-partitionkey"],
          body.parameters,
        ])
      ).toEqual(
        [undefined, "after 1", "still after 1", "after 2"].map(
          (continuation) => [
            continuation,
            '["aggregate id"]',
            [{ name: "@aggregateId", value: id }],
          ]
        )
      );
    });

    it("should read from the start each time", async () => {
      // arrange
      const { store } = await setupAsync(
        page([0], "after 0"),
        page([1]),
        page([0], "after 0"),
        page([1])
      );

      // act
      const first = await store.readAsync(id);
      const second = await store.readAsync(id);

      // assert
      expect(first).toStrictEqual([event(0), event(1)]);
      expect(second).toStrictEqual(first);
      expect(
        cosmos.requests.map(({ headers }) => headers["x-ms-continuation"])
      ).toEqual([undefined, "after 0", undefined, "after 0"]);
    });

    it("should return an empty array when there are no events", async () => {
      // arrange
      const { store } = await setupAsync(page([]));

      // act / assert
      expect(await store.readAsync(id)).toEqual([]);
    });

    it.each<[string, Answer[]]>([
      ["the only", []],
      ["the second", [page([0, 1], "after 1")]],
    ])(
      "should not change an error from %s page, and not return the rest",
      async (_, pages) => {
        // arrange
        const { store } = await setupAsync(...pages, {
          status: 403,
          body: { message: "Not allowed." },
        });

        // act
        const error = await store.readAsync(id).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ code: 403, message: "Not allowed." });
      }
    );

    it.each([[undefined], [null], [7], [{}]])(
      "should ask for nothing when the aggregate's id is %p",
      async (notAnId) => {
        // arrange
        const { store } = await setupAsync(page([0]));

        // act / assert
        await expect(
          store.readAsync(notAnId as unknown as string)
        ).rejects.toThrow("An aggregate's id must be a string");
        expect(cosmos.requests).toHaveLength(0);
      }
    );
  });
});
