import { EventStoreContract } from "@es-aggregates/store-tests";

import { PostgresEventStore } from "../src";

import { Postgres } from "./test-objects/postgres";

jest.setTimeout(90000);

Postgres.describe("PostgresEventStore", () => {
  const postgres = new Postgres();
  let table: string;

  beforeAll(async () => {
    await postgres.startAsync();
    table = await postgres.createTableAsync();
  });
  afterAll(postgres.stopAsync);

  new EventStoreContract(
    () => new PostgresEventStore(postgres.pool, { table })
  ).define();
});
