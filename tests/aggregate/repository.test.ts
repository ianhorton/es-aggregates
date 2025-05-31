import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { v4 } from "uuid";

import { Repository } from "../../src";

import { TestAggregateRoot } from "../test-objects";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { Logger, LogLevel } from "@sailplane/logger";

const config = {
  convertEmptyValues: true,
  endpoint: "http://localhost:8000",
  sslEnabled: false,
  region: "local-env",
  credentials: {
    accessKeyId: "fakeMyKeyId",
    secretAccessKey: "fakeSecretAccessKey",
  },
};

Logger.initialize({ level: LogLevel.INFO });

jest.setTimeout(90000);

describe("Repository Tests", () => {
  it("will fail when we try and create more that 100 changes", () => {
    // arrange
    const id = "id";
    const { repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "1");

    // act
    for (let index = 2; index <= 100; index++) {
      ar.changeName(index.toString());
    }

    // assert
    expect(() => ar.changeName("foo")).toThrow();
  });

  // we are going to write 20000 changes to the aggregate
  // this should create more than 1mb of data in dynamo
  // 1mb is the page limit for a dynamo query, so the read
  // operation has to page through many results to rehydrate
  // the aggregate
  it("should handle writing and reading many events", async () => {
    // arrange
    const { ddbc, id, name, ar, repo } = await setupAndExecuteAsync(false);

    // act
    let count = 1;
    for (let i1 = 0; i1 < 200; i1++) {
      for (let i2 = 0; i2 < 100; i2++) {
        ar.changeName(`${count}`);
        count++;
      }
      await repo.writeAsync(ar);
    }

    // act
    // read items from db and ensure we have LastEvaluatedKey as this
    // indicates we have more that one page of results
    const dc = DynamoDBDocumentClient.from(ddbc);
    const { LastEvaluatedKey } = await dc.send(
      new QueryCommand({
        TableName: "test-service-event-dev",
        KeyConditionExpression: "aggregateId = :aggregateId",
        ExpressionAttributeValues: { ":aggregateId": id },
        ConsistentRead: true,
        ScanIndexForward: true,
      })
    );

    // read aggregate from repo to ensure it rehydrates correctly
    const x = await repo.readAsync(id);

    // assert
    expect(LastEvaluatedKey).not.toBeNull();
    expect(x).not.toBeNull();
    expect(x?.name).toBe("20000");
  });

  it("should write events to correct event table", async () => {
    // arrange
    const { ddbc, id, name } = await setupAndExecuteAsync(false);
    const dc = DynamoDBDocumentClient.from(ddbc);

    // act
    const { Item } = await dc.send(
      new GetCommand({
        TableName: "test-service-event-dev",
        Key: { aggregateId: id, aggregateVersion: 0 },
      })
    );

    // assert
    if (Item) {
      expect(Item.aggregateId).toBe(id);
      expect(Item.aggregateVersion).toBe(0);
      expect(Item.data.name).toBe(name);
    } else {
      fail("Event not found in dateabase.");
    }
  });

  it("should write events with encrypted properties when passed a key", async () => {
    // arrange
    const { ddbc, id, name } = await setupAndExecuteAsync(true);
    const dc = DynamoDBDocumentClient.from(ddbc);

    // act
    const { Item } = await dc.send(
      new GetCommand({
        TableName: "test-service-event-dev",
        Key: { aggregateId: id, aggregateVersion: 0 },
      })
    );

    // assert
    if (Item) {
      expect(Item.aggregateId).toBe(id);
      expect(Item.aggregateVersion).toBe(0);
      expect(Item.data.name).not.toBe(name);
    } else {
      fail("Event not found in database.");
    }
  });

  it("should return and AggregateRoot with unencrypted properties", async () => {
    // arrange
    const { repo, id, key, name } = await setupAndExecuteAsync(true);

    // act
    const readAr = await repo.readAsync(id, key);

    // assert
    if (readAr) expect(readAr.name).toBe(name);
    else {
      fail("AggregateRoot not found in database.");
    }
  });

  it("should clear the changed from and AggregateRoot when write is successful", async () => {
    // arrange
    const { ar } = await setupAndExecuteAsync(true);

    // act
    const changes = ar.getChanges();

    // assert
    expect(changes).toHaveLength(0);
  });

  it("should increment the expected version when write is successful", async () => {
    // arrange
    const { ar } = await setupAndExecuteAsync(true);

    // act
    const ev = ar.getExpectedVersion();

    // assert
    expect(ev).toBe(1);
  });

  // this is the situation where we have two copies of the ar in memory and they are being updated at the same time
  // we use the 'expected version' value of the ar to ensure that if there is a version of a an with stale changes in memory
  // somewhere, we cannot over write the current changes with the stale ones.
  it("should fail if the expected version does not match that of the AggregateRoot we are saving", async () => {
    // arrane
    const { id, repo } = await setupAndExecuteAsync(false);

    // act
    // read back two copies of the ar
    const ar1 = await repo.readAsync(id);
    const ar2 = await repo.readAsync(id);

    if (ar1 && ar2) {
      // make a change to both of them
      ar1.changeName("ar1");
      ar2.changeName("ar2");

      // save the first
      await repo.writeAsync(ar1);

      // assert
      // save the second and expect it to fail
      await expect(repo.writeAsync(ar2)).rejects.toThrow();
    }
  });
});

// helper methods
const setupRepoAndDynamoDB = (): {
  ddbc: DynamoDBClient;
  repo: Repository<TestAggregateRoot>;
} => {
  const ddbc = new DynamoDBClient(config);

  const repo = new Repository<TestAggregateRoot>(
    "test-service-event-dev",
    TestAggregateRoot.factory,
    ddbc
    //true
  );

  return {
    ddbc,
    repo,
  };
};

const setupAndExecuteAsync = async (
  encryptProps: boolean
): Promise<{
  id: string;
  ar: TestAggregateRoot;
  name: string;
  key: string;
  ddbc: DynamoDBClient;
  repo: Repository<TestAggregateRoot>;
}> => {
  const id = v4();
  const name = "New AR";
  const key = "key";

  const { ddbc, repo } = setupRepoAndDynamoDB();

  const ar = TestAggregateRoot.create(id, name);

  await repo.writeAsync(ar, encryptProps ? key : undefined);

  return {
    id,
    ar,
    name,
    key,
    ddbc,
    repo,
  };
};
