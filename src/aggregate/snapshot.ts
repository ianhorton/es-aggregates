/**
 * Configuration for snapshot behavior
 */
export interface ISnapshotConfig {
  /**
   * Enable or disable snapshot functionality
   * @default false
   */
  enabled: boolean;

  /**
   * Create a snapshot every N events
   * @default 100
   */
  frequency?: number;

  /**
   * Number of snapshots to retain (keeps last N snapshots)
   * @default 3
   */
  retention?: number;

  /**
   * Automatically create snapshots on write
   * @default true
   */
  autoSnapshot?: boolean;

  /**
   * Custom serializer for complex aggregate types
   * If not provided, default JSON serialization is used
   */
  serializer?: ISnapshotSerializer;
}

/**
 * Custom serialization interface for aggregates with complex types
 */
export interface ISnapshotSerializer {
  /**
   * Serialize aggregate state to a plain object
   * @param aggregate The aggregate instance to serialize
   * @returns Plain object representing aggregate state
   */
  serialize(aggregate: any): Record<string, any>;

  /**
   * Deserialize plain object back to aggregate state
   * @param data The serialized data
   * @param aggregate The aggregate instance to populate
   */
  deserialize(data: Record<string, any>, aggregate: any): void;
}

/**
 * Repository configuration that supports both legacy and new formats
 */
export interface IRepositoryConfig {
  /**
   * DynamoDB table name for event storage
   */
  tableName: string;

  /**
   * Encryption key for field-level encryption (optional)
   */
  encryptionKey?: string;

  /**
   * Snapshot configuration (optional)
   */
  snapshot?: ISnapshotConfig;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}

/**
 * Internal representation of a snapshot stored in DynamoDB
 */
export interface IPersistedSnapshot {
  /**
   * Aggregate ID (HASH key)
   */
  aggregateId: string;

  /**
   * Snapshot version (RANGE key) - uses negative numbers (-1, -2, -3, etc.)
   */
  aggregateVersion: number;

  /**
   * The actual event version this snapshot represents
   */
  snapshotAtVersion: number;

  /**
   * Aggregate type name for routing
   */
  aggregateType: string;

  /**
   * Timestamp when snapshot was created
   */
  timestamp: string;

  /**
   * Serialized aggregate state
   */
  data: Record<string, any>;

  /**
   * List of encrypted property names (if encryption enabled)
   */
  encryptedProps?: string[];

  /**
   * Metadata for snapshot validation
   */
  metadata?: ISnapshotMetadata;
}

/**
 * Metadata stored with snapshots for validation
 */
export interface ISnapshotMetadata {
  /**
   * Library version used to create snapshot
   */
  libraryVersion: string;

  /**
   * Node.js version
   */
  nodeVersion: string;

  /**
   * User-defined schema version (optional)
   */
  schemaVersion?: number;
}
