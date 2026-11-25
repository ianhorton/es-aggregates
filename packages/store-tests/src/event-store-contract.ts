import {
  ConcurrencyError,
  EventStore,
  IPersistedEvent,
} from "@es-aggregates/core";
import { v4 } from "uuid";

import { RepositoryContract } from "./repository-contract";

/**
 * The tests that every EventStore must pass, by itself and under Repository. A test
 * file in the store's package defines them:
 *
 *   describe("SomeEventStore", () => {
 *     new EventStoreContract(() => new SomeEventStore(client)).define();
 *   });
 *
 * Every test uses ids of its own, so the database can have other events in it.
 */
export class EventStoreContract {
  /**
   * Values that some databases cannot hold. A store must either keep them as they are,
   * or refuse them.
   */
  public static readonly unusual = {
    "a property without a name": { "": 1 },
    "a property called constructor": { constructor: 1 },
    "a property called __proto__": JSON.parse('{"__proto__":{"a":1},"b":2}'),
    "an integer that is not safe": 2 ** 53 + 2,
    "a bigint": BigInt(1),
    "a Map": new Map([["a", 1]]),
    "a Set": new Set(["a"]),
    "a byte array": new Uint8Array([0, 1, 255]),
  };

  /**
   * @param createStore is called for every append and every read, as if each was made
   * by another process. So all the stores that it returns must have the same events
   * @param altered the unusual values that the store is known to alter, though it must
   * not. Their tests must fail, so that this list stays true
   */
  constructor(
    private readonly createStore: () => EventStore,
    private readonly altered: Array<
      keyof typeof EventStoreContract.unusual
    > = []
  ) {}

  public define(): void {
    describe("EventStore contract", () => {
      this.defineReading();
      this.defineOrder();
      this.defineRefusing();
      this.defineClashes();
      this.defineSeparation();
    });

    new RepositoryContract(this.createStore).define();
  }

