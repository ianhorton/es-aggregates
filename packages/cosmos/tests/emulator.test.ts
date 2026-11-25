import {
  ConcurrencyError,
  IPersistedEvent,
  isEncrypted,
  Repository,
} from "@es-aggregates/core";
import { TestAggregateRoot } from "@es-aggregates/store-tests";
import { v4 } from "uuid";

import { CosmosEventStore } from "../src";

import { Emulator } from "./test-objects/emulator";

jest.setTimeout(90000);

Emulator.describe("In the Cosmos DB emulator", () => {
  const emulator = new Emulator();
  const store = new CosmosEventStore(emulator.container);

  beforeAll(emulator.startAsync);
  afterAll(emulator.stop);

  // the properties that Cosmos DB itself gives an item. Those of the emulator differ
  // from those of the service, so none of them has to be there
  const withoutSystemProperties = (item: Record<string, unknown>) => {
    const { _rid, _self, _etag, _attachments, _ts, ...rest } = item;
    return rest;
  };

  describe("CosmosEventStore", () => {
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

    it("should read back what was appended", async () => {
      // arrange
      const id = v4();
      const events = [
        event(id, 0, {
          text: "Zoë Åström, 東京 😀",
          emptyText: "",
          date: "2026-01-01T00:00:00.000Z",
          numeric: "1.0",
          escaped: "\"'\\/\b\f\n\r\t\u0001\u2028\ufeff",
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
          id: "the id of something in the event",
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
      ];

      // act
      await store.appendAsync(id, events, 0);
      const read = await store.readAsync(id);

      // assert
      // a property that is undefined is not read back
      const { data, ...withoutData } = events[9];
      expect(read).toStrictEqual([...events.slice(0, 9), withoutData]);
      expect(JSON.stringify(read[6].data)).toBe('{"__proto__":{"a":1},"b":2}');
    });

    it("should append to the events that are already there", async () => {
      // arrange
      const id = v4();
      const events = eventsOf(id, range(0, 5));

      // act
      await store.appendAsync(id, events.slice(0, 1), 0);
      await store.appendAsync(id, events.slice(1, 4), 1);
      await store.appendAsync(id, events.slice(4), 4);

      // assert
      expect(await store.readAsync(id)).toStrictEqual(events);
    });

    it("should read many events, from many pages", async () => {
      // arrange
      const id = v4();
      const events = eventsOf(id, range(0, 1049));
      for (let first = 0; first < events.length; first += 100) {
        await store.appendAsync(id, events.slice(first, first + 100), first);
      }
      emulator.pageSizes.length = 0;

      // act
      const read = await store.readAsync(id);

      // assert
      expect(read).toHaveLength(1050);
      expect(read).toStrictEqual(events);
      expect(emulator.pageSizes).toEqual([...Array(10).fill(100), 50]);
    });

    it("should read events in the order of their versions, not in the order they were stored", async () => {
      // arrange
      const id = v4();

      // act
      for (const versions of [
        [100],
        range(8, 11),
        [2],
        range(98, 99),
        [0, 1],
      ]) {
        await store.appendAsync(id, eventsOf(id, versions), versions[0]);
      }

      // assert
      expect(await store.readAsync(id)).toStrictEqual(
        eventsOf(id, [0, 1, 2, 8, 9, 10, 11, 98, 99, 100])
      );
    });

    it("should return an empty array for an unknown aggregate", async () => {
      expect(await store.readAsync(v4())).toEqual([]);
    });

    it("should keep aggregates apart", async () => {
      // arrange
      const uuid = `a-${v4()}`;
      const ids = [
        uuid,
        uuid.toUpperCase(),
        `${uuid}/`,
        `${uuid} `,
        `["${uuid}"]`,
        `${uuid} é東京`,
      ];

      // act
      for (const id of ids) {
        await store.appendAsync(id, eventsOf(id, [0, 1], { of: id }), 0);
      }

      // assert
      for (const id of ids) {
        expect(await store.readAsync(id)).toStrictEqual(
          eventsOf(id, [0, 1], { of: id })
        );
      }
    });

    it.each([[undefined], [null], [7]])(
      "should not read or append when the aggregate's id is %p",
      async (notAnId) => {
        // arrange
        const id = notAnId as unknown as string;

        // act / assert
        await expect(
          store.appendAsync(id, [event(id, 0)], 0)
        ).rejects.toThrow();
        await expect(store.readAsync(id)).rejects.toThrow();
      }
    );

    it("should store exactly the properties of the event, and the version as the id", async () => {
      // arrange
      const id = v4();
      const events = [
        event(id, 0),
        { ...event(id, 1), encryptedProps: ["text"] },
        { ...event(id, 2), encryptedProps: undefined },
      ];

      // act
      await store.appendAsync(id, events, 0);
      const items = await emulator.itemsAsync(id);

      // assert
      expect(items.map(withoutSystemProperties)).toStrictEqual([
        { id: "0", ...event(id, 0) },
        { id: "1", ...event(id, 1), encryptedProps: ["text"] },
        { id: "2", ...event(id, 2) },
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
      const [item] = await emulator.itemsAsync(id);
      const read = await store.readAsync(id);

      // assert
      const kept = { map: { kept: 1 }, list: ["a", ["b"], {}], holes: [1, 2] };
      expect(item.data).toStrictEqual(kept);
      expect(read).toStrictEqual([event(id, 0, kept)]);
    });

    it.each([
      ["a date", new Date(0)],
      ["a map", new Map([["a", 1]])],
      ["a set", new Set(["a"])],
      ["bytes", new Uint8Array([1])],
      ["an instance of a class", new (class Thing {})()],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["a bigint", BigInt(1)],
      ["a symbol", Symbol("a")],
    ])("should store nothing of an append that has %s", async (_, value) => {
      // arrange
      const id = v4();
      const events = [event(id, 0), event(id, 1, { list: [{ value }] })];

      // act
      const error = await store.appendAsync(id, events, 0).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("SomethingHappened.data.list[0].value");
      expect(await emulator.itemsAsync(id)).toEqual([]);
    });

    it("should store nothing of an append that has more than 100 events", async () => {
      // arrange
      const id = v4();
      const events = eventsOf(id, range(0, 100));

      // act
      const error = await store.appendAsync(id, events, 0).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Cannot append 101 events");
      expect(await emulator.itemsAsync(id)).toEqual([]);
    });

    it("should store nothing of an append that is too large", async () => {
      // arrange
      const id = v4();
      const events = eventsOf(id, range(0, 9), "x".repeat(300000));

      // act
      const error = await store.appendAsync(id, events, 0).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConcurrencyError);
      expect(error.message).toMatch(/too large/i);
      expect(await emulator.itemsAsync(id)).toEqual([]);
    });

    it("should store nothing of an append in which an event is of another aggregate", async () => {
      // arrange
      const [id, otherId] = [v4(), v4()];
      const events = [event(id, 0), event(otherId, 1), event(id, 2)];

      // act
      const error = await store.appendAsync(id, events, 0).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConcurrencyError);
      expect(error.message).toContain("[424, 400, 424]");
      expect(error.cause.result).toHaveLength(3);
      expect(await emulator.itemsAsync(id)).toEqual([]);
      expect(await emulator.itemsAsync(otherId)).toEqual([]);
    });

    it("should store nothing in a container that has another partition key", async () => {
      // arrange
      const id = v4();
      const container = await emulator.createContainerAsync(
        "by-event-type",
        "/eventType"
      );
      const otherStore = new CosmosEventStore(container);

      // act
      const error = await otherStore
        .appendAsync(id, eventsOf(id, [0, 1]), 0)
        .catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConcurrencyError);
      for (const partitionKey of [id, "SomethingHappened"]) {
        const { resources } = await container.items
          .query("SELECT * FROM c", { partitionKey })
          .fetchAll();
        expect(resources).toEqual([]);
      }
    });

    it("should reject when there is no such container", async () => {
      // arrange
      const id = v4();
      const { database } = emulator.container;
      const otherStore = new CosmosEventStore(database.container("missing"));

      // act / assert
      const append = otherStore.appendAsync(id, [event(id, 0)], 0);
      const error = await append.catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConcurrencyError);
      await expect(otherStore.readAsync(id)).rejects.toThrow();
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
          const before = await emulator.itemsAsync(id);

          // act
          const error = await store
            .appendAsync(id, eventsOf(id, [1, 2, 3], "second"), 1)
            .catch((e) => e);

          // assert
          // one status code per event: only the taken version is at fault
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.aggregateId).toBe(id);
          expect(error.expectedVersion).toBe(1);
          expect(error.cause.code).toBe(207);
          expect(error.cause.result).toMatchObject(
            [1, 2, 3].map((version) => ({
              statusCode: version === takenVersion ? 409 : 424,
            }))
          );
          expect(await emulator.itemsAsync(id)).toEqual(before);
        }
      );

      it("should store an append only once", async () => {
        // arrange
        const id = v4();
        const events = eventsOf(id, [0, 1]);
        await store.appendAsync(id, events, 0);
        const before = await emulator.itemsAsync(id);

        // act
        const error = await store.appendAsync(id, events, 0).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(ConcurrencyError);
        expect(await emulator.itemsAsync(id)).toEqual(before);
      });

      it("should store only one of several appends that are made at once", async () => {
        // arrange
        const id = v4();
        const appends = range(0, 7).map((writer) =>
          eventsOf(id, [0, 1, 2], { writer })
        );

        // act
        const errors = await Promise.all(
          appends.map((events) =>
            store.appendAsync(id, events, 0).catch((e) => e)
          )
        );

        // assert
        const winner = errors.indexOf(undefined);
        expect(await store.readAsync(id)).toStrictEqual(appends[winner]);
        errors.splice(winner, 1);
        expect(errors).toEqual(Array(7).fill(expect.any(ConcurrencyError)));
      });
    });
  });

  describe("Repository", () => {
    const key = "key";

    const repo = new Repository(store, TestAggregateRoot.factory);

    // stores an aggregate, with one event, for a test to read or change
    const createAsync = async (encryptionKey?: string) => {
      const id = v4();
      const name = "a name";
      const ar = TestAggregateRoot.create(id, name);
      await repo.writeAsync(ar, encryptionKey);
      return { id, name, ar };
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should rebuild an aggregate that was written", async () => {
      // arrange
      const id = v4();
      const ar = TestAggregateRoot.create(id, "a name");
      ar.createSecret("a secret", "plain");
      ar.recordDetails({ list: [1, undefined, 2], map: { a: undefined } });
      ar.createMessage("a message"); // imageUrl is undefined
      ar.changeName("another name");

      // act
      await repo.writeAsync(ar);
      const readAr = (await repo.readAsync(id))!;

      // assert
      expect(ar.getChanges()).toHaveLength(0);
      expect(ar.getExpectedVersion()).toBe(5);
      expect(readAr).toBeInstanceOf(TestAggregateRoot);
      expect(readAr.getChanges()).toHaveLength(0);
      expect(readAr.state).toEqual({
        version: 5,
        id,
        name: "another name",
        created: ar.created,
        secret: "a secret",
        plain: "plain",
        messageText: "a message",
        details: { list: [1, 2], map: {} },
      });
    });

    it("should return undefined when nothing has been written for the id", async () => {
      expect(await repo.readAsync(v4())).toBeUndefined();
      expect(await repo.readAsync(v4(), key)).toBeUndefined();
    });

    it("should not write when there are no changes", async () => {
      // arrange
      const { id } = await createAsync();
      const ar = (await repo.readAsync(id))!;
      const before = await emulator.itemsAsync(id);

      // act
      await repo.writeAsync(ar);

      // assert
      expect(await emulator.itemsAsync(id)).toEqual(before);
    });

    it("should number the events contiguously from the expected version", async () => {
      // arrange
      const id = v4();
      const ar = TestAggregateRoot.create(id, "event 0");
      ar.changeName("event 1");
      ar.changeName("event 2");

      // act
      // write the new ar, write to it again, then write to a copy read back
      await repo.writeAsync(ar);
      ar.changeName("event 3");
      ar.changeName("event 4");
      await repo.writeAsync(ar);
      const readAr = (await repo.readAsync(id))!;
      readAr.changeName("event 5");
      await repo.writeAsync(readAr);

      // assert
      expect(await emulator.itemsAsync(id)).toMatchObject(
        [0, 1, 2, 3, 4, 5].map((version) => ({
          id: `${version}`,
          aggregateVersion: version,
          data: { name: `event ${version}` },
        }))
      );
      expect(readAr.getExpectedVersion()).toBe(6);
    });

    it("should write and read many events", async () => {
      // arrange
      const { id, ar } = await createAsync();

      // act
      for (let count = 1; count <= 500; count++) {
        ar.changeName(`${count}`);
        if (count % 100 === 0) {
          await repo.writeAsync(ar);
        }
      }
      emulator.pageSizes.length = 0;
      const readAr = (await repo.readAsync(id))!;

      // assert
      // there are 501 events (the first created the ar), on 6 pages
      expect(readAr.getExpectedVersion()).toBe(501);
      expect(readAr.name).toBe("500");
      expect(emulator.pageSizes).toEqual([100, 100, 100, 100, 100, 1]);
    });

    it("should reject the changes to a copy that is out of date", async () => {
      // arrange
      const { id, name } = await createAsync();
      const ar1 = (await repo.readAsync(id))!;
      const ar2 = (await repo.readAsync(id))!;
      ar1.changeName("ar1");
      ar2.changeName("ar2");
      ar2.changeName("ar2 again");

      // act
      await repo.writeAsync(ar1);
      const error = await repo.writeAsync(ar2).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error.aggregateId).toBe(id);
      expect(error.expectedVersion).toBe(1);
      expect(error.cause.result).toMatchObject([
        { statusCode: 409 },
        { statusCode: 424 },
      ]);

      // it keeps its uncommitted changes, at the version it was read at
      expect(ar2.getChanges()).toMatchObject([
        { name: "ar2" },
        { name: "ar2 again" },
      ]);
      expect(ar2.getExpectedVersion()).toBe(1);

      // and nothing it tried to write was stored
      expect(await emulator.itemsAsync(id)).toMatchObject([
        { aggregateVersion: 0, data: { name } },
        { aggregateVersion: 1, data: { name: "ar1" } },
      ]);
      expect((await repo.readAsync(id))!.name).toBe("ar1");
    });

    it.each([[1], [2], [3]])(
      "should store none of events 1 to 3 when version %i already exists",
      async (takenVersion) => {
        // arrange
        const { id } = await createAsync();
        const ar = (await repo.readAsync(id))!;
        ar.changeName("event 1");
        ar.changeName("event 2");
        ar.changeName("event 3");

        const [created] = await emulator.itemsAsync(id);
        await emulator.putAsync({
          ...created,
          id: `${takenVersion}`,
          aggregateVersion: takenVersion,
        });
        const before = await emulator.itemsAsync(id);

        // act
        const error = await repo.writeAsync(ar).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(ConcurrencyError);
        expect(await emulator.itemsAsync(id)).toEqual(before);
        expect(ar.getChanges()).toHaveLength(3);
        expect(ar.getExpectedVersion()).toBe(1);
      }
    );

    it("should keep the changes, and store none, when one has a value that is refused", async () => {
      // arrange
      const { id, ar } = await createAsync();
      const before = await emulator.itemsAsync(id);
      ar.changeName("another name");
      ar.recordDetails({ when: new Date(0) });

      // act
      const error = await repo.writeAsync(ar).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("TestDetailsRecorded.data.details.when");
      expect(ar.getChanges()).toHaveLength(2);
      expect(ar.getExpectedVersion()).toBe(1);
      expect(await emulator.itemsAsync(id)).toEqual(before);
    });

    it("should store a plain event with exactly these properties", async () => {
      // arrange
      const id = v4();
      const ar = TestAggregateRoot.create(id, "a name");
      ar.recordDetails({
        text: "text",
        whole: 3,
        fraction: 1.5,
        yes: true,
        nothing: null,
        list: ["a", undefined, 1],
        map: { kept: "kept", dropped: undefined },
        dropped: undefined,
      });
      const { timestamp } = ar.getChanges()[1];

      // act
      await repo.writeAsync(ar);
      const items = await emulator.itemsAsync(id);

      // assert
      // there is no encryptedProps, because the event declares none
      expect(withoutSystemProperties(items[1])).toStrictEqual({
        id: "1",
        aggregateId: id,
        aggregateVersion: 1,
        eventType: "TestDetailsRecorded",
        timestamp,
        data: {
          id,
          details: {
            text: "text",
            whole: 3,
            fraction: 1.5,
            yes: true,
            nothing: null,
            list: ["a", 1],
            map: { kept: "kept" },
          },
        },
      });
    });

    it("should store an encrypted event with exactly these properties", async () => {
      // arrange
      const id = v4();
      const ar = TestAggregateRoot.create(id, "a name");
      ar.createMessage("a message"); // imageUrl is undefined
      const { timestamp } = ar.getChanges()[1];

      // act
      await repo.writeAsync(ar, key);
      const items = await emulator.itemsAsync(id);

      // assert
      // ENC1.<alg>.<keyId>.<12-byte iv>.<ciphertext>.<16-byte tag>, in base64url
      const envelope =
        /^ENC1\.aes-256-gcm\.[\w-]{12}\.[\w-]{16}\.[\w-]+\.[\w-]{22}$/;
      expect(withoutSystemProperties(items[1])).toStrictEqual({
        id: "1",
        aggregateId: id,
        aggregateVersion: 1,
        eventType: "TestMessageCreated",
        timestamp,
        encryptedProps: ["text", "imageUrl"],
        data: { id, text: expect.stringMatching(envelope) },
      });
    });

    describe("Encryption", () => {
      // an aggregate that has a secret too
      const createWithSecretAsync = async (encryptionKey?: string) => {
        const id = v4();
        const ar = TestAggregateRoot.create(id, "a name");
        ar.createSecret("a secret", "plain");
        await repo.writeAsync(ar, encryptionKey);
        const [created, secretCreated] = await emulator.itemsAsync(id);
        return {
          id,
          name: created.data.name,
          secret: secretCreated.data.secret,
        };
      };

      it("should store only the declared properties encrypted when it is given a key", async () => {
        // act
        const { id, name, secret } = await createWithSecretAsync(key);

        // assert
        expect(isEncrypted(name)).toBe(true);
        expect(isEncrypted(secret)).toBe(true);
        expect(await emulator.itemsAsync(id)).toMatchObject([
          { encryptedProps: ["name"], data: { id } },
          { encryptedProps: ["secret"], data: { id, plain: "plain" } },
        ]);
      });

      it("should store nothing encrypted when it is given no key", async () => {
        // act
        const { id } = await createWithSecretAsync();

        // assert
        expect(await emulator.itemsAsync(id)).toMatchObject([
          { encryptedProps: ["name"], data: { id, name: "a name" } },
          {
            encryptedProps: ["secret"],
            data: { id, secret: "a secret", plain: "plain" },
          },
        ]);
      });

      it("should read what was encrypted, with the key", async () => {
        // arrange
        const { id } = await createWithSecretAsync(key);
        const log = jest.spyOn(console, "error").mockImplementation(() => {});

        // act
        const ar = (await repo.readAsync(id, key))!;

        // assert
        expect(ar.name).toBe("a name");
        expect(ar.secret).toBe("a secret");
        expect(ar.plain).toBe("plain");
        expect(log).not.toHaveBeenCalled();
      });

      it.each([
        ["the wrong key", "wrong key"],
        ["no key", undefined],
      ])(
        "should leave what was encrypted as it is, and log it, with %s",
        async (_, otherKey) => {
          // arrange
          const { id, name, secret } = await createWithSecretAsync(key);
          const log = jest.spyOn(console, "error").mockImplementation(() => {});

          // act
          const ar = (await repo.readAsync(id, otherKey))!;

          // assert
          expect(ar.name).toBe(name);
          expect(ar.secret).toBe(secret);
          expect(ar.plain).toBe("plain");
          expect(log.mock.calls).toEqual([
            [expect.stringContaining('Failed to decrypt PII field "name"')],
            [expect.stringContaining('Failed to decrypt PII field "secret"')],
          ]);
        }
      );

      it.each([
        ["a key", key],
        ["no key", undefined],
      ])("should read what was not encrypted, with %s", async (_, anyKey) => {
        // arrange
        const { id } = await createWithSecretAsync();
        const log = jest.spyOn(console, "error").mockImplementation(() => {});

        // act
        const ar = (await repo.readAsync(id, anyKey))!;

        // assert
        expect(ar.name).toBe("a name");
        expect(ar.secret).toBe("a secret");
        expect(ar.plain).toBe("plain");
        expect(log).not.toHaveBeenCalled();
      });
    });
  });
});
