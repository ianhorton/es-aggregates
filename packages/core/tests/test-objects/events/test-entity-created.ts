import { EventBase } from "../../../src";


export class TestEntityCreated extends EventBase {
  public static typename = "TestEntityCreated";
  constructor(public readonly id: string, public readonly name: string) {
    super(TestEntityCreated.typename);
  }
}
