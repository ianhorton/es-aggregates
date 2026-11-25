import { inspect } from "node:util";
import { v4 } from "uuid";

import {
  AggregateRoot,
  decrypt,
  EventBase,
  IEvent,
  IPersistedEvent,
} from "../../src";

import { InMemoryEventStore } from "../test-objects/in-memory-event-store";

// an aggregate that takes any event
class TestAggregate extends AggregateRoot {
  public readonly id = v4();

  constructor(events: IEvent[] = []) {
    super();
    for (const event of events) {
      this.register(event.eventType, () => {});
      this.applyChange(event);
    }
  }
}

class Right extends EventBase {
  public static eventType = "Right";
  public static encryptedProps = ["name"];

  constructor(public readonly name: unknown = "a name") {
    super();
  }
}

class Misspelt extends EventBase {
  public static eventType = "Misspelt";
  public static encryptedProps = ["nmae"];

  constructor(public readonly name: unknown = "a name") {
    super();
  }
}

// passes its type to super, and no list
class TypeOnly extends EventBase {
  public static encryptedProps = ["name"];

  constructor(
    public readonly name: unknown = "a name",
    eventType: string = "TypeOnly"
  ) {
    super(eventType);
  }
}

describe("Warnings about encryptedProps", () => {
  const key = "key";

  let Repository: typeof import("../../src").Repository;
  let store: InMemoryEventStore;
  let append: jest.SpyInstance;
  let warn: jest.SpyInstance;

  // each warning is given once per process, so this loads the library again
  const startProcess = () => {
    jest.isolateModules(() => {
      ({ Repository } = require("../../src"));
    });
  };

  beforeEach(() => {
    store = new InMemoryEventStore();
    append = jest.spyOn(store, "appendAsync");
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    startProcess();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const writeAsync = (
    events: IEvent[],
    encryptionKey: string | undefined
  ): Promise<void> =>
    new Repository(store, () => new TestAggregate()).writeAsync(
      new TestAggregate(events),
      encryptionKey
    );

  // what a write of the events logs with console.warn
  const warningsAsync = async (
    events: IEvent[],
    encryptionKey: string | undefined
  ): Promise<unknown[][]> => {
    warn.mockClear(); // making an event that passes its type to super has logged too
    await writeAsync(events, encryptionKey);
    return [...warn.mock.calls];
  };

  // what the last write has stored
  const stored = (): IPersistedEvent[] => append.mock.calls.slice(-1)[0][1];

  const nameNotInData = (eventType: string, name: string) => [
    expect.stringContaining(
      `[es-aggregates] Event "${eventType}" lists "${name}" in encryptedProps, but`
    ),
  ];

  const staticListNotUsed = (eventType: string) => [
    expect.stringContaining(
      `[es-aggregates] Event "${eventType}" has no encryptedProps, although`
    ),
  ];

  const encrypted = expect.stringMatching(/^ENC1\./);

  it("should not be given for an event that is encrypted", async () => {
    expect(await warningsAsync([new Right()], key)).toEqual([]);
    expect(stored()).toMatchObject([{ data: { name: encrypted } }]);
  });

  describe("for a name that the event does not have", () => {
    it("should say what happens and what to do", async () => {
      expect(await warningsAsync([new Misspelt()], key)).toEqual([
        [
          '[es-aggregates] Event "Misspelt" lists "nmae" in encryptedProps, but its data ' +
            "has no property of that name, so nothing is encrypted for it. Check the " +
            "spelling: if another property is meant, its value is stored as plain text. " +
            "Only the event's own properties can be encrypted, other than eventType and " +
            'timestamp, and not one inside an object, such as "address.city". If the ' +
            "property is optional, and this event does not have it, you can ignore this.",
        ],
      ]);
    });

    it("should not change what is stored", async () => {
      // arrange
      class Moved extends EventBase {
        public static eventType = "Moved";
        public static encryptedProps = ["nmae", "address.city", "nickname"];

        constructor(
          public readonly name: string,
          public readonly nickname: string,
          public readonly address: { city: string }
        ) {
          super();
        }
      }
      const event = new Moved("a name", "a nickname", { city: "a city" });

      // act
      const warnings = await warningsAsync([event], key);

      // assert
      expect(warnings).toEqual([
        nameNotInData("Moved", "nmae"),
        nameNotInData("Moved", "address.city"),
      ]);
      expect(stored()).toStrictEqual([
        {
          aggregateId: expect.any(String),
          eventType: "Moved",
          timestamp: event.timestamp,
          aggregateVersion: 0,
          encryptedProps: ["nmae", "address.city", "nickname"],
          data: {
            name: "a name",
            nickname: encrypted,
            address: { city: "a city" },
          },
        },
      ]);
      expect(decrypt(stored()[0].data.nickname, key)).toBe("a nickname");
    });

    it.each([
      ["a name in another case", "Name"],
      ["a name with a space", "name "],
      ["an empty name", ""],
      ["the path of a property inside an object", "address.city"],
      ["the path of an element of an array", "cities[0]"],
      // the event has these, but not in its data, so they are never encrypted
      ["eventType", "eventType"],
      ["timestamp", "timestamp"],
      ["encryptedProps", "encryptedProps"],
      ["a getter of the class", "capitals"],
      ["a static property of the class", "country"],
    ])("should be given for %s", async (_, name) => {
      class Moved extends Right {
        public static eventType = "Moved";
        public static encryptedProps = [name];
        public static country = "a country";

        public readonly address = { city: "a city" };
        public readonly cities = ["a city"];

        public get capitals(): string {
          return `${this.name}`.toUpperCase();
        }
      }

      expect(await warningsAsync([new Moved()], key)).toEqual([
        nameNotInData("Moved", name),
      ]);
    });

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["an empty string", ""],
    ])("should not be given for a property that is %s", async (_, value) => {
      const event = Object.assign(new Right(), { name: value });

      expect(await warningsAsync([event], key)).toEqual([]);
    });

    it("should not be given for a property that has a dot in its name", async () => {
      class Moved extends Right {
        public static eventType = "Moved";
        public static encryptedProps = ["address.city"];

        public readonly "address.city" = "a city";
      }

      expect(await warningsAsync([new Moved()], key)).toEqual([]);
      expect(stored()[0].data["address.city"]).toEqual(encrypted);
    });

    it("should say that it can be ignored if the property is optional", async () => {
      class Renamed extends Right {
        public static eventType = "Renamed";
        public static encryptedProps = ["name", "nickname"];

        public nickname?: string; // which an event does not have until it is set
      }
      const event = new Renamed();
      expect(event).not.toHaveProperty("nickname");

      expect(await warningsAsync([event], key)).toEqual([
        [
          expect.stringMatching(
            /"nickname".* If the property is optional, and this event does not have it, you can ignore this\.$/
          ),
        ],
      ]);
    });

    it("should be given for each character if the list is a string", async () => {
      class Renamed extends Right {
        public static eventType = "Renamed";
        public static encryptedProps = "name" as unknown as string[];
      }

      expect(await warningsAsync([new Renamed()], key)).toEqual(
        ["n", "a", "m", "e"].map((name) => nameNotInData("Renamed", name))
      );
    });

    it("should be given once for each event type and name", async () => {
      class Other extends Right {
        public static eventType = "Other";
        public static encryptedProps = ["nmae", "name", "naem", "nmae"];
      }

      expect(
        await warningsAsync(
          [new Misspelt(), new Misspelt(), new Other(), new Misspelt()],
          key
        )
      ).toEqual([
        nameNotInData("Misspelt", "nmae"),
        nameNotInData("Other", "nmae"),
        nameNotInData("Other", "naem"),
      ]);
    });

    it("should tell event types and names apart, whatever is in them", async () => {
      const pairs = [
        ["User", "name.first"],
        ["User.name", "first"],
        ["User,name", "first"],
        ["User", "name,first"],
        ["Username", "first"],
        ["User", "namefirst"],
      ];
      const events = pairs.map(([eventType, name]) => ({
        eventType,
        timestamp: "2026-01-01T00:00:00.000Z",
        encryptedProps: [name],
      }));

      expect(await warningsAsync(events, key)).toEqual(
        pairs.map(([eventType, name]) => nameNotInData(eventType, name))
      );
    });
  });

  describe("for a static list that is not used", () => {
    it("should say what happens and what to do", async () => {
      expect(await warningsAsync([new TypeOnly()], key)).toEqual([
        [
          '[es-aggregates] Event "TypeOnly" has no encryptedProps, although its class ' +
            "declares static encryptedProps, so nothing of it is encrypted: its values " +
            "are stored as plain text. The static list is not used if the constructor " +
            "passes the event's type to super. Declare static eventType too, and call " +
            "super() without arguments. If no list is passed on purpose, to switch " +
            "encryption off, you can ignore this.",
        ],
      ]);
    });

    it("should not change what is stored", async () => {
      // arrange
      const event = new TypeOnly();

      // act
      const warnings = await warningsAsync([event], key);

      // assert
      expect(warnings).toEqual([staticListNotUsed("TypeOnly")]);
      expect(stored()).toStrictEqual([
        {
          aggregateId: expect.any(String),
          eventType: "TypeOnly",
          timestamp: event.timestamp,
          aggregateVersion: 0,
          encryptedProps: undefined,
          data: { name: "a name" },
        },
      ]);
    });

    it("should be given if undefined is passed for the list", async () => {
      class Renamed extends EventBase {
        public static encryptedProps = ["name"];

        constructor(public readonly name: string) {
          super("Renamed", undefined);
        }
      }

      expect(await warningsAsync([new Renamed("a name")], key)).toEqual([
        staticListNotUsed("Renamed"),
      ]);
    });

    it("should be given if the list is that of a class that it extends", async () => {
      class Renamed extends TypeOnly {}

      expect(Object.keys(Renamed)).not.toContain("encryptedProps");
      expect(await warningsAsync([new Renamed()], key)).toEqual([
        staticListNotUsed("TypeOnly"),
      ]);
    });

    it("should be given if the event's own list is taken away", async () => {
      const event = Object.assign(new Right(), { encryptedProps: undefined });

      expect(await warningsAsync([event], key)).toEqual([
        staticListNotUsed("Right"),
      ]);
    });

    it.each<[string, unknown, string[] | undefined]>([
      ["a list is passed", ["name"], ["name"]],
      ["a list is passed that is empty", ["name"], []],
      ["a list is passed that has another name", ["name"], ["id"]],
      ["the static list is empty", [], undefined],
      ["the static list is undefined", undefined, undefined],
      ["the static list is null", null, undefined],
      // such as one that returns the list for an environment
      ["it is a static method", (_: string) => ["name"], undefined],
    ])("should not be given if %s", async (_, staticList, passedList) => {
      class Renamed extends EventBase {
        public static encryptedProps = staticList;

        constructor(public readonly id: string, public readonly name: string) {
          super("Renamed", passedList);
        }
      }

      expect(
        await warningsAsync([new Renamed("an id", "a name")], key)
      ).toEqual([]);
    });

    it("should not be given if there is no static list", async () => {
      class Renamed extends EventBase {
        public static eventType = "Renamed";
      }
      class OldRenamed extends EventBase {
        constructor() {
          super("OldRenamed");
        }
      }

      expect(
        await warningsAsync([new Renamed(), new OldRenamed()], key)
      ).toEqual([]);
    });

    it("should be given once for each event type", async () => {
      class Other extends TypeOnly {
        public static encryptedProps = ["name", "nickname"];

        constructor() {
          super("a name", "Other");
        }
      }

      expect(
        await warningsAsync(
          [new TypeOnly(), new TypeOnly(), new Other(), new TypeOnly()],
          key
        )
      ).toEqual([staticListNotUsed("TypeOnly"), staticListNotUsed("Other")]);
    });
  });

  it("should be given once per process", async () => {
    // arrange
    const create = () => [new Misspelt(), new TypeOnly()];
    const both = [
      nameNotInData("Misspelt", "nmae"),
      staticListNotUsed("TypeOnly"),
    ];
    class OtherRepository extends Repository<TestAggregate> {}

    // act / assert
    expect(await warningsAsync(create(), key)).toEqual(both);

    // for another aggregate, by another repository, with another key
    expect(await warningsAsync(create(), key)).toEqual([]);
    expect(await warningsAsync(create(), "another key")).toEqual([]);

    // by one of another class, with another store
    const other = new OtherRepository(
      new InMemoryEventStore(),
      () => new TestAggregate()
    );
    const ar = new TestAggregate(create());
    warn.mockClear();
    await other.writeAsync(ar, key);
    expect(warn).not.toHaveBeenCalled();

    startProcess();
    expect(await warningsAsync(create(), key)).toEqual(both);
  });

  it("should not be given by a write without a key", async () => {
    const events = [new Misspelt(), new TypeOnly()];

    expect(await warningsAsync(events, undefined)).toEqual([]);
    expect(stored()).toMatchObject([
      { data: { name: "a name" } },
      { data: { name: "a name" } },
    ]);

    // so they are still to be given
    expect(await warningsAsync(events, key)).toEqual([
      nameNotInData("Misspelt", "nmae"),
      staticListNotUsed("TypeOnly"),
    ]);
  });

  it("should be given if the key is an empty string, which is a key too", async () => {
    const events = [new Misspelt(), new TypeOnly()];

    expect(await warningsAsync(events, "")).toEqual([
      nameNotInData("Misspelt", "nmae"),
      staticListNotUsed("TypeOnly"),
    ]);
  });

  it("should not be given by a read", async () => {
    // arrange
    const create = () => new TestAggregate([new Misspelt(), new TypeOnly()]);
    const ar = create();
    await new Repository(store, create).writeAsync(ar, key);
    expect(warn).toHaveBeenCalled();

    // act
    startProcess();
    warn.mockClear();
    await new Repository(store, create).readAsync(ar.id, key);
    await new Repository(store, create).readAsync(ar.id);

    // assert
    expect(warn).not.toHaveBeenCalled();
  });

  it("should not be given for an event that cannot be encrypted", async () => {
    class Renamed extends Right {
      public static eventType = "Renamed";
      public static encryptedProps = ["nmae", "name"];
    }

    await expect(writeAsync([new Renamed(1)], key)).rejects.toThrow(
      'Cannot encrypt encryptedProps field "name": expected a string, got number.'
    );
    expect(append).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("should have no value of an event in them, nor the key", async () => {
    // arrange
    const secrets: string[] = [];
    const newSecret = (): string => {
      const secret = v4();
      secrets.push(secret);
      return secret;
    };
    const logged: unknown[][] = [];
    for (const name of ["debug", "error", "info", "log", "warn"] as const) {
      jest.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const ar = new TestAggregate([
      new Right(newSecret()),
      new Misspelt(newSecret()),
      new Misspelt({ first: newSecret(), list: [newSecret()] }),
      new TypeOnly(newSecret()),
    ]);
    const repo = new Repository(store, () => new TestAggregate());
    logged.length = 0;

    // act
    await repo.writeAsync(ar, newSecret());

    // assert
    const [{ data }] = stored();
    secrets.push(data.name, ar.id, ...stored().map((event) => event.timestamp));
    const text = inspect(logged, {
      depth: Infinity,
      maxStringLength: Infinity,
    });
    expect(logged).toEqual([
      nameNotInData("Misspelt", "nmae"),
      staticListNotUsed("TypeOnly"),
    ]);
    expect(data.name).toEqual(encrypted);
    expect(secrets).toHaveLength(12);
    expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);
  });

  describe("should not fail the write", () => {
    const eventType = "Renamed";
    const timestamp = "2026-01-01T00:00:00.000Z";

    it.each([
      ["is a plain object", () => ({})],
      ["has no prototype", () => Object.create(null)],
      [
        "has a prototype without a constructor",
        () => Object.create(Object.create(null)),
      ],
    ])("of an event that %s", async (_, createObject) => {
      const create = (properties: object): IEvent =>
        Object.assign(createObject(), { eventType, timestamp }, properties);

      expect(
        await warningsAsync(
          [
            create({ name: "a name" }),
            create({ name: "a name", encryptedProps: [] }),
            create({ name: "a name", encryptedProps: ["name"] }),
            create({ name: "a name", encryptedProps: ["nmae"] }),
          ],
          key
        )
      ).toEqual([nameNotInData(eventType, "nmae")]);
      expect(stored().map(({ data }) => data.name)).toEqual([
        "a name",
        "a name",
        encrypted,
        "a name",
      ]);
    });

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["a string", "Constructor Ltd"],
      ["an object that has a list", { encryptedProps: ["name"] }],
    ])(
      "of an event whose property called constructor is %s",
      async (_, constructor) => {
        const plain = { eventType, timestamp, constructor };
        const ofClass = Object.assign(new TypeOnly(), { constructor });

        // it is not taken for the event's class
        expect(await warningsAsync([plain, ofClass], key)).toEqual([
          staticListNotUsed("TypeOnly"),
        ]);
        expect(stored().map(({ data }) => data.constructor)).toEqual([
          constructor,
          constructor,
        ]);
      }
    );

    it("of an event whose class cannot be read", async () => {
      const prototype = Object.defineProperty({}, "constructor", {
        get: () => {
          throw new Error("cannot be read");
        },
      });
      const event = Object.assign(Object.create(prototype), {
        eventType,
        timestamp,
      });

      expect(await warningsAsync([event, new Misspelt()], key)).toEqual([
        nameNotInData("Misspelt", "nmae"),
      ]);
      expect(stored()).toHaveLength(2);
    });

    it("of an event whose static list cannot be read", async () => {
      class Renamed extends EventBase {
        public static get encryptedProps(): string[] {
          throw new Error("cannot be read");
        }

        constructor() {
          super("Renamed");
        }
      }

      expect(await warningsAsync([new Renamed(), new Misspelt()], key)).toEqual(
        [nameNotInData("Misspelt", "nmae")]
      );
      expect(stored()).toHaveLength(2);
    });

    it("of an event whose list has something that cannot be shown", async () => {
      const encryptedProps = [Symbol("name") as unknown as string];
      const event = { eventType, timestamp, encryptedProps };

      expect(await warningsAsync([event, new Misspelt()], key)).toEqual([
        nameNotInData("Misspelt", "nmae"),
      ]);
      expect(stored()).toHaveLength(2);
    });

    it("if the console throws", async () => {
      // arrange
      const events = [new Misspelt(), new TypeOnly(), new Right()];
      warn.mockClear().mockImplementation(() => {
        throw new Error("from the console");
      });

      // act
      await writeAsync(events, key);

      // assert
      expect(warn.mock.calls).toEqual([
        nameNotInData("Misspelt", "nmae"),
        staticListNotUsed("TypeOnly"),
      ]);
      expect(stored()).toMatchObject([
        { eventType: "Misspelt", data: { name: "a name" } },
        { eventType: "TypeOnly", data: { name: "a name" } },
        { eventType: "Right", data: { name: encrypted } },
      ]);
    });
  });
});