  private defineReading(): void {
    it("should read an empty array for an unknown aggregate", async () => {
      expect(await this.readAsync(v4())).toStrictEqual([]);
    });

    it.each<[string, unknown]>([
      [
        "texts",
        {
          empty: "",
          spaces: "  a  b  ",
          unicode: "Zoë Åström, 東京 😀, \u00e9 and e\u0301",
          escaped: "\"'\\/\b\f\n\r\t\u0001\u2028\ufeff",
          date: "2026-01-01T00:00:00.000Z",
          number: "1.0",
          json: '{"a":[null]}',
          long: "x".repeat(100000),
        },
      ],
      [
        "numbers",
        {
          zero: 0,
          negative: -1,
          fraction: 0.1 + 0.2,
          negativeFraction: -1.5,
          third: 1 / 3,
          small: 1e-7,
          largestSafe: Number.MAX_SAFE_INTEGER,
          smallestSafe: Number.MIN_SAFE_INTEGER,
        },
      ],
      [
        "objects and arrays",
        {
          list: ["a", 1, null, true, ["b", [2, [false]]], { c: [{ d: 3 }] }],
          emptyList: [],
          emptyLists: [[], [[]], {}, { list: [] }],
          map: { nothing: null, yes: true, no: false, map: { map: { a: 1 } } },
          emptyMap: {},
        },
      ],
      [
        "properties with awkward names",
        this.withNames(
          [" ", "a b", "a.b", ".", "/", "\\", "#", "$", ":", "@", "%", "?"],
          ["*", "[0]", "{}", "'", '"', "`", "\n", "\u0001", "x".repeat(200)],
          ["\u00e9", "e\u0301", "東京", "😀", "0", "10", "9", "-1", "1.5"],
          ["null", "undefined", "true", "NaN", "id", "ID", "_id", "ttl"],
          ["aggregateId", "aggregateVersion", "eventType", "timestamp", "data"],
          ["encryptedProps", "S", "N", "M", "L", "NULL", "length", "prototype"],
          ["toString", "valueOf", "hasOwnProperty", "toJSON", "then", "$ref"]
        ),
      ],
    ])("should read back %s", async (_, data) => {
      // arrange
      const id = v4();
      const events = [
        this.event(id, 0, { data }),
        this.event(id, 1, { data: { list: [data] } }),
      ];

      // act
      await this.appendAsync(events);

      // assert
      expect(await this.readAsync(id)).toStrictEqual(events);
    });

    it("should read back every property of an event", async () => {
      // arrange
      const id = v4();
      const events = [
        this.event(id, 0),
        this.event(id, 1, { eventType: "Été #1/2 😀", timestamp: "noon" }),
        this.event(id, 2, { timestamp: "2026-01-01T01:00:00+01:00" }),
        this.event(id, 3, { encryptedProps: ["text", "a.b"] }),
        this.event(id, 4, { encryptedProps: [] }),
        this.event(id, 5, { data: null }),
        this.event(id, 6, { data: "a text" }),
        this.event(id, 7, { data: 0 }),
        this.event(id, 8, { data: [1, [2]] }),
      ];

      // act
      await this.appendAsync(events);

      // assert
      expect(await this.readAsync(id)).toStrictEqual(events);
    });

    it("should leave out what is undefined, at any depth", async () => {
      // arrange
      const id = v4();
      const data = {
        dropped: undefined,
        map: { kept: 1, dropped: undefined, map: { dropped: undefined } },
        list: [undefined, "a", undefined, null, ["b", undefined], undefined],
        objects: [{ kept: 2, dropped: undefined }, { dropped: undefined }],
        onlyUndefined: [undefined],
      };

      // act
      await this.appendAsync([
        this.event(id, 0, { data, encryptedProps: undefined }),
        this.event(id, 1, { data: undefined }),
      ]);

      // assert
      const { data: _, ...withoutData } = this.event(id, 1);
      expect(await this.readAsync(id)).toStrictEqual([
        this.event(id, 0, {
          data: {
            map: { kept: 1, map: {} },
            list: ["a", null, ["b"]],
            objects: [{ kept: 2 }, {}],
            onlyUndefined: [],
          },
        }),
        withoutData,
      ]);
    });
  }

  private defineOrder(): void {
    it("should read events in the order of their versions, from many appends and pages", async () => {
      // arrange
      // more than a page of most databases: they have 100 or 1000 events, or 1 MB
      const id = v4();
      const versions = this.range(0, 1049);
      const events = versions.map((version) =>
        this.event(id, version, { data: `${version}`.padEnd(1000, "x") })
      );

      // act
      let first = 0;
      for (const count of [1, 8, 2, 89, ...Array(9).fill(100), 50]) {
        await this.appendAsync(events.slice(first, first + count));
        first += count;
      }

      // assert
      const read = await this.readAsync(id);
      expect(read.map((event) => event.aggregateVersion)).toEqual(versions);
      expect(read).toStrictEqual(events);
    });

    it("should read events in the order of their versions, not in the order they were appended", async () => {
      // arrange
      const id = v4();

      // act
      for (const versions of [[100], [8, 9, 10, 11], [2], [98, 99], [0, 1]]) {
        await this.appendAsync(this.events(id, versions));
      }

      // assert
      expect(await this.readAsync(id)).toStrictEqual(
        this.events(id, [0, 1, 2, 8, 9, 10, 11, 98, 99, 100])
      );
    });

    it("should append 100 events at once", async () => {
      // arrange
      // they differ only in their versions
      const id = v4();
      const timestamp = "2026-01-01T00:00:00.000Z";
      const events = this.events(id, this.range(0, 99), {
        timestamp,
        data: {},
      });

      // act
      await this.appendAsync(events);

      // assert
      expect(await this.readAsync(id)).toStrictEqual(events);
    });
  }

