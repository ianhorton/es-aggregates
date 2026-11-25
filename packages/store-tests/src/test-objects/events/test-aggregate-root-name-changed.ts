import { EventBase } from "@es-aggregates/core";


export class TestAggregateRootNameChanged extends EventBase {
  public static eventType = "TestAggregateRootNameChanged";

  constructor(public readonly id: string, public readonly name: string) {
    super();
  }
}
