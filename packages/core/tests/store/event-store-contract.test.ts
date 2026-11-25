import { EventStoreContract } from "@es-aggregates/store-tests";

import { InMemoryEventStore } from "../test-objects/in-memory-event-store";

describe("InMemoryEventStore", () => {
  const store = new InMemoryEventStore();

  new EventStoreContract(() => store).define();
});
