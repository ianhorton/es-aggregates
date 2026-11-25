import { ConcurrencyError, EventStore, IPersistedEvent } from "../../src";

// Holds each event as JSON, so that it shares no objects with whoever appended or
// read it.
export class InMemoryEventStore implements EventStore {
  private readonly aggregates = new Map<string, Map<number, string>>();

  public appendAsync = async (
    aggregateId: string,
    events: IPersistedEvent[],
    expectedVersion: number
  ): Promise<void> => {
    const stored = this.storedFor(aggregateId);
    if (events.some(({ aggregateVersion }) => stored.has(aggregateVersion))) {
      throw new ConcurrencyError(aggregateId, expectedVersion);
    }
    for (const event of events) {
      stored.set(event.aggregateVersion, this.toJson(event));
    }
    this.aggregates.set(aggregateId, stored);
  };

  public readAsync = async (
    aggregateId: string
  ): Promise<IPersistedEvent[]> => {
    return [...this.storedFor(aggregateId)]
      .sort(([version], [other]) => version - other)
      .map(([, json]) => JSON.parse(json));
  };

  private storedFor(aggregateId: string): Map<number, string> {
    return this.aggregates.get(aggregateId) ?? new Map();
  }

  // JSON already leaves out a property that is undefined, but not an array element
  private toJson(event: IPersistedEvent): string {
    return JSON.stringify(event, (_, value) =>
      Array.isArray(value) ? value.filter((x) => x !== undefined) : value
    );
  }
}
