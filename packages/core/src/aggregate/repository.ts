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
        // encryptedProps is a STRING-ONLY contract. Fail loudly on a non-string
        // rather than String()-coercing (which would silently persist
        // "[object Object]" and read back a corrupted value) — restoring the
        // loud failure the old CBC path gave. (review comment #1)
        if (typeof value !== "string") {
          throw new Error(
            `Cannot encrypt encryptedProps field "${propertyName}": expected a string, got ${typeof value}. ` +
              `Fields declared in an event's encryptedProps must be string-valued.`
          );
        }
        result[propertyName] = encrypt(value, encryptionKey);
      }
    }
    return result;
  };

  /**
   * Decrypt PII fields on read. Two independent gates:
   *
   *  1. SCOPE — only the fields named in the row's `encryptedProps` marker are
   *     inspected at all (the faithful static declaration). Non-PII fields are
   *     never touched, whatever their value → bounded blast radius.
   *  2. SIGNAL — within scope, the ENC1 envelope sentinel on the VALUE decides
   *     decrypt-vs-passthrough. The marker is SCOPE-ONLY: presence in it does NOT
   *     mean "is encrypted" (that would reintroduce the decrypt-on-
   *     plaintext landmine). A plaintext scoped field passes through untouched.
   *
   * A declared-PII envelope that fails to decrypt (GCM auth failure — tampering
   * or wrong key — or a missing key) is passed through UNCHANGED so a bad value
   * cannot brick the whole aggregate, but is logged loudly so genuine tampering
   * surfaces. Availability is chosen over hard-fail; the loud log is the
   * tamper-detection signal.
   */
  private decryptData = (
    data: Record<string, unknown>,
    encryptionKey?: string,
    encryptedProps?: string[]
  ): Record<string, unknown> => {
    if (!encryptedProps || encryptedProps.length === 0) {
      return data;
    }
    const result: Record<string, unknown> = { ...data };
    for (const name of encryptedProps) {
      const value = result[name];
      // SIGNAL: only an actual envelope is decrypted — plaintext passes through.
      if (!isEncrypted(value)) {
        continue;
      }
      try {
        if (encryptionKey === undefined) {
          throw new Error("no encryption key was provided");
        }
        result[name] = decrypt(value, encryptionKey);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Log loudly regardless of the debug logger level — this is a
        // security-relevant event (possible tampering or key mismatch).
        // eslint-disable-next-line no-console
        console.error(
          `[es-aggregates] Failed to decrypt PII field "${name}" — leaving the ` +
            `value as-is to avoid bricking the aggregate. Cause: ${reason}. ` +
            `Investigate: this can indicate tampering or a key mismatch.`
        );
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

      // Persist encryptedProps as a SCOPE-ONLY marker: the FAITHFUL static array
      // exactly as the event declares it — NOT the runtime "what was actually
      // encrypted" runtime version. It bounds which fields the read path
      // inspects; the ENC1 sentinel on each value is the sole is-encrypted
      // signal, so a plaintext (key-less) write still carries the marker but is
      // never decrypted on read.
      const persistedEvent: IPersistedEvent = {
        aggregateId,
        eventType,
        timestamp,
        aggregateVersion: expectedVersion + index,
        encryptedProps,
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
      const events = items.map(
        ({ eventType, timestamp, encryptedProps, data }: any) => {
          // Scope decryption to the row's faithful marker; within it, the ENC1
          // sentinel on each value decides decrypt-vs-passthrough.
          const decryptedData = this.decryptData(
            data,
            encryptionKey,
            encryptedProps
          );

          const event: IEvent = {
            eventType,
            timestamp,
            encryptedProps,
            ...decryptedData,
          };

          return event;
        }
      );
      return events;
    } else {
      const e: IEvent[] = [];
      return e;
    }
  };
}
