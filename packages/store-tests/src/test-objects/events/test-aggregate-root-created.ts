import { EventBase } from "@es-aggregates/core";

export class TestAggregateRootCreated extends EventBase {
  public static eventType = "TestAggregateRootCreated";
  public static encryptedProps = ["name"];

  constructor(public readonly id: string, public readonly name: string) {
    super();
  }
}
