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
    const taken = events.find((event) => stored.has(event.aggregateVersion));
    if (taken !== undefined) {
      throw new ConcurrencyError(
        aggregateId,
        expectedVersion,
        new Error(`Version ${taken.aggregateVersion} is already stored.`)
      );
    }

    // one that is refused throws here, so before any of them is stored
    const appended = events.map((event): [number, string] => [
      event.aggregateVersion,
      this.toJson(event),
    ]);
    this.aggregates.set(aggregateId, new Map([...stored, ...appended]));
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

  // JSON already leaves out a property that is undefined, but not an array element. It
  // would change a value that is not plain, such as a Date, so that is refused
  private toJson(event: IPersistedEvent): string {
    const isPlain = this.isPlain;
    return JSON.stringify(event, function (name) {
      // what is passed as the value has already been through its toJSON
      const value = this[name];
      if (!isPlain(value)) {
        throw new Error(`Cannot store the ${name} of ${event.eventType}.`);
      }
      return Array.isArray(value)
        ? value.filter((x) => x !== undefined)
        : value;
    });
  }

  private isPlain = (value: unknown): boolean => {
    if (typeof value === "object" && value !== null) {
      const prototype = Object.getPrototypeOf(value);
      return [Object.prototype, Array.prototype].includes(prototype);
    }
    return typeof value !== "number" || Number.isFinite(value);
  };
}
