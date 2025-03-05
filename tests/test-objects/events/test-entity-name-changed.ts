import { EventBase } from "../../../src";

export class TestEntityNameChanged extends EventBase {
  public static typename = "TestEntityNameChanged";
  constructor(public readonly id: string, public readonly name: string) {
    super(TestEntityNameChanged.typename);
  }
}
