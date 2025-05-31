import { v4 } from "uuid";

import {
  TestAggregateRoot,
  TestAggregateRootMissingHandler,
} from "../test-objects";

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

  it("should update proerty value when new event is raised", () => {
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

});
