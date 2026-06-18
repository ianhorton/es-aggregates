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
import { decrypt, encrypt } from "./encryption";

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

  // Applies f (encrypt/decrypt) to each allow-listed field that is actually
  // present, and reports back exactly which fields it transformed. The caller
  // derives the persisted encryptedProps marker from `transformed`, so the
  // marker can never desync from what was really encrypted (single source of
  // truth — the presence check lives here and nowhere else).
  private changeProps = (
    props: any,
    f: (data: string, key: string) => string,
    encryptionKey?: string,
    encryptedProps?: string[]
  ): { data: {}; transformed: string[] } => {
    if (encryptionKey === undefined) return { data: props, transformed: [] };
    if (encryptedProps === undefined) return { data: props, transformed: [] };

    const transformed: string[] = [];
    for (let index = 0; index < encryptedProps.length; index++) {
      const propertyName = encryptedProps[index];
      const value = props[propertyName];
      // An allow-listed field may be absent on a given event (e.g.
      // MessageCreated lists both text and imageUrl but populates only one).
      // Skip absent fields so encrypt/decrypt is never called with undefined,
      // and keep absent as absent (do NOT coerce to "").
      if (value !== undefined && value !== null) {
        props[propertyName] = f(value, encryptionKey);
        transformed.push(propertyName);
      }
    }
    return { data: props, transformed };
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

      // Stamp the encryptedProps marker from exactly what changeProps actually
      // encrypted. With no key (encryption off) changeProps leaves the data
      // plaintext and reports nothing transformed, so persisting a marker would
      // falsely claim the fields are ciphertext — corrupting the read path (it
      // would run decrypt() on plaintext when rehydrating) and defeating any
      // marker-trusting backfill (it would skip plaintext as "already
      // encrypted"). Plaintext events therefore carry no marker at all. Absent
      // allow-listed fields (e.g. a MessageCreated with text but no imageUrl)
      // are likewise excluded, because changeProps does not transform them.
      const { data, transformed } = this.changeProps(
        otherProps,
        encrypt,
        encryptionKey,
        encryptedProps
      );

      const persistedEvent: IPersistedEvent = {
        aggregateId,
        eventType,
        timestamp,
        aggregateVersion: expectedVersion + index,
        encryptedProps: transformed.length > 0 ? transformed : undefined,
        data,
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
          const { data: decryptedData } = this.changeProps(
            data,
            decrypt,
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
