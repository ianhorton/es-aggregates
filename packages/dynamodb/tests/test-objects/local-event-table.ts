import {
  AttributeValue,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";

export type RawItem = Record<string, AttributeValue>;

/**
 * The event table in DynamoDB Local. Reads and writes items exactly as DynamoDB
 * holds them (low-level AttributeValues), so a test can see what the library
 * stored without going through the library or the document client.
 */
export class LocalEventTable {
  public readonly name = "test-service-event-dev";

  public readonly client = new DynamoDBClient({
    endpoint: "http://localhost:8000",
    region: "local-env",
    credentials: {
      accessKeyId: "fakeMyKeyId",
      secretAccessKey: "fakeSecretAccessKey",
    },
  });

  // an aggregate's items in version order (one page, so up to 1mb)
  public itemsAsync = async (aggregateId: string): Promise<RawItem[]> => {
    const { Items } = await this.client.send(
      new QueryCommand({
        TableName: this.name,
        KeyConditionExpression: "aggregateId = :aggregateId",
        ExpressionAttributeValues: { ":aggregateId": { S: aggregateId } },
        ConsistentRead: true,
      })
    );

    return Items ?? [];
  };

  public putAsync = async (item: RawItem): Promise<void> => {
    await this.client.send(
      new PutItemCommand({ TableName: this.name, Item: item })
    );
  };
}
