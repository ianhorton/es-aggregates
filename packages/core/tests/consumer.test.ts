import { Consumer } from "@es-aggregates/store-tests/src/consumer";

describe("Apps that use the package", () => {
  const consumer = new Consumer("core");

  const rightNames = ["name", "nickname", "address", "address.city"];
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
          }
        }`
      )
      .join("\n");

  const app = `
    import { EncryptedProps, EventBase, IEvent } from "@es-aggregates/core";

    ${eventsWith(rightNames)}
    ${eventsWith(wrongNames, "// @ts-expect-error")}

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

      constructor(readonly reason: string) {
        super("UserLeft", UserLeft.encryptedProps);
      }
    }
    export const list: string[] = UserLeft.encryptedProps;
    export const event: IEvent = {
      eventType: "UserLeft",
      timestamp: "2026-01-01T00:00:00.000Z",
      encryptedProps: UserLeft.encryptedProps,
    };

    // but not every list has the type
    // @ts-expect-error
    UserLeft.encryptedProps = list;
    // @ts-expect-error
    UserLeft.encryptedProps = "reason";
    // @ts-expect-error
    UserLeft.encryptedProps = undefined;

    // an event that does not extend EventBase
    export interface UserBanned extends IEvent {
      readonly reason: string;
    }
    export const ofInterface: EncryptedProps<UserBanned> = ["reason"];
    // @ts-expect-error
    ofInterface.push("raeson");

    // an event that has no properties but EventBase's
    export const ofNone: EncryptedProps<UserDeleted> = [];
    // @ts-expect-error
    ofNone.push("name");

    // an event that can have any property
    export interface UserImported extends IEvent {
      readonly [name: string]: unknown;
      readonly 1: string;
    }
    export const ofAny: EncryptedProps<UserImported> = ["name"];
    export const listOfAny: string[] = ofAny;

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
});
