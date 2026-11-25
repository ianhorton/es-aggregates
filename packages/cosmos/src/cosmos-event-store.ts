import {
  ConcurrencyError,
  EventStore,
  IPersistedEvent,
} from "@es-aggregates/core";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [name: string]: JsonValue;
}

interface CreateOperation {
  operationType: "Create";
  resourceBody: JsonObject;
}

// what the SDK returns for a batch, or throws
interface Outcome {
  code?: number | string;
  result?: Array<{ statusCode?: number }>;
  cause?: { code?: number | string };
  diagnostics?: {
    clientSideRequestStatistics?: {
      retryDiagnostics?: { failedAttempts?: SentRequest[] };
      gatewayStatistics?: SentRequest[];
    };
  };
}

// what the SDK's diagnostics tell about a request that it sent
interface SentRequest {
  operationType?: string;
  statusCode?: number | string;
  subStatusCode?: number;
}

/**
 * What CosmosEventStore uses of a Container from @azure/cosmos. The class itself cannot be
 * the type of the parameter: the SDK declares it twice, once for ES modules and once for
 * CommonJS, and as it has private members, TypeScript does not take the one for the other.
 */
export interface EventContainer {
  readonly items: {
    batch(
      operations: CreateOperation[],
      partitionKey: string
    ): Promise<unknown>;

    query(
      query: {
        query: string;
        parameters: Array<{ name: string; value: string }>;
      },
      options: { partitionKey: string }
    ): { fetchAll(): Promise<{ resources: unknown[] }> };
  };
}

/**
 * Stores events in a container of Cosmos DB for NoSQL. The container must have
 * /aggregateId as its partition key path, and nothing else may be stored in it. An
 * event's id is its version, and a partition can have each id only once.
 *
 * An append is one transactional batch, so it can have at most 100 events, and 2 MB.
 * Events are stored as JSON. An append is refused if it has a value, such as a Date,
 * that JSON would change or cannot hold.
 *
 * A read can miss events that were stored shortly before it, unless the consistency
 * level of the account is Strong: a request cannot ask for a stronger level than the
 * account's. With Session, the default, a read has the events that the same CosmosClient
 * stored, but only if the client was created with `consistencyLevel: "Session"`, because
 * otherwise the SDK does not send its session token. It can still miss those that
 * another client stored, such as that of another process.
 *
 * Events that a read missed cannot be lost or overwritten. Every append goes to the
 * account's write region, and if a version is already stored there, the append stores
 * nothing and rejects with a ConcurrencyError. That needs an account with a single write
 * region: with more, two regions can both store the same version, and Cosmos DB then
 * keeps only one of the two events.
 *
 * After any other error, the events may have been stored, or not: read the aggregate again
 * before you retry. One of these errors is for an append that the SDK, by itself, sent more
 * than once, as it can after a 503. Then a version that is already stored can be one that
 * an earlier attempt of the same append has stored, so that is not a ConcurrencyError.
 *
 * A read sorts by aggregateVersion, and fails if that has no range index. If aggregateId
 * has none, the read scans, which costs more. The default indexing policy indexes both.
 * A policy that excludes all other paths must include /aggregateVersion/? and
 * /aggregateId/?.
 */
export class CosmosEventStore implements EventStore {
  // as many operations as a transactional batch can have
  private static readonly maxEvents = 100;

  constructor(private readonly container: EventContainer) {}

