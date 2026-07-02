import {
  DynamoDBClient,
  Put,
  TransactWriteItem,
  TransactWriteItemsCommand,
  TransactWriteItemsInput,
  TransactWriteItemsOutput,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { Logger, LogLevel } from "@sailplane/logger";

import { IEvent } from "../event/models/event";
import { IPersistedEvent } from "../event/models/persisted-event";
import { AggregateRoot } from "./aggregate-root";
import { decrypt, encrypt, isEncrypted } from "./encryption";

const logger = new Logger("repository");

export interface IRepository<T extends AggregateRoot> {
  readonly readAsync: (
    id: string,
    encryptionKey?: string
  ) => Promise<T | undefined>;

  readonly writeAsync: (aggregate: T, encryptionKey?: string) => Promise<void>;
}

export class Repository<T extends AggregateRoot> implements IRepository<T> {
  constructor(
    private readonly eventTableName: string,
    private readonly activator: () => T,
    private readonly dynamoDBClient: DynamoDBClient,
    readonly debug: boolean = false
  ) {
    logger.level = debug ? LogLevel.DEBUG : LogLevel.NONE;
  }

  public readAsync = async (
    id: string,
    encryptionKey?: string
  ): Promise<T | undefined> => {
    const events = await this.readEventsAsync(id, encryptionKey);

    if (events.length > 0) {
      const aggregate = this.activator();
      aggregate.initialize(events);
      return aggregate;
    }

    return undefined;
  };

  public writeAsync = async (aggregate: T, encryptionKey?: string): Promise<void> => {
    const changes = aggregate.getChanges();
    logger.debug("Changes.", changes);

    if (changes.length === 0) {
      logger.debug("No changes to write for aggregate.", aggregate.id);
      return;
    }

    const expectedVersion = aggregate.getExpectedVersion();
    logger.debug("Expected Version.", expectedVersion);

    const output = await this.transactWriteAsync(
      aggregate.id,
      changes,
      expectedVersion,
      encryptionKey
    );
    logger.debug("Transact Write Items Output.", output);

    aggregate.clearChanges();
  };

  /**
   * Encrypt the write-time-declared PII fields. `encryptedProps` is the STATIC
   * per-event-type declaration of which props carry PII (used only to select
   * fields here). With no key, values are left plaintext — they carry no
   * envelope, so the read path never decrypts them. Returns a new object.
   */
  private encryptData = (
    props: Record<string, unknown>,
    encryptionKey?: string,
    encryptedProps?: string[]
  ): Record<string, unknown> => {
    if (encryptionKey === undefined || encryptedProps === undefined) {
      return props;
    }
    const result: Record<string, unknown> = { ...props };
    for (const propertyName of encryptedProps) {
      const value = result[propertyName];
      // An allow-listed field may be absent on a given event (e.g. a
      // MessageCreated lists both text and imageUrl but populates only one).
      // Skip absent fields so encrypt is never called with undefined, and keep
      // absent as absent (do NOT coerce to "").
      if (value !== undefined && value !== null) {
        result[propertyName] = encrypt(String(value), encryptionKey);
      }
    }
    return result;
  };

  /**
   * Decrypt every field whose VALUE is an encryption envelope — the decision is
   * made from the value itself (self-describing), never from a persisted marker.
   * Plaintext fields pass through untouched. Returns a new object.
   */
  private decryptData = (
    data: Record<string, unknown>,
    encryptionKey?: string
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...data };
    for (const [name, value] of Object.entries(result)) {
      if (isEncrypted(value)) {
        if (encryptionKey === undefined) {
          throw new Error(
            `Encountered an encrypted value for "${name}" but no encryption key was provided`
          );
        }
        result[name] = decrypt(value, encryptionKey);
      }
    }
    return result;
  };

  private transactWriteAsync = async (
    aggregateId: string,
    changes: IEvent[],
    expectedVersion: number,
    encryptionKey?: string
  ): Promise<TransactWriteItemsOutput> => {
    const transactWriteItemList: TransactWriteItem[] = [];

    for (let index = 0; index < changes.length; index++) {
      const event = changes[index];
      const { eventType, timestamp, encryptedProps, ...otherProps } = event;

      // encryptedProps is the STATIC, write-time declaration of which fields
      // carry PII — used only to SELECT fields to encrypt, then discarded. It is
      // deliberately NOT persisted (qp-9k9o): the read path is envelope-based
      // (values self-describe via the ENC1 sentinel), so a persisted marker is
      // unnecessary and — as a per-row field — was dangerous when treated as
      // runtime state (this reverts the qp-qdwt marker stamping).
      const persistedEvent: IPersistedEvent = {
        aggregateId,
        eventType,
        timestamp,
        aggregateVersion: expectedVersion + index,
        data: this.encryptData(
          otherProps as Record<string, unknown>,
          encryptionKey,
          encryptedProps
        ),
      };

      const item = marshall(persistedEvent, { removeUndefinedValues: true });

      const put: Put = {
        TableName: this.eventTableName,
        ConditionExpression: "attribute_not_exists(aggregateVersion)",
        Item: item,
      };

      const transactWriteItem: TransactWriteItem = {
        Put: put,
      };

      transactWriteItemList.push(transactWriteItem);
    }

    const transactWriteItemsInput: TransactWriteItemsInput = {
      TransactItems: transactWriteItemList,
    };

    const command = new TransactWriteItemsCommand(transactWriteItemsInput);
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);
    const response = await documentClient.send(command);

    return response;
  };

  private readEventsAsync = async (
    aggregateId: string,
    encryptionKey?: string
  ): Promise<IEvent[]> => {
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);
    const items: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;

    do {
      const response: QueryCommandOutput = await documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression: "aggregateId = :aggregateId",
          ExpressionAttributeValues: { ":aggregateId": aggregateId },
          ConsistentRead: true,
          ScanIndexForward: true,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      const { Items, LastEvaluatedKey } = response;
      logger.debug("Retrieved Items.", items)
      if (Items) items.push(...Items);
      logger.debug("All Items.", items)
      lastEvaluatedKey = LastEvaluatedKey;
    } while (lastEvaluatedKey);

    documentClient.destroy();

    if (items.length > 0) {
      const events = items.map(({ eventType, timestamp, data }: any) => {
        // Decrypt is driven by the values themselves (ENC1 envelopes), not by a
        // persisted encryptedProps marker (which is no longer written). (qp-9k9o)
        const decryptedData = this.decryptData(data, encryptionKey);

        const event: IEvent = {
          eventType,
          timestamp,
          ...decryptedData,
        };

        return event;
      });
      return events;
    } else {
      const e: IEvent[] = [];
      return e;
    }
  };
}
