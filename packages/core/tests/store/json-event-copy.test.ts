import { runInNewContext } from "node:vm";

import { IPersistedEvent, JsonEventCopy } from "../../src";

describe("JsonEventCopy", () => {
  const event = (data: unknown = { a: 1 }): IPersistedEvent => ({
    aggregateId: "aggregate id",
    eventType: "SomethingHappened",
    timestamp: "2026-01-01T00:00:00.000Z",
    aggregateVersion: 7,
    data,
  });

  const copy = new JsonEventCopy();

  // the copy of an event's data
  const copyOf = (data: unknown): any => copy.of(event(data)).data;

  // the value, with each object in it made without a prototype, as in a copy
  const bare = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(bare);
    }
    if (typeof value === "object" && value !== null) {
      const object = Object.create(null);
      for (const [name, property] of Object.entries(value)) {
        object[name] = bare(property);
      }
      return object;
    }
    return value;
  };

  // what a copy of an event with the data throws
  const errorOf = (data: unknown, by = copy): Error => {
    try {
      by.of(event(data));
    } catch (error) {
      return error as Error;
    }
    throw new Error("Nothing was thrown.");
  };

  describe("what it keeps", () => {
    it("should keep what JSON can hold", () => {
      // arrange
      const data = {
        text: "Zoë Åström, 東京",
        emptyText: "",
        zero: 0,
        negative: -1.5,
        fraction: 0.1 + 0.2,
        big: 2 ** 53 + 2,
        biggest: Number.MAX_VALUE,
        smallest: Number.MIN_VALUE,
        yes: true,
        no: false,
        nothing: null,
        list: ["a", 1, null, ["nested", []], { b: "c" }],
        emptyList: [],
        map: { nested: { deeper: ["deepest"] } },
        emptyMap: {},
        "": "a property without a name",
        "a.b": "a property with a dot in its name",
        toJSON: "not a function",
      };

      // act / assert
      expect(copy.of(event(data))).toStrictEqual(bare(event(data)));
    });

    it("should make objects without a prototype, so that __proto__ is a property like any other", () => {
      // arrange
      const json = '{"__proto__":{"a":1},"b":[{"c":2}]}';

      // act
      const copied = copyOf(JSON.parse(json));

      // assert
      expect(JSON.stringify(copied)).toBe(json);
      expect(Object.getPrototypeOf(copied)).toBeNull();
      expect(Object.keys(copied)).toEqual(["__proto__", "b"]);
      expect(Object.getPrototypeOf(copied["__proto__"])).toBeNull();
      expect(Object.getPrototypeOf(copied.b[0])).toBeNull();
    });

    it("should keep objects and lists of another vm context, and objects without a prototype", () => {
      // arrange
      const ofAnotherContext = runInNewContext(
        '({ b: { c: [2, { d: "e" }] } })'
      );
      expect(ofAnotherContext).not.toBeInstanceOf(Object);
      expect(ofAnotherContext.b.c).not.toBeInstanceOf(Array);
      const withoutPrototype = Object.assign(Object.create(null), {
        a: 1,
        nested: Object.create(null),
      });

      // act
      const copied = copyOf({ ofAnotherContext, withoutPrototype });

      // assert
      expect(copied).toStrictEqual(
        bare({
          ofAnotherContext: { b: { c: [2, { d: "e" }] } },
          withoutPrototype: { a: 1, nested: {} },
        })
      );
      expect(copied.ofAnotherContext.b.c).toBeInstanceOf(Array);
    });

    it("should keep -0, which JSON writes as 0", () => {
      // act
      const copied = copyOf([-0, 0]);

      // assert
      expect(copied).toStrictEqual([-0, 0]);
      expect(JSON.stringify(copied)).toBe("[0,0]");
    });

    it("should keep every string and property name when it is given no checks", () => {
      // arrange
      const data = { "a\u0000b": "c\u0000d", "\ud800": ["\udc00"] };

      // act / assert
      expect(copyOf(data)).toStrictEqual(bare(data));
    });
  });

  describe("what it leaves out", () => {
    it("should leave out undefined values, at any depth", () => {
      expect(
        copyOf({
          dropped: undefined,
          map: { kept: 1, dropped: undefined, nested: { a: undefined } },
          list: [undefined, "a", undefined, ["b", undefined], undefined],
          objects: [{ kept: 1, dropped: undefined }, undefined],
          onlyUndefined: [undefined],
          holes: [, 1, , 2],
        })
      ).toStrictEqual(
        bare({
          map: { kept: 1, nested: {} },
          list: ["a", ["b"]],
          objects: [{ kept: 1 }],
          onlyUndefined: [],
          holes: [1, 2],
        })
      );
    });

    it("should leave out the event's own properties that are undefined", () => {
      // arrange
      const withUndefined = { ...event(), encryptedProps: undefined };

      // act / assert
      expect(Object.keys(copy.of(withUndefined))).toEqual([
        "aggregateId",
        "eventType",
        "timestamp",
        "aggregateVersion",
        "data",
      ]);
    });

    it("should leave out properties that are functions, and those with a symbol for a name", () => {
      expect(
        copyOf({
          kept: 1,
          method: () => "dropped",
          map: { toJSON: () => "must not be called", kept: 2 },
          [Symbol("dropped")]: 3,
        })
      ).toStrictEqual(bare({ kept: 1, map: { kept: 2 } }));
    });
  });

  describe("what it refuses", () => {
    class Thing {
      public readonly a = 1;
    }

    class ThingWithJson {
      public toJSON = () => "JSON";
    }

    class Things extends Array {}

    const refused: Array<[string, unknown, string]> = [
      ["a date", new Date(0), "an instance of Date"],
      ["an invalid date", new Date(NaN), "an instance of Date"],
      [
        "a date of another vm context",
        runInNewContext("new Date(0)"),
        "an instance of Date",
      ],
      ["a map", new Map([["a", 1]]), "an instance of Map"],
      ["a set", new Set([1]), "an instance of Set"],
      ["an empty set", new Set(), "an instance of Set"],
      ["a buffer", Buffer.from("a"), "an instance of Buffer"],
      ["a byte array", new Uint8Array([1]), "an instance of Uint8Array"],
      ["an array buffer", new ArrayBuffer(1), "an instance of ArrayBuffer"],
      [
        "a data view",
        new DataView(new ArrayBuffer(1)),
        "an instance of DataView",
      ],
      ["a float array", new Float64Array([1.5]), "an instance of Float64Array"],
      ["a blob", new Blob(["a"]), "an instance of Blob"],
      ["an instance of a class", new Thing(), "an instance of Thing"],
      [
        "an instance of a class of another vm context",
        runInNewContext("new (class Other {})()"),
        "an instance of Other",
      ],
      [
        "one that has toJSON",
        new ThingWithJson(),
        "an instance of ThingWithJson",
      ],
      ["one of a subclass of Array", new Things(), "an instance of Things"],
      ["one of a class without a name", new (class {})(), "an instance of "],
      [
        "a list without a prototype",
        Object.setPrototypeOf([1], null),
        "an instance of undefined",
      ],
      [
        "an object with inherited properties",
        Object.create({ a: 1 }),
        "an instance of Object",
      ],
      ["a regular expression", /a/, "an instance of RegExp"],
      ["an error", new Error("a"), "an instance of Error"],
      ["a promise", Promise.resolve(1), "an instance of Promise"],
      ["a URL", new URL("https://example.com"), "an instance of URL"],
      ["a boxed number", new Number(1), "an instance of Number"],
      ["a boxed text", new String("a"), "an instance of String"],
      ["a boxed boolean", new Boolean(false), "an instance of Boolean"],
      ["NaN", NaN, "NaN"],
      ["Infinity", Infinity, "Infinity"],
      ["-Infinity", -Infinity, "-Infinity"],
      ["a bigint", BigInt(1), "a bigint"],
      ["a symbol", Symbol("a"), "a symbol"],
    ];

    it.each(refused)("should refuse %s", (_, value, description) => {
      // act
      const error = errorOf({ value });

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        `Cannot store SomethingHappened.data.value, because JSON cannot hold ${description}.`
      );
    });

    it.each(refused)("should refuse %s in a list", (_, value, description) => {
      // act
      const error = errorOf([[1], [2, value]]);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        `Cannot store SomethingHappened.data[1][1], because JSON cannot hold ${description}.`
      );
    });

    it("should name the path to the value", () => {
      // act
      const error = errorOf({
        details: { list: [1, undefined, { "a.b": [{ when: new Date(0) }] }] },
      });

      // assert
      expect(error.message).toBe(
        "Cannot store SomethingHappened.data.details.list[2].a.b[0].when, because JSON cannot hold an instance of Date."
      );
    });

    it.each<[string, Partial<IPersistedEvent>]>([
      ["data", { data: new Date(0) }],
      ["timestamp", { timestamp: new Date(0) as unknown as string }],
      [
        "encryptedProps[1]",
        { encryptedProps: ["a", new Date(0) as unknown as string] },
      ],
    ])("should refuse an event whose %s is a date", (path, properties) => {
      // act / assert
      expect(() => copy.of({ ...event(), ...properties })).toThrow(
        `Cannot store SomethingHappened.${path}, because JSON cannot hold an instance of Date.`
      );
    });

    it("should refuse an event that is itself an instance of a class", () => {
      // arrange
      class PersistedEvent {}

      // act / assert
      expect(() =>
        copy.of(Object.assign(new PersistedEvent(), event()))
      ).toThrow(
        "Cannot store SomethingHappened, because JSON cannot hold an instance of PersistedEvent."
      );
    });

    it("should refuse a function in a list", () => {
      expect(errorOf([1, () => 2]).message).toBe(
        "Cannot store SomethingHappened.data[1], because JSON cannot hold a function."
      );
    });

    it("should refuse a value that contains itself", () => {
      // arrange
      const value: Record<string, unknown> = {};
      value.list = [value];

      // act / assert
      expect(errorOf(value)).toBeInstanceOf(Error);
    });
  });

  describe("what it is given", () => {
    it("should not change the event", () => {
      // arrange
      const data = { list: [1, undefined], map: { a: undefined, b: {} } };
      const given = { ...event(data), encryptedProps: undefined };

      // act
      copy.of(given);

      // assert
      expect(given).toStrictEqual({
        ...event({ list: [1, undefined], map: { a: undefined, b: {} } }),
        encryptedProps: undefined,
      });
    });

    it("should share no object with the event", () => {
      // arrange
      const data = { list: [1, { a: 2 }], map: { b: [3] } };
      const copied = copyOf(data);

      // act
      data.list.push(4);
      data.list[1] = { a: 5 };
      data.map.b.push(6);

      // assert
      expect(copied).toStrictEqual(
        bare({ list: [1, { a: 2 }], map: { b: [3] } })
      );
    });
  });

  describe("the checks", () => {
    it("should check each string that it keeps, with the path to it", () => {
      // arrange
      const checked: string[][] = [];
      const checking = new JsonEventCopy({
        checkString: (value, path) => {
          checked.push([value, path]);
        },
      });

      // act
      checking.of(
        event({
          name: "a",
          list: ["b", ["c"], { d: "e" }, undefined],
          number: 1,
          dropped: undefined,
          method: () => "f",
        })
      );

      // assert
      expect(checked).toEqual([
        ["aggregate id", "SomethingHappened.aggregateId"],
        ["SomethingHappened", "SomethingHappened.eventType"],
        ["2026-01-01T00:00:00.000Z", "SomethingHappened.timestamp"],
        ["a", "SomethingHappened.data.name"],
        ["b", "SomethingHappened.data.list[0]"],
        ["c", "SomethingHappened.data.list[1][0]"],
        ["e", "SomethingHappened.data.list[2].d"],
      ]);
    });

    it("should check the name of each property that it keeps, with the path to its object, before its value", () => {
      // arrange
      const checked: string[] = [];
      const checking = new JsonEventCopy({
        checkString: (value, path) => {
          checked.push(`the string ${value} at ${path}`);
        },
        checkPropertyName: (name, path) => {
          checked.push(`the name ${name} in ${path}`);
        },
      });

      // act
      checking.of(
        event({
          a: "b",
          list: [{ c: 1 }],
          dropped: undefined,
          method: () => "d",
          [Symbol("dropped")]: "e",
        })
      );

      // assert
      expect(checked).toEqual([
        "the name aggregateId in SomethingHappened",
        "the string aggregate id at SomethingHappened.aggregateId",
        "the name eventType in SomethingHappened",
        "the string SomethingHappened at SomethingHappened.eventType",
        "the name timestamp in SomethingHappened",
        "the string 2026-01-01T00:00:00.000Z at SomethingHappened.timestamp",
        "the name aggregateVersion in SomethingHappened",
        "the name data in SomethingHappened",
        "the name a in SomethingHappened.data",
        "the string b at SomethingHappened.data.a",
        "the name list in SomethingHappened.data",
        "the name c in SomethingHappened.data.list[0]",
      ]);
    });

    it("should keep what the checks accept", () => {
      // arrange
      const checking = new JsonEventCopy({
        checkString: () => undefined,
        checkPropertyName: () => undefined,
      });
      const data = { a: "b", list: ["c", { d: null }] };

      // act / assert
      expect(checking.of(event(data))).toStrictEqual(bare(event(data)));
    });

    it("should throw what a check of a string throws, and check nothing after it", () => {
      // arrange
      const refusal = new Error("This string cannot be stored.");
      const checked: string[] = [];
      const checking = new JsonEventCopy({
        checkString: (value) => {
          checked.push(value);
          if (value === "refused") {
            throw refusal;
          }
        },
      });

      // act
      const error = errorOf(
        { a: "fine", b: "refused", c: "not checked" },
        checking
      );

      // assert
      expect(error).toBe(refusal);
      expect(checked).toEqual([
        "aggregate id",
        "SomethingHappened",
        "2026-01-01T00:00:00.000Z",
        "fine",
        "refused",
      ]);
    });

    it("should throw what a check of a name throws, before it copies the value", () => {
      // arrange
      const refusal = new Error("This name cannot be stored.");
      const checking = new JsonEventCopy({
        checkPropertyName: (name) => {
          if (name === "refused") {
            throw refusal;
          }
        },
      });

      // act
      const error = errorOf({ fine: 1, refused: new Date(0) }, checking);

      // assert
      expect(error).toBe(refusal);
    });
  });
});
