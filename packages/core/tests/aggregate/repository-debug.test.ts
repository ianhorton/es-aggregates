import { TestAggregateRoot } from "@es-aggregates/store-tests";
import { LogFormat, LogLevel } from "@sailplane/logger";
import { inspect } from "node:util";
import { v4 } from "uuid";

import { isEncrypted } from "../../src";

import { InMemoryEventStore } from "../test-objects/in-memory-event-store";

describe("Debug logging of Repository", () => {
  const id = "aggregate id";

  let Logger: typeof import("@sailplane/logger").Logger;
  let Repository: typeof import("../../src").Repository;

  let store: InMemoryEventStore;

  // the arguments of each call to the console
  let logged: unknown[][];

  beforeEach(() => {
    store = new InMemoryEventStore();
    logged = [];
    for (const name of [
      "debug",
      "error",
      "info",
      "log",
      "trace",
      "warn",
    ] as const) {
      jest.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    // the logger takes the console's functions when it is loaded, so it must be loaded
    // after they are spied on
    jest.isolateModules(() => {
      ({ Logger } = require("@sailplane/logger"));
      ({ Repository } = require("../../src"));
    });

    // the format, which is not what is tested, would depend on the environment
    Logger.initialize({
      format: LogFormat.FLAT,
      logTimestamps: false,
      outputLevels: false,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createRepo = (debug?: boolean) =>
    new Repository(store, TestAggregateRoot.factory, debug);

  // what was logged, with its JSON parsed
  const lines = () =>
    logged.map(([module, message, ...details]) => [
      module,
      message,
      ...details.map((json) => JSON.parse(json as string)),
    ]);

  describe("of several repositories", () => {
    describe.each(["DEBUG", "NONE"] as const)(
      "when the app's level for all loggers is %s",
      (level) => {
        beforeEach(() => {
          Logger.initialize({ level: LogLevel[level] });
        });

        it.each([
          [true, false],
          [false, true],
          [true, undefined],
          [undefined, true],
        ])(
          "should log only for the one with debug, when they are created with %p and %p",
          async (...order) => {
            // arrange
            const repos = order.map(createRepo);
            const withDebug = repos[order.indexOf(true)];
            const without = repos[1 - order.indexOf(true)];
            const useAsync = async (repo: typeof withDebug) => {
              await repo.writeAsync(TestAggregateRoot.create(v4(), "name"));
              await repo.writeAsync(TestAggregateRoot.factory());
              await repo.readAsync(v4());
            };

            // act / assert
            await useAsync(without);
            expect(logged).toEqual([]);

            await useAsync(withDebug);
            expect(logged.map(([, message]) => message)).toEqual([
              "Writing changes.",
              "No changes to write.",
              "Read items.",
            ]);

            await useAsync(without);
            expect(logged).toHaveLength(3);
          }
        );
      }
    );
  });

  it("should log the id, the expected version and the event types of a write", async () => {
    // arrange
    const repo = createRepo(true);
    const ar = TestAggregateRoot.create(id, "name");
    ar.createSecret("secret", "plain");

    // act
    await repo.writeAsync(ar, "key");
    ar.changeName("new name");
    await repo.writeAsync(ar, "key");

    // assert
    expect(lines()).toEqual([
      [
        "repository:",
        "Writing changes.",
        {
          aggregateId: id,
          expectedVersion: 0,
          eventTypes: ["TestAggregateRootCreated", "TestSecretCreated"],
        },
      ],
      [
        "repository:",
        "Writing changes.",
        {
          aggregateId: id,
          expectedVersion: 2,
          eventTypes: ["TestAggregateRootNameChanged"],
        },
      ],
    ]);
  });

  it("should log the id of a write without changes", async () => {
    // arrange
    const repo = createRepo(true);
    const ar = TestAggregateRoot.create(id, "name");
    ar.clearChanges();

    // act
    await repo.writeAsync(ar, "key");

    // assert
    expect(lines()).toEqual([
      ["repository:", "No changes to write.", { aggregateId: id }],
    ]);
  });

  it("should log the id, and the versions and event types of a read", async () => {
    // arrange
    const repo = createRepo(true);
    const ar = TestAggregateRoot.create(id, "name");
    ar.createSecret("secret", "plain");
    await createRepo().writeAsync(ar, "key");

    // act
    await repo.readAsync(id, "key");
    await repo.readAsync("another id", "key");

    // assert
    expect(lines()).toEqual([
      [
        "repository:",
        "Read items.",
        {
          aggregateId: id,
          items: [
            { aggregateVersion: 0, eventType: "TestAggregateRootCreated" },
            { aggregateVersion: 1, eventType: "TestSecretCreated" },
          ],
        },
      ],
      ["repository:", "Read items.", { aggregateId: "another id", items: [] }],
    ]);
  });

  it("should not use a logger that a subclass has", async () => {
    // arrange
    class LoggingRepository extends Repository<TestAggregateRoot> {
      public readonly logger = { debug: jest.fn() };
    }
    const repo = new LoggingRepository(store, TestAggregateRoot.factory, true);

    // act
    await repo.writeAsync(TestAggregateRoot.create(id, "name"));
    await repo.readAsync(id);

    // assert
    expect(repo.logger.debug).not.toHaveBeenCalled();
    expect(logged).toHaveLength(2);
  });

  describe("of values and keys", () => {
    // what must not be logged
    let secrets: string[];

    const newSecret = (): string => {
      const secret = v4();
      secrets.push(secret);
      return secret;
    };

    // the secrets that were logged, however deep in whatever the console was given
    const leaked = (): string[] => {
      const text = inspect(logged, {
        breakLength: Infinity,
        depth: Infinity,
        maxArrayLength: Infinity,
        maxStringLength: Infinity,
      });
      return secrets.filter((secret) => text.includes(secret));
    };

    const createAggregate = (): TestAggregateRoot => {
      const ar = TestAggregateRoot.create(id, newSecret());
      ar.createSecret(newSecret(), newSecret());
      ar.createMessage(newSecret(), newSecret());
      ar.recordDetails({ list: [newSecret()], map: { a: newSecret() } });
      return ar;
    };

    // those of the stored values that are encrypted, which are secrets too
    const envelopesAsync = async (): Promise<string[]> => {
      const events = await store.readAsync(id);
      const envelopes = events
        .flatMap(({ data }) => Object.values(data))
        .filter(isEncrypted);
      secrets.push(...envelopes);
      return envelopes;
    };

    beforeEach(() => {
      secrets = [];
    });

    it("should find a secret that is logged", () => {
      const error = new Error(`with ${newSecret()}`);
      const nested = { a: [{ b: { c: { d: [newSecret()] } } }] };
      const notLogged = newSecret();

      console.debug("a line", error, `"${newSecret()}"`);
      console.error({ error: Object.assign(new Error(), nested) });

      expect(secrets).toHaveLength(4);
      expect(leaked()).toEqual(secrets.filter((secret) => secret !== notLogged));
    });

    it.each([
      ["encrypted", true, 4],
      ["not encrypted", false, 0],
    ])(
      "should log none of them when the values are %s",
      async (_, isWithKey, encrypted) => {
        // arrange
        const key = isWithKey ? newSecret() : undefined;
        const repo = createRepo(true);
        const ar = createAggregate();

        // act
        await repo.writeAsync(ar, key);
        const readAr = (await repo.readAsync(id, key))!;
        readAr.changeName(newSecret());
        await repo.writeAsync(readAr, key);

        // assert
        expect(await envelopesAsync()).toHaveLength(encrypted);
        expect(lines()).toHaveLength(3);
        expect(leaked()).toEqual([]);
      }
    );

    it.each([
      ["no key", false],
      ["the wrong key", true],
    ])(
      "should log none of them when a read is given %s",
      async (_, isWithKey) => {
        // arrange
        const repo = createRepo(true);
        await createRepo().writeAsync(createAggregate(), newSecret());
        const envelopes = await envelopesAsync();

        // act
        await repo.readAsync(id, isWithKey ? newSecret() : undefined);

        // assert
        expect(envelopes).toHaveLength(4);
        expect(logged.map(([text]) => text)).toEqual([
          "repository:",
          expect.stringContaining('Failed to decrypt PII field "name"'),
          expect.stringContaining('Failed to decrypt PII field "secret"'),
          expect.stringContaining('Failed to decrypt PII field "text"'),
          expect.stringContaining('Failed to decrypt PII field "imageUrl"'),
        ]);
        expect(leaked()).toEqual([]);
      }
    );

    it("should log none of them, nor the error, when the store rejects", async () => {
      // arrange
      const repo = createRepo(true);
      const ar = createAggregate();
      const error = Object.assign(new Error(newSecret()), {
        cause: new Error(newSecret()),
        item: { data: newSecret() },
      });
      jest.spyOn(store, "appendAsync").mockRejectedValue(error);
      jest.spyOn(store, "readAsync").mockRejectedValue(error);

      // act / assert
      await expect(repo.writeAsync(ar, newSecret())).rejects.toBe(error);
      await expect(repo.readAsync(id, newSecret())).rejects.toBe(error);
      expect(lines()).toMatchObject([["repository:", "Writing changes.", {}]]);
      expect(leaked()).toEqual([]);
    });

    it("should log none of them, nor the error, when a value cannot be encrypted", async () => {
      // arrange
      const repo = createRepo(true);
      const ar = createAggregate();
      ar.createMessage({ not: newSecret() } as unknown as string);

      // act / assert
      await expect(repo.writeAsync(ar, newSecret())).rejects.toThrow(
        'Cannot encrypt encryptedProps field "text"'
      );
      expect(lines()).toMatchObject([["repository:", "Writing changes.", {}]]);
      expect(leaked()).toEqual([]);
    });

    it("should log none of them, nor the error, when the aggregate throws", async () => {
      // arrange
      await createRepo().writeAsync(createAggregate());
      const error = new Error(newSecret());
      const repo = new Repository<TestAggregateRoot>(
        store,
        () => {
          const ar = TestAggregateRoot.factory();
          ar.initialize = () => {
            throw error;
          };
          return ar;
        },
        true
      );

      // act / assert
      await expect(repo.readAsync(id)).rejects.toBe(error);
      expect(lines()).toMatchObject([["repository:", "Read items.", {}]]);
      expect(leaked()).toEqual([]);
    });
  });
});
