import { EventStoreContract } from "@es-aggregates/store-tests";

import { DynamoEventStore } from "../src";

import { LocalEventTable } from "./test-objects/local-event-table";

jest.setTimeout(90000);

describe("DynamoEventStore", () => {
  const table = new LocalEventTable();

  // the AWS SDK's marshall function alters these without an error, as it did in 1.x
  new EventStoreContract(
    () => new DynamoEventStore(table.client, table.name),
    ["a property called __proto__", "a bigint", "a Map"]
  ).define();
});
