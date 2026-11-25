/*
 * Writes golden-1.1.1.json: the raw DynamoDB items that the published
 * es-aggregates 1.1.1 stores, next to the state it reads back from them.
 *
 * To regenerate, with Java on the PATH and this repo's dependencies installed:
 *
 *   npm install --prefix <folder outside this repo> es-aggregates@1.1.1
 *   node tests/fixtures/generate-golden-1.1.1.js <that folder>
 *
 * Every run gets new timestamps and encryption ivs, so only regenerate to add a
 * case. 1.1.1 logs each envelope it cannot decrypt; here that is expected.
 */
"use strict";

const { writeFileSync } = require("fs");
const { createRequire } = require("module");
const { join, resolve } = require("path");

// comes with @shelf/jest-dynamodb
const DynamoDbLocal = require("dynamodb-local");

const VERSION = "1.1.1";
const TABLE_NAME = "golden-events";
const PORT = 8001; // not 8000, which the tests use
const TEST_KEY = "throwaway-test-key";

const [, , folder] = process.argv;
const requireInstalled = createRequire(join(resolve(folder), "package.json"));
const { version } = requireInstalled("es-aggregates/package.json");
if (version !== VERSION) {
  throw new Error(`Expected es-aggregates ${VERSION}, found ${version}.`);
}
const { AggregateRoot, EventBase, Repository } =
  requireInstalled("es-aggregates");

// the AWS SDK that the installed es-aggregates itself uses
const requireSdk = createRequire(requireInstalled.resolve("es-aggregates"));
const {
  CreateTableCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} = requireSdk("@aws-sdk/client-dynamodb");
const { version: sdkVersion } = requireSdk(
  "@aws-sdk/client-dynamodb/package.json"
);

// The events and aggregate below are those in packages/store-tests, in plain
// JavaScript on top of the published package.

class TestAggregateRootCreated extends EventBase {
  static eventType = "TestAggregateRootCreated";
  static encryptedProps = ["name"];

  constructor(id, name) {
    super();
    this.id = id;
    this.name = name;
  }
}

class TestAggregateRootNameChanged extends EventBase {
  static eventType = "TestAggregateRootNameChanged";

  constructor(id, name) {
    super();
    this.id = id;
    this.name = name;
  }
}

class TestDetailsRecorded extends EventBase {
  static eventType = "TestDetailsRecorded";

  constructor(id, details) {
    super();
    this.id = id;
    this.details = details;
  }
}

class TestMessageCreated extends EventBase {
  static eventType = "TestMessageCreated";
  static encryptedProps = ["text", "imageUrl"];

  constructor(id, text, imageUrl) {
    super();
    this.id = id;
    this.text = text;
    this.imageUrl = imageUrl;
  }
}

class TestSecretCreated extends EventBase {
  static eventType = "TestSecretCreated";
  static encryptedProps = ["secret"];

  constructor(id, secret, plain) {
    super();
    this.id = id;
    this.secret = secret;
    this.plain = plain;
  }
}

class TestAggregateRoot extends AggregateRoot {
  static create(id, name) {
    const ar = new TestAggregateRoot();
    ar.applyChange(new TestAggregateRootCreated(id, name));
    return ar;
  }

  constructor() {
    super();

    this.fields = {};
    this.register(TestAggregateRootCreated.eventType, (e) => {
      this.fields.id = e.id;
      this.fields.name = e.name;
      this.fields.created = e.timestamp;
    });
    this.register(TestAggregateRootNameChanged.eventType, (e) => {
      this.fields.name = e.name;
    });
    this.register(TestDetailsRecorded.eventType, (e) => {
      this.fields.details = e.details;
    });
    this.register(TestMessageCreated.eventType, (e) => {
      this.fields.messageText = e.text;
      this.fields.messageImageUrl = e.imageUrl;
    });
    this.register(TestSecretCreated.eventType, (e) => {
      this.fields.secret = e.secret;
      this.fields.plain = e.plain;
    });
  }

  get id() {
    return this.fields.id;
  }

  get state() {
    return { version: this.getExpectedVersion(), ...this.fields };
  }

  changeName(name) {
    this.applyChange(new TestAggregateRootNameChanged(this.id, name));
  }

  recordDetails(details) {
    this.applyChange(new TestDetailsRecorded(this.id, details));
  }

  createMessage(text, imageUrl) {
    this.applyChange(new TestMessageCreated(this.id, text, imageUrl));
  }

  createSecret(secret, plain) {
    this.applyChange(new TestSecretCreated(this.id, secret, plain));
  }
}

class GoldenGenerator {
  constructor() {
    this.client = new DynamoDBClient({
      endpoint: `http://localhost:${PORT}`,
      region: "local-env",
      credentials: {
        accessKeyId: "fakeMyKeyId",
        secretAccessKey: "fakeSecretAccessKey",
      },
      maxAttempts: 10, // DynamoDB Local takes a moment to start
    });
    this.repository = new Repository(
      TABLE_NAME,
      () => new TestAggregateRoot(),
      this.client
    );
  }

  async runAsync() {
    const local = await DynamoDbLocal.launch(PORT);
    try {
      await this.createTableAsync();
      this.save({
        about:
          "Raw DynamoDB items (low-level AttributeValue JSON) stored by the published " +
          "es-aggregates 1.1.1, and the state it reads back from them with and without " +
          "testEncryptionKey. The state is that of TestAggregateRoot in " +
          "generate-golden-1.1.1.js, which wrote this file: an absent field is " +
          "undefined, and version is the aggregate's expected version.",
        writtenBy: {
          "es-aggregates": version,
          "@aws-sdk/client-dynamodb": sdkVersion,
          node: process.version,
        },
        testEncryptionKey: TEST_KEY,
        aggregates: [
          await this.plainEventsAsync(),
          await this.encryptedFieldsAsync(),
          await this.keylessThenKeyedAsync(),
          await this.emptyStringAsync(),
          await this.absentFieldAsync(),
          await this.nullFieldAsync(),
          await this.tamperedEnvelopesAsync(),
        ],
      });
    } finally {
      DynamoDbLocal.stopChild(local);
    }
  }

