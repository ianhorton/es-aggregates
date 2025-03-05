import { AggregateRoot } from "../../src";
import { TestAggregateRootNameChanged } from "./events/test-aggregate-root-name-changed";
import { TestAggregateRootCreated } from "./events/test-aggregate-root-created";

export class TestAggregateRootMissingHandler extends AggregateRoot {
  private _id: string;
  public get id(): string {
    return this._id;
  }

  private _name: string;
  public get name(): string {
    return this._name;
  }

  constructor() {
    super();

    this.register(
      TestAggregateRootCreated.typename,
      (e: TestAggregateRootCreated) => {
        this._id = e.id;
        this._name = e.name;
      }
    );

    // handler for TestAggregateRootNameChanged omitted
  }

  public static factory = (): TestAggregateRootMissingHandler => {
    return new TestAggregateRootMissingHandler();
  };

  public static create = (
    id: string,
    name: string
  ): TestAggregateRootMissingHandler => {
    const ar = new TestAggregateRootMissingHandler();

    const fooCreated = new TestAggregateRootCreated(id, name);

    ar.applyChange(fooCreated);

    return ar;
  };

  public changeName = (newName: string) => {
    const nameChangedEvent = new TestAggregateRootNameChanged(this.id, newName);

    this._name = newName;

    this.applyChange(nameChangedEvent);
  };
}
