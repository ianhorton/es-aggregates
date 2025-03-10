import {
    DynamoDBClient, Put, TransactWriteItem, TransactWriteItemsCommand, TransactWriteItemsInput,
    TransactWriteItemsOutput
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Logger } from '@sailplane/logger';

import { IEvent } from '../event/models/event';
import { IPersistedEvent } from '../event/models/persisted-event';
import { AggregateRoot } from './aggregate-root';
import { decrypt, encrypt } from './encryption';

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
    private eventTableName: string,
    private activator: () => T,
    private dynamoDBClient: DynamoDBClient
  ) {}

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

  public writeAsync = async (
    aggregate: T,
    encryptionKey?: string
  ): Promise<void> => {
    const changes = aggregate.getChanges();
    logger.debug("Changes.", changes);

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

  private changeProps = (
    props: any,
    f: (data: string, key: string) => string,
    encryptionKey?: string,
    encryptedProps?: string[]
  ): {} => {
    if (encryptionKey === undefined) return props;
    if (encryptedProps === undefined) return props;

    for (let index = 0; index < encryptedProps.length; index++) {
      const propertyName = encryptedProps[index];
      props[propertyName] = f(props[propertyName], encryptionKey);
    }
    return props;
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

      const persistedEvent: IPersistedEvent = {
        aggregateId,
        eventType,
        timestamp,
        aggregateVersion: expectedVersion + index,
        encryptedProps,
        data: this.changeProps(
          otherProps,
          encrypt,
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
    const command = new QueryCommand({
      TableName: this.eventTableName,
      KeyConditionExpression: "aggregateId = :aggregateId",
      ExpressionAttributeValues: { ":aggregateId": aggregateId },
      ConsistentRead: true,
      ScanIndexForward: true,
    });

    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);
    const response = await documentClient.send(command);
    documentClient.destroy();
    const { Items } = response;

    if (Items) {
      const events = Items?.map(
        ({ eventType, timestamp, encryptedProps, data }: any) => {
          const decryptedData = this.changeProps(
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
