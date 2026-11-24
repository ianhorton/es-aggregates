import { EventBase } from "../../../src";


export class TestAggregateRootNameChanged extends EventBase {
  public static typename = "TestAggregateRootNameChanged";
  constructor(public readonly id: string, public readonly name: string) {
    super(TestAggregateRootNameChanged.typename);
  }
}
