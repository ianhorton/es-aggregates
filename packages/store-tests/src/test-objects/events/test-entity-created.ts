import { EventBase } from "@es-aggregates/core";


export class TestEntityCreated extends EventBase {
  public static eventType = "TestEntityCreated";

  constructor(public readonly id: string, public readonly name: string) {
    super();
  }
}