  public appendAsync = async (
    aggregateId: string,
    events: IPersistedEvent[],
    expectedVersion: number
  ): Promise<void> => {
    this.checkId(aggregateId);
    if (events.length > CosmosEventStore.maxEvents) {
      throw new Error(
        `Cannot append ${events.length} events to aggregate "${aggregateId}" at once. ` +
          `The limit is ${CosmosEventStore.maxEvents}.`
      );
    }

    const operations = events.map((event) => this.toOperation(event));

    let response: Outcome | undefined;
    try {
      response = (await this.container.items.batch(operations, aggregateId)) as
        | Outcome
        | undefined;
    } catch (error) {
      if (this.isConflict(error)) {
        throw this.conflictError(
          aggregateId,
          expectedVersion,
          error as Outcome
        );
      }
      throw error;
    }

    // a batch that stored nothing does not throw: only its response tells
    const code = response?.code;
    const operationCodes = this.operationCodes(response?.result);
    if ([code, ...operationCodes].some(this.isTaken)) {
      // if an earlier attempt had stored these events, the first one would have a 409. So
      // if a later one has that, none of them was stored
      throw operationCodes.indexOf(409) > 0
        ? new ConcurrencyError(aggregateId, expectedVersion, response)
        : this.conflictError(aggregateId, expectedVersion, response);
    }
    if (
      code !== 200 ||
      operationCodes.length !== operations.length ||
      operationCodes.some((operationCode) => operationCode !== 201)
    ) {
      throw Object.assign(
        new Error(
          `Cannot append ${operations.length} events to aggregate "${aggregateId}" at ` +
            `version ${expectedVersion}: the batch has status code ${code}, and its ` +
            `operations have [${operationCodes.join(", ")}].`
        ),
        { cause: response }
      );
    }
  };

  public readAsync = async (
    aggregateId: string
  ): Promise<IPersistedEvent[]> => {
    this.checkId(aggregateId);

    const { resources } = await this.container.items
      .query(
        {
          query:
            "SELECT * FROM c WHERE c.aggregateId = @aggregateId " +
            "ORDER BY c.aggregateVersion",
          parameters: [{ name: "@aggregateId", value: aggregateId }],
        },
        { partitionKey: aggregateId }
      )
      .fetchAll();

    return resources.map((item) => this.toEvent(item as JsonObject));
  };

  /**
   * If the SDK is given undefined for a partition key, it reads every partition, or
   * stores the events in one that they cannot be read from.
   */
  private checkId = (aggregateId: string): void => {
    if (typeof aggregateId !== "string") {
      throw new Error(
        `An aggregate's id must be a string, but this one is ${typeof aggregateId}.`
      );
    }
  };

  /**
   * An item's key is the aggregate plus the id, which is the version. So a conflict (409)
   * means that the version is already stored. A 449 means that another request is storing
   * it, and that this one has failed, because an item takes one write at a time.
   *
   * https://learn.microsoft.com/azure/cosmos-db/conceptual-resilient-sdk-applications#http-449
   * https://github.com/Azure/azure-sdk-for-java/blob/main/sdk/cosmos/azure-cosmos/docs/ErrorCodesAndRetries.md
   */
  private isTaken = (code?: number | string): boolean =>
    code === 409 || code === 449;

  private isConflict = (error: unknown): boolean => {
    // what items.batch throws has the original error as its cause since version 4.10.1
    // of the SDK; in older versions, only its diagnostics tell the status code
    const thrown = error as Outcome | undefined;
    const requests =
      thrown?.diagnostics?.clientSideRequestStatistics?.gatewayStatistics ?? [];
    return [
      thrown?.code,
      thrown?.cause?.code,
      ...requests.map(({ statusCode }) => statusCode),
    ].some(this.isTaken);
  };

  /**
   * The error for a version that is taken. It can be a ConcurrencyError only if it is known
   * that no earlier attempt of the same append has stored that version, or is storing it.
   */
  private conflictError = (
    aggregateId: string,
    expectedVersion: number,
    cause?: Outcome
  ): Error =>
    this.mayHaveBeenStored(cause)
      ? Object.assign(
          new Error(
            `It is not known whether the events for aggregate "${aggregateId}" at version ` +
              `${expectedVersion} were stored: the SDK sent them more than once, and an ` +
              "earlier attempt may have stored them. Read the aggregate again before you " +
              "retry anything."
          ),
          { cause }
        )
      : new ConcurrencyError(aggregateId, expectedVersion, cause);

  /**
   * Whether an attempt before the last one may have stored the events. The SDK sends a
   * batch again after some failures that do not tell whether it was stored, such as a 503.
   */
  private mayHaveBeenStored = (outcome?: Outcome): boolean => {
    const statistics = outcome?.diagnostics?.clientSideRequestStatistics;
    const failed = statistics?.retryDiagnostics?.failedAttempts ?? [];
    // a failed attempt is here too if the service answered it, and only here it has the
    // substatus
    const answered = statistics?.gatewayStatistics ?? [];

    return (
      failed.filter(this.isBatch).length >
      answered.filter(this.isBatch).filter(this.isRefusal).length
    );
  };

