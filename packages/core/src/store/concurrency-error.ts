/**
 * An EventStore rejects with this when something else has stored, or is storing, a
 * version that it was to append. Read the aggregate again, and then make the change
 * again.
 */
export class ConcurrencyError extends Error {
  public readonly name: string = "ConcurrencyError";

  /**
   * @param cause the error from the database's SDK
   */
  constructor(
    public readonly aggregateId: string,
    public readonly expectedVersion: number,
    public readonly cause?: unknown
  ) {
    super(
      `Cannot append events to aggregate "${aggregateId}" at version ` +
        `${expectedVersion}: another write came first.`
    );
  }
}
