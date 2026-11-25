import {
  InterruptedEventStore,
  TestAggregateRoot,
  TestAggregateRootNameChanged,
} from "@es-aggregates/store-tests";

import {
  ConcurrencyError,
  decrypt,
  encrypt,
  IEvent,
  IPersistedEvent,
  isEncrypted,
  Repository,
} from "../../src";

import { InMemoryEventStore } from "../test-objects/in-memory-event-store";

describe("Repository Tests", () => {
  const id = "aggregate id";
  const key = "key";

  const setup = () => {
    const store = new InMemoryEventStore();
    const append = jest.spyOn(store, "appendAsync");
    const read = jest.spyOn(store, "readAsync");
    const repo = new Repository<TestAggregateRoot>(
      store,
      TestAggregateRoot.factory
    );
    return { store, append, read, repo };
  };

  // an event as a store returns it
  const stored = (
    aggregateVersion: number,
    event: Partial<IPersistedEvent>
  ): IPersistedEvent => ({
    aggregateId: id,
    eventType: "TestAggregateRootNameChanged",
    timestamp: "2026-01-01T00:00:00.000Z",
    aggregateVersion,
    data: { id, name: `name ${aggregateVersion}` },
    ...event,
  });

  // the version and the name of each event, in each append
  const appended = (append: ReturnType<typeof setup>["append"]) =>
    append.mock.calls.map(([, events]) =>
      events.map(({ aggregateVersion, data }) => [aggregateVersion, data.name])
    );

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should have debug off unless it is turned on", () => {
    const { store } = setup();

    const on = new Repository(store, TestAggregateRoot.factory, true);
    const off = new Repository(store, TestAggregateRoot.factory);

    expect(on.debug).toBe(true);
    expect(off.debug).toBe(false);
  });

  describe("writeAsync", () => {
    it("should not call the store when there are no changes", async () => {
      // arrange
      const { append, read, repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      await repo.writeAsync(ar);
      append.mockClear();

      // act
      await repo.writeAsync(ar);
      await repo.writeAsync(ar, key);
      await repo.writeAsync(TestAggregateRoot.factory());

      // assert
      expect(append).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });

    it("should append all the changes at once, in their persisted form", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      ar.recordDetails({ list: [1, undefined], map: { a: undefined } });
      const [created, recorded] = [...ar.getChanges()];

      // act
      await repo.writeAsync(ar);

      // assert
      const expected = [
        {
          aggregateId: id,
          eventType: "TestAggregateRootCreated",
          timestamp: created.timestamp,
          aggregateVersion: 0,
          encryptedProps: ["name"],
          data: { id, name: "name" },
        },
        {
          aggregateId: id,
          eventType: "TestDetailsRecorded",
          timestamp: recorded.timestamp,
          aggregateVersion: 1,
          encryptedProps: undefined,
          data: {
            id,
            details: { list: [1, undefined], map: { a: undefined } },
          },
        },
      ];
      expect(append).toHaveBeenCalledTimes(1);
      const [aggregateId, events, expectedVersion] = append.mock.calls[0];
      expect(aggregateId).toBe(id);
      expect(events).toStrictEqual(expected);
      expect(expectedVersion).toBe(0);

      // the properties are in the same order too
      expect(events.map(Object.keys)).toEqual(expected.map(Object.keys));
    });

    it("should number the events contiguously from the expected version", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "event 0");
      ar.changeName("event 1");

      // act
      // write the new ar, write to it again, then write to a copy read back
      await repo.writeAsync(ar);
      ar.changeName("event 2");
      ar.changeName("event 3");
      ar.changeName("event 4");
      await repo.writeAsync(ar);
      const readAr = (await repo.readAsync(id))!;
      readAr.changeName("event 5");
      await repo.writeAsync(readAr);

      // assert
      expect(
        append.mock.calls.map(([, events, expectedVersion]) => ({
          expectedVersion,
          events: events.map(({ aggregateVersion, data }) => [
            aggregateVersion,
            data.name,
          ]),
        }))
      ).toEqual([
        {
          expectedVersion: 0,
          events: [
            [0, "event 0"],
            [1, "event 1"],
          ],
        },
        {
          expectedVersion: 2,
          events: [
            [2, "event 2"],
            [3, "event 3"],
            [4, "event 4"],
          ],
        },
        { expectedVersion: 5, events: [[5, "event 5"]] },
      ]);
      expect(readAr.getExpectedVersion()).toBe(6);
    });

    it("should encrypt only the declared fields when it is given a key", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      ar.createSecret("secret", "plain");
      ar.changeName("not declared in this event");

      // act
      await repo.writeAsync(ar, key);

      // assert
      const [created, secret, nameChanged] = append.mock.calls[0][1];
      expect(created.encryptedProps).toEqual(["name"]);
      expect(created.data).toEqual({ id, name: expect.any(String) });
      expect(isEncrypted(created.data.name)).toBe(true);
      expect(decrypt(created.data.name, key)).toBe("name");

      expect(secret.encryptedProps).toEqual(["secret"]);
      expect(secret.data).toEqual({
        id,
        secret: expect.any(String),
        plain: "plain",
      });
      expect(isEncrypted(secret.data.secret)).toBe(true);
      expect(decrypt(secret.data.secret, key)).toBe("secret");

      expect(nameChanged.encryptedProps).toBeUndefined();
      expect(nameChanged.data).toEqual({
        id,
        name: "not declared in this event",
      });
    });

    it("should encrypt nothing without a key, but still list the declared fields", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      ar.createSecret("secret", "plain");

      // act
      await repo.writeAsync(ar);

      // assert
      expect(append.mock.calls[0][1]).toMatchObject([
        { encryptedProps: ["name"], data: { id, name: "name" } },
        {
          encryptedProps: ["secret"],
          data: { id, secret: "secret", plain: "plain" },
        },
      ]);
    });

    it("should leave a declared field that is undefined or null as it is", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      ar.createMessage(null as unknown as undefined, undefined);

      // act
      await repo.writeAsync(ar, key);

      // assert
      const [, message] = append.mock.calls[0][1];
      expect(message.encryptedProps).toEqual(["text", "imageUrl"]);
      expect(message.data).toStrictEqual({
        id,
        text: null,
        imageUrl: undefined,
      });
    });

    it("should append nothing when a declared field is not a string", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      ar.createMessage({ not: "a string" } as unknown as string);

      // act / assert
      await expect(repo.writeAsync(ar, key)).rejects.toThrow(
        'Cannot encrypt encryptedProps field "text": expected a string, got object.'
      );
      expect(append).not.toHaveBeenCalled();
      expect(ar.getChanges()).toHaveLength(2);
      expect(ar.getExpectedVersion()).toBe(0);
    });

    it("should clear the changes only after the append has succeeded", async () => {
      // arrange
      const { append, repo } = setup();
      let succeed!: () => void;
      append.mockReturnValue(
        new Promise((resolve) => {
          succeed = resolve;
        })
      );
      const ar = TestAggregateRoot.create(id, "name");

      // act
      const write = repo.writeAsync(ar);
      await new Promise(setImmediate);

      // assert
      expect(append).toHaveBeenCalledTimes(1);
      expect(ar.getChanges()).toHaveLength(1);
      expect(ar.getExpectedVersion()).toBe(0);

      // act
      succeed();
      await write;

      // assert
      expect(ar.getChanges()).toHaveLength(0);
      expect(ar.getExpectedVersion()).toBe(1);
    });

    it("should keep the changes, and not alter the error, when the append is rejected", async () => {
      // arrange
      const { append, repo, store } = setup();
      const error = new Error("from the store");
      append.mockRejectedValueOnce(error);
      const ar = TestAggregateRoot.create(id, "name");
      ar.changeName("new name");
      const changes = [...ar.getChanges()];

      // act / assert
      await expect(repo.writeAsync(ar)).rejects.toBe(error);
      expect(ar.getChanges()).toEqual(changes);
      expect(ar.getExpectedVersion()).toBe(0);

      // the same changes can still be written
      await repo.writeAsync(ar);
      expect(await store.readAsync(id)).toMatchObject([
        { aggregateVersion: 0, data: { name: "name" } },
        { aggregateVersion: 1, data: { name: "new name" } },
      ]);
      expect(ar.getChanges()).toHaveLength(0);
      expect(ar.getExpectedVersion()).toBe(2);
    });

    it("should append only the changes that there were when it began", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "a");
      ar.changeName("b");

      // act
      const write = repo.writeAsync(ar);
      ar.changeName("c");
      await write;

      // assert
      expect(append).toHaveBeenCalledTimes(1);
      expect(appended(append)).toEqual([
        [
          [0, "a"],
          [1, "b"],
        ],
      ]);
      expect(ar.getChanges()).toMatchObject([{ name: "c" }]);
      expect(ar.getExpectedVersion()).toBe(2);
    });

    it("should lose no change, at whatever moment of a write it is made", async () => {
      const hadBeenCleared: boolean[] = [];

      for (let ticks = 0; ticks < 20; ticks++) {
        // arrange
        const { append, repo, store } = setup();
        const ar = TestAggregateRoot.create(id, "a");

        // act
        const write = repo.writeAsync(ar);
        for (let tick = 0; tick < ticks; tick++) {
          await undefined;
        }
        hadBeenCleared.push(!ar.hasChanges());
        ar.changeName("b");
        ar.changeName("c");
        await write;
        const nextWrite = repo.writeAsync(ar);
        ar.changeName("d");
        await nextWrite;
        await repo.writeAsync(ar);

        // assert
        expect(appended(append)).toEqual([
          [[0, "a"]],
          [
            [1, "b"],
            [2, "c"],
          ],
          [[3, "d"]],
        ]);
        expect(await store.readAsync(id)).toHaveLength(4);
        expect(ar.hasChanges()).toBe(false);
        expect(ar.getExpectedVersion()).toBe(4);
      }

      // the changes were made from the beginning of the write until after its end
      expect(hadBeenCleared[0]).toBe(false);
      expect(hadBeenCleared[hadBeenCleared.length - 1]).toBe(true);
    });

    it("should keep a change of the same event as one that it stores", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "a");
      const event = new TestAggregateRootNameChanged(id, "again");
      ar["applyChange"](event);
      ar["applyChange"](event);

      // act
      const write = repo.writeAsync(ar);
      ar["applyChange"](event);
      await write;

      // assert
      expect(ar.getChanges()).toEqual([event]);
      expect(ar.getExpectedVersion()).toBe(3);

      // act
      await repo.writeAsync(ar);

      // assert
      expect(appended(append)).toEqual([
        [
          [0, "a"],
          [1, "again"],
          [2, "again"],
        ],
        [[3, "again"]],
      ]);
    });

    it("should keep a change that is made during a write that cannot be encrypted", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "a");
      ar.createMessage(1 as unknown as string);

      // act
      const write = repo.writeAsync(ar, key);
      ar.changeName("b");
      const error = await write.catch((e) => e);

      // assert
      expect(error.message).toContain("Cannot encrypt");
      expect(append).not.toHaveBeenCalled();
      expect(ar.getChanges()).toMatchObject([
        { name: "a" },
        { text: 1 },
        { name: "b" },
      ]);
      expect(ar.getExpectedVersion()).toBe(0);
    });

    it("should reject the second of two writes that begin at once, and lose nothing", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "a");

      // act
      const first = repo.writeAsync(ar);
      ar.changeName("b");
      const second = repo.writeAsync(ar).catch((e) => e);
      ar.changeName("c");
      await first;
      const error = await second;

      // assert
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error).toMatchObject({ aggregateId: id, expectedVersion: 0 });
      expect(ar.getChanges()).toMatchObject([{ name: "b" }, { name: "c" }]);
      expect(ar.getExpectedVersion()).toBe(1);

      // act
      append.mockClear();
      await repo.writeAsync(ar);

      // assert
      expect(appended(append)).toEqual([
        [
          [1, "b"],
          [2, "c"],
        ],
      ]);
      expect(ar.hasChanges()).toBe(false);
      expect(ar.getExpectedVersion()).toBe(3);
    });

    it("should reject the first of two writes that begin at once if the second is faster, and lose nothing", async () => {
      // arrange
      const { append, repo, store } = setup();
      const ar = TestAggregateRoot.create(id, "a");
      const slow = new InterruptedEventStore(store, async (moment) => {
        if (moment === "first") {
          ar.changeName("b");
          await repo.writeAsync(ar);
          ar.changeName("c");
        }
      });

      // act
      const error = await new Repository(slow, TestAggregateRoot.factory)
        .writeAsync(ar)
        .catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error).toMatchObject({ aggregateId: id, expectedVersion: 0 });
      expect(ar.getChanges()).toMatchObject([{ name: "c" }]);
      expect(ar.getExpectedVersion()).toBe(2);

      // act
      append.mockClear();
      await repo.writeAsync(ar);

      // assert
      expect(appended(append)).toEqual([[[2, "c"]]]);
    });

    // the stores do not know of each other, so both writes succeed
    it("should clear the changes only once if two repositories store them at once", async () => {
      // arrange
      const [one, other] = [setup(), setup()];
      const ar = TestAggregateRoot.create(id, "a");
      ar.changeName("b");
      const slow = new InterruptedEventStore(other.store, async (moment) => {
        if (moment === "last") {
          await write;
          ar.changeName("c");
        }
      });

      // act
      const write = one.repo.writeAsync(ar);
      await new Repository(slow, TestAggregateRoot.factory).writeAsync(ar);

      // assert
      expect(ar.getChanges()).toMatchObject([{ name: "c" }]);
      expect(ar.getExpectedVersion()).toBe(2);

      // act
      await Promise.all([one, other].map(({ repo }) => repo.writeAsync(ar)));

      // assert
      for (const { append } of [one, other]) {
        expect(appended(append)).toEqual([
          [
            [0, "a"],
            [1, "b"],
          ],
          [[2, "c"]],
        ]);
      }
      expect(ar.hasChanges()).toBe(false);
      expect(ar.getExpectedVersion()).toBe(3);
    });

    it("should keep a change that is made after the app has cleared those of the write", async () => {
      // arrange
      const { append, repo } = setup();
      const ar = TestAggregateRoot.create(id, "a");

      // act
      const write = repo.writeAsync(ar);
      ar.clearChanges();
      ar.changeName("b");
      await write;

      // assert
      expect(ar.getChanges()).toMatchObject([{ name: "b" }]);
      expect(ar.getExpectedVersion()).toBe(1);

      // act
      await repo.writeAsync(ar);

      // assert
      expect(appended(append)).toEqual([[[0, "a"]], [[1, "b"]]]);
    });

    it("should reject the changes to a copy that is out of date", async () => {
      // arrange
      const { repo, store } = setup();
      await repo.writeAsync(TestAggregateRoot.create(id, "name"));
      const ar1 = (await repo.readAsync(id))!;
      const ar2 = (await repo.readAsync(id))!;
      ar1.changeName("ar1");
      ar2.changeName("ar2");

      // act
      await repo.writeAsync(ar1);
      const error = await repo.writeAsync(ar2).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error.aggregateId).toBe(id);
      expect(error.expectedVersion).toBe(1);
      expect(ar2.getChanges()).toMatchObject([{ name: "ar2" }]);
      expect(ar2.getExpectedVersion()).toBe(1);
      expect(await store.readAsync(id)).toMatchObject([
        { aggregateVersion: 0, data: { name: "name" } },
        { aggregateVersion: 1, data: { name: "ar1" } },
      ]);
    });
  });

  describe("readAsync", () => {
    it("should return undefined when there are no events", async () => {
      // arrange
      const { read, store } = setup();
      const activator = jest.fn(TestAggregateRoot.factory);
      const repo = new Repository<TestAggregateRoot>(store, activator);

      // act / assert
      expect(await repo.readAsync(id)).toBeUndefined();
      expect(await repo.readAsync(id, key)).toBeUndefined();
      expect(read.mock.calls).toEqual([[id], [id]]);
      expect(activator).not.toHaveBeenCalled();
    });

    it("should rebuild an aggregate that was written without a key", async () => {
      // arrange
      const { repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      ar.createSecret("secret", "plain");
      ar.recordDetails({ list: [1, undefined, 2], map: { a: undefined } });
      ar.changeName("new name");
      await repo.writeAsync(ar);

      // act
      const readAr = (await repo.readAsync(id))!;
      const readArWithKey = (await repo.readAsync(id, key))!;

      // assert
      expect(readAr).toBeInstanceOf(TestAggregateRoot);
      expect(readAr.getChanges()).toHaveLength(0);
      expect(readAr.state).toEqual({
        version: 4,
        id,
        name: "new name",
        created: ar.created,
        secret: "secret",
        plain: "plain",
        details: { list: [1, 2], map: {} },
      });
      expect(readArWithKey.state).toEqual(readAr.state);
    });

    it("should decrypt what was written with a key", async () => {
      // arrange
      const { repo } = setup();
      const ar = TestAggregateRoot.create(id, "name");
      ar.createSecret("secret", "plain");
      ar.createMessage(""); // an empty string is encrypted too
      await repo.writeAsync(ar, key);

      // act
      const readAr = (await repo.readAsync(id, key))!;

      // assert
      expect(readAr.state).toEqual({
        version: 3,
        id,
        name: "name",
        created: ar.created,
        secret: "secret",
        plain: "plain",
        messageText: "",
      });
    });

    it.each([
      ["no key", undefined, "no encryption key was provided"],
      ["the wrong key", "wrong key", "Cause: "],
    ])(
      "should leave encrypted fields as they are, and log them, when it is given %s",
      async (_, otherKey, message) => {
        // arrange
        const { repo, store } = setup();
        const ar = TestAggregateRoot.create(id, "name");
        ar.createSecret("secret", "plain");
        await repo.writeAsync(ar, key);
        const [created, secret] = await store.readAsync(id);
        const log = jest.spyOn(console, "error").mockImplementation(() => {});

        // act
        const readAr = (await repo.readAsync(id, otherKey))!;

        // assert
        expect(readAr.name).toBe(created.data.name);
        expect(readAr.secret).toBe(secret.data.secret);
        expect(readAr.plain).toBe("plain");
        expect(log.mock.calls).toEqual([
          [expect.stringContaining('Failed to decrypt PII field "name"')],
          [expect.stringContaining('Failed to decrypt PII field "secret"')],
        ]);
        expect(log.mock.calls[0][0]).toContain(message);
      }
    );

    it("should not decrypt an envelope in a field that the event does not list", async () => {
      // arrange
      const { read, repo } = setup();
      const envelope = encrypt("must not be decrypted", key);
      read.mockResolvedValue([
        stored(0, { data: { id, name: envelope } }),
        stored(1, {
          eventType: "TestSecretCreated",
          encryptedProps: ["secret"],
          data: { id, secret: encrypt("secret", key), plain: envelope },
        }),
        stored(2, {
          eventType: "TestMessageCreated",
          encryptedProps: [],
          data: { id, text: envelope },
        }),
      ]);

      // act
      const readAr = (await repo.readAsync(id, key))!;

      // assert
      expect(readAr.name).toBe(envelope);
      expect(readAr.secret).toBe("secret");
      expect(readAr.plain).toBe(envelope);
      expect(readAr.messageText).toBe(envelope);
    });

    it("should replay each event as its own properties, then those of its data", async () => {
      // arrange
      const { read, store } = setup();
      const replayed: IEvent[] = [];
      const repo = new Repository<TestAggregateRoot>(store, () => {
        const ar = TestAggregateRoot.factory();
        ar.initialize = (events) => {
          replayed.push(...events);
        };
        return ar;
      });
      read.mockResolvedValue([
        stored(0, { encryptedProps: ["name"] }),
        stored(1, { data: { name: "name 1", timestamp: "from the data" } }),
        stored(2, { data: undefined }),
      ]);

      // act
      await repo.readAsync(id);

      // assert
      const expected = [
        {
          eventType: "TestAggregateRootNameChanged",
          timestamp: "2026-01-01T00:00:00.000Z",
          encryptedProps: ["name"],
          id,
          name: "name 0",
        },
        {
          eventType: "TestAggregateRootNameChanged",
          timestamp: "from the data",
          encryptedProps: undefined,
          name: "name 1",
        },
        {
          eventType: "TestAggregateRootNameChanged",
          timestamp: "2026-01-01T00:00:00.000Z",
          encryptedProps: undefined,
        },
      ];
      expect(replayed).toStrictEqual(expected);
      expect(replayed.map(Object.keys)).toEqual(expected.map(Object.keys));
    });

    it("should not alter the error when the read is rejected", async () => {
      // arrange
      const { read, repo } = setup();
      const error = new Error("from the store");
      read.mockRejectedValue(error);

      // act / assert
      await expect(repo.readAsync(id)).rejects.toBe(error);
    });
  });
});
