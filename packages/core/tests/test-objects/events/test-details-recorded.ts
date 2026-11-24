import { EventBase } from "../../../src";

// A plain event: it declares no encryptedProps. `details` can hold any kind of
// value, so tests can pin the DynamoDB type each kind is stored as.
export class TestDetailsRecorded extends EventBase {
  public static eventType = "TestDetailsRecorded";

  constructor(
    public readonly id: string,
    public readonly details: Record<string, unknown>
  ) {
    super();
  }
}