  // the SDK can also have sent requests for other things, such as the account's regions
  private isBatch = ({ operationType = "batch" }: SentRequest): boolean =>
    operationType === "batch";

  /**
   * Whether the service certainly stored nothing. Of the answers after which the SDK sends
   * a batch again, only these are documented to mean that:
   * - 429, because there are too many requests:
   *   https://learn.microsoft.com/azure/cosmos-db/troubleshoot-request-rate-too-large
   * - 403 with substatus 3, because the region does not take writes:
   *   https://learn.microsoft.com/rest/api/cosmos-db/http-status-codes-for-cosmosdb
   * - 403 with substatus 1008, because the region does not have the account:
   *   https://github.com/Azure/azure-sdk-for-java/blob/main/sdk/cosmos/azure-cosmos/docs/StatusCodes.md
   */
  private isRefusal = ({ statusCode, subStatusCode }: SentRequest): boolean =>
    statusCode === 429 ||
    (statusCode === 403 && (subStatusCode === 3 || subStatusCode === 1008));

  private operationCodes = (
    result?: Outcome["result"]
  ): Array<number | undefined> =>
    Array.isArray(result)
      ? result.map((operation) => operation?.statusCode)
      : [];

  private toOperation = (event: IPersistedEvent): CreateOperation => {
    const item = this.toJson(event, event.eventType) as JsonObject;
    const reserved = Object.keys(item).find(this.isReserved);
    if (reserved !== undefined) {
      throw new Error(
        `Cannot store ${event.eventType}.${reserved}, because Cosmos DB uses that name.`
      );
    }
    return {
      operationType: "Create",
      resourceBody: { ...item, id: `${event.aggregateVersion}` },
    };
  };

  /**
   * A copy of the value that will be read back as it is. It leaves out what
   * DynamoEventStore leaves out: undefined values, and properties that are functions.
   */
  private toJson = (value: unknown, path: string): JsonValue => {
    if (this.isPlainArray(value)) {
      const copy: JsonValue[] = [];
      value.forEach((element, index) => {
        if (element !== undefined) {
          copy.push(this.toJson(element, `${path}[${index}]`));
        }
      });
      return copy;
    }

    if (this.isPlainObject(value)) {
      // it has no prototype, so that __proto__ is a property like any other
      const copy: JsonObject = Object.create(null);
      for (const [name, property] of Object.entries(value)) {
        if (property !== undefined && typeof property !== "function") {
          copy[name] = this.toJson(property, `${path}.${name}`);
        }
      }
      return copy;
    }

    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      Number.isFinite(value)
    ) {
      return value as JsonValue;
    }

    throw new Error(
      `Cannot store ${path}, because JSON cannot hold ${this.describe(value)}.`
    );
  };

  // These two do not compare a prototype with Array.prototype or Object.prototype,
  // because each vm context has its own. Array.prototype is itself an array, and
  // Object.prototype has no prototype

  private isPlainArray = (value: unknown): value is unknown[] =>
    Array.isArray(value) && Array.isArray(Object.getPrototypeOf(value));

  private isPlainObject = (
    value: unknown
  ): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  };

  private describe = (value: unknown): string => {
    if (typeof value === "object") {
      return `an instance of ${(value as object).constructor?.name}`;
    }
    return typeof value === "number" ? `${value}` : `a ${typeof value}`;
  };

  private toEvent = (item: JsonObject): IPersistedEvent => {
    const event: JsonObject = {};
    for (const name of Object.keys(item)) {
      if (!this.isReserved(name)) {
        event[name] = item[name];
      }
    }
    return event as unknown as IPersistedEvent;
  };

  // besides the id, Cosmos DB gives an item properties such as _etag and _ts
  private isReserved = (name: string): boolean =>
    name === "id" || name.startsWith("_");
}
