import {
  DynamoDBClient,
  Put,
  TransactWriteItem,
  TransactWriteItemsCommand,
  TransactWriteItemsInput,
  TransactWriteItemsOutput,
  Delete,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandOutput,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { Logger, LogLevel } from "@sailplane/logger";
import { formatInTimeZone } from "date-fns-tz";

import { IEvent } from "../event/models/event";
import { IPersistedEvent } from "../event/models/persisted-event";
import { AggregateRoot } from "./aggregate-root";
import { decrypt, encrypt } from "./encryption";
import {
  IRepositoryConfig,
  ISnapshotConfig,
  IPersistedSnapshot,
  ISnapshotMetadata,
} from "./snapshot";
import { DefaultSnapshotSerializer } from "./snapshot-serializer";

const logger = new Logger("repository");

export interface IRepository<T extends AggregateRoot> {
  readonly readAsync: (
    id: string,
    encryptionKey?: string
  ) => Promise<T | undefined>;

  readonly writeAsync: (aggregate: T, encryptionKey?: string) => Promise<void>;
}

export class Repository<T extends AggregateRoot> implements IRepository<T> {
  private readonly eventTableName: string;
  private readonly activator: () => T;
  private readonly dynamoDBClient: DynamoDBClient;
  private readonly encryptionKey?: string;
  private readonly snapshotConfig?: ISnapshotConfig;
  private readonly serializer: DefaultSnapshotSerializer;

  /**
   * Creates a new Repository instance
   * @param configOrTableName - Either IRepositoryConfig object or legacy table name string
   * @param activator - Factory function to create new aggregate instances
   * @param dynamoDBClient - DynamoDB client instance
   * @param debugOrEncryptionKey - Legacy: encryption key string, or debug boolean
   */
  constructor(
    configOrTableName: IRepositoryConfig | string,
    activator: () => T,
    dynamoDBClient: DynamoDBClient,
    debugOrEncryptionKey?: boolean | string
  ) {
    // Support both old and new constructor formats for backwards compatibility
    if (typeof configOrTableName === "string") {
      // Legacy format: Repository(tableName, activator, client, debug)
      this.eventTableName = configOrTableName;
      this.activator = activator;
      this.dynamoDBClient = dynamoDBClient;
      this.encryptionKey =
        typeof debugOrEncryptionKey === "string" ? debugOrEncryptionKey : undefined;
      this.snapshotConfig = undefined; // Snapshots disabled in legacy mode
      logger.level =
        typeof debugOrEncryptionKey === "boolean" && debugOrEncryptionKey
          ? LogLevel.DEBUG
          : LogLevel.NONE;
    } else {
      // New format: Repository(config, activator, client)
      const config = configOrTableName;
      this.eventTableName = config.tableName;
      this.activator = activator;
      this.dynamoDBClient = dynamoDBClient;
      this.encryptionKey = config.encryptionKey;
      this.snapshotConfig = config.snapshot;
      logger.level = config.debug ? LogLevel.DEBUG : LogLevel.NONE;
    }

    // Initialize serializer (used for snapshots if enabled)
    this.serializer = new DefaultSnapshotSerializer();
  }

  public readAsync = async (
    id: string,
    encryptionKey?: string
  ): Promise<T | undefined> => {
    const effectiveEncryptionKey = encryptionKey || this.encryptionKey;

    // If snapshots not enabled, use original event-only loading
    if (!this.snapshotConfig?.enabled) {
      return this.readFromEventsAsync(id, effectiveEncryptionKey);
    }

    // Try to load from snapshot
    try {
      const snapshot = await this.getLatestSnapshotAsync(id, effectiveEncryptionKey);

      if (snapshot) {
        logger.debug(`Loading aggregate ${id} from snapshot at version ${snapshot.snapshotAtVersion}`);

        // Deserialize aggregate from snapshot
        const aggregate = this.deserializeSnapshot(snapshot, effectiveEncryptionKey);

        // Load events after the snapshot
        const events = await this.readEventsAsync(
          id,
          effectiveEncryptionKey,
          snapshot.snapshotAtVersion + 1
        );

        // Replay events since snapshot
        if (events.length > 0) {
          logger.debug(`Replaying ${events.length} events since snapshot`);
          aggregate.initialize(events);
        }

        return aggregate;
      }
    } catch (error) {
      // If snapshot loading fails, fall back to event replay
      logger.debug(`Snapshot load failed for ${id}, falling back to events:`, error);
    }

    // No snapshot found or snapshot loading failed - fall back to full event replay
    logger.debug(`No snapshot found for ${id}, loading from all events`);
    return this.readFromEventsAsync(id, effectiveEncryptionKey);
  };

  /**
   * Load aggregate from events only (original behavior)
   * @private
   */
  private readFromEventsAsync = async (
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

    const expectedVersion = aggregate.getExpectedVersion();
    logger.debug("Expected Version.", expectedVersion);

    const effectiveEncryptionKey = encryptionKey || this.encryptionKey;

    const output = await this.transactWriteAsync(
      aggregate.id,
      changes,
      expectedVersion,
      effectiveEncryptionKey
    );
    logger.debug("Transact Write Items Output.", output);

    aggregate.clearChanges();

    // Check if we should create a snapshot
    if (this.shouldCreateSnapshot(aggregate)) {
      try {
        await this.createSnapshotAsync(aggregate, effectiveEncryptionKey);
        logger.debug(`Snapshot created for ${aggregate.id} at version ${aggregate.getExpectedVersion()}`);
      } catch (error) {
        // Log error but don't fail the write - snapshots are best-effort
        logger.debug(`Failed to create snapshot for ${aggregate.id}:`, error);
      }
    }
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
    encryptionKey?: string,
    fromVersion?: number
  ): Promise<IEvent[]> => {
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);
    const items: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;

    do {
      const queryParams: any = {
        TableName: this.eventTableName,
        KeyConditionExpression:
          fromVersion !== undefined
            ? "aggregateId = :aggregateId AND aggregateVersion >= :fromVersion"
            : "aggregateId = :aggregateId",
        ExpressionAttributeValues:
          fromVersion !== undefined
            ? { ":aggregateId": aggregateId, ":fromVersion": fromVersion }
            : { ":aggregateId": aggregateId },
        ConsistentRead: true,
        ScanIndexForward: true,
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const response: QueryCommandOutput = await documentClient.send(
        new QueryCommand(queryParams)
      );
      const { Items, LastEvaluatedKey } = response;
      logger.debug("Retrieved Items.", items);
      if (Items) {
        // Filter out snapshots (negative versions) if any
        const eventItems = Items.filter(
          (item) => !item.aggregateVersion || item.aggregateVersion >= 0
        );
        items.push(...eventItems);
      }
      logger.debug("All Items.", items);
      lastEvaluatedKey = LastEvaluatedKey;
    } while (lastEvaluatedKey);

    documentClient.destroy();

    if (items.length > 0) {
      const events = items.map(
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

  /**
   * Get the latest snapshot for an aggregate
   * @private
   */
  private getLatestSnapshotAsync = async (
    aggregateId: string,
    encryptionKey?: string
  ): Promise<IPersistedSnapshot | undefined> => {
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);

    try {
      // Query for items with negative version numbers (snapshots)
      // Sort descending to get the latest (most recent) snapshot first
      const response: QueryCommandOutput = await documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": aggregateId,
            ":zero": 0,
          },
          ConsistentRead: true,
          ScanIndexForward: false, // Descending order - get latest first
          Limit: 1, // We only need the most recent snapshot
        })
      );

      documentClient.destroy();

      if (response.Items && response.Items.length > 0) {
        const item = response.Items[0];

        // Decrypt snapshot data if needed
        const decryptedData = this.changeProps(
          item.data,
          decrypt,
          encryptionKey,
          item.encryptedProps
        );

        const snapshot: IPersistedSnapshot = {
          aggregateId: item.aggregateId,
          aggregateVersion: item.aggregateVersion,
          snapshotAtVersion: item.snapshotAtVersion,
          aggregateType: item.aggregateType,
          timestamp: item.timestamp,
          data: decryptedData,
          encryptedProps: item.encryptedProps,
          metadata: item.metadata,
        };

        return snapshot;
      }

      return undefined;
    } catch (error) {
      logger.debug(`Error loading snapshot for ${aggregateId}:`, error);
      throw error;
    }
  };

  /**
   * Create a snapshot for the current aggregate state
   * @private
   */
  private createSnapshotAsync = async (
    aggregate: T,
    encryptionKey?: string
  ): Promise<void> => {
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);

    try {
      const snapshotAtVersion = aggregate.getExpectedVersion();
      const aggregateId = aggregate.id;

      // Serialize aggregate state
      const serializer = this.snapshotConfig?.serializer || this.serializer;
      const serializedState = serializer.serialize(aggregate);

      // Determine which properties to encrypt (if any)
      let encryptedProps: string[] | undefined = undefined;
      if (encryptionKey) {
        // Find properties that were marked for encryption in the aggregate
        // For simplicity, we'll encrypt the same properties that would be encrypted in events
        // Users can customize this via custom serializer if needed
        encryptedProps = this.getEncryptedPropsFromAggregate(aggregate);
      }

      // Encrypt data if needed
      const encryptedData = this.changeProps(
        serializedState,
        encrypt,
        encryptionKey,
        encryptedProps
      );

      // Get current snapshot count and determine version number
      const currentSnapshotVersion = await this.getNextSnapshotVersion(aggregateId);

      // Create snapshot metadata
      const metadata: ISnapshotMetadata = {
        libraryVersion: "1.0.0", // TODO: Get from package.json
        nodeVersion: process.version,
      };

      const snapshot: IPersistedSnapshot = {
        aggregateId,
        aggregateVersion: currentSnapshotVersion, // Negative version number
        snapshotAtVersion,
        aggregateType: aggregate.constructor.name,
        timestamp: formatInTimeZone(new Date(), "UTC", "yyyy-MM-dd'T'HH:mm:ss.SSSxxx"),
        data: encryptedData,
        encryptedProps,
        metadata,
      };

      // Write snapshot to DynamoDB
      await documentClient.send(
        new PutCommand({
          TableName: this.eventTableName,
          Item: snapshot,
        })
      );

      // Enforce retention policy (delete old snapshots)
      await this.enforceSnapshotRetention(aggregateId);

      documentClient.destroy();
    } catch (error) {
      logger.debug(`Error creating snapshot for ${aggregate.id}:`, error);
      throw error;
    }
  };

  /**
   * Get the next snapshot version number (negative, sequential)
   * @private
   */
  private getNextSnapshotVersion = async (aggregateId: string): Promise<number> => {
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);

    try {
      // Query for all snapshots (negative versions)
      const response: QueryCommandOutput = await documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": aggregateId,
            ":zero": 0,
          },
          ProjectionExpression: "aggregateVersion",
          ConsistentRead: true,
        })
      );

      documentClient.destroy();

      if (!response.Items || response.Items.length === 0) {
        return -1; // First snapshot
      }

      // Find the minimum (most negative) version
      const versions = response.Items.map((item) => item.aggregateVersion);
      const minVersion = Math.min(...versions);

      return minVersion - 1; // Next snapshot version
    } catch (error) {
      logger.debug(`Error getting next snapshot version for ${aggregateId}:`, error);
      return -1; // Default to first snapshot if error
    }
  };

  /**
   * Enforce snapshot retention policy by deleting old snapshots
   * @private
   */
  private enforceSnapshotRetention = async (aggregateId: string): Promise<void> => {
    const retention = this.snapshotConfig?.retention || 3;
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);

    try {
      // Query for all snapshots
      const response: QueryCommandOutput = await documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": aggregateId,
            ":zero": 0,
          },
          ProjectionExpression: "aggregateVersion",
          ConsistentRead: true,
          ScanIndexForward: false, // Descending order (latest first)
        })
      );

      if (response.Items && response.Items.length > retention) {
        // Delete old snapshots beyond retention limit
        const snapshotsToDelete = response.Items.slice(retention);

        for (const snapshot of snapshotsToDelete) {
          await documentClient.send(
            new DeleteCommand({
              TableName: this.eventTableName,
              Key: {
                aggregateId,
                aggregateVersion: snapshot.aggregateVersion,
              },
            })
          );
          logger.debug(
            `Deleted old snapshot for ${aggregateId} at version ${snapshot.aggregateVersion}`
          );
        }
      }

      documentClient.destroy();
    } catch (error) {
      logger.debug(`Error enforcing snapshot retention for ${aggregateId}:`, error);
      // Don't throw - retention is best-effort
    }
  };

  /**
   * Deserialize a snapshot back to an aggregate instance
   * @private
   */
  private deserializeSnapshot = (
    snapshot: IPersistedSnapshot,
    encryptionKey?: string
  ): T => {
    const aggregate = this.activator();
    const serializer = this.snapshotConfig?.serializer || this.serializer;

    // Deserialize state into aggregate
    serializer.deserialize(snapshot.data, aggregate);

    // Set expected version to match snapshot version
    // This is a bit hacky but necessary - we need to access private field
    (aggregate as any)._expectedVersion = snapshot.snapshotAtVersion;

    return aggregate;
  };

  /**
   * Determine if a snapshot should be created for this aggregate
   * @private
   */
  private shouldCreateSnapshot = (aggregate: T): boolean => {
    if (!this.snapshotConfig?.enabled) {
      return false;
    }

    if (this.snapshotConfig.autoSnapshot === false) {
      return false;
    }

    const version = aggregate.getExpectedVersion();
    const frequency = this.snapshotConfig.frequency || 100;

    // Create snapshot if version is a multiple of frequency
    return version > 0 && version % frequency === 0;
  };

  /**
   * Get encrypted property names from aggregate events
   * This is a helper to determine which properties should be encrypted in snapshots
   * @private
   */
  private getEncryptedPropsFromAggregate = (aggregate: T): string[] | undefined => {
    // Try to get encrypted props from recent events
    const changes = aggregate.getChanges();
    if (changes.length > 0) {
      const lastChange = changes[changes.length - 1];
      return lastChange.encryptedProps;
    }
    return undefined;
  };

  /**
   * Manually create a snapshot for an aggregate (public API)
   */
  public createManualSnapshotAsync = async (
    id: string,
    encryptionKey?: string
  ): Promise<void> => {
    if (!this.snapshotConfig?.enabled) {
      throw new Error("Snapshots are not enabled for this repository");
    }

    const effectiveEncryptionKey = encryptionKey || this.encryptionKey;

    // Load the aggregate
    const aggregate = await this.readAsync(id, effectiveEncryptionKey);
    if (!aggregate) {
      throw new Error(`Aggregate with id ${id} not found`);
    }

    // Create snapshot
    await this.createSnapshotAsync(aggregate, effectiveEncryptionKey);
  };

  /**
   * Delete all snapshots for an aggregate (public API)
   */
  public deleteSnapshotsAsync = async (id: string): Promise<void> => {
    const documentClient = DynamoDBDocumentClient.from(this.dynamoDBClient);

    try {
      // Query for all snapshots
      const response: QueryCommandOutput = await documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression:
            "aggregateId = :aggregateId AND aggregateVersion < :zero",
          ExpressionAttributeValues: {
            ":aggregateId": id,
            ":zero": 0,
          },
          ProjectionExpression: "aggregateVersion",
          ConsistentRead: true,
        })
      );

      if (response.Items) {
        for (const snapshot of response.Items) {
          await documentClient.send(
            new DeleteCommand({
              TableName: this.eventTableName,
              Key: {
                aggregateId: id,
                aggregateVersion: snapshot.aggregateVersion,
              },
            })
          );
          logger.debug(`Deleted snapshot for ${id} at version ${snapshot.aggregateVersion}`);
        }
      }

      documentClient.destroy();
    } catch (error) {
      logger.debug(`Error deleting snapshots for ${id}:`, error);
      throw error;
    }
  };
}
