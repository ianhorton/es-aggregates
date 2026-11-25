import {
  ConcurrencyError,
  EventStore,
  isEncrypted,
  Repository,
} from "@es-aggregates/core";
import { v4 } from "uuid";

import { TestAggregateRoot } from "./test-objects";

/**
 * The tests of EventStoreContract that use the store through Repository.
 */
export class RepositoryContract {
  private readonly key = "key";

  constructor(private readonly createStore: () => EventStore) {}

  public define(): void {
    describe("Repository contract", () => {
      this.defineSaving();
      describe("encryption", () => this.defineEncryption());
      describe("when another save came first", () => this.defineLosing());
    });
  }

  private defineSaving(): void {
    it("should return undefined for an unknown aggregate", async () => {
      expect(await this.repository().readAsync(v4())).toBeUndefined();
      expect(await this.repository().readAsync(v4(), this.key)).toBeUndefined();
    });

    it("should save, load, change and save an aggregate", async () => {
      // arrange
      const id = v4();
      const ar = TestAggregateRoot.create(id, "a name");
      ar.createSecret("a secret", "plain");
      ar.recordDetails({ list: [1, undefined, 2], map: { a: undefined } });
      ar.createMessage("a message"); // imageUrl is undefined
      ar.changeName("another name");

      // act
      await this.repository().writeAsync(ar);
      const loaded = (await this.repository().readAsync(id))!;

      // assert
      const state = {
        version: 5,
        id,
        name: "another name",
        created: ar.created,
        secret: "a secret",
        plain: "plain",
        messageText: "a message",
        details: { list: [1, 2], map: {} },
      };
      expect(ar.getChanges()).toHaveLength(0);
      expect(ar.getExpectedVersion()).toBe(5);
      expect(loaded).toBeInstanceOf(TestAggregateRoot);
      expect(loaded.getChanges()).toHaveLength(0);
      expect(loaded.state).toEqual(state);

      // act
      // change the loaded copy twice, without loading it again
      loaded.changeName("a third name");
      await this.repository().writeAsync(loaded);
      loaded.createSecret("another secret");
      loaded.changeName("a fourth name");
      await this.repository().writeAsync(loaded);

      // assert
      expect((await this.repository().readAsync(id))!.state).toEqual({
        ...state,
        version: 8,
        name: "a fourth name",
        secret: "another secret",
        plain: undefined,
      });
    });
  }

  private defineEncryption(): void {
    let log: jest.SpyInstance;

    beforeEach(() => {
      log = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      log.mockRestore();
    });

    // the encrypted properties, as they are stored, of a new aggregate
    const createAsync = async (encryptionKey?: string) => {
      const id = v4();
      const ar = TestAggregateRoot.create(id, "a name");
      ar.createSecret("a secret", "plain");
      await this.repository().writeAsync(ar, encryptionKey);
      const [created, secretCreated] = await this.createStore().readAsync(id);
      return {
        id,
        name: created.data.name,
        secret: secretCreated.data.secret,
      };
    };

    it("should read what was encrypted, with the key", async () => {
      // arrange
      const { id, name, secret } = await createAsync(this.key);

      // act
      const ar = (await this.repository().readAsync(id, this.key))!;

      // assert
      expect(isEncrypted(name)).toBe(true);
      expect(isEncrypted(secret)).toBe(true);
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
        const { id, name, secret } = await createAsync(this.key);

        // act
        const ar = (await this.repository().readAsync(id, otherKey))!;

        // assert
        expect(isEncrypted(name)).toBe(true);
        expect(isEncrypted(secret)).toBe(true);
        expect(ar.name).toBe(name);
        expect(ar.secret).toBe(secret);
        expect(ar.plain).toBe("plain");
        expect(log.mock.calls).toEqual([
          [expect.stringContaining('Failed to decrypt PII field "name"')],
          [expect.stringContaining('Failed to decrypt PII field "secret"')],
        ]);
      }
    );

    it("should read what was not encrypted, with a key", async () => {
      // arrange
      const { id, name, secret } = await createAsync();

      // act
      const ar = (await this.repository().readAsync(id, this.key))!;

      // assert
      expect(name).toBe("a name");
      expect(secret).toBe("a secret");
      expect(ar.name).toBe("a name");
      expect(ar.secret).toBe("a secret");
      expect(ar.plain).toBe("plain");
      expect(log).not.toHaveBeenCalled();
    });
  }

  private defineLosing(): void {
    it("should keep the changes, which can be made again after a fresh read", async () => {
      // arrange
      const id = v4();
      const [repo, otherRepo] = [this.repository(), this.repository()];
      await repo.writeAsync(TestAggregateRoot.create(id, "a name"));
      const ar = (await repo.readAsync(id))!;
      const otherAr = (await otherRepo.readAsync(id))!;
      ar.changeName("first");
      otherAr.changeName("second");
      otherAr.changeName("third");
      await repo.writeAsync(ar);

      // act
      const error = await otherRepo.writeAsync(otherAr).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error).toMatchObject({ aggregateId: id, expectedVersion: 1 });
      expect(otherAr.getChanges()).toMatchObject([
        { name: "second" },
        { name: "third" },
      ]);
      expect(otherAr.getExpectedVersion()).toBe(1);
      expect(await this.namesAsync(id)).toEqual(["a name", "first"]);

      // act
      const fresh = (await otherRepo.readAsync(id))!;
      fresh.changeName("second");
      fresh.changeName("third");
      await otherRepo.writeAsync(fresh);

      // assert
      expect(await this.namesAsync(id)).toEqual([
        "a name",
        "first",
        "second",
        "third",
      ]);
      expect((await repo.readAsync(id))!.name).toBe("third");
    });

    it("should lose no change, however many save at once and then try again", async () => {
      // arrange
      const id = v4();
      const names = ["a", "b", "c", "d", "e"];
      await this.repository().writeAsync(TestAggregateRoot.create(id, ""));

      const saveAsync = async (name: string, attempts = 50): Promise<void> => {
        const repo = this.repository();
        const ar = (await repo.readAsync(id))!;
        ar.changeName(name);
        try {
          await repo.writeAsync(ar);
        } catch (error) {
          if (attempts === 0 || !(error instanceof ConcurrencyError)) {
            throw error;
          }
          await saveAsync(name, attempts - 1);
        }
      };

      // act
      await Promise.all(names.map((name) => saveAsync(name)));

      // assert
      const [, ...saved] = await this.namesAsync(id);
      expect(saved.sort()).toEqual(names);
    });
  }

  private repository(): Repository<TestAggregateRoot> {
    return new Repository(this.createStore(), TestAggregateRoot.factory);
  }

  // the name in each of the aggregate's events
  private async namesAsync(aggregateId: string): Promise<string[]> {
    const events = await this.createStore().readAsync(aggregateId);
    return events.map(({ data }) => data.name);
  }
}