  save(golden) {
    const json = JSON.stringify(golden, null, 2)
      // keep each {"S": "..."}, {"N": "..."} and so on to one line
      .replace(/\{\s+("[A-Z]+": [^{}[\]\n]+)\s+\}/g, "{ $1 }");
    writeFileSync(join(__dirname, `golden-${VERSION}.json`), `${json}\n`);
  }

  async plainEventsAsync() {
    const id = "golden-plain-events";

    const ar = TestAggregateRoot.create(id, "first name");
    ar.recordDetails({
      text: "Zoë Åström, 東京",
      emptyText: "",
      whole: 3,
      fraction: -1.5,
      yes: true,
      no: false,
      nothing: null,
      list: ["a", undefined, 1, ["nested"], { nested: true }],
      emptyList: [],
      map: { kept: "kept", dropped: undefined },
      emptyMap: {},
    });
    await this.repository.writeAsync(ar);

    ar.changeName("second name");
    ar.changeName("third name");
    await this.repository.writeAsync(ar);

    const readAr = await this.repository.readAsync(id);
    readAr.changeName("fourth name");
    await this.repository.writeAsync(readAr);

    return this.captureAsync("plain events, over three writes", id);
  }

  async encryptedFieldsAsync() {
    const id = "golden-encrypted-fields";

    const ar = TestAggregateRoot.create(id, "Zoë Åström");
    ar.createSecret("a secret", "not declared in encryptedProps");
    await this.repository.writeAsync(ar, TEST_KEY);

    ar.createMessage("こんにちは", "https://example.com/image.png");
    ar.recordDetails({ text: "an event without encryptedProps" });
    await this.repository.writeAsync(ar, TEST_KEY);

    return this.captureAsync("encrypted fields, over two writes", id);
  }

  async keylessThenKeyedAsync() {
    const id = "golden-keyless-then-keyed";

    const ar = TestAggregateRoot.create(id, "name written without a key");
    ar.createSecret("secret written without a key", "plain");
    await this.repository.writeAsync(ar);

    ar.createMessage("text written with the key");
    await this.repository.writeAsync(ar, TEST_KEY);

    return this.captureAsync(
      "events with encryptedProps written without a key, then with it",
      id
    );
  }

  async emptyStringAsync() {
    const id = "golden-empty-string";

    const ar = TestAggregateRoot.create(id, "name");
    ar.createSecret("", "");
    await this.repository.writeAsync(ar, TEST_KEY);

    return this.captureAsync("an encrypted empty string", id);
  }

  async absentFieldAsync() {
    const id = "golden-absent-field";

    const ar = TestAggregateRoot.create(id, "name");
    ar.createMessage("text without an image");
    await this.repository.writeAsync(ar, TEST_KEY);

    return this.captureAsync("an absent field named in encryptedProps", id);
  }

  async nullFieldAsync() {
    const id = "golden-null-field";

    const ar = TestAggregateRoot.create(id, "name");
    ar.createMessage(null, "https://example.com/image.png");
    await this.repository.writeAsync(ar, TEST_KEY);

    return this.captureAsync("a null field named in encryptedProps", id);
  }

  // the name and the imageUrl are left alone, so they still decrypt
  async tamperedEnvelopesAsync() {
    const id = "golden-tampered-envelopes";

    const ar = TestAggregateRoot.create(id, "name");
    ar.createSecret("a secret", "plain");
    ar.createMessage("text", "https://example.com/image.png");
    await this.repository.writeAsync(ar, TEST_KEY);

    // still a well-formed envelope, but the ciphertext is not what was written
    await this.tamperAsync(id, 1, "secret", (parts) => {
      const [first, ...rest] = parts[4];
      parts[4] = [first === "A" ? "B" : "A", ...rest].join("");
      return parts;
    });
    // no longer an envelope: its tag is cut off
    await this.tamperAsync(id, 2, "text", (parts) => parts.slice(0, -1));

    return this.captureAsync(
      "two tampered envelopes: one altered, one cut short",
      id
    );
  }

  async tamperAsync(aggregateId, aggregateVersion, field, tamper) {
    const item = (await this.itemsAsync(aggregateId))[aggregateVersion];
    const value = item.data.M[field];
    value.S = tamper(value.S.split(".")).join(".");
    await this.client.send(
      new PutItemCommand({ TableName: TABLE_NAME, Item: item })
    );
  }

  async captureAsync(description, aggregateId) {
    const withTestKey = await this.repository.readAsync(aggregateId, TEST_KEY);
    const withoutKey = await this.repository.readAsync(aggregateId);
    return {
      description,
      aggregateId,
      items: await this.itemsAsync(aggregateId),
      expected: {
        withTestKey: withTestKey.state,
        withoutKey: withoutKey.state,
      },
    };
  }

  async itemsAsync(aggregateId) {
    const { Items } = await this.client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "aggregateId = :aggregateId",
        ExpressionAttributeValues: { ":aggregateId": { S: aggregateId } },
        ConsistentRead: true,
      })
    );
    return Items;
  }

  async createTableAsync() {
    await this.client.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "aggregateId", KeyType: "HASH" },
          { AttributeName: "aggregateVersion", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "aggregateId", AttributeType: "S" },
          { AttributeName: "aggregateVersion", AttributeType: "N" },
        ],
      })
    );
  }
}

new GoldenGenerator().runAsync().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
