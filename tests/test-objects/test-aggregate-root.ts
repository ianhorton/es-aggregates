import { AggregateRoot } from "../../src";
import { v4 } from "uuid";
import { DummyEntityCreated, TestEntity } from "./test-entity"
import { TestEntityCreated } from "./events/test-entity-created";
import { TestAggregateRootNameChanged } from "./events/test-aggregate-root-name-changed";
import { TestAggregateRootCreated } from "./events/test-aggregate-root-created";
import { TestEntityNameChanged } from "./events/test-entity-name-changed";

export class TestAggregateRoot extends AggregateRoot {
  private _id: string;
  public get id(): string {
    return this._id;
  }

  private _name: string;
  public get name(): string {
    return this._name;
  }

  private _testEntities: Array<TestEntity> = new Array<TestEntity>();
  public get testEntities(): Array<TestEntity> {
    return this._testEntities;
  }

  private _created: string;
  public get created(): string {
    return this._created;
  }

  constructor() {
    super();

    this.register(
      TestAggregateRootCreated.typename,
      (e: TestAggregateRootCreated) => {
        this._id = e.id;
        this._name = e.name;
        this._created = e.timestamp;
      }
    );

    this.register(
      TestAggregateRootNameChanged.typename,
      (e: TestAggregateRootNameChanged) => {
        this._id = e.id;
        this._name = e.name;
      }
    );

    this.register(TestEntityCreated.typename, (e: TestEntityCreated) => {
      const testEntity = new TestEntity(this.applyChange);
      testEntity.route(e);
      this.testEntities.push(testEntity);
    });

    this.register(
      TestEntityNameChanged.typename,
      (e: TestEntityNameChanged) => {
        const te = this.testEntities.find((x) => x.id === e.id);
        if (te) {
          te.route(e);
        }
      }
    );

    this.register(
      DummyEntityCreated.typename,
      (e: DummyEntityCreated) => {
      }
    );
  }

  public static factory = (): TestAggregateRoot => {
    return new TestAggregateRoot();
  };

  public static create = (id: string, name: string): TestAggregateRoot => {
    const ar = new TestAggregateRoot();

    const fooCreated = new TestAggregateRootCreated(id, name);

    ar.applyChange(fooCreated);

    return ar;
  };

  public changeName = (newName: string) => {
    const nameChangedEvent = new TestAggregateRootNameChanged(this.id, newName);

    this._name = newName;

    this.applyChange(nameChangedEvent);
  };

  public createTestEntity = (name: string): string => {
    const id = v4();
    this.applyChange(TestEntity.create(id, name));
    return id;
  };

  public createTestEntityTwoEventsToReproPaymentIssue = (
    name: string
  ): string => {
    const id = v4();
    this.applyChange(TestEntity.create(id, name));

    const te = this.testEntities.find((x) => x.id === id);
    if (te) {
      this.applyChange(te.changeName("NewName321"));
    }

    return id;
  };

  public changeNameTestEntity = (id: string, name: string) => {
    const te = this.testEntities.find((x) => x.id === id);
    if (te) {
      this.applyChange(te.changeName(name));
    }
  };
}
