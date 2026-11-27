import {
  ConcurrencyError,
  EventStore,
  IPersistedEvent,
} from "@es-aggregates/core";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [name: string]: JsonValue;
}

/**
 * What PostgresEventStore uses of a Pool from pg. A Client and a PoolClient have it too.
 * The store needs nothing else, so it does not depend on pg, nor on pg's types.
 */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PostgresEventStoreOptions {
  /**
   * The table's name, or its schema and its name with a dot between them, such as
   * "app.events". The default is "events", in the first schema of the search_path. Each
   * name is quoted, so it is used exactly as it is written: case counts.
   */
  readonly table?: string;
}

/**
 * Stores events in a table of Postgres, one row per event: the aggregate's id, the
 * event's version, and the event as jsonb. The primary key is the id and the version, so
 * a version can be stored only once. createTableSql returns the statement that creates
 * the table: the store never creates or alters one by itself. Store nothing else in the
 * table, and give it no other unique key.
 *
 * An append is one INSERT, so it stores all of the events or none of them. It can have
 * at most 32767 events. If a version is already stored, or another transaction is storing
 * it and then commits, the append rejects with a ConcurrencyError. After any other error,
 * the events may have been stored, or not: read the aggregate again before you retry. pg
 * never sends a statement again by itself, so a version that the append itself has stored
 * is never taken for one that another write has stored.
 *
 * An append is refused, before anything is sent, if it has a value that would not be
 * read back as it is: one that JSON cannot hold, such as a Date, or \u0000 or a lone
 * surrogate, which jsonb cannot hold, in a string or a property name.
 *
 * A read on the primary server has every event of the appends that have resolved. A
 * standby can be behind the primary, so a read there can miss events that were stored
 * shortly before.
 */
export class PostgresEventStore implements EventStore {
  // as many events as an INSERT can have: each takes two of its 65535 parameters, and
  // the aggregate's id takes one
  private static readonly maxEvents = 32767;

  private static readonly defaultTable = "events";

  // neither text nor jsonb can hold it
  private static readonly nul = /\u0000/;

  // half of a surrogate pair, without the other half. jsonb refuses it, and pg sends it
  // in a text as U+FFFD
  private static readonly loneSurrogate =
    /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

  // the table, as SQL
  private readonly table: string;

  constructor(
    private readonly pool: Queryable,
    options: PostgresEventStoreOptions = {}
  ) {
    this.table = PostgresEventStore.quote(options.table);
  }

  /**
   * The statement that creates the table, for the same options as the store's.
   */
  public static createTableSql(
    options: PostgresEventStoreOptions = {}
  ): string {
    return [
      `CREATE TABLE ${PostgresEventStore.quote(options.table)} (`,
      '  aggregate_id text COLLATE "C" NOT NULL,',
      "  aggregate_version integer NOT NULL,",
      "  event jsonb NOT NULL,",
      "  PRIMARY KEY (aggregate_id, aggregate_version)",
      ");",
    ].join("\n");
  }

  public appendAsync = async (
    aggregateId: string,
    events: IPersistedEvent[],
    expectedVersion: number
  ): Promise<void> => {
    this.checkId(aggregateId);
    if (events.length > PostgresEventStore.maxEvents) {
      throw new Error(
        `Cannot append ${events.length} events to aggregate "${aggregateId}" at once. ` +
          `The limit is ${PostgresEventStore.maxEvents}.`
      );
    }
    // there is nothing to store, so nothing is sent. CosmosEventStore resolves too
    if (events.length === 0) {
      return;
    }

    const values: unknown[] = [aggregateId];
    const rows: string[] = [];
    for (const event of events) {
      values.push(event.aggregateVersion, this.toText(aggregateId, event));
      rows.push(`($1, $${values.length - 1}, $${values.length})`);
    }

    try {
      await this.pool.query(
        `INSERT INTO ${this.table} (aggregate_id, aggregate_version, event) ` +
          `VALUES ${rows.join(", ")}`,
        values
      );
    } catch (error) {
      if (this.isTaken(error)) {
        throw new ConcurrencyError(aggregateId, expectedVersion, error);
      }
      throw error;
    }
  };

