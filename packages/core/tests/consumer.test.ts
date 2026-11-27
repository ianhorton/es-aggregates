import { Consumer } from "@es-aggregates/store-tests/src/consumer";

describe("Apps that use the package", () => {
  const consumer = new Consumer("core");

  const rightNames = [
    "name",
    "nickname",
    "address.city",
    "initials", // it is a getter
  ];
  const wrongNames = [
    "nmae",
    "Name",
    "address.street",
    "",
    "eventType",
    "timestamp",
    "encryptedProps",
    "secret", // it is private
    "country", // it is static
    "print", // it is a method
  ];

  // an event for each name, which is the one in its list
  const eventsWith = (names: string[], comment = "") =>
    names
      .map(
        (name) => `{
          class UserMoved extends EventBase {
            static eventType = "UserMoved";
            ${comment}
            static encryptedProps: EncryptedProps<UserMoved> = ["${name}"];

            static readonly country = "";
            readonly "address.city" = "";

            constructor(
              readonly name: string,
              readonly address: { street: string },
              private readonly secret: string,
              readonly nickname?: string
            ) {
              super();
            }

            get initials() {
              return this.name[0];
            }

            print() {
              return this.name;
            }
          }
        }`
      )
      .join("\n");

  // a property of each type, and an optional one
  const propsOf = (types: string[]) =>
    types.flatMap((type) => [`value: ${type}`, `value?: ${type}`]);

  const rightProps = propsOf([
    "string",
    "string | null",
    "string | undefined",
    "null",
    '"home" | "work"',
    "`user-${string}`",
    "Email", // it is a branded string
    "Role", // it is an enum of strings
    "any",
  ]);
  const wrongProps = propsOf([
    "number",
    "bigint",
    "boolean",
    "symbol",
    "String",
    "Date",
    "string[]",
    "{ street: string }",
    "() => string",
    "Level", // it is an enum of numbers
    "string | number",
    "string | string[]",
    "number | null",
    "unknown",
  ]);

  // the types that are the app's own
  const types = `
    type Email = string & { readonly isEmail: true };
    enum Role { Admin = "admin", Guest = "guest" }
    enum Level { Low, High }
  `;

  // an event for each property, which is the one in its list
  const eventsOf = (props: string[], comment = "") =>
    props
      .map(
        (prop) => `{
          class UserChanged extends EventBase {
            static eventType = "UserChanged";
            ${comment}
            static encryptedProps: EncryptedProps<UserChanged> = ["value"];

            constructor(readonly name: string, readonly ${prop}) {
              super();
            }
          }
        }`
      )
      .join("\n");

  const app = `
    import {
      EncryptedProps,
      EventBase,
      EventStore,
      IEvent,
      IPersistedEvent,
      JsonEventCopy,
      JsonEventCopyOptions,
      JsonObject,
      JsonValue,
    } from "@es-aggregates/core";

    ${eventsWith(rightNames)}
    ${eventsWith(wrongNames, "// @ts-expect-error")}

    ${types}
    ${eventsOf(rightProps)}
    ${eventsOf(wrongProps, "// @ts-expect-error")}

    // events whose lists do not have the type
    export class UserCreated extends EventBase {
      static eventType = "UserCreated";
      static encryptedProps = ["name"];

      constructor(readonly name: string) {
        super();
      }
    }
    export class UserRenamed extends EventBase {
      constructor(readonly name: string) {
        super("UserRenamed", ["name"]);
      }
    }
    export class UserDeleted extends EventBase {
      static eventType = "UserDeleted";

      constructor() {
        super();
      }
    }

    // a list that has the type can be passed to EventBase, and be used as any list can
    export class UserLeft extends EventBase {
      static encryptedProps: EncryptedProps<UserLeft> = ["reason"];

      constructor(readonly reason: string, readonly remark?: string) {
        super("UserLeft", UserLeft.encryptedProps);
      }
    }
    export const list: string[] = UserLeft.encryptedProps;
    export const event: IEvent = {
      eventType: "UserLeft",
      timestamp: "2026-01-01T00:00:00.000Z",
      encryptedProps: UserLeft.encryptedProps,
    };

    // the same, where it is not known which event it is
    export abstract class PrivateEvent<T extends IEvent> extends EventBase {
      constructor(eventType: string, encryptedProps: EncryptedProps<T>) {
        super(eventType, encryptedProps);
      }
    }

    // but not every list has the type
    // @ts-expect-error
    UserLeft.encryptedProps = list;
    // @ts-expect-error
    UserLeft.encryptedProps = "reason";
    // @ts-expect-error
    UserLeft.encryptedProps = undefined;
    // @ts-expect-error
    UserLeft.encryptedProps = [undefined];

    // events that do not extend EventBase
    export interface UserBanned extends IEvent {
      readonly reason: string;
      readonly days: number;
    }
    export const ofInterface: EncryptedProps<UserBanned> = ["reason"];
    // @ts-expect-error
    ofInterface.push("raeson");
    // @ts-expect-error
    ofInterface.push("days");

    export class UserWarned implements IEvent {
      static encryptedProps: EncryptedProps<UserWarned> = ["reason"];

      readonly eventType = "UserWarned";
      readonly timestamp = "2026-01-01T00:00:00.000Z";
      readonly encryptedProps = UserWarned.encryptedProps;

      constructor(readonly reason: string) {}
    }

    // an event that has no properties but EventBase's
    export const ofNone: EncryptedProps<UserDeleted> = [];
    // @ts-expect-error
    ofNone.push("name");

    // an event that can have any property, of any type
    export interface UserImported extends IEvent {
      readonly [name: string]: any;
      readonly 1: string;
    }
    export const ofAny: EncryptedProps<UserImported> = ["name"];
    export const listOfAny: string[] = ofAny;

    // an event that can have any property, of a type that is not known
    export interface UserExported extends IEvent {
      readonly [name: string]: unknown;
    }
    export const ofUnknown: EncryptedProps<UserExported> = [];
    // @ts-expect-error
    ofUnknown.push("name");

    // an event that has a property of any one type
    export class UserUpdated<T> extends EventBase {
      static eventType = "UserUpdated";
      static encryptedProps: EncryptedProps<UserUpdated<unknown>> = ["field"];

      constructor(readonly field: string, readonly value: T) {
        super();
      }
    }
    // @ts-expect-error
    UserUpdated.encryptedProps = ["value"];
    export const ofString: EncryptedProps<UserUpdated<string>> = ["value"];

    // an event that is one of two
    type Updated = UserUpdated<string> | UserUpdated<number>;
    export let ofUnion: EncryptedProps<Updated> = ["field"];
    // @ts-expect-error
    ofUnion = ["value"];

    // an event that has another one like it, and that uses its own list
    export class UserMerged extends EventBase {
      static eventType = "UserMerged";
      static encryptedProps: EncryptedProps<UserMerged> = ["name"];

      constructor(readonly name: string, readonly other?: UserMerged) {
        super();
      }

      isPrivate(name: string) {
        return UserMerged.encryptedProps.some((prop) => prop === name);
      }
    }

    // an event that extends one whose list does not have the type
    export class AdminCreated extends UserCreated {
      static eventType = "AdminCreated";
      static encryptedProps: EncryptedProps<AdminCreated> = ["name", "role"];

      constructor(name: string, readonly role: string) {
        super(name);
      }
    }

    // the class is not an event
    // @ts-expect-error
    export type OfClass = EncryptedProps<typeof UserLeft>;

    // a store that keeps events as JSON, and one that checks their strings too
    export class JsonEventStore implements EventStore {
      private readonly copy = new JsonEventCopy();
      private readonly rows: string[] = [];

      async appendAsync(
        aggregateId: string,
        events: IPersistedEvent[],
        expectedVersion: number
      ): Promise<void> {
        const copies: JsonObject[] = events.map(this.copy.of);
        this.rows.push(...copies.map((copy) => JSON.stringify(copy)));
      }

      async readAsync(aggregateId: string): Promise<IPersistedEvent[]> {
        return this.rows.map((row) => JSON.parse(row));
      }
    }
    export const checks: JsonEventCopyOptions = {
      checkString: (value: string, path: string): void => {
        if (value.length > 1000) {
          throw new Error("Cannot store " + path + ", because it is too long.");
        }
      },
      checkPropertyName: (name, path) => undefined,
    };
    export const checkingCopy = new JsonEventCopy(checks);

    export const persisted: IPersistedEvent = {
      aggregateId: "user-1",
      aggregateVersion: 1,
      eventType: "UserCreated",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { name: "Ann" },
    };
    export const copied: JsonObject = checkingCopy.of(persisted);
    export const jsonValue: JsonValue = [null, true, 1, "a", { b: [] }];

    // @ts-expect-error: a check is a function
    new JsonEventCopy({ checkString: true });
    // @ts-expect-error: it copies an event
    checkingCopy.of({ eventType: "UserCreated" });
    // @ts-expect-error: a copy is an object
    export const notText: string = checkingCopy.of(persisted);
    // @ts-expect-error: JSON cannot hold a date
    export const date: JsonValue = new Date();
  `;

  it.each([
    ["an ES module", "app.mts", true],
    ["an ES module, with skipLibCheck off", "app.mts", false],
    ["a CommonJS module", "app.cts", true],
    ["a CommonJS module, with skipLibCheck off", "app.cts", false],
  ])("should compile as %s", (_, name, skipLibCheck) => {
    expect(consumer.errorsOf(name, app, skipLibCheck)).toEqual([]);
  });

  it("should not compile with a name that is not a public property of the event", () => {
    const wrongApp = `
      import { EncryptedProps, EventBase } from "@es-aggregates/core";

      ${eventsWith(rightNames, "// @ts-expect-error")}
      ${eventsWith(wrongNames)}
    `;

    expect(consumer.errorsOf("app.mts", wrongApp, false)).toEqual([
      ...rightNames.map(() => "Unused '@ts-expect-error' directive."),
      ...wrongNames.map((name) =>
        expect.stringContaining(`Type '"${name}"' is not assignable to type `)
      ),
    ]);
  });

  it("should not compile with a property that can be something other than a string, null or undefined", () => {
    const wrongApp = `
      import { EncryptedProps, EventBase } from "@es-aggregates/core";

      ${types}
      ${eventsOf(rightProps, "// @ts-expect-error")}
      ${eventsOf(wrongProps)}
    `;

    expect(consumer.errorsOf("app.mts", wrongApp, false)).toEqual([
      ...rightProps.map(() => "Unused '@ts-expect-error' directive."),
      ...wrongProps.map(
        () => `Type '"value"' is not assignable to type '"name"'.`
      ),
    ]);
  });
});
