import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { v4 } from "uuid";

import { Repository } from "../../src";
import { isEncrypted } from "../../src/aggregate/encryption";

import { TestAggregateRoot } from "../test-objects";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
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
      fail("Event not found in database.");
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

  it("persists the faithful encryptedProps marker and envelopes the field (with key)", async () => {
    // arrange
    const { ddbc, id } = await setupAndExecuteAsync(true);
    const dc = DynamoDBDocumentClient.from(ddbc);

    // act
    const { Item } = await dc.send(
      new GetCommand({
        TableName: "test-service-event-dev",
        Key: { aggregateId: id, aggregateVersion: 0 },
      })
    );

    // assert
    // qp-9k9o: encryptedProps is persisted as the FAITHFUL static declaration
    // (scope-only marker); the value itself is a self-describing ENC1 envelope.
    if (Item) {
      expect(Item.encryptedProps).toEqual(["name"]);
      expect(isEncrypted(Item.data.name)).toBe(true);
    } else {
      fail("Event not found in database.");
    }
  });

  it("(f) key absent: writes plaintext + still persists the faithful marker; read does not decrypt", async () => {
    // arrange
    // qp-9k9o: the marker is SCOPE-ONLY, so it is persisted even with no key.
    // The value has no ENC1 sentinel, so the read path passes it through
    // untouched — presence in the marker never means "is encrypted".
    const { ddbc, id, name, key, repo } = await setupAndExecuteAsync(false);
    const dc = DynamoDBDocumentClient.from(ddbc);

    // act
    const { Item } = await dc.send(
      new GetCommand({
        TableName: "test-service-event-dev",
        Key: { aggregateId: id, aggregateVersion: 0 },
      })
    );

    // assert: faithful marker persisted, value plaintext
    if (Item) {
      expect(Item.encryptedProps).toEqual(["name"]);
      expect(isEncrypted(Item.data.name)).toBe(false);
      expect(Item.data.name).toBe(name);
    } else {
      fail("Event not found in database.");
    }

    // read WITH a key: the plaintext value is not an envelope -> not decrypted
    const readAr = await repo.readAsync(id, key);
    expect(readAr?.name).toBe(name);
  });

  it("round-trips an EMPTY-string PII field (empty ciphertext, not the raw envelope)", async () => {
    // arrange
    // Regression: encrypt("") produces an envelope with an empty ciphertext
    // segment; the read path must decrypt it back to "" — not leave the raw
    // "ENC1...." string (silent corruption when a user clears an optional field).
    const id = v4();
    const key = "key";
    const { ddbc, repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "ar");
    ar.createSecret(""); // scoped PII field, empty string

    // act
    await repo.writeAsync(ar, key);

    // the stored value is a real envelope (encrypted at rest), not ""
    const dc = DynamoDBDocumentClient.from(ddbc);
    const { Item } = await dc.send(
      new GetCommand({
        TableName: "test-service-event-dev",
        Key: { aggregateId: id, aggregateVersion: 1 },
      })
    );
    expect(isEncrypted(Item?.data.secret)).toBe(true);

    // read back: decrypts to "" (not the raw envelope)
    const readAr = await repo.readAsync(id, key);
    expect(readAr?.secret).toBe("");
  });

  it("(a) does not touch a NON-PII field even if its value is envelope-shaped (scope)", async () => {
    // arrange
    const id = v4();
    const key = "key";
    const envelopeShaped = "ENC1.aes-256-gcm.kid.aaaa.bbbb.cccc";
    const { repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "ar");
    // secret is PII; plain is NOT declared and carries an envelope-shaped value.
    ar.createSecret("real-secret", envelopeShaped);

    // act
    await repo.writeAsync(ar, key);
    const readAr = await repo.readAsync(id, key);

    // assert
    expect(readAr?.plain).toBe(envelopeShaped); // out of scope -> untouched
    expect(readAr?.secret).toBe("real-secret"); // in scope -> decrypts
  });

  it("(b) passes through a scoped PII field that is envelope-shaped PLAINTEXT (not bricked)", async () => {
    // arrange
    const id = v4();
    const key = "key";
    const shapedPlaintext = "ENC1.aes-256-gcm.kid.aaaa.bbbb.cccc";
    const { repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "ar");
    ar.createSecret(shapedPlaintext); // secret happens to look like an envelope

    // act: write WITHOUT a key (secret stored as plaintext), read WITH a key
    await repo.writeAsync(ar);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const readAr = await repo.readAsync(id, key);
    errorSpy.mockRestore();

    // assert: GCM fails on the fake envelope -> passthrough, not bricked
    expect(readAr?.secret).toBe(shapedPlaintext);
  });

  it("(c) passes through a TAMPERED PII ciphertext and logs loudly (integrity)", async () => {
    // arrange
    const id = v4();
    const key = "key";
    const { ddbc, repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "ar");
    ar.createSecret("top-secret");
    await repo.writeAsync(ar, key); // secret -> ENC1 envelope

    // tamper the stored ciphertext segment
    const dc = DynamoDBDocumentClient.from(ddbc);
    const { Item } = await dc.send(
      new GetCommand({
        TableName: "test-service-event-dev",
        Key: { aggregateId: id, aggregateVersion: 1 },
      })
    );
    const parts = (Item!.data.secret as string).split(".");
    parts[4] = parts[4] === "AAAA" ? "BBBB" : "AAAA";
    const tampered = parts.join(".");
    await dc.send(
      new PutCommand({
        TableName: "test-service-event-dev",
        Item: { ...Item, data: { ...Item!.data, secret: tampered } },
      })
    );

    // act
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const readAr = await repo.readAsync(id, key);

    // assert: passthrough (not bricked) + logged loudly
    expect(readAr?.secret).toBe(tampered);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
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
    // arrange
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

  it("should not throw when encrypting an event with an absent allow-listed field", async () => {
    // arrange
    // TestMessageCreated allow-lists both text and imageUrl, but a text-only
    // message leaves imageUrl undefined. encrypt(undefined, key) must not run.
    const id = v4();
    const key = "key";
    const { repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "msg-ar");
    ar.createMessage("hello world");

    // act / assert
    await expect(repo.writeAsync(ar, key)).resolves.not.toThrow();
  });

  it("should not throw when an allow-listed field is null", async () => {
    // arrange
    const id = v4();
    const key = "key";
    const { repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "msg-ar");
    // image-only message: text is explicitly null
    ar.createMessage(null as unknown as undefined, "https://example.com/i.png");

    // act / assert
    await expect(repo.writeAsync(ar, key)).resolves.not.toThrow();
  });

  it("throws at write when an encryptedProps field is not a string (string-only contract)", async () => {
    // arrange
    // qp-9k9o review #1: encryptedProps is a STRING-ONLY contract. A non-string
    // value must fail loudly at write, not be String()-coerced into
    // "[object Object]" and silently persisted.
    const id = v4();
    const key = "key";
    const { repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "msg-ar");
    // "text" is declared PII (encryptedProps) but given a non-string value.
    ar.createMessage({ not: "a string" } as unknown as string);

    // act / assert
    await expect(repo.writeAsync(ar, key)).rejects.toThrow(/expected a string/i);
  });

  it("should round-trip an event with one populated and one absent allow-listed field", async () => {
    // arrange
    const id = v4();
    const key = "key";
    const text = "secret message text";
    const { ddbc, repo } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "msg-ar");
    ar.createMessage(text); // imageUrl absent

    // act
    await repo.writeAsync(ar, key);

    // the populated allow-listed field is encrypted at rest
    const dc = DynamoDBDocumentClient.from(ddbc);
    const { Item } = await dc.send(
      new GetCommand({
        TableName: "test-service-event-dev",
        Key: { aggregateId: id, aggregateVersion: 1 },
      })
    );
    expect(Item?.data.text).not.toBe(text);
    expect(Item?.data.imageUrl).toBeUndefined();

    // read back: present field decrypts, absent stays absent
    const readAr = await repo.readAsync(id, key);

    // assert
    if (readAr) {
      expect(readAr.messageText).toBe(text);
      expect(readAr.messageImageUrl).toBeUndefined();
    } else {
      fail("AggregateRoot not found in database.");
    }
  });

  it("should handle writeAsync with no changes without throwing", async () => {
    // arrange
    const { id, repo } = await setupAndExecuteAsync(false);

    // act
    // read back the aggregate
    const ar = await repo.readAsync(id);

    // assert
    // writing without making changes should not throw
    if (ar) {
      await expect(repo.writeAsync(ar)).resolves.not.toThrow();

      // verify the aggregate still has no uncommitted changes
      expect(ar.getChanges()).toHaveLength(0);
    } else {
      fail("AggregateRoot not found in database.");
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
