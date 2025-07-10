import { v4 } from "uuid";

import { TestAggregateRoot } from "../test-objects";

describe("Entity Tests", () => {
  it("should create a new Entity", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);

    // assert
    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);

    // act
    ar.createTestEntity("child");

    // assert
    expect(ar.testEntities).toHaveLength(1);
    expect(ar.testEntities[0].name).toBe("child");
  });

  it("should route Entity events to Entity", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);

    // assert
    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);

    // act
    ar.createTestEntity("child");

    // assert
    expect(ar.testEntities).toHaveLength(1);
    expect(ar.testEntities[0].name).toBe("child");
  });

  it("should route Entity events to Entity and update property", () => {
    // arrange
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);

    // assert
    expect(ar.name).toBe(name);
    expect(ar.id).toBe(id);

    // act
    const teId = ar.createTestEntity("child");
    ar.changeNameTestEntity(teId, "new name");

    // assert
    expect(ar.testEntities[0].name).toBe("new name");
  });

  it("should preserve the context of the entity when it is routed to", () => {
    const id = v4();
    const name = "New AR";

    // act
    const ar = TestAggregateRoot.create(id, name);
    const entityId = ar.createTestEntity("child");
    const entity = ar.testEntities.find((x) => x.id === entityId);

    entity?.testContext()

  })
});
