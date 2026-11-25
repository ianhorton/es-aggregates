import { readFileSync } from "fs";
import { join } from "path";

import { DynamoRepository } from "../src";

import { TestAggregateRoot } from "@es-aggregates/store-tests";
import { LocalEventTable, RawItem } from "./test-objects/local-event-table";

interface GoldenData {
  testEncryptionKey: string;
  aggregates: Array<{
    description: string;
    aggregateId: string;
    items: RawItem[];
    expected: { withTestKey: unknown; withoutKey: unknown };
  }>;
}

const golden: GoldenData = JSON.parse(
  readFileSync(join(__dirname, "fixtures/golden-1.1.1.json"), "utf8")
);

// Events that 1.1.1 has already stored must go on reading back exactly as 1.1.1
// itself reads them.
describe("Golden data stored by es-aggregates 1.1.1", () => {
  const table = new LocalEventTable();
  const repo = new DynamoRepository<TestAggregateRoot>(
    table.name,
    TestAggregateRoot.factory,
    table.client
  );

  beforeAll(async () => {
    for (const { items } of golden.aggregates) {
      for (const item of items) {
        await table.putAsync(item);
      }
    }
  });

  // every envelope that cannot be decrypted is logged
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(golden.aggregates)(
    "$description",
    ({ aggregateId, expected }) => {
      it("should read back the same with the key", async () => {
        const ar = await repo.readAsync(aggregateId, golden.testEncryptionKey);

        expect(ar?.state).toEqual(expected.withTestKey);
      });

      it("should read back the same without a key", async () => {
        const ar = await repo.readAsync(aggregateId);

        expect(ar?.state).toEqual(expected.withoutKey);
      });
    }
  );
});
