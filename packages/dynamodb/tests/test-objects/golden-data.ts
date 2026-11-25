import { readFileSync } from "fs";
import { join } from "path";

import { RawItem } from "./local-event-table";

interface GoldenData {
  testEncryptionKey: string;
  aggregates: Array<{
    description: string;
    aggregateId: string;
    items: RawItem[];
    expected: { withTestKey: unknown; withoutKey: unknown };
  }>;
}

export const golden: GoldenData = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/golden-1.1.1.json"), "utf8")
);
