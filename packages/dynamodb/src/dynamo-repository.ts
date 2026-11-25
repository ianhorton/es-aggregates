import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { AggregateRoot, Repository } from "@es-aggregates/core";

import { DynamoEventStore } from "./dynamo-event-store";

/**
 * A Repository that stores events in DynamoDB. Its constructor is that of
 * Repository in 1.x.
 */
export class DynamoRepository<T extends AggregateRoot> extends Repository<T> {
  constructor(
    eventTableName: string,
    activator: () => T,
    dynamoDBClient: DynamoDBClient,
    debug: boolean = false
  ) {
    super(
      new DynamoEventStore(dynamoDBClient, eventTableName),
      activator,
      debug
    );
  }
}
