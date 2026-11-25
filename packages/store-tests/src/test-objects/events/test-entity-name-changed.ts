import { EventBase } from "@es-aggregates/core";

export class TestEntityNameChanged extends EventBase {
  public static eventType = "TestEntityNameChanged";

  constructor(public readonly id: string, public readonly name: string) {
    super();
  }
}
