import { ClientBase, Pool, PoolConfig } from "pg";
import { v4 } from "uuid";

import { PostgresEventStore } from "../../src";

// a row of an event table, with the event as Postgres has it
export interface Row {
  aggregate_id: string;
  aggregate_version: number;
  event: string;
}

/**
 * A schema of its own in the Postgres of the tests, which the variables of libpq tell
 * (PGHOST and the like), or else the one that `yarn workspace @es-aggregates/postgres db`
 * starts. It creates the schema when it starts, and drops it, with its tables, when it
 * stops. Reads rows as Postgres holds them, so a test can see what the store stored
 * without going through the store.
 */
export class Postgres {
  public static readonly config: PoolConfig = {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "postgres",
  };

  /**
   * To be called before any tests run. It tells them, in an environment variable, if
   * there is no server.
   */
  public static findAsync = async (): Promise<void> => {
    delete process.env.POSTGRES_MISSING;

    if (!(await Postgres.answersAsync())) {
      const { host, port } = Postgres.config;
      const consequence = process.env.CI
        ? "fail, because CI is set"
        : "are skipped";
      const message =
        `Nothing answers at ${host}:${port}, so the tests that need Postgres ` +
        `${consequence}. To start it, run: yarn workspace @es-aggregates/postgres db`;
      console.warn(message);
      process.env.POSTGRES_MISSING = message;
    }
  };

  // without a server, the tests that need it are skipped, but never in CI
  public static get describe(): jest.Describe {
    const isSkipped = process.env.POSTGRES_MISSING && !process.env.CI;
    return isSkipped ? describe.skip : describe;
  }

  /**
   * Whether a server answers, even if it refuses the user. One that is still starting
   * closes the connection, or says that it is starting.
   */
  private static answersAsync = async (): Promise<boolean> => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const pool = new Pool({
        ...Postgres.config,
        connectionTimeoutMillis: 10000,
      });
      try {
        await pool.query("SELECT 1");
        return true;
      } catch (error) {
        if (!Postgres.isStarting(error)) {
          // only Postgres itself gives a severity, such as FATAL for a wrong password
          return typeof (error as { severity?: unknown }).severity === "string";
        }
      } finally {
        await pool.end();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  // 57P03 is "the database system is starting up"
  private static isStarting = (error: unknown): boolean => {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return (
      code === "57P03" ||
      code === "ECONNRESET" ||
      message === "Connection terminated unexpectedly"
    );
  };

  // a name in double quotes, as SQL has it, which pg's escapeIdentifier makes too
  public static quote = (name: string): string =>
    `"${name.replace(/"/g, '""')}"`;

  public readonly pool = new Pool(Postgres.config);

  constructor(public readonly schema = `es-aggregates-tests-${v4()}`) {}

  public startAsync = async (): Promise<void> => {
    if (process.env.POSTGRES_MISSING) {
      throw new Error(process.env.POSTGRES_MISSING);
    }

    await this.pool.query(`CREATE SCHEMA ${Postgres.quote(this.schema)}`);
  };

  public stopAsync = async (): Promise<void> => {
    try {
      if (!process.env.POSTGRES_MISSING) {
        await this.pool.query(
          `DROP SCHEMA IF EXISTS ${Postgres.quote(this.schema)} CASCADE`
        );
      }
    } finally {
      await this.pool.end();
    }
  };

  /**
   * Creates a table of the schema, with the statement of the store.
   *
   * @returns the table, as the option of the store
   */
  public createTableAsync = async (name = "events"): Promise<string> => {
    const table = this.tableOf(name);
    await this.pool.query(PostgresEventStore.createTableSql({ table }));
    return table;
  };

  // the option of the store for a table of the schema
  public tableOf = (name: string): string => `${this.schema}.${name}`;

  // an aggregate's rows in version order
  public rowsAsync = async (
    name: string,
    aggregateId: string
  ): Promise<Row[]> => {
    const { rows } = await this.pool.query(
      `SELECT aggregate_id, aggregate_version, event::text AS event ` +
        `FROM ${this.sqlOf(name)} WHERE aggregate_id = $1 ` +
        "ORDER BY aggregate_version",
      [aggregateId]
    );
    return rows;
  };

  // the names of the schema's tables
  public tablesAsync = async (): Promise<string[]> => {
    const { rows } = await this.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [this.schema]
    );
    return rows.map(({ table_name }) => table_name);
  };

  // a table's columns, with their types
  public columnsAsync = async (name: string): Promise<string[]> => {
    const { rows } = await this.pool.query(
      "SELECT column_name, data_type, collation_name, is_nullable " +
        "FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [this.schema, name]
    );
    return rows.map(
      (row) =>
        `${row.column_name} ${row.data_type}` +
        (row.collation_name ? ` collate ${row.collation_name}` : "") +
        (row.is_nullable === "NO" ? " not null" : "")
    );
  };

  // a table's primary key and unique constraints, as SQL
  public uniqueKeysAsync = async (name: string): Promise<string[]> => {
    const { rows } = await this.pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint " +
        "WHERE conrelid = $1::regclass AND contype IN ('p', 'u')",
      [this.sqlOf(name)]
    );
    return rows.map(({ definition }) => definition);
  };

  /**
   * Waits until as many sessions as given wait for a lock that the session of this client
   * holds, such as one of a row that it has inserted, and not committed.
   */
  public waitUntilBlockedAsync = async (
    holder: ClientBase,
    count: number
  ): Promise<void> => {
    const { rows } = await holder.query("SELECT pg_backend_pid() AS pid");
    const [{ pid }] = rows;
    const deadline = Date.now() + 10000;
    for (;;) {
      const { rows: blocked } = await this.pool.query(
        "SELECT count(*)::integer AS count FROM pg_stat_activity " +
          "WHERE $1 = ANY (pg_blocking_pids(pid))",
        [pid]
      );
      if (blocked[0].count >= count) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${blocked[0].count} sessions wait for ${pid}, and not ${count}.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  // a table of the schema, as SQL
  public sqlOf = (name: string): string =>
    `${Postgres.quote(this.schema)}.${Postgres.quote(name)}`;
}
