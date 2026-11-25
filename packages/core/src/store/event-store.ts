import { IPersistedEvent } from "../event/models/persisted-event";

/**
 * Where a Repository keeps the events of its aggregates. Implement it to store
 * them in a database. Repository does the encryption and decryption, so a store
 * keeps events as they are.
 */
export interface EventStore {
  /**
   * Appends all of the events to the aggregate, or none of them.
   *
   * Their versions are contiguous, and the first is `expectedVersion`. If any of
   * those versions is already stored for the aggregate, this rejects with a
   * ConcurrencyError.
   *
   * Undefined values are not stored, at any depth: a property that holds one is
   * left out, and so is an array element.
   */
  appendAsync(
    aggregateId: string,
    events: IPersistedEvent[],
    expectedVersion: number
  ): Promise<void>;

  /**
   * Reads all of the aggregate's events, in aggregateVersion order. If it has
   * none, the array is empty.
   */
  readAsync(aggregateId: string): Promise<IPersistedEvent[]>;
}
