import { EventStoreContract } from "@es-aggregates/store-tests";

import { CosmosEventStore } from "../src";

import { Emulator } from "./test-objects/emulator";

jest.setTimeout(90000);

Emulator.describe("CosmosEventStore", () => {
  const emulator = new Emulator();

  beforeAll(emulator.startAsync);
  afterAll(emulator.stop);

  new EventStoreContract(
    () => new CosmosEventStore(emulator.container)
  ).define();
});
