import { ConcurrencyError, IPersistedEvent } from "@es-aggregates/core";

import { CosmosEventStore } from "../src";

import { Account, Answer, StubbedCosmos } from "./test-objects/stubbed-cosmos";

describe("CosmosEventStore Tests", () => {
  const id = "aggregate id";

  const event = (
    aggregateVersion: number,
    data: unknown = { version: aggregateVersion }
  ): IPersistedEvent => ({
    aggregateId: id,
    eventType: "SomethingHappened",
    timestamp: "2026-01-01T00:00:00.000Z",
    aggregateVersion,
    data,
  });

  const events = [event(7), event(8), event(9)];

  let cosmos: StubbedCosmos;

  const setupAsync = async (...answers: Answer[]) => {
    cosmos = await StubbedCosmos.startAsync(answers);
    const { container } = cosmos;
    return { container, store: new CosmosEventStore(container) };
  };

  // with an account, the SDK sends some requests again, if they fail
  const setupWithAccountAsync = async (
    account: Account,
    ...answers: Answer[]
  ) => {
    cosmos = await StubbedCosmos.startAsync(answers, account);
    return new CosmosEventStore(cosmos.container);
  };

  // the answer to a request for the account
  const accountWith = (enableMultipleWriteLocations: boolean): Answer => ({
    status: 200,
    body: { id: "account", enableMultipleWriteLocations },
  });

  afterEach(async () => {
    await cosmos.stopAsync();
  });

  describe("appendAsync", () => {
    // a response to a batch, with the status codes of its operations
    const batch = (status: number, ...statusCodes: unknown[]): Answer => ({
      status,
      body: statusCodes.map((statusCode) => ({ statusCode, requestCharge: 1 })),
    });

    const stored = batch(200, 201, 201, 201);

    const appendAndCatchAsync = (store: CosmosEventStore): Promise<any> =>
      store.appendAsync(id, events, 7).catch((e) => e);

    it("should send the events in one transactional batch", async () => {
      // arrange
      const { store } = await setupAsync(stored);

      // act
      const result = await store.appendAsync(id, events, 7);

      // assert
      expect(result).toBeUndefined();
      expect(cosmos.requests).toHaveLength(1);
      const [{ path, headers, body }] = cosmos.requests;
      expect(path).toBe("/dbs/db/colls/events/docs");
      expect(headers).toMatchObject({
        "x-ms-cosmos-is-batch-request": "true",
        "x-ms-cosmos-batch-atomic": "true",
        "x-ms-documentdb-partitionkey": '["aggregate id"]',
      });
      expect(body).toEqual(
        ["7", "8", "9"].map((version) => ({
          operationType: "Create",
          resourceBody: {
            id: version,
            aggregateId: id,
            eventType: "SomethingHappened",
            timestamp: "2026-01-01T00:00:00.000Z",
            aggregateVersion: Number(version),
            data: { version: Number(version) },
          },
        }))
      );
    });

    it("should send as many as 100 events, but no more", async () => {
      // arrange
      const versions = [...Array(101).keys()];
      const { store } = await setupAsync(
        batch(200, ...Array(100).fill(201)),
        batch(200, ...Array(101).fill(201))
      );
      const tooMany = versions.map((version) => event(version));

      // act
      await store.appendAsync(id, tooMany.slice(0, 100), 0);
      const error = await store.appendAsync(id, tooMany, 0).catch((e) => e);

      // assert
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        'Cannot append 101 events to aggregate "aggregate id" at once. The limit is 100.'
      );
      expect(cosmos.requests).toHaveLength(1);
      expect(
        cosmos.requests[0].body.map(({ resourceBody }: any) => resourceBody.id)
      ).toEqual(versions.slice(0, 100).map((version) => `${version}`));
    });

    describe("when a version is already stored, or is being stored", () => {
      it.each([
        [409, 424, 424],
        [424, 409, 424],
        [424, 424, 409],
        [449, 424, 424],
        [424, 449, 424],
        [424, 424, 449],
      ])(
        "should reject with a ConcurrencyError when the operations have %i, %i and %i",
        async (...statusCodes) => {
          // arrange
          const { store } = await setupAsync(batch(207, ...statusCodes));

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.aggregateId).toBe(id);
          expect(error.expectedVersion).toBe(7);
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(error.cause.code).toBe(207);
          expect(error.cause.result).toMatchObject(
            statusCodes.map((statusCode) => ({ statusCode }))
          );
          expect(cosmos.requests).toHaveLength(1);
        }
      );

      it.each<[number, string, Answer]>([
        [409, "a message", { status: 409, body: { message: "It is taken." } }],
        [409, "no body", { status: 409 }],
        [449, "a message", { status: 449, body: { message: "Try again." } }],
        [449, "no body", { status: 449 }],
      ])(
        "should reject with a ConcurrencyError when the SDK throws a %i that has %s",
        async (_, __, answer) => {
          // arrange
          const { store } = await setupAsync(answer);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.aggregateId).toBe(id);
          expect(error.expectedVersion).toBe(7);
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(error.cause.message).toMatch(/^Batch request error: /);
        }
      );

      // what items.batch throws has diagnostics, in all versions of the SDK, and it has
      // the original error as its cause since 4.10.1
      const placesOf = (code: number): Array<[number, string, object]> => [
        [code, "the error", { code }],
        [code, "its cause", { cause: { code } }],
        [
          code,
          "its diagnostics",
          {
            diagnostics: {
              clientSideRequestStatistics: {
                gatewayStatistics: [{ statusCode: 429 }, { statusCode: code }],
              },
            },
          },
        ],
      ];

      it.each([...placesOf(409), ...placesOf(449)])(
        "should reject with a ConcurrencyError when the %i is in %s",
        async (_, __, properties) => {
          // arrange
          const { container, store } = await setupAsync();
          const thrown = Object.assign(new Error("from the SDK"), properties);
          container.items.batch = () => Promise.reject(thrown);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.cause).toBe(thrown);
        }
      );

      it.each([[409], [449]])(
        "should reject with a ConcurrencyError when the batch itself has a %i",
        async (code) => {
          // arrange
          const { container, store } = await setupAsync();
          const response = { code, headers: {} };
          container.items.batch = () => Promise.resolve(response);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.cause).toBe(response);
        }
      );
    });

    describe("when the SDK sends the batch more than once", () => {
      // an account on which the SDK sends a batch again after a 503
      const failover: Account = { enablePerPartitionFailoverBehavior: true };

      const failure = (status: number, substatus?: number): Answer => ({
        status,
        body: { message: "It failed." },
        headers:
          substatus === undefined ? {} : { "x-ms-substatus": `${substatus}` },
      });

      const conflict = batch(207, 409, 424, 424);

      const expectUnknown = (error: any, cause: unknown): void => {
        // an app that catches a ConcurrencyError would make the change a second time
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
        expect(error.message).toBe(
          'It is not known whether the events for aggregate "aggregate id" at version 7 ' +
            "were stored: the SDK sent them more than once, and an earlier attempt may " +
            "have stored them. Read the aggregate again before you retry anything."
        );
        expect(error.cause).toBe(cause);
      };

      it.each<[string, Account, Answer[]]>([
        ["a 503", failover, [failure(503)]],
        ["a 503 and a 429", failover, [failure(503), failure(429)]],
        ["a 429 and a 503", failover, [failure(429), failure(503)]],
        ["a 503 and a 403/3", failover, [failure(503), failure(403, 3)]],
        ["a 403/3 and a 503", failover, [failure(403, 3), failure(503)]],
        ["a 503 that has a substatus", failover, [failure(503, 21006)]],
        ["a 404/1002", {}, [failure(404, 1002)]],
      ])(
        "should not know whether the events were stored, when they conflict after %s",
        async (_, account, failures) => {
          // arrange
          const store = await setupWithAccountAsync(
            account,
            ...failures,
            conflict
          );

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expectUnknown(error, cosmos.outcomes[0]);
          expect(error.cause.code).toBe(207);
          expect(cosmos.requests).toHaveLength(failures.length + 1);
          const [{ body }] = cosmos.requests;
          expect(cosmos.requests.map((r) => r.body)).toEqual(
            Array(failures.length + 1).fill(body)
          );
        }
      );

      it("should not know whether the events were stored, when they conflict after a 503, with multi-region writes", async () => {
        // arrange
        const store = await setupWithAccountAsync(
          { enableMultipleWriteLocations: true },
          failure(503),
          conflict
        );
        // the account cannot be read, or else the append would be refused. That is logged
        cosmos.accountAnswers.push(failure(500));
        const log = jest.spyOn(console, "error").mockImplementation(() => {});

        // act
        const error = await appendAndCatchAsync(store);

        // assert
        log.mockRestore();
        expectUnknown(error, cosmos.outcomes[0]);
        expect(error.cause.code).toBe(207);
        expect(cosmos.requests.map(({ path }) => path)).toEqual([
          "/west/dbs/db/colls/events/docs",
          "/east/dbs/db/colls/events/docs",
        ]);
        expect(cosmos.requests[1].body).toEqual(cosmos.requests[0].body);
      });

      // a 449 can be because the first attempt is not finished yet
      it.each([
        [449, 424, 424],
        [424, 449, 424],
        [424, 424, 449],
      ])(
        "should not know whether the events were stored, when the operations have %i, %i and %i after a 503",
        async (...statusCodes) => {
          // arrange
          const store = await setupWithAccountAsync(
            failover,
            failure(503),
            batch(207, ...statusCodes)
          );

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expectUnknown(error, cosmos.outcomes[0]);
          expect(cosmos.requests).toHaveLength(2);
        }
      );

      it.each<[number, string, Answer]>([
        [409, "a message", { status: 409, body: { message: "It is taken." } }],
        [409, "no body", { status: 409 }],
        [449, "a message", { status: 449, body: { message: "Try again." } }],
        [449, "no body", { status: 449 }],
      ])(
        "should not know whether the events were stored, when the SDK throws a %i that has %s, after a 503",
        async (_, __, answer) => {
          // arrange
          const store = await setupWithAccountAsync(
            failover,
            failure(503),
            answer
          );

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expectUnknown(error, cosmos.outcomes[0]);
          expect(error.cause.message).toMatch(/^Batch request error: /);
          expect(cosmos.requests).toHaveLength(2);
        }
      );

      it("should send the batch to another region after a 503", async () => {
        // arrange
        const store = await setupWithAccountAsync(
          failover,
          failure(503),
          conflict
        );

        // act
        await appendAndCatchAsync(store);

        // assert
        expect(cosmos.requests.map(({ path }) => path)).toEqual([
          "/west/dbs/db/colls/events/docs",
          "/east/dbs/db/colls/events/docs",
        ]);
      });

      it.each<[string, Account, Answer[]]>([
        ["a 429", {}, [failure(429)]],
        ["several 429s", {}, [failure(429), failure(429), failure(429)]],
        ["a 403/3", {}, [failure(403, 3)]],
        ["a 403/3 that moves the partition", failover, [failure(403, 3)]],
        ["a 403/1008", {}, [failure(403, 1008)]],
        ["a 429 and a 403/3", {}, [failure(429), failure(403, 3)]],
      ])(
        "should reject with a ConcurrencyError when the events conflict after %s, which stored nothing",
        async (_, account, failures) => {
          // arrange
          const store = await setupWithAccountAsync(
            account,
            ...failures,
            conflict
          );

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(cosmos.requests).toHaveLength(failures.length + 1);
        }
      );

      it("should reject with a ConcurrencyError when the events are being stored, after a 429", async () => {
        // arrange
        const store = await setupWithAccountAsync(
          {},
          failure(429),
          batch(207, 449, 424, 424)
        );

        // act
        const error = await appendAndCatchAsync(store);

        // assert
        expect(error).toBeInstanceOf(ConcurrencyError);
        expect(error.cause).toBe(cosmos.outcomes[0]);
        expect(cosmos.requests).toHaveLength(2);
      });

      // the first event is not stored, so that attempt stored none of them
      it.each([
        [424, 409, 424],
        [424, 424, 409],
      ])(
        "should reject with a ConcurrencyError when the operations have %i, %i and %i after a 503",
        async (...statusCodes) => {
          // arrange
          const store = await setupWithAccountAsync(
            failover,
            failure(503),
            batch(207, ...statusCodes)
          );

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(ConcurrencyError);
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(cosmos.requests).toHaveLength(2);
        }
      );

      it("should succeed when the last attempt stores the events", async () => {
        // arrange
        const store = await setupWithAccountAsync(
          failover,
          failure(503),
          stored
        );

        // act / assert
        await expect(store.appendAsync(id, events, 7)).resolves.toBeUndefined();
        expect(cosmos.requests).toHaveLength(2);
      });

      it("should not change the error when the last attempt fails, but not because of a conflict", async () => {
        // arrange
        const store = await setupWithAccountAsync(
          failover,
          failure(503),
          failure(503)
        );

        // act
        const error = await appendAndCatchAsync(store);

        // assert
        expect(error).not.toBeInstanceOf(ConcurrencyError);
        expect(error).toBe(cosmos.outcomes[0]);
        expect(cosmos.requests).toHaveLength(2);
      });

      // the SDK sends a batch again after these too, but they are not answers
      const sendError = {
        operationType: "batch",
        statusCode: "REQUEST_SEND_ERROR",
      };
      const notFound = { operationType: "batch", statusCode: "ENOTFOUND" };

      const request = (
        statusCode: number,
        subStatusCode?: number,
        operationType: string | undefined = "batch"
      ) => ({ operationType, statusCode, subStatusCode });

      // the failed attempts, and then the answers, as the SDK's diagnostics list them. They
      // do not have the substatus of a failed attempt, only that of an answer
      const diagnostics: Array<[string, unknown[], unknown[], boolean]> = [
        ["a lost connection", [sendError], [request(207)], false],
        ["a name that is not found", [notFound], [request(207)], false],
        [
          "a lost connection and a 429",
          [sendError, request(429)],
          [request(429), request(207)],
          false,
        ],
        ["a 403", [request(403)], [request(403), request(207)], false],
        [
          "a 403/1014",
          [request(403)],
          [request(403, 1014), request(207)],
          false,
        ],
        ["a 408", [request(408)], [request(408), request(207)], false],
        ["a 500", [request(500)], [request(500), request(207)], false],
        [
          "a 429 that was no answer",
          [request(429)],
          [request(200), request(207)],
          false,
        ],
        [
          "a 503, and a 429 to something else",
          [request(503), request(429, undefined, "read")],
          [request(503), request(429, undefined, "read"), request(207)],
          false,
        ],
        [
          "a 503 to something of which the type is not told",
          [{ statusCode: 503 }],
          [{ statusCode: 503 }, { statusCode: 207 }],
          false,
        ],
        [
          "a 503 to something else",
          [request(503, undefined, "read")],
          [request(503, undefined, "read"), request(207)],
          true,
        ],
        ["a 429", [request(429)], [request(429), request(207)], true],
        ["a 403/3", [request(403)], [request(403, 3), request(207)], true],
        [
          "a 403/1008",
          [request(403)],
          [request(403, 1008), request(207)],
          true,
        ],
        ["nothing", [], [request(207)], true],
      ];

      it.each(diagnostics)(
        "should go by the diagnostics of the response, which have %s",
        async (_, failedAttempts, gatewayStatistics, isConflict) => {
          // arrange
          const { container, store } = await setupAsync();
          const response: any = {
            code: 207,
            result: [409, 424, 424].map((statusCode) => ({ statusCode })),
            diagnostics: {
              clientSideRequestStatistics: {
                retryDiagnostics: { failedAttempts },
                gatewayStatistics,
              },
            },
          };
          container.items.batch = () => Promise.resolve(response);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          if (isConflict) {
            expect(error).toBeInstanceOf(ConcurrencyError);
            expect(error.cause).toBe(response);
          } else {
            expectUnknown(error, response);
          }
        }
      );

      it.each(diagnostics)(
        "should go by the diagnostics of what the SDK throws, which have %s",
        async (_, failedAttempts, gatewayStatistics, isConflict) => {
          // arrange
          const { container, store } = await setupAsync();
          const thrown = Object.assign(new Error("from the SDK"), {
            cause: { code: 409 },
            diagnostics: {
              clientSideRequestStatistics: {
                retryDiagnostics: { failedAttempts },
                gatewayStatistics,
              },
            },
          });
          container.items.batch = () => Promise.reject(thrown);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          if (isConflict) {
            expect(error).toBeInstanceOf(ConcurrencyError);
            expect(error.cause).toBe(thrown);
          } else {
            expectUnknown(error, thrown);
          }
        }
      );

      it.each([
        ["none", undefined],
        ["null", null],
        ["nothing", {}],
        ["no statistics", { clientSideRequestStatistics: {} }],
        [
          "no attempts",
          { clientSideRequestStatistics: { retryDiagnostics: {} } },
        ],
      ])(
        "should reject with a ConcurrencyError when the diagnostics are %s",
        async (_, incomplete) => {
          // arrange
          const { container, store } = await setupAsync();
          const response: any = { code: 409, diagnostics: incomplete };
          container.items.batch = () => Promise.resolve(response);

          // act / assert
          await expect(store.appendAsync(id, events, 7)).rejects.toThrow(
            ConcurrencyError
          );
        }
      );
    });

    describe("when it checks the account", () => {
      // each test here that cannot read the account logs a line
      let log: jest.SpyInstance;

      beforeEach(() => {
        log = jest.spyOn(console, "error").mockImplementation(() => {});
      });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      const lineWith = (cause: string): string =>
        "[es-aggregates] The Cosmos DB account could not be read, so appends go ahead " +
        "unchecked: they are not refused if multi-region writes are enabled for it. " +
        "Check that the CosmosClient may read the account, and that the account has a " +
        "single write region. This is logged only once for each CosmosClient. " +
        `Cause: ${cause}`;

      const expectRefused = (error: any): void => {
        expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
        expect(error.message).toBe(
          'Cannot append events to aggregate "aggregate id", because multi-region writes ' +
            "are enabled for the Cosmos DB account. With them, two regions can store the " +
            "same version, and Cosmos DB then keeps only one of the two events."
        );
      };

      // four stores that share a client, and answers for an append to each
      const setupManyAsync = async () => {
        const { container, store } = await setupAsync(...Array(4).fill(stored));
        const { client } = container.database;
        return [
          store,
          new CosmosEventStore(container),
          new CosmosEventStore(client.database("db").container("others")),
          new CosmosEventStore(client.database("other").container("events")),
        ];
      };

      it("should append when there is a single write region", async () => {
        // arrange
        const { store } = await setupAsync(stored);
        cosmos.accountAnswers.push(accountWith(false));

        // act / assert
        await expect(store.appendAsync(id, events, 7)).resolves.toBeUndefined();
        expect(cosmos.accountRequests).toBe(1);
        expect(cosmos.requests).toHaveLength(1);
        expect(log).not.toHaveBeenCalled();
      });

      it("should send nothing when multi-region writes are enabled", async () => {
        // arrange
        const { store } = await setupAsync(stored);
        cosmos.accountAnswers.push(accountWith(true));

        // act
        const error = await appendAndCatchAsync(store);

        // assert
        expectRefused(error);
        expect(cosmos.accountRequests).toBe(1);
        expect(cosmos.requests).toHaveLength(0);
        expect(log).not.toHaveBeenCalled();
      });

      it("should send nothing when the SDK knows of two write regions", async () => {
        // arrange
        const store = await setupWithAccountAsync(
          { enableMultipleWriteLocations: true },
          stored
        );

        // act
        const error = await appendAndCatchAsync(store);

        // assert
        expectRefused(error);
        expect(cosmos.requests).toHaveLength(0);
        expect(log).not.toHaveBeenCalled();
      });

      it("should ask for the account only once for a client", async () => {
        // arrange
        const stores = await setupManyAsync();
        cosmos.accountAnswers.push(accountWith(false), accountWith(true));

        // act
        for (const store of stores) {
          await store.appendAsync(id, events, 7);
        }

        // assert
        expect(cosmos.accountRequests).toBe(1);
        expect(cosmos.requests).toHaveLength(4);
      });

      it("should not ask again after it has refused the account", async () => {
        // arrange
        const stores = await setupManyAsync();
        cosmos.accountAnswers.push(accountWith(true), accountWith(false));

        // act
        const errors: unknown[] = [];
        for (const store of stores) {
          errors.push(await appendAndCatchAsync(store));
        }

        // assert
        errors.forEach(expectRefused);
        expect(cosmos.accountRequests).toBe(1);
        expect(cosmos.requests).toHaveLength(0);
      });

      it.each([
        ["append", false, 4],
        ["refuse", true, 0],
      ])(
        "should ask only once, and then %s, when several appends begin at once",
        async (_, isRefused, expectedRequests) => {
          // arrange
          const stores = await setupManyAsync();
          cosmos.accountAnswers.push(
            accountWith(isRefused),
            accountWith(!isRefused)
          );

          // act
          const results = await Promise.all(stores.map(appendAndCatchAsync));

          // assert
          results.forEach((result) =>
            isRefused ? expectRefused(result) : expect(result).toBeUndefined()
          );
          expect(cosmos.accountRequests).toBe(1);
          expect(cosmos.requests).toHaveLength(expectedRequests);
        }
      );

      it("should ask for each client's account", async () => {
        // arrange
        const { store } = await setupAsync(stored);
        const other = await StubbedCosmos.startAsync([stored]);
        other.accountAnswers.push(accountWith(true));

        // act
        const result = await appendAndCatchAsync(store);
        const otherResult = await appendAndCatchAsync(
          new CosmosEventStore(other.container)
        );
        await other.stopAsync();

        // assert
        expect(result).toBeUndefined();
        expectRefused(otherResult);
        expect(cosmos.accountRequests).toBe(1);
        expect(other.accountRequests).toBe(1);
        expect(other.requests).toHaveLength(0);
      });

      // what the SDK itself throws, if an answer has no body, is in its own words
      const anyCause = expect.stringMatching(/ Cause: \S/);

      it.each<[string, Answer, unknown]>([
        [
          "a 401",
          { status: 401, body: { message: "The key is wrong." } },
          lineWith("status code 401: The key is wrong."),
        ],
        [
          "a 403",
          { status: 403, body: { message: "It is not allowed." } },
          lineWith("status code 403: It is not allowed."),
        ],
        [
          "a 404",
          { status: 404, body: { message: "There is none." } },
          lineWith("status code 404: There is none."),
        ],
        [
          "a 429",
          { status: 429, body: { message: "There is too much." } },
          lineWith("status code 429: There is too much."),
        ],
        [
          "a 500",
          { status: 500, body: { message: "It broke." } },
          lineWith("status code 500: It broke."),
        ],
        [
          "a 500 without a message",
          { status: 500, body: {} },
          lineWith("status code 500"),
        ],
        ["a 500 that is empty", { status: 500 }, anyCause],
        [
          "a 503",
          { status: 503, body: { message: "It is down." } },
          lineWith("status code 503: It is down."),
        ],
        ["a 200 that is empty", { status: 200 }, anyCause],
        [
          "a message on more than one line",
          {
            status: 403,
            body: { message: "It is not allowed.\r\nActivityId: 1,\n  2.0 " },
          },
          lineWith("status code 403: It is not allowed. ActivityId: 1, 2.0"),
        ],
      ])(
        "should append, log it only the first time, and ask again the next time, when the answer is %s",
        async (_, answer, line) => {
          // arrange
          const { store } = await setupAsync(stored, stored, stored, stored);
          cosmos.accountAnswers.push(answer, answer, accountWith(false));

          // act
          const asked: number[] = [];
          const logged: number[] = [];
          for (let count = 1; count <= 4; count++) {
            await store.appendAsync(id, events, 7);
            asked.push(cosmos.accountRequests);
            logged.push(log.mock.calls.length);
          }

          // assert
          expect(asked).toEqual([1, 2, 3, 3]);
          expect(logged).toEqual([1, 1, 1, 1]);
          expect(log.mock.calls).toEqual([[line]]);
          expect(cosmos.requests).toHaveLength(4);
        }
      );

      // without a response, the SDK rejects, but only after 10 seconds. The others are what
      // it would not do
      it.each<[string, () => any, string]>([
        [
          "rejects",
          () => Promise.reject(new Error("socket hang up")),
          "socket hang up",
        ],
        ["rejects with undefined", () => Promise.reject(undefined), "unknown"],
        ["rejects with null", () => Promise.reject(null), "unknown"],
        [
          "rejects with a string",
          () => Promise.reject("It broke."),
          "It broke.",
        ],
        ["rejects with a number", () => Promise.reject(7), "unknown"],
        ["rejects with an object", () => Promise.reject({}), "unknown"],
        [
          "rejects with an object that has no prototype",
          () => Promise.reject(Object.create(null)),
          "unknown",
        ],
        [
          "rejects with an object that has a status code, but no message",
          () => Promise.reject({ code: 403 }),
          "status code 403",
        ],
        [
          "rejects with a message that is not a string",
          () => Promise.reject({ code: 403, message: { text: "It broke." } }),
          "status code 403",
        ],
        [
          "rejects with an empty message",
          () => Promise.reject(new Error("")),
          "unknown",
        ],
        [
          "throws",
          () => {
            throw new Error("from the SDK");
          },
          "from the SDK",
        ],
        ["returns undefined", () => undefined, "The SDK returned no account."],
        [
          "returns no account",
          () => Promise.resolve({ resource: undefined }),
          "The SDK returned no account.",
        ],
      ])(
        "should append, log it, and ask again the next time, when the SDK %s",
        async (_, getDatabaseAccount, cause) => {
          // arrange
          const { container, store } = await setupAsync(stored);
          jest
            .spyOn(container.database.client, "getDatabaseAccount")
            .mockImplementationOnce(getDatabaseAccount);
          cosmos.accountAnswers.push(accountWith(true));

          // act
          const result = await appendAndCatchAsync(store);
          const nextResult = await appendAndCatchAsync(store);

          // assert
          expect(result).toBeUndefined();
          expectRefused(nextResult);
          expect(log.mock.calls).toEqual([[lineWith(cause)]]);
          expect(cosmos.requests).toHaveLength(1);
        }
      );

      it("should ask only once, and append, when several appends begin at once, but the account cannot be read", async () => {
        // arrange
        const stores = await setupManyAsync();
        cosmos.accountAnswers.push(
          { status: 403, body: { message: "It is not allowed." } },
          accountWith(true)
        );

        // act
        const results = await Promise.all(stores.map(appendAndCatchAsync));
        const asked = cosmos.accountRequests;
        const nextResult = await appendAndCatchAsync(stores[0]);

        // assert
        expect(results).toEqual(Array(4).fill(undefined));
        expect(asked).toBe(1);
        expectRefused(nextResult);
        expect(cosmos.accountRequests).toBe(2);
        expect(cosmos.requests).toHaveLength(4);
        expect(log.mock.calls).toEqual([
          [lineWith("status code 403: It is not allowed.")],
        ]);
      });

      it("should log once for each client that cannot read its account", async () => {
        // arrange
        const { container, store } = await setupAsync(...Array(3).fill(stored));
        const other = await StubbedCosmos.startAsync([stored]);
        const answer = {
          status: 403,
          body: { message: "It is not allowed." },
        };
        cosmos.accountAnswers.push(answer, answer, answer);
        other.accountAnswers.push(answer);

        // act
        await store.appendAsync(id, events, 7);
        await new CosmosEventStore(container).appendAsync(id, events, 7);
        await store.appendAsync(id, events, 7);
        await new CosmosEventStore(other.container).appendAsync(id, events, 7);
        await other.stopAsync();

        // assert
        const line = lineWith("status code 403: It is not allowed.");
        expect(log.mock.calls).toEqual([[line], [line]]);
        expect(cosmos.accountRequests).toBe(3);
        expect(other.accountRequests).toBe(1);
      });

      it("should log neither the endpoint nor the key when the account cannot be reached", async () => {
        // arrange
        const { store } = await setupAsync();
        await cosmos.stopAsync();

        // act
        await appendAndCatchAsync(store);

        // assert
        expect(log.mock.calls).toEqual([[lineWith("ECONNREFUSED")]]);
        const [[line]] = log.mock.calls;
        expect(line).not.toContain(new URL(cosmos.endpoint).host);
        expect(line).not.toContain(StubbedCosmos.key);
      });

      // a message that names the endpoint, and a code that is not a status code, are what
      // the SDK rejects with when there was no answer
      it.each<[string, number | string, string, string]>([
        [
          "an answer",
          403,
          "It is not allowed.",
          "status code 403: It is not allowed.",
        ],
        [
          "a name that is not found",
          "ENOTFOUND",
          "getaddrinfo ENOTFOUND my-account.documents.azure.com",
          "ENOTFOUND",
        ],
        [
          "a connection that is refused",
          "ECONNREFUSED",
          "connect ECONNREFUSED 10.0.0.1:443",
          "ECONNREFUSED",
        ],
        [
          "a wrong certificate",
          "ERR_TLS_CERT_ALTNAME_INVALID",
          "Hostname/IP does not match certificate's altnames: Host: " +
            "my-account.documents.azure.com. is not in the cert's altnames: " +
            "DNS:*.documents.azure.com",
          "ERR_TLS_CERT_ALTNAME_INVALID",
        ],
      ])(
        "should log nothing else of the reason when it is %s",
        async (_, code, message, cause) => {
          // arrange
          const { container, store } = await setupAsync(stored);
          const endpoint = "https://my-account.documents.azure.com:443/";
          const authorization = `type=master&sig=${StubbedCosmos.key}`;
          const reason = Object.assign(new Error(message), {
            code,
            headers: { authorization },
            body: { message, endpoint },
            request: { url: endpoint, headers: { authorization } },
            diagnostics: { clientConfig: { endpoint }, authorization },
          });
          jest
            .spyOn(container.database.client, "getDatabaseAccount")
            .mockRejectedValueOnce(reason);

          // act
          await store.appendAsync(id, events, 7);

          // assert
          expect(log.mock.calls).toEqual([[lineWith(cause)]]);
          const [[line]] = log.mock.calls;
          expect(line).not.toContain("my-account");
          expect(line).not.toContain("10.0.0.1");
          expect(line).not.toContain(StubbedCosmos.key);
          expect(line).not.toContain(id);
        }
      );

      it("should append even if the console cannot log", async () => {
        // arrange
        const { store } = await setupAsync(stored);
        cosmos.accountAnswers.push({ status: 403, body: { message: "No." } });
        log.mockImplementation(() => {
          throw new Error("from the console");
        });

        // act / assert
        await expect(store.appendAsync(id, events, 7)).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledTimes(1);
        expect(cosmos.requests).toHaveLength(1);
      });

      it.each<[string, unknown, IPersistedEvent[]]>([
        ["the id is not a string", 7, events],
        ["there are too many events", id, Array(101).fill(event(7))],
        ["there is a value that is refused", id, [event(7, new Date(0))]],
        ["there is a name that is refused", id, [{ ...event(7), id } as any]],
      ])(
        "should not ask for the account when %s",
        async (_, anyId, refused) => {
          // arrange
          const { store } = await setupAsync(stored);

          // act / assert
          await expect(
            store.appendAsync(anyId as string, refused, 7)
          ).rejects.toThrow();
          expect(cosmos.accountRequests).toBe(0);
          expect(cosmos.requests).toHaveLength(0);
        }
      );
    });

    describe("when the events were not stored, or might not have been", () => {
      it.each<[string, Answer, string]>([
        // the service's reasons
        ["400", batch(207, 400, 424, 424), "207 [400, 424, 424]"],
        ["403", batch(207, 424, 403, 424), "207 [424, 403, 424]"],
        ["404", batch(207, 424, 424, 404), "207 [424, 424, 404]"],
        ["408", batch(207, 408, 424, 424), "207 [408, 424, 424]"],
        ["412", batch(207, 412, 424, 424), "207 [412, 424, 424]"],
        ["413", batch(207, 424, 413, 424), "207 [424, 413, 424]"],
        ["429", batch(207, 424, 429, 424), "207 [424, 429, 424]"],
        ["500", batch(207, 500, 424, 424), "207 [500, 424, 424]"],
        ["503", batch(207, 503, 424, 424), "207 [503, 424, 424]"],
        ["only 424", batch(207, 424, 424, 424), "207 [424, 424, 424]"],
        ["424 in a 200", batch(200, 424, 424, 424), "200 [424, 424, 424]"],
        // operations that were not created
        ["a 200", batch(200, 201, 200, 201), "200 [201, 200, 201]"],
        ["a 202", batch(200, 201, 202, 201), "200 [201, 202, 201]"],
        ["a 204", batch(200, 204, 204, 204), "200 [204, 204, 204]"],
        ["a 304", batch(200, 201, 201, 304), "200 [201, 201, 304]"],
        ["a 0", batch(200, 201, 0, 201), "200 [201, 0, 201]"],
        ["a text", batch(200, 201, "201", 201), "200 [201, 201, 201]"],
        ["no code", batch(200, 201, undefined, 201), "200 [201, , 201]"],
        // results that are missing
        ["no results", batch(200), "200 []"],
        ["a result too few", batch(200, 201, 201), "200 [201, 201]"],
        [
          "one too many",
          batch(200, 201, 201, 201, 201),
          "200 [201, 201, 201, 201]",
        ],
        ["a null", { status: 200, body: [null, null, null] }, "200 [, , ]"],
        ["an object", { status: 200, body: { statusCode: 201 } }, "200 []"],
        ["an empty body", { status: 200 }, "200 []"],
        // batches that were not successful
        ["a 201 batch", batch(201, 201, 201, 201), "201 [201, 201, 201]"],
        ["a 202 batch", batch(202, 201, 201, 201), "202 [201, 201, 201]"],
        ["a 204 batch", { status: 204 }, "204 []"],
        ["a 207 batch", batch(207, 201, 201, 201), "207 [201, 201, 201]"],
        ["a 302 batch", batch(302, 201, 201, 201), "302 [201, 201, 201]"],
        ["a 304 batch", { status: 304 }, "304 []"],
      ])(
        "should reject with the response when it has %s",
        async (_, answer, codes) => {
          // arrange
          const { store } = await setupAsync(answer);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          const [batchCode, operationCodes] = codes.split(/ (?=\[)/);
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          expect(error.message).toBe(
            'Cannot append 3 events to aggregate "aggregate id" at version 7: the batch ' +
              `has status code ${batchCode}, and its operations have ${operationCodes}.`
          );
          expect(error.cause).toBe(cosmos.outcomes[0]);
          expect(error.cause).toHaveProperty("code", Number(batchCode));
          expect(cosmos.requests).toHaveLength(1);
        }
      );

      // the SDK would not return these
      it.each<[string, any, string]>([
        ["is undefined", undefined, "undefined"],
        ["is null", null, "undefined"],
        ["is empty", {}, "undefined"],
        ["has only a code", { code: 200 }, "200"],
        [
          "has only results",
          { result: Array(3).fill({ statusCode: 201 }) },
          "undefined",
        ],
      ])(
        "should reject with the response when it %s",
        async (_, response, code) => {
          // arrange
          const { container, store } = await setupAsync();
          container.items.batch = () => Promise.resolve(response);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          expect(error.message).toContain(
            `the batch has status code ${code}, and its operations have [`
          );
          expect(error.cause).toBe(response);
        }
      );

      it.each<[string, Answer]>([
        ["400", { status: 400, body: { message: "It is wrong." } }],
        ["403", { status: 403, body: { message: "It is full." } }],
        ["404", { status: 404, body: { message: "There is none." } }],
        ["408", { status: 408, body: { message: "It took too long." } }],
        ["412", { status: 412, body: { message: "It has changed." } }],
        ["413", { status: 413, body: { message: "It is too large." } }],
        ["429", { status: 429, body: { message: "There is too much." } }],
        ["500", { status: 500, body: { message: "It broke." } }],
        ["503", { status: 503, body: { message: "It is down." } }],
        ["no message", { status: 500 }],
        ["no response", "hang up"],
      ])(
        "should not change the error when the SDK throws because of %s",
        async (_, answer) => {
          // arrange
          const { store } = await setupAsync(answer);

          // act
          const error = await appendAndCatchAsync(store);

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(ConcurrencyError);
          expect(error).toBe(cosmos.outcomes[0]);
          expect(cosmos.requests).toHaveLength(1);
        }
      );

      it.each([[undefined], [null], ["a text"]])(
        "should not change what is thrown when it is %p",
        async (thrown) => {
          // arrange
          const { container, store } = await setupAsync();
          container.items.batch = () => Promise.reject(thrown);

          // act / assert
          await expect(store.appendAsync(id, events, 7)).rejects.toBe(thrown);
        }
      );
    });

    describe("what it stores", () => {
      // what is sent for an event's data
      const sentForAsync = async (data: unknown) => {
        const { store } = await setupAsync(batch(200, 201));
        await store.appendAsync(id, [event(7, data)], 7);
        return cosmos.requests[0].body[0].resourceBody.data;
      };

      it("should keep what JSON can hold", async () => {
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
          id: "the id of something in the event",
          _ts: "not the _ts of the item",
          toJSON: "not a function",
        };

        // act / assert
        expect(await sentForAsync(data)).toStrictEqual(data);
      });

      it("should keep a property called __proto__", async () => {
        // arrange
        const json = '{"__proto__":{"a":1},"b":2}';

        // act
        const sent = await sentForAsync(JSON.parse(json));

        // assert
        expect(JSON.stringify(sent)).toBe(json);
      });

      it("should keep objects and lists of another realm, and objects without a prototype", async () => {
        // arrange
        const withoutPrototype = Object.assign(Object.create(null), { a: 1 });
        const ofAnotherRealm = structuredClone({ b: { c: [2] } });
        expect(ofAnotherRealm).not.toBeInstanceOf(Object);
        expect(ofAnotherRealm.b.c).not.toBeInstanceOf(Array);

        // act / assert
        expect(
          await sentForAsync({ withoutPrototype, ofAnotherRealm })
        ).toStrictEqual({
          withoutPrototype: { a: 1 },
          ofAnotherRealm: { b: { c: [2] } },
        });
      });

      it("should leave out undefined values, at any depth", async () => {
        expect(
          await sentForAsync({
            dropped: undefined,
            map: { kept: 1, dropped: undefined, nested: { a: undefined } },
            list: [undefined, "a", undefined, ["b", undefined], undefined],
            objects: [{ kept: 1, dropped: undefined }, undefined],
            onlyUndefined: [undefined],
            holes: [, 1, , 2],
          })
        ).toStrictEqual({
          map: { kept: 1, nested: {} },
          list: ["a", ["b"]],
          objects: [{ kept: 1 }],
          onlyUndefined: [],
          holes: [1, 2],
        });
      });

      it("should leave out the event's own properties that are undefined", async () => {
        // arrange
        const { store } = await setupAsync(batch(200, 201));
        const withUndefined = { ...event(7), encryptedProps: undefined };

        // act
        await store.appendAsync(id, [withUndefined], 7);

        // assert
        expect(Object.keys(cosmos.requests[0].body[0].resourceBody)).toEqual([
          "aggregateId",
          "eventType",
          "timestamp",
          "aggregateVersion",
          "data",
          "id",
        ]);
      });

      // as DynamoEventStore does
      it("should leave out properties that are functions, and those with a symbol for a name", async () => {
        expect(
          await sentForAsync({
            kept: 1,
            method: () => "dropped",
            map: { toJSON: () => "must not be called", kept: 2 },
            [Symbol("dropped")]: 3,
          })
        ).toStrictEqual({ kept: 1, map: { kept: 2 } });
      });

      // as DynamoEventStore does
      it("should store 0 for -0", async () => {
        expect(await sentForAsync({ zeros: [-0, 0] })).toStrictEqual({
          zeros: [0, 0],
        });
      });

      it("should store the events as they were when the append began", async () => {
        // arrange
        const { store } = await setupAsync(batch(200, 201));
        const data: Record<string, unknown> = { list: ["before"] };
        const appended = [event(7, data)];

        // act
        const append = store.appendAsync(id, appended, 7);
        (data.list as unknown[]).push("during");
        data.added = "during";
        appended.push(event(8));
        await append;

        // assert
        const { body } = cosmos.requests[0];
        expect(body).toHaveLength(1);
        expect(body[0].resourceBody.data).toEqual({ list: ["before"] });
      });

      it("should not change the events that it is given", async () => {
        // arrange
        const { store } = await setupAsync(batch(200, 201));
        const data = { list: [1, undefined], map: { a: undefined, b: {} } };
        const appended = [{ ...event(7, data), encryptedProps: undefined }];

        // act
        await store.appendAsync(id, appended, 7);

        // assert
        expect(appended).toStrictEqual([
          {
            ...event(7, {
              list: [1, undefined],
              map: { a: undefined, b: {} },
            }),
            encryptedProps: undefined,
          },
        ]);
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
        [
          "a float array",
          new Float64Array([1.5]),
          "an instance of Float64Array",
        ],
        ["a blob", new Blob(["a"]), "an instance of Blob"],
        ["an instance of a class", new Thing(), "an instance of Thing"],
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

      // appends an event that is fine and then this one
      const appendAndCatchAsync = async (refused: IPersistedEvent) => {
        const { store } = await setupAsync(batch(200, 201, 201));
        return store.appendAsync(id, [event(7), refused], 7).catch((e) => e);
      };

      it.each(refused)(
        "should send nothing when there is %s",
        async (_, value, description) => {
          // act
          const error = await appendAndCatchAsync(event(8, { value }));

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe(
            `Cannot store SomethingHappened.data.value, because JSON cannot hold ${description}.`
          );
          expect(cosmos.requests).toHaveLength(0);
        }
      );

      it.each(refused)(
        "should send nothing when there is %s in a list",
        async (_, value, description) => {
          // act
          const error = await appendAndCatchAsync(event(8, [[1], [2, value]]));

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe(
            `Cannot store SomethingHappened.data[1][1], because JSON cannot hold ${description}.`
          );
          expect(cosmos.requests).toHaveLength(0);
        }
      );

      it("should name the path to the value", async () => {
        // act
        const error = await appendAndCatchAsync(
          event(8, {
            details: {
              list: [1, undefined, { "a.b": [{ when: new Date(0) }] }],
            },
          })
        );

        // assert
        expect(error.message).toBe(
          "Cannot store SomethingHappened.data.details.list[2].a.b[0].when, because JSON cannot hold an instance of Date."
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it.each<[string, Partial<IPersistedEvent>]>([
        ["data", { data: new Date(0) }],
        ["timestamp", { timestamp: new Date(0) as unknown as string }],
        [
          "encryptedProps[1]",
          { encryptedProps: ["a", new Date(0) as unknown as string] },
        ],
      ])("should send nothing when %s is a date", async (path, properties) => {
        // act
        const error = await appendAndCatchAsync({ ...event(8), ...properties });

        // assert
        expect(error.message).toBe(
          `Cannot store SomethingHappened.${path}, because JSON cannot hold an instance of Date.`
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it("should send nothing when the event itself is an instance of a class", async () => {
        // arrange
        class PersistedEvent {}

        // act
        const error = await appendAndCatchAsync(
          Object.assign(new PersistedEvent(), event(8))
        );

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(
          "Cannot store SomethingHappened, because JSON cannot hold an instance of PersistedEvent."
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it.each([["id"], ["_ts"], ["_something"]])(
        "should send nothing when the event has a property called %s",
        async (name) => {
          // act
          const error = await appendAndCatchAsync({ ...event(8), [name]: "a" });

          // assert
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toBe(
            `Cannot store SomethingHappened.${name}, because Cosmos DB uses that name.`
          );
          expect(cosmos.requests).toHaveLength(0);
        }
      );

      // as DynamoEventStore does
      it("should send nothing when there is a function in a list", async () => {
        // act
        const error = await appendAndCatchAsync(event(8, [1, () => 2]));

        // assert
        expect(error.message).toBe(
          "Cannot store SomethingHappened.data[1], because JSON cannot hold a function."
        );
        expect(cosmos.requests).toHaveLength(0);
      });

      it("should send nothing when a value contains itself", async () => {
        // arrange
        const value: Record<string, unknown> = {};
        value.list = [value];

        // act
        const error = await appendAndCatchAsync(event(8, value));

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(cosmos.requests).toHaveLength(0);
      });

      it.each([[undefined], [null], [7], [{}]])(
        "should send nothing when the aggregate's id is %p",
        async (notAnId) => {
          // arrange
          const { store } = await setupAsync(stored);

          // act / assert
          await expect(
            store.appendAsync(notAnId as unknown as string, events, 7)
          ).rejects.toThrow("An aggregate's id must be a string");
          expect(cosmos.requests).toHaveLength(0);
        }
      );
    });
  });

  describe("readAsync", () => {
    // an event as Cosmos DB returns it
    const item = (version: number) => ({
      ...event(version),
      id: `${version}`,
      _rid: "AgAAAIEAAAAPAAAAFz0AAAAAAAA=",
      _self: `dbs/db/colls/events/docs/${version}/`,
      _etag: '"1b38a98e-35de-4e19-93fc-f7fc7604774b"',
      _attachments: "attachments/",
      _ts: 1795567861,
      _something: "that Cosmos DB might add some day",
    });

    const page = (versions: number[], continuation?: string): Answer => ({
      status: 200,
      body: {
        _rid: "AgAAAIEAAAA=",
        Documents: versions.map(item),
        _count: versions.length,
      },
      headers: continuation ? { "x-ms-continuation": continuation } : {},
    });

    it("should ask for the aggregate's events in the order of their versions", async () => {
      // arrange
      const { store } = await setupAsync(page([0]));

      // act
      await store.readAsync(id);

      // assert
      expect(cosmos.requests).toHaveLength(1);
      const [{ path, headers, body }] = cosmos.requests;
      expect(path).toBe("/dbs/db/colls/events/docs");
      expect(headers["x-ms-documentdb-partitionkey"]).toBe('["aggregate id"]');
      expect(body).toEqual({
        query:
          "SELECT * FROM c WHERE c.aggregateId = @aggregateId ORDER BY c.aggregateVersion",
        parameters: [{ name: "@aggregateId", value: id }],
      });
    });

    it("should return the events as they were appended", async () => {
      // arrange
      const data = { id: "a", _ts: "b", _self: { _etag: ["c"] } };
      const { store } = await setupAsync({
        status: 200,
        body: {
          Documents: [
            item(0),
            { ...item(1), encryptedProps: ["a"] },
            { ...item(2), data },
          ],
        },
      });

      // act / assert
      expect(await store.readAsync(id)).toStrictEqual([
        event(0),
        { ...event(1), encryptedProps: ["a"] },
        event(2, data),
      ]);
    });

    it("should read until there are no more pages", async () => {
      // arrange
      const { store } = await setupAsync(
        page([0, 1], "after 1"),
        page([], "still after 1"),
        page([2], "after 2"),
        page([3, 4])
      );

      // act
      const result = await store.readAsync(id);

      // assert
      expect(result).toStrictEqual([0, 1, 2, 3, 4].map((v) => event(v)));
      expect(
        cosmos.requests.map(({ headers, body }) => [
          headers["x-ms-continuation"],
          headers["x-ms-documentdb-partitionkey"],
          body.parameters,
        ])
      ).toEqual(
        [undefined, "after 1", "still after 1", "after 2"].map(
          (continuation) => [
            continuation,
            '["aggregate id"]',
            [{ name: "@aggregateId", value: id }],
          ]
        )
      );
    });

    it("should read from the start each time", async () => {
      // arrange
      const { store } = await setupAsync(
        page([0], "after 0"),
        page([1]),
        page([0], "after 0"),
        page([1])
      );

      // act
      const first = await store.readAsync(id);
      const second = await store.readAsync(id);

      // assert
      expect(first).toStrictEqual([event(0), event(1)]);
      expect(second).toStrictEqual(first);
      expect(
        cosmos.requests.map(({ headers }) => headers["x-ms-continuation"])
      ).toEqual([undefined, "after 0", undefined, "after 0"]);
    });

    it("should read when multi-region writes are enabled, and not ask for the account", async () => {
      // arrange
      const { store } = await setupAsync(page([0]), page([0]));
      cosmos.accountAnswers.push(accountWith(true));

      // act
      const read = await store.readAsync(id);
      const asked = cosmos.accountRequests;
      const error = await store.appendAsync(id, events, 7).catch((e) => e);
      const readAfterRefusal = await store.readAsync(id);

      // assert
      expect(read).toStrictEqual([event(0)]);
      expect(asked).toBe(0);
      expect(error.message).toContain("multi-region writes are enabled");
      expect(readAfterRefusal).toStrictEqual([event(0)]);
    });

    it("should return an empty array when there are no events", async () => {
      // arrange
      const { store } = await setupAsync(page([]));

      // act / assert
      expect(await store.readAsync(id)).toEqual([]);
    });

    it.each<[string, Answer[]]>([
      ["the only", []],
      ["the second", [page([0, 1], "after 1")]],
    ])(
      "should not change an error from %s page, and not return the rest",
      async (_, pages) => {
        // arrange
        const { store } = await setupAsync(...pages, {
          status: 403,
          body: { message: "Not allowed." },
        });

        // act
        const error = await store.readAsync(id).catch((e) => e);

        // assert
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ code: 403, message: "Not allowed." });
      }
    );

    it.each([[undefined], [null], [7], [{}]])(
      "should ask for nothing when the aggregate's id is %p",
      async (notAnId) => {
        // arrange
        const { store } = await setupAsync(page([0]));

        // act / assert
        await expect(
          store.readAsync(notAnId as unknown as string)
        ).rejects.toThrow("An aggregate's id must be a string");
        expect(cosmos.requests).toHaveLength(0);
      }
    );
  });
});
