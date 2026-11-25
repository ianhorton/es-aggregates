import { ConcurrencyError } from "../../src";

describe("ConcurrencyError Tests", () => {
  it("should tell which aggregate and version, and why", () => {
    // arrange
    const cause = new Error("the error from the SDK");

    // act
    const error = new ConcurrencyError("some id", 3, cause);

    // assert
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConcurrencyError");
    expect(error.aggregateId).toBe("some id");
    expect(error.expectedVersion).toBe(3);
    expect(error.cause).toBe(cause);
    expect(`${error}`).toBe(
      'ConcurrencyError: Cannot append events to aggregate "some id" at version 3: another write came first.'
    );
  });

  it("should not need a cause", () => {
    expect(new ConcurrencyError("some id", 3).cause).toBeUndefined();
  });
});
