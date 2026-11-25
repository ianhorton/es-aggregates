import { EventBase } from "@es-aggregates/core";

export class TestAggregateRootCreated extends EventBase {
  public static typename = "TestAggregateRootCreated";
  constructor(public readonly id: string, public readonly name: string) {
    super(TestAggregateRootCreated.typename, ["name"]);
  }
}
