import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 } from "uuid";
import { Logger, LogLevel } from "@sailplane/logger";

import { Repository, IRepositoryConfig } from "../../src";
import { TestAggregateRoot } from "../test-objects";

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

describe("Repository Snapshot Tests", () => {
  describe("Configuration", () => {
    it("should support legacy constructor format", () => {
      // arrange
      const ddbc = new DynamoDBClient(config);

      // act
      const repo = new Repository<TestAggregateRoot>(
        "test-service-event-dev",
        TestAggregateRoot.factory,
        ddbc
      );

      // assert
      expect(repo).toBeDefined();
    });

    it("should support new config object format", () => {
      // arrange
      const ddbc = new DynamoDBClient(config);
      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
      };

      // act
      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      // assert
      expect(repo).toBeDefined();
    });

    it("should support snapshot configuration", () => {
      // arrange
      const ddbc = new DynamoDBClient(config);
      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 50,
          retention: 5,
        },
      };

      // act
      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      // assert
      expect(repo).toBeDefined();
    });
  });

  describe("Snapshot Creation", () => {
    it("should not create snapshot when disabled", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repo = new Repository<TestAggregateRoot>(
        "test-service-event-dev",
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);

      // Create 100 events (normally would trigger snapshot if enabled)
      for (let i = 0; i < 99; i++) {
        ar.changeName(`Name ${i}`);
      }

      // act
      await repo.writeAsync(ar);

      // assert - check no snapshots exist
      const dc = DynamoDBDocumentClient.from(ddbc);
      const { Items } = await dc.send(
        new QueryCommand({
          TableName: "test-service-event-dev",
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": id,
            ":zero": 0,
          },
        })
      );

      expect(Items).toEqual([]);
      dc.destroy();
    });

    it("should create snapshot at configured frequency", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 10, // Create snapshot every 10 events
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);

      // Create 9 more events (total 10 including creation)
      for (let i = 0; i < 9; i++) {
        ar.changeName(`Name ${i}`);
      }

      // act
      await repo.writeAsync(ar);

      // assert - check snapshot exists at version -1
      const dc = DynamoDBDocumentClient.from(ddbc);
      const { Items } = await dc.send(
        new QueryCommand({
          TableName: "test-service-event-dev",
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": id,
            ":zero": 0,
          },
        })
      );

      expect(Items).toBeDefined();
      expect(Items!.length).toBe(1);
      expect(Items![0].aggregateVersion).toBe(-1);
      expect(Items![0].snapshotAtVersion).toBe(10);
      dc.destroy();
    });

    it("should create multiple snapshots at configured frequency", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 10,
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);

      // Create events in batches to trigger multiple snapshots
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 9; i++) {
          ar.changeName(`Name ${batch * 9 + i}`);
        }
        await repo.writeAsync(ar);

        // Load aggregate to continue
        const loaded = await repo.readAsync(id);
        if (loaded) {
          ar.changeName(`Continue ${batch}`);
        }
      }

      await repo.writeAsync(ar);

      // assert - check multiple snapshots exist
      const dc = DynamoDBDocumentClient.from(ddbc);
      const { Items } = await dc.send(
        new QueryCommand({
          TableName: "test-service-event-dev",
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": id,
            ":zero": 0,
          },
        })
      );

      expect(Items).toBeDefined();
      expect(Items!.length).toBeGreaterThan(1);
      dc.destroy();
    });

    it("should enforce snapshot retention policy", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 10,
          retention: 2, // Keep only 2 snapshots
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);

      // Create enough events to trigger 4 snapshots (40 events total)
      for (let batch = 0; batch < 4; batch++) {
        for (let i = 0; i < 9; i++) {
          ar.changeName(`Name ${batch * 10 + i}`);
        }
        await repo.writeAsync(ar);

        // Load and continue if not last batch
        if (batch < 3) {
          const loaded = await repo.readAsync(id);
          Object.assign(ar, loaded);
        }
      }

      // assert - should have exactly 2 snapshots due to retention policy
      const dc = DynamoDBDocumentClient.from(ddbc);
      const { Items } = await dc.send(
        new QueryCommand({
          TableName: "test-service-event-dev",
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": id,
            ":zero": 0,
          },
        })
      );

      expect(Items).toBeDefined();
      expect(Items!.length).toBeLessThanOrEqual(2);
      dc.destroy();
    });
  });

  describe("Snapshot Loading", () => {
    it("should load aggregate from snapshot", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 10,
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);
      for (let i = 0; i < 9; i++) {
        ar.changeName(`Name ${i}`);
      }
      await repo.writeAsync(ar);

      // act - load from snapshot
      const loaded = await repo.readAsync(id);

      // assert
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe(id);
      expect(loaded!.name).toBe("Name 8");
      expect(loaded!.getExpectedVersion()).toBe(10);
    });

    it("should load snapshot and replay events after it", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 10,
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      // Create aggregate with 10 events (triggers snapshot)
      const ar = TestAggregateRoot.create(id, name);
      for (let i = 0; i < 9; i++) {
        ar.changeName(`Name ${i}`);
      }
      await repo.writeAsync(ar);

      // Add more events after snapshot
      const loaded1 = await repo.readAsync(id);
      loaded1!.changeName("After Snapshot 1");
      loaded1!.changeName("After Snapshot 2");
      await repo.writeAsync(loaded1!);

      // act - load should use snapshot + replay events
      const loaded2 = await repo.readAsync(id);

      // assert
      expect(loaded2).toBeDefined();
      expect(loaded2!.name).toBe("After Snapshot 2");
      expect(loaded2!.getExpectedVersion()).toBe(12);
    });

    it("should fall back to events if no snapshot exists", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 100, // High frequency - won't trigger
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);
      ar.changeName("Version 1");
      await repo.writeAsync(ar);

      // act
      const loaded = await repo.readAsync(id);

      // assert - should load from events
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe("Version 1");
      expect(loaded!.getExpectedVersion()).toBe(2);
    });
  });

  describe("Manual Snapshot Management", () => {
    it("should create manual snapshot", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          autoSnapshot: false, // Disable auto-snapshots
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);
      ar.changeName("Name 1");
      await repo.writeAsync(ar);

      // act - manually create snapshot
      await repo.createManualSnapshotAsync(id);

      // assert
      const dc = DynamoDBDocumentClient.from(ddbc);
      const { Items } = await dc.send(
        new QueryCommand({
          TableName: "test-service-event-dev",
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": id,
            ":zero": 0,
          },
        })
      );

      expect(Items).toBeDefined();
      expect(Items!.length).toBe(1);
      dc.destroy();
    });

    it("should delete all snapshots", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        snapshot: {
          enabled: true,
          frequency: 10,
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      // Create snapshots
      const ar = TestAggregateRoot.create(id, name);
      for (let i = 0; i < 19; i++) {
        ar.changeName(`Name ${i}`);
      }
      await repo.writeAsync(ar);

      // act - delete all snapshots
      await repo.deleteSnapshotsAsync(id);

      // assert
      const dc = DynamoDBDocumentClient.from(ddbc);
      const { Items } = await dc.send(
        new QueryCommand({
          TableName: "test-service-event-dev",
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": id,
            ":zero": 0,
          },
        })
      );

      expect(Items).toBeDefined();
      expect(Items!.length).toBe(0);
      dc.destroy();
    });
  });

  describe("Backwards Compatibility", () => {
    it("should work identically to old behavior when snapshots disabled", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const ddbc = new DynamoDBClient(config);

      // Old way
      const repoOld = new Repository<TestAggregateRoot>(
        "test-service-event-dev",
        TestAggregateRoot.factory,
        ddbc
      );

      // New way with snapshots disabled
      const repoNew = new Repository<TestAggregateRoot>(
        {
          tableName: "test-service-event-dev",
          snapshot: { enabled: false },
        },
        TestAggregateRoot.factory,
        ddbc
      );

      const ar1 = TestAggregateRoot.create(id, name);
      ar1.changeName("Version 1");
      await repoOld.writeAsync(ar1);

      const ar2 = TestAggregateRoot.create(v4(), name);
      ar2.changeName("Version 1");
      await repoNew.writeAsync(ar2);

      // act
      const loaded1 = await repoOld.readAsync(id);
      const loaded2 = await repoNew.readAsync(ar2.id);

      // assert - both should behave identically
      expect(loaded1!.name).toBe("Version 1");
      expect(loaded2!.name).toBe("Version 1");
      expect(loaded1!.getExpectedVersion()).toBe(2);
      expect(loaded2!.getExpectedVersion()).toBe(2);
    });
  });

  describe("Snapshot with Encryption", () => {
    it("should encrypt and decrypt snapshot data", async () => {
      // arrange
      const id = v4();
      const name = "Test Aggregate";
      const encryptionKey = "test-encryption-key-32-bytes!!";
      const ddbc = new DynamoDBClient(config);

      const repoConfig: IRepositoryConfig = {
        tableName: "test-service-event-dev",
        encryptionKey,
        snapshot: {
          enabled: true,
          frequency: 10,
        },
      };

      const repo = new Repository<TestAggregateRoot>(
        repoConfig,
        TestAggregateRoot.factory,
        ddbc
      );

      const ar = TestAggregateRoot.create(id, name);
      for (let i = 0; i < 9; i++) {
        ar.changeName(`Name ${i}`);
      }
      await repo.writeAsync(ar);

      // act - load with encryption
      const loaded = await repo.readAsync(id);

      // assert
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe("Name 8");
    });
  });
});
