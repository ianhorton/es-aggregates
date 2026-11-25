import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { ConcurrencyError, IPersistedEvent } from "@es-aggregates/core";

import { DynamoEventStore } from "../src";

import { Answer, StubbedDynamoDB } from "./test-objects/stubbed-dynamodb";

describe("DynamoEventStore Tests", () => {
  const id = "aggregate id";

  const events: IPersistedEvent[] = [7, 8].map((aggregateVersion) => ({
    aggregateId: id,
    eventType: "SomethingHappened",
    timestamp: "2026-01-01T00:00:00.000Z",
    aggregateVersion,
    data: {},
  }));

  const setup = (...answers: Answer[]) => {
    const dynamo = new StubbedDynamoDB(answers);
    const store = new DynamoEventStore(dynamo.client, "events");
    return { dynamo, store };
  };

  // the second event is the one that is at fault
  const cancelledBecauseOf = (reason: string): Answer => ({
    status: 400,
    body: {
      __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
      Message: `Transaction cancelled, please refer cancellation reasons for specific reasons [None, ${reason}]`,
      CancellationReasons: [
        { Code: "None" },
        { Code: reason, Message: `The message of ${reason}` },
      ],
    },
  });

  const appendAndCatchAsync = (store: DynamoEventStore): Promise<any> =>
    store.appendAsync(id, events, 7).catch((e) => e);

  it("should send the events in one transaction", async () => {
    // arrange
    const { dynamo, store } = setup({ status: 200, body: {} });

    // act
    const result = await store.appendAsync(id, events, 7);

    // assert
    expect(result).toBeUndefined();
    expect(dynamo.requests).toHaveLength(1);
    expect(dynamo.requests[0].operation).toBe("TransactWriteItems");
    expect(JSON.parse(dynamo.requests[0].body).TransactItems).toEqual(
      ["7", "8"].map((version) => ({
        Put: {
          TableName: "events",
          ConditionExpression: "attribute_not_exists(aggregateVersion)",
          Item: {
            aggregateId: { S: id },
            eventType: { S: "SomethingHappened" },
            timestamp: { S: "2026-01-01T00:00:00.000Z" },
            aggregateVersion: { N: version },
            data: { M: {} },
          },
        },
      }))
    );
  });

  // an ongoing transaction is writing the version, or a finished one has written it
  it.each(["TransactionConflict", "ConditionalCheckFailed"])(
    "should reject with a ConcurrencyError when the reason is %s",
    async (reason) => {
      // arrange
      const { dynamo, store } = setup(cancelledBecauseOf(reason));

      // act
      const error = await appendAndCatchAsync(store);

      // assert
      expect(error).toBeInstanceOf(ConcurrencyError);
      expect(error.aggregateId).toBe(id);
      expect(error.expectedVersion).toBe(7);
      expect(error.cause).toBe(dynamo.errors[0]);
      expect(error.cause).toBeInstanceOf(TransactionCanceledException);
      expect(error.cause.CancellationReasons).toMatchObject([
        { Code: "None" },
        { Code: reason },
      ]);
    }
  );

  it.each([
    "ItemCollectionSizeLimitExceeded",
    "ProvisionedThroughputExceeded",
    "ThrottlingError",
    "ValidationError",
  ])("should not change the error when the reason is %s", async (reason) => {
    // arrange
    const { dynamo, store } = setup(cancelledBecauseOf(reason));

    // act
    const error = await appendAndCatchAsync(store);

    // assert
    expect(error).toBe(dynamo.errors[0]);
    expect(error).toBeInstanceOf(TransactionCanceledException);
    expect(error.CancellationReasons).toMatchObject([
      { Code: "None" },
      { Code: reason },
    ]);
  });

  it("should not change a cancellation that gives no reasons", async () => {
    // arrange
    const { dynamo, store } = setup({
      status: 400,
      body: {
        __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
      },
    });

    // act
    const error = await appendAndCatchAsync(store);

    // assert
    expect(error).toBe(dynamo.errors[0]);
    expect(error).toBeInstanceOf(TransactionCanceledException);
  });

  it("should not change an error that is not about the transaction", async () => {
    // arrange
    const { dynamo, store } = setup({
      status: 400,
      body: {
        __type: "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException",
        message: "Requested resource not found",
      },
    });

    // act
    const error = await appendAndCatchAsync(store);

    // assert
    expect(error).toBe(dynamo.errors[0]);
    expect(error.name).toBe("ResourceNotFoundException");
  });

  it("should not change an error that is not from DynamoDB", async () => {
    // arrange
    const socketError = new Error("socket hang up");
    const { store } = setup(socketError);

    // act
    const error = await appendAndCatchAsync(store);

    // assert
    expect(error).toBe(socketError);
  });

  it("should read until there are no more pages", async () => {
    // arrange
    const key = (version: number) => ({
      aggregateId: { S: id },
      aggregateVersion: { N: `${version}` },
    });
    const { dynamo, store } = setup(
      {
        status: 200,
        body: { Items: [key(0), key(1)], LastEvaluatedKey: key(1) },
      },
      { status: 200, body: { Items: [], LastEvaluatedKey: key(2) } },
      { status: 200, body: { Items: [key(3)] } }
    );

    // act
    const result = await store.readAsync(id);

    // assert
    expect(result).toEqual(
      [0, 1, 3].map((aggregateVersion) => ({
        aggregateId: id,
        aggregateVersion,
      }))
    );
    expect(dynamo.requests.map(({ operation }) => operation)).toEqual([
      "Query",
      "Query",
      "Query",
    ]);
    expect(
      dynamo.requests.map(({ body }) => JSON.parse(body).ExclusiveStartKey)
    ).toEqual([undefined, key(1), key(2)]);
  });

  it("should return an empty array when there are no events", async () => {
    // arrange
    const { store } = setup({ status: 200, body: { Items: [] } });

    // act / assert
    expect(await store.readAsync(id)).toEqual([]);
  });

  it("should not change an error from a read", async () => {
    // arrange
    const socketError = new Error("socket hang up");
    const { store } = setup(socketError);

    // act / assert
    await expect(store.readAsync(id)).rejects.toBe(socketError);
  });
});