  private defineRefusing(): void {
    it.each<[string, unknown]>([
      ["a Date", new Date(0)],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
      ["an instance of a class", new (class Thing {})()],
    ])("should store nothing of an append that has %s", async (_, value) => {
      // arrange
      const id = v4();
      const stored = this.events(id, [0]);
      await this.appendAsync(stored);

      for (const data of [value, { value }, { list: [{ a: [value] }] }]) {
        // act
        const error = await this.rejectionAsync([
          ...this.events(id, this.range(1, 98)),
          this.event(id, 99, { data }),
          this.event(id, 100),
        ]);

        // assert
        expect(error).toBeDefined();
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        expect(await this.readAsync(id)).toStrictEqual(stored);
      }
    });

    for (const [name, value] of Object.entries(EventStoreContract.unusual)) {
      const isAltered = (this.altered as string[]).includes(name);
      const test = isAltered ? it.failing : it;
      const note = isAltered ? ", but is known to alter it" : "";
      test(`should either keep or refuse ${name}${note}`, async () => {
        // arrange
        const id = v4();
        const events = [
          this.event(id, 0),
          this.event(id, 1, { data: { list: [value] } }),
          this.event(id, 2),
        ];

        // act
        const error = await this.rejectionAsync(events);

        // assert
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        expect(await this.readAsync(id)).toStrictEqual(
          error === undefined ? events : []
        );
      });
    }
  }

  private defineClashes(): void {
    it.each([
      ["first", 1],
      ["middle", 50],
      ["last", 100],
    ])(
      "should store nothing of 100 events if their %s version is already stored",
      async (_, takenVersion) => {
        // arrange
        const id = v4();
        const stored = this.events(id, [0, takenVersion]);
        await this.appendAsync(stored.slice(0, 1));
        await this.appendAsync(stored.slice(1));

        // act
        const error = await this.rejectionAsync(
          this.events(id, this.range(1, 100), {
            eventType: "SomethingElseHappened",
            timestamp: "2026-01-02T00:00:00.000Z",
            data: {},
          })
        );

        // assert
        this.expectConcurrencyError(error, id, 1);
        expect(await this.readAsync(id)).toStrictEqual(stored);

        // and the versions after the stored one are still free
        const next = this.events(id, [takenVersion + 1, takenVersion + 2]);
        await this.appendAsync(next);
        expect(await this.readAsync(id)).toStrictEqual([...stored, ...next]);
      }
    );

    it("should store the same append only once", async () => {
      // arrange
      const id = v4();
      const events = this.events(id, [0, 1]);
      await this.appendAsync(events);

      // act
      const error = await this.rejectionAsync(events);

      // assert
      this.expectConcurrencyError(error, id, 0);
      expect(await this.readAsync(id)).toStrictEqual(events);
    });

    it.each<[string, number[]]>([
      ["a new aggregate", []],
      ["an aggregate that has events", [0, 1]],
    ])(
      "should store only one of many appends that are made at once to %s",
      async (_, storedVersions) => {
        // arrange
        const id = v4();
        const stored = this.events(id, storedVersions);
        if (stored.length > 0) {
          await this.appendAsync(stored);
        }
        const next = stored.length;
        const appends = this.range(1, 20).map((writer) =>
          // one, two or three events
          this.events(id, this.range(next, next + (writer % 3)), {
            eventType: `SomethingHappenedTo${writer}`,
            timestamp: new Date(writer).toISOString(),
            data: { writer },
          })
        );

        // act
        const errors = await Promise.all(
          appends.map((events) => this.rejectionAsync(events))
        );

        // assert
        const winners = appends.filter(
          (_, index) => errors[index] === undefined
        );
        expect(winners).toHaveLength(1);
        expect(await this.readAsync(id)).toStrictEqual([
          ...stored,
          ...winners[0],
        ]);
        for (const error of errors.filter((each) => each !== undefined)) {
          this.expectConcurrencyError(error, id, next);
        }
      }
    );
  }

