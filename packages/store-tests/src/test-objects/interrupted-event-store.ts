import { EventStore, IPersistedEvent } from "@es-aggregates/core";

/**
 * Passes everything on to another store, but interrupts its appends, so that a test can do
 * something while one is running:
 * - at the first moment, before the events go to the other store
 * - at the middle moment, when they are on their way
 * - at the last moment, when they are stored or refused, but nobody has been told
 *
 * An append goes on when the interruption is over. If that fails, the append fails too.
 */
export class InterruptedEventStore implements EventStore {
  public static readonly moments = ["first", "middle", "last"] as const;

  constructor(
    private readonly store: EventStore,
    private readonly interrupt: (
      moment: (typeof InterruptedEventStore.moments)[number]
    ) => void | Promise<void>
  ) {}

  public appendAsync = async (
    aggregateId: string,
    events: IPersistedEvent[],
    expectedVersion: number
  ): Promise<void> => {
    await this.interrupt("first");

    const append = this.store.appendAsync(aggregateId, events, expectedVersion);
    append.catch(() => {}); // it is awaited later
    await new Promise(setImmediate);
    await this.interrupt("middle");

    try {
      await append;
    } finally {
      await this.interrupt("last");
    }
  };

  public readAsync = (aggregateId: string): Promise<IPersistedEvent[]> =>
    this.store.readAsync(aggregateId);
}