  public readAsync = async (
    aggregateId: string
  ): Promise<IPersistedEvent[]> => {
    this.checkId(aggregateId);

    // as text, so that a parser that the app has set in pg for jsonb does not change it
    const { rows } = await this.pool.query(
      `SELECT event::text AS event FROM ${this.table} ` +
        "WHERE aggregate_id = $1 ORDER BY aggregate_version",
      [aggregateId]
    );

    return rows.map((row) => JSON.parse((row as { event: string }).event));
  };

  /**
   * The table's name, or its schema and its name, each in double quotes, so that they
   * are used as they are, whatever they hold.
   */
  private static quote(table = PostgresEventStore.defaultTable): string {
    if (typeof table !== "string") {
      throw new Error(
        `A table's name must be a string, but this one is ${typeof table}.`
      );
    }

    const names = table.split(".");
    if (
      names.length > 2 ||
      names.some((name) => name === "" || PostgresEventStore.nul.test(name))
    ) {
      const quoted = JSON.stringify(table);
      throw new Error(
        `Cannot use the table ${quoted}. Give its name, or its schema and its name ` +
          'with a dot between them, such as "app.events". Neither can be empty, or ' +
          "have \\u0000 in it."
      );
    }
    return names.map((name) => `"${name.replace(/"/g, '""')}"`).join(".");
  }

  /**
   * An id that text cannot hold is refused for a read too: pg would send a lone surrogate
   * as U+FFFD, so the read would have the events of another aggregate.
   */
  private checkId = (aggregateId: string): void => {
    if (typeof aggregateId !== "string") {
      throw new Error(
        `An aggregate's id must be a string, but this one is ${typeof aggregateId}.`
      );
    }
    const flaw = this.flawOf(aggregateId);
    if (flaw !== undefined) {
      throw new Error(
        `An aggregate's id cannot have ${flaw}, because Postgres cannot hold it in a text.`
      );
    }
  };

  /**
   * A table has one unique key, which is the aggregate and the version. So a unique
   * violation means that the version is already stored, or that another transaction was
   * storing it, and has committed.
   */
  private isTaken = (error: unknown): boolean =>
    (error as { code?: unknown } | undefined)?.code === "23505";

  // the event as JSON, if it is an event of the aggregate
  private toText = (aggregateId: string, event: IPersistedEvent): string => {
    if (event.aggregateId !== aggregateId) {
      throw new Error(
        `Cannot append ${event.eventType} to aggregate "${aggregateId}", because it is ` +
          `an event of aggregate "${event.aggregateId}".`
      );
    }
    return JSON.stringify(this.toJson(event, event.eventType));
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
          this.checkText(name, "a property name", path);
          copy[name] = this.toJson(property, `${path}.${name}`);
        }
      }
      return copy;
    }

    if (typeof value === "string") {
      this.checkText(value, "a string", path);
      return value;
    }

    if (
      value === null ||
      typeof value === "boolean" ||
      Number.isFinite(value)
    ) {
      return value as JsonValue;
    }

    throw new Error(
      `Cannot store ${path}, because JSON cannot hold ${this.describe(value)}.`
    );
  };

  // jsonb cannot hold \u0000 or a lone surrogate, which JSON can
  private checkText = (text: string, what: string, path: string): void => {
    const flaw = this.flawOf(text);
    if (flaw !== undefined) {
      throw new Error(
        `Cannot store ${path}, because jsonb cannot hold ${what} with ${flaw}.`
      );
    }
  };

  // what Postgres cannot hold of a text, if anything
  private flawOf = (text: string): string | undefined => {
    if (PostgresEventStore.nul.test(text)) {
      return "\\u0000";
    }
    if (PostgresEventStore.loneSurrogate.test(text)) {
      return "a lone surrogate";
    }
    return undefined;
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
}