  private defineSeparation(): void {
    it("should keep aggregates apart", async () => {
      // arrange
      // some are equal if case, spaces or the form of unicode do not count. Others have
      // a key in common if a key is an id and then a version: 11 of id, and 1 of id1
      const id = `a-${v4()}`;
      const suffixes = [
        ...["1", "-1", ":1", "/", "/1", "#", "#1", ".", "*", "?", "%2F"],
        ...[" ", " 1", "'", '"', "\\", "\n", "\u00e9", "e\u0301", "東京", "😀"],
      ];
      const ids = [
        id,
        id.slice(0, -1),
        id.toUpperCase(),
        ` ${id}`,
        `["${id}"]`,
        ...suffixes.map((suffix) => id + suffix),
      ];
      const eventsOf = (aggregateId: string) =>
        this.events(aggregateId, this.range(0, 11), {
          data: { of: aggregateId },
        });

      // act
      await Promise.all(ids.map((each) => this.appendAsync(eventsOf(each))));

      // assert
      for (const each of ids) {
        expect(await this.readAsync(each)).toStrictEqual(eventsOf(each));
      }
    });

    it("should share nothing with whoever appends or reads", async () => {
      // arrange
      const id = v4();
      const list = ["appended"];
      await this.appendAsync([this.event(id, 0, { data: { list } })]);

      // act
      list.push("added after the append");
      const [read] = await this.readAsync(id);
      read.data.list.push("added after a read");

      // assert
      expect(await this.readAsync(id)).toStrictEqual([
        this.event(id, 0, { data: { list: ["appended"] } }),
      ]);
    });

    it("should not modify the events that it is given", async () => {
      // arrange
      const id = v4();
      const create = () =>
        this.events(id, [0, 1], {
          encryptedProps: undefined,
          data: { list: [2, undefined, 1], map: { a: undefined, b: {} } },
        });
      const events = create();

      // act
      await this.appendAsync(events);
      await this.rejectionAsync(events);

      // assert
      expect(events).toStrictEqual(create());
    });
  }

  private appendAsync(events: IPersistedEvent[]): Promise<void> {
    const [{ aggregateId, aggregateVersion }] = events;
    return this.createStore().appendAsync(
      aggregateId,
      events,
      aggregateVersion
    );
  }

  // what an append is rejected with, or undefined if it is not rejected
  private rejectionAsync(events: IPersistedEvent[]): Promise<unknown> {
    return this.appendAsync(events).catch((error) => error);
  }

  private readAsync(aggregateId: string): Promise<IPersistedEvent[]> {
    return this.createStore().readAsync(aggregateId);
  }

  private expectConcurrencyError(
    error: unknown,
    aggregateId: string,
    expectedVersion: number
  ): void {
    expect(error).toBeInstanceOf(ConcurrencyError);
    expect(error).toMatchObject({
      name: "ConcurrencyError",
      aggregateId,
      expectedVersion,
    });
    expect((error as ConcurrencyError).cause).toBeTruthy();
  }

  private events(
    aggregateId: string,
    versions: number[],
    properties?: Partial<IPersistedEvent>
  ): IPersistedEvent[] {
    return versions.map((version) =>
      this.event(aggregateId, version, properties)
    );
  }

  // the timestamps go back in time, as they can when writers have different clocks
  private event(
    aggregateId: string,
    aggregateVersion: number,
    properties?: Partial<IPersistedEvent>
  ): IPersistedEvent {
    const timestamp = new Date(Date.UTC(2026, 0, 1) - aggregateVersion * 1000);
    return {
      aggregateId,
      eventType: "SomethingHappened",
      timestamp: timestamp.toISOString(),
      aggregateVersion,
      data: { text: `event ${aggregateVersion}` },
      ...properties,
    };
  }

  // from the first to the last, which is included
  private range(first: number, last: number): number[] {
    return [...Array(last - first + 1).keys()].map((index) => first + index);
  }

  private withNames(...names: string[][]): Record<string, unknown> {
    return Object.fromEntries(
      names.flat().map((name) => [name, { [name]: name }])
    );
  }
}
