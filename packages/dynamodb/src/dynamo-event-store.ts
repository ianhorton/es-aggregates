import {
  DynamoDBClient,
  Put,
  TransactionCanceledException,
  TransactWriteItem,
  TransactWriteItemsCommand,
  TransactWriteItemsInput,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  ConcurrencyError,
  EventStore,
  IPersistedEvent,
} from "@es-aggregates/core";

/**
 * Stores events in a DynamoDB table whose partition key is aggregateId (a string)
 * and whose sort key is aggregateVersion (a number).
 *
 * An append is one transaction, so it can have at most 100 events, and 4 MB.
 */
export class DynamoEventStore implements EventStore {
  // as many items as a transaction can have
  private static readonly maxEvents = 100;

  constructor(
    private readonly dynamoDBClient: DynamoDBClient,
    private readonly eventTableName: string
  ) {}

  public appendAsync = async (
    aggregateId: string,
    events: IPersistedEvent[],
    expectedVersion: number
  ): Promise<void> => {
    if (events.length > DynamoEventStore.maxEvents) {
      throw new Error(
        `Cannot append ${events.length} events to aggregate "${aggregateId}" at once. ` +
          `The limit is ${DynamoEventStore.maxEvents}.`
      );
    }

    const transactWriteItemList: TransactWriteItem[] = [];

    for (const event of events) {
      const item = marshall(event, { removeUndefinedValues: true });

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

    try {
      await documentClient.send(command);
    } catch (error) {
      if (this.isVersionConflict(error)) {
        throw new ConcurrencyError(aggregateId, expectedVersion, error);
      }
      throw error;
    }
  };

  public readAsync = async (
    aggregateId: string
  ): Promise<IPersistedEvent[]> => {
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
      if (Items) items.push(...Items);
      lastEvaluatedKey = LastEvaluatedKey;
    } while (lastEvaluatedKey);

    documentClient.destroy();

    return items as IPersistedEvent[];
  };

  /**
   * An item's key is the aggregate plus the version. So a failed condition means
   * that the version is already stored, and a conflict with another transaction
   * means that both are writing the same version.
   */
  private isVersionConflict = (error: unknown): boolean => {
    // by name, not instanceof: an app can have more than one copy of the SDK
    const cancelled = error as TransactionCanceledException | undefined;
    if (cancelled?.name !== "TransactionCanceledException") {
      return false;
    }
    return (cancelled.CancellationReasons ?? []).some(
      ({ Code }) =>
        Code === "ConditionalCheckFailed" || Code === "TransactionConflict"
    );
  };
}
