import { Entity, EventBase, IEvent } from "@es-aggregates/core"
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

    this.register(TestEntityCreated.eventType, (e: TestEntityCreated) => {
      this._id = e.id;
      this._name = e.name;
    });

    this.register(
      TestEntityNameChanged.eventType,
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

  public testContext() {
    const dummy = DummyEntity.create("1", "2");

    this.apply(dummy);
  }
}

class DummyEntity extends Entity {
  private _id: string;
  public get id(): string {
    return this._id;
  }

  private _name: string;
  public get name(): string {
    return this._name;
  }

  constructor(applier: (e: IEvent) => void) {
    super(applier);

    this.register(DummyEntityCreated.eventType, (e: DummyEntityCreated) => {
      this._id = e.id;
      this._name = e.name;
    });
  }


  public static create = (id: string, name: string): DummyEntityCreated => {
    return new DummyEntityCreated(id, name);
  };
}


export class DummyEntityCreated extends EventBase {
  public static eventType = "DummyEntityCreated";

  constructor(public readonly id: string, public readonly name: string) {
    super();
  }
}