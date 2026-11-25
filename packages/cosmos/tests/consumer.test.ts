import { Consumer } from "./test-objects/consumer";

describe("Apps that use the package", () => {
  const consumer = new Consumer();

  const app = `
    import { CosmosClient } from "@azure/cosmos";
    import { EventStore } from "@es-aggregates/core";
    import { CosmosEventStore } from "@es-aggregates/cosmos";

    const client = new CosmosClient({ endpoint: "https://a.b", key: "c" });
    const container = client.database("d").container("e");
    export const store: EventStore = new CosmosEventStore(container);

    // @ts-expect-error: this is not a container
    new CosmosEventStore(client);
  `;

  // the SDK declares its classes for ES modules, and once more for CommonJS
  it.each([
    ["an ES module", "app.mts", true],
    ["an ES module, with skipLibCheck off", "app.mts", false],
    ["a CommonJS module", "app.cts", true],
    ["a CommonJS module, with skipLibCheck off", "app.cts", false],
  ])("should compile as %s", (_, name, skipLibCheck) => {
    expect(consumer.errorsOf(name, app, skipLibCheck)).toEqual([]);
  });
});
