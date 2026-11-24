import {
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { v4 } from "uuid";

import { Repository } from "../../src";
import { encrypt, isEncrypted } from "../../src/aggregate/encryption";

import { LocalEventTable, TestAggregateRoot } from "../test-objects";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { Logger, LogLevel } from "@sailplane/logger";

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
    // read the first page of items from db, to show that it stops part-way
    // through the events
    const dc = DynamoDBDocumentClient.from(ddbc);
    const { Items, LastEvaluatedKey } = await dc.send(
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
    // there are 20001 events (the first created the ar) and the first page does
    // not hold them all, so the repo can only have read the rest from later pages
    const firstPage = Items!.length;
    expect(firstPage).toBeLessThan(20001);
    expect(LastEvaluatedKey).toEqual({
      aggregateId: id,
      aggregateVersion: firstPage - 1,
    });
    expect(x?.getExpectedVersion()).toBe(20001);
    expect(x?.name).toBe("20000");
  });

  it("should return undefined when nothing has been written for the id", async () => {
    // arrange
    const { repo } = setupRepoAndDynamoDB();

    // act
    const withoutKey = await repo.readAsync(v4());
    const withKey = await repo.readAsync(v4(), "key");

    // assert
    expect(withoutKey).toBeUndefined();
    expect(withKey).toBeUndefined();
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

  it("does not decrypt a REAL envelope in a field the row does not list (scope)", async () => {
    // arrange
    // The envelope in (a) is fake: it comes back untouched even if every field is
    // decrypted. This one is made with the key that reads it, so it would decrypt.
    const id = v4();
    const key = "key";
    const envelope = encrypt("must not be decrypted", key);
    const { repo, table } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "ar");
    ar.createSecret("real-secret", envelope); // this row lists secret, not plain
    ar.changeName(envelope); // this row lists nothing (the first row lists name)

    // act
    await repo.writeAsync(ar, key);
    const items = await table.itemsAsync(id);
    const readAr = await repo.readAsync(id, key);

    // assert
    expect(items).toMatchObject([
      { encryptedProps: { L: [{ S: "name" }] } },
      {
        encryptedProps: { L: [{ S: "secret" }] },
        data: { M: { plain: { S: envelope } } },
      },
      { data: { M: { name: { S: envelope } } } },
    ]);
    expect(items[2]).not.toHaveProperty("encryptedProps");

    expect(readAr?.plain).toBe(envelope); // out of scope -> untouched
    expect(readAr?.name).toBe(envelope); // out of scope -> untouched
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
    const { id, name, repo, table } = await setupAndExecuteAsync(false);

    // read back two copies of the ar
    const ar1 = (await repo.readAsync(id))!;
    const ar2 = (await repo.readAsync(id))!;

    // make a change to both of them
    ar1.changeName("ar1");
    ar2.changeName("ar2");

    // act
    // save the first, then the second
    await repo.writeAsync(ar1);
    const error = await repo.writeAsync(ar2).catch((e) => e);

    // assert
    // the second fails with the error from dynamo
    expect(error).toBeInstanceOf(TransactionCanceledException);
    expect(error.name).toBe("TransactionCanceledException");
    expect(error.CancellationReasons).toMatchObject([
      { Code: "ConditionalCheckFailed" },
    ]);

    // it keeps its uncommitted change, at the version it was read at
    expect(ar2.getChanges()).toMatchObject([
      { eventType: "TestAggregateRootNameChanged", name: "ar2" },
    ]);
    expect(ar2.getExpectedVersion()).toBe(1);

    // and nothing it tried to write was stored
    const items = await table.itemsAsync(id);
    expect(items).toMatchObject([
      { aggregateVersion: { N: "0" }, data: { M: { name: { S: name } } } },
      { aggregateVersion: { N: "1" }, data: { M: { name: { S: "ar1" } } } },
    ]);
  });

  it.each([1, 2, 3])(
    "should store none of events 1 to 3 when version %i already exists",
    async (takenVersion) => {
      // arrange
      const { id, repo, table } = await setupAndExecuteAsync(false);
      const ar = (await repo.readAsync(id))!;
      ar.changeName("event 1");
      ar.changeName("event 2");
      ar.changeName("event 3");

      const [created] = await table.itemsAsync(id);
      await table.putAsync({
        ...created,
        aggregateVersion: { N: `${takenVersion}` },
      });
      const before = await table.itemsAsync(id);

      // act
      const error = await repo.writeAsync(ar).catch((e) => e);

      // assert
      // one reason per event: only the taken version is at fault
      expect(error).toBeInstanceOf(TransactionCanceledException);
      expect(error.CancellationReasons).toMatchObject(
        [1, 2, 3].map((version) => ({
          Code: version === takenVersion ? "ConditionalCheckFailed" : "None",
        }))
      );
      expect(await table.itemsAsync(id)).toEqual(before);
      expect(ar.getChanges()).toHaveLength(3);
      expect(ar.getExpectedVersion()).toBe(1);
    }
  );

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

  it("should store a plain event with exactly these attributes and types, dropping undefined values", async () => {
    // arrange
    const id = v4();
    const { repo, table } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "ar");
    ar.recordDetails({
      text: "text",
      emptyText: "",
      whole: 3,
      fraction: 1.5,
      yes: true,
      nothing: null,
      list: ["a", undefined, 1],
      emptyList: [],
      map: { kept: "kept", dropped: undefined },
      emptyMap: {},
      dropped: undefined,
    });
    const { timestamp } = ar.getChanges()[1];

    // act
    await repo.writeAsync(ar);
    const items = await table.itemsAsync(id);

    // assert
    // there is no encryptedProps attribute, because the event declares none
    expect(items[1]).toStrictEqual({
      aggregateId: { S: id },
      aggregateVersion: { N: "1" },
      eventType: { S: "TestDetailsRecorded" },
      timestamp: { S: timestamp },
      data: {
        M: {
          id: { S: id },
          details: {
            M: {
              text: { S: "text" },
              emptyText: { S: "" },
              whole: { N: "3" },
              fraction: { N: "1.5" },
              yes: { BOOL: true },
              nothing: { NULL: true },
              list: { L: [{ S: "a" }, { N: "1" }] },
              emptyList: { L: [] },
              map: { M: { kept: { S: "kept" } } },
              emptyMap: { M: {} },
            },
          },
        },
      },
    });
  });

  it("should store an encrypted event with exactly these attributes and types, dropping undefined values", async () => {
    // arrange
    const id = v4();
    const { repo, table } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "ar");
    ar.createMessage("secret message text"); // imageUrl is undefined
    const { timestamp } = ar.getChanges()[1];

    // act
    await repo.writeAsync(ar, "key");
    const items = await table.itemsAsync(id);

    // assert
    // ENC1.<alg>.<keyId>.<12-byte iv>.<ciphertext>.<16-byte tag>, in base64url
    const envelope =
      /^ENC1\.aes-256-gcm\.[\w-]{12}\.[\w-]{16}\.[\w-]+\.[\w-]{22}$/;
    expect(items[1]).toStrictEqual({
      aggregateId: { S: id },
      aggregateVersion: { N: "1" },
      eventType: { S: "TestMessageCreated" },
      timestamp: { S: timestamp },
      encryptedProps: { L: [{ S: "text" }, { S: "imageUrl" }] },
      data: {
        M: {
          id: { S: id },
          text: { S: expect.stringMatching(envelope) },
        },
      },
    });
  });

  it("should number aggregateVersion contiguously from the expected version", async () => {
    // arrange
    const id = v4();
    const { repo, table } = setupRepoAndDynamoDB();
    const ar = TestAggregateRoot.create(id, "event 0");
    ar.changeName("event 1");
    ar.changeName("event 2");

    // act
    // write the new ar, write to it again, then write to a copy read back
    await repo.writeAsync(ar);
    ar.changeName("event 3");
    ar.changeName("event 4");
    await repo.writeAsync(ar);
    const readAr = (await repo.readAsync(id))!;
    readAr.changeName("event 5");
    await repo.writeAsync(readAr);

    // assert
    expect(await table.itemsAsync(id)).toMatchObject(
      [0, 1, 2, 3, 4, 5].map((version) => ({
        aggregateVersion: { N: `${version}` },
        data: { M: { name: { S: `event ${version}` } } },
      }))
    );
    expect(readAr.getExpectedVersion()).toBe(6);
  });
});

// helper methods
const setupRepoAndDynamoDB = (): {
  ddbc: DynamoDBClient;
  repo: Repository<TestAggregateRoot>;
  table: LocalEventTable;
} => {
  const table = new LocalEventTable();
  const ddbc = table.client;

  const repo = new Repository<TestAggregateRoot>(
    table.name,
    TestAggregateRoot.factory,
    ddbc
    //true
  );

  return {
    ddbc,
    repo,
    table,
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
  table: LocalEventTable;
}> => {
  const id = v4();
  const name = "New AR";
  const key = "key";

  const { ddbc, repo, table } = setupRepoAndDynamoDB();

  const ar = TestAggregateRoot.create(id, name);

  await repo.writeAsync(ar, encryptProps ? key : undefined);

  return {
    id,
    ar,
    name,
    key,
    ddbc,
    repo,
    table,
  };
};
