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

describe("Repository Tests", () => {
  xit("failing test - will fail when we try and write more than 100 events to dynamo", async () => {
    // arrange
    const id = "id";
    const { repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "1");

    // act
    for (let index = 2; index <= 101; index++) {
      ar.changeName(index.toString());
    }

    // assert
    await expect(repo.writeAsync(ar)).rejects.toThrow();
  });

  xit("should handle writing and reading many events", async () => {
    const { ddbc, id, name, ar, repo } = await setupAndExecuteAsync(false);

    for (let i1 = 0; i1 < 200; i1++) {
      for (let i2 = 0; i2 < 100; i2++) {
        ar.changeName(`${i1}${i2}`);
      }
      await repo.writeAsync(ar);
    }

    const dc = DynamoDBDocumentClient.from(ddbc);

    const command = new QueryCommand({
      TableName: "test-service-event-dev",
      KeyConditionExpression: "aggregateId = :aggregateId",
      ExpressionAttributeValues: { ":aggregateId": id },
      ConsistentRead: true,
      ScanIndexForward: true,
    });

    const { Items } = await dc.send(command);

    if (Items) {
      expect(Items.length).toBe(5542);
    } else {
      fail("Event not found in database.");
    }

    const x = await repo.readAsync(id);
    console.log(x?.name);
  });

  it("should write events to correct event table", async () => {
    const { ddbc, id, name } = await setupAndExecuteAsync(false);

    const dc = DynamoDBDocumentClient.from(ddbc);

    const command = new GetCommand({
      TableName: "test-service-event-dev",
      Key: { aggregateId: id, aggregateVersion: 0 },
    });

    const { Item } = await dc.send(command);

    if (Item) {
      expect(Item.aggregateId).toBe(id);
      expect(Item.aggregateVersion).toBe(0);
      expect(Item.data.name).toBe(name);
    } else {
      fail("Event not found in dateabase.");
    }
  });

  it("should write events with encrypted properties when passed a key", async () => {
    const { ddbc, id, name } = await setupAndExecuteAsync(true);

    const dc = DynamoDBDocumentClient.from(ddbc);

    const command = new GetCommand({
      TableName: "test-service-event-dev",
      Key: { aggregateId: id, aggregateVersion: 0 },
    });

    const { Item } = await dc.send(command);

    if (Item) {
      expect(Item.aggregateId).toBe(id);
      expect(Item.aggregateVersion).toBe(0);
      expect(Item.data.name).not.toBe(name);
    } else {
      fail("Event not found in database.");
    }
  });

  it("should return and AggregateRoot with unencrypted properties", async () => {
    const { repo, id, key, name } = await setupAndExecuteAsync(true);

    const readAr = await repo.readAsync(id, key);
    if (readAr) expect(readAr.name).toBe(name);
    else {
      fail("AggregateRoot not found in database.");
    }
  });

  it("should clear the changed from and AggregateRoot when write is successful", async () => {
    const { ar } = await setupAndExecuteAsync(true);

    const changes = ar.getChanges();
    expect(changes).toHaveLength(0);
  });

  it("should increment the expected version when write is successful", async () => {
    const { ar } = await setupAndExecuteAsync(true);

    const ev = ar.getExpectedVersion();
    expect(ev).toBe(1);
  });

  // this is the situation where we have two copies of the ar in memory and they are being updated at the same time
  // we use the 'expected version' value of the ar to ensure that if there is a version of a an with stale changes in memory
  // somewhere, we cannot over write the current changes with the stale ones.
  it("should fail if the expected version does not match that of the AggregateRoot we are saving", async () => {
    const { id, repo } = await setupAndExecuteAsync(false);

    // read back two copies of the ar
    const ar1 = await repo.readAsync(id);
    const ar2 = await repo.readAsync(id);

    if (ar1 && ar2) {
      // make a change to both of them
      ar1.changeName("ar1");
      ar2.changeName("ar2");

      // save the first
      await repo.writeAsync(ar1);

      // save the second and expect it to fail
      await expect(repo.writeAsync(ar2)).rejects.toThrow();
    }
  });
});

const setupRepoAndDynamoDB = (): {
  ddbc: DynamoDBClient;
  repo: Repository<TestAggregateRoot>;
} => {
  const ddbc = new DynamoDBClient(config);

  const repo = new Repository<TestAggregateRoot>(
    "test-service-event-dev",
    TestAggregateRoot.factory,
    ddbc,
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
