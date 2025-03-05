import { Entity, IEvent } from "../../src";
import { TestEntityCreated } from "./events/test-entity-created";
import { TestEntityNameChanged } from "./events/test-entity-name-changed";

export class TestEntity extends Entity {
  private _id: string;
  public get id(): string {
    return this._id;
  }

  private _name: string;
  public get name(): string {
    return this._name;
  }

  private _created: number;
  public get created(): number {
    return this._created;
  }

  constructor(applier: (e: IEvent) => void) {
    super(applier);

    this.register(TestEntityCreated.typename, (e: TestEntityCreated) => {
      this._id = e.id;
      this._name = e.name;
    });

    this.register(
      TestEntityNameChanged.typename,
      (e: TestEntityNameChanged) => {
        this._name = e.name;
      }
    );
  }

  public static create = (id: string, name: string): TestEntityCreated => {
    return new TestEntityCreated(id, name);
  };

  public changeName = (name: string): TestEntityNameChanged => {
    return new TestEntityNameChanged(this.id, name);
  };
}
