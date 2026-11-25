import { v4 } from "uuid";

import {
  TestAggregateRoot,
  TestAggregateRootMissingHandler,
} from "@es-aggregates/store-tests";

describe("AggregateRoot Tests", () => {
  it("should create a new AggregateRoot", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);

    // assert
    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);
  });

  it("should have changes", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);
    const changes = ar.getChanges();

    // assert
    expect(changes).toHaveLength(1);
    expect(changes[0].eventType).toBe("TestAggregateRootCreated");
  });

  it("should return true if it has changes", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    expect(ar.hasChanges()).toBeTruthy();
  });

  it("should clear changes", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);
    ar.clearChanges();
    const changes = ar.getChanges();

    // assert
    expect(changes).toHaveLength(0);
  });

  it("should update property value when new event is raised", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);

    // assert
    expect(ar.getExpectedVersion()).toBe(0);
    expect(ar.name).toBe(name);

    // act
    ar.changeName("new name");

    // assert
    expect(ar.name).toBe("new name");
  });

  it("should not increment the expected version when a new event is raised", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);

    // assert
    expect(ar.getExpectedVersion()).toBe(0);

    // act
    ar.changeName("new name");

    // assert
    expect(ar.getExpectedVersion()).toBe(0);
  });

  it("should throw if Event handler is missing", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRootMissingHandler.create(id, name);

    // assert
    expect(ar.getExpectedVersion()).toBe(0);
    expect(() => ar.changeName("new name")).toThrow();
  });

  it("should throw if we try and create more than 100 changes", () => {
    // arrange
    const id = v4();
    const name = "1";
    const ar = TestAggregateRoot.create(id, name);

    // act
    for (let index = 2; index <= 100; index++) {
      ar.changeName(index.toString());
    }

    // assert
    expect(() => ar.changeName("new name")).toThrow();
  });

  describe("clearChanges", () => {
    // versions 0 to 3 have been cleared, and there are changes for versions 4 to 7
    const setup = () => {
      const ar = TestAggregateRoot.create(v4(), "0");
      ["1", "2", "3"].forEach(ar.changeName);
      ar.clearChanges();
      ["4", "5", "6", "7"].forEach(ar.changeName);
      return ar;
    };

    it("should clear all the changes, and expect the version after them", () => {
      // arrange
      const ar = setup();
      const changes = ar.getChanges();

      // act / assert
      expect(ar.getExpectedVersion()).toBe(4);
      ar.clearChanges();
      expect(ar.getExpectedVersion()).toBe(8);
      expect(ar.hasChanges()).toBe(false);
      expect(ar.getChanges()).toHaveLength(0);
      expect(changes).toHaveLength(0);

      // act / assert
      // there are none to clear
      ar.clearChanges();
      expect(ar.getExpectedVersion()).toBe(8);
    });

    it.each([
      [4, ["5", "6", "7"]],
      [5, ["6", "7"]],
      [6, ["7"]],
      [7, []],
    ])(
      "should clear the changes up to version %i, and keep the others",
      (lastVersion, names) => {
        // arrange
        const ar = setup();
        const changes = ar.getChanges();

        // act
        ar.clearChanges(lastVersion);

        // assert
        expect(ar.getExpectedVersion()).toBe(lastVersion + 1);
        expect(ar.hasChanges()).toBe(names.length > 0);
        expect(ar.getChanges()).toMatchObject(names.map((name) => ({ name })));

        // and it has not become another list
        expect(ar.getChanges()).toBe(changes);
      }
    );

    it.each([0, 2, 3])(
      "should clear nothing up to version %i, which has been cleared already",
      (lastVersion) => {
        // arrange
        const ar = setup();

        // act
        ar.clearChanges(lastVersion);

        // assert
        expect(ar.getExpectedVersion()).toBe(4);
        expect(ar.getChanges()).toHaveLength(4);
      }
    );

    it.each([["4"], [null], [{ rowCount: 4 }]])(
      "should clear all the changes if it is the callback of a promise for %p, which is not a number",
      async (result) => {
        // arrange
        const ar = setup();

        // act
        await Promise.resolve(result as unknown as undefined).then(
          ar.clearChanges
        );

        // assert
        expect(ar.getExpectedVersion()).toBe(8);
        expect(ar.hasChanges()).toBe(false);
      }
    );

    it("should make room for as many changes as it clears", () => {
      // arrange
      const ar = TestAggregateRoot.create(v4(), "0");
      for (let version = 1; version < 100; version++) {
        ar.changeName(`${version}`);
      }

      // act
      ar.clearChanges(59);
      for (let version = 100; version < 160; version++) {
        ar.changeName(`${version}`);
      }

      // assert
      expect(() => ar.changeName("160")).toThrow("limit of 100");
      expect(ar.getExpectedVersion()).toBe(60);
      expect(ar.getChanges()).toMatchObject(
        [...Array(100).keys()].map((index) => ({ name: `${60 + index}` }))
      );
    });
  });
});
