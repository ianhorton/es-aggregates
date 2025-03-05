import { v4 } from "uuid";

import { TestAggregateRoot } from "../test-objects";

describe("Entity Tests", () => {
  it("should create a new Entity", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);

    ar.createTestEntity("child");

    expect(ar.testEntities).toHaveLength(1);
    expect(ar.testEntities[0].name).toBe("child");
  });

  it("should route Entity events to Entity", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);

    ar.createTestEntity("child");

    expect(ar.testEntities).toHaveLength(1);
    expect(ar.testEntities[0].name).toBe("child");
  });

  it("should route Entity events to Entity and update property", () => {
    const id = v4();
    const name = "New AR";

    const ar = TestAggregateRoot.create(id, name);

    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);

    const teId = ar.createTestEntity("child");
    ar.changeNameTestEntity(teId, "new name");

    expect(ar.testEntities[0].name).toBe("new name");
  });
});
