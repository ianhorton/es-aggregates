import { v4 } from "uuid";

import {
  TestAggregateRoot,
  TestAggregateRootMissingHandler,
} from "../test-objects";

describe("AggregateRoot Tests", () => {
  it("should create a new AggregateRoot", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);
  });

  it("should have changes", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    const changes = ar.getChanges();

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
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    ar.clearChanges();

    const changes = ar.getChanges();

    expect(changes).toHaveLength(0);
  });

  it("should update proerty value when new event is raised", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    expect(ar.getExpectedVersion()).toBe(0);
    expect(ar.name).toBe(name);

    ar.changeName("new name");

    expect(ar.name).toBe("new name");
  });

  it("should not increment the expected version when a new event is raised", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    expect(ar.getExpectedVersion()).toBe(0);

    ar.changeName("new name");

    expect(ar.getExpectedVersion()).toBe(0);
  });

  it("should throw if Event handler is missing", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRootMissingHandler.create(id, name);

    expect(ar.getExpectedVersion()).toBe(0);

    expect(() => ar.changeName("new name")).toThrow();
  });

});
