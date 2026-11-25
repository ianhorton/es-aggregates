import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { IRepository } from "@es-aggregates/core";
import * as storeTests from "@es-aggregates/store-tests";
import * as es1 from "es-aggregates-1";

import { DynamoRepository } from "../../src";

/**
 * An app that uses a version of the library. Its own code is the test aggregates,
 * so it is the same whichever version that is.
 */
export class App {
  public static onCurrent(): App {
    return new App("2.0", storeTests.TestAggregateRoot, DynamoRepository);
  }

  // the test aggregates, loaded again with the published package in place of core
  public static onPublished(): App {
    let storeTestsOn1!: typeof storeTests;
    jest.isolateModules(() => {
      jest.doMock("@es-aggregates/core", () => es1);
      storeTestsOn1 = require("@es-aggregates/store-tests");
    });
    jest.dontMock("@es-aggregates/core");

    return new App(
      "1.1.1",
      storeTestsOn1.TestAggregateRoot,
      es1.Repository as unknown as typeof DynamoRepository
    );
  }

  private constructor(
    private readonly version: string,
    public readonly TestAggregateRoot: typeof storeTests.TestAggregateRoot,
    private readonly Repository: typeof DynamoRepository
  ) {}

  public toString(): string {
    return this.version;
  }

  public repository(
    tableName: string,
    client: DynamoDBClient,
    activator = this.TestAggregateRoot.factory
  ): IRepository<storeTests.TestAggregateRoot> {
    return new this.Repository(tableName, activator, client);
  }
}
