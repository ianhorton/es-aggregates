import {
  Container,
  CosmosClient,
  CosmosClientOptions,
  ItemDefinition,
  Plugin,
  PluginOn,
} from "@azure/cosmos";

/**
 * The event container in the Cosmos DB emulator. Reads and writes items exactly as
 * Cosmos DB holds them, so a test can see what the library stored without going
 * through the library.
 */
export class Emulator {
  public static readonly endpoint =
    process.env.COSMOS_EMULATOR_ENDPOINT || "http://localhost:8081";

  // every emulator has this key, and Microsoft publishes it, so it is not a secret
  public static readonly key =
    "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

  /**
   * To be called before any tests run. It tells them, in an environment variable, if
   * there is no emulator.
   */
  public static findAsync = async (): Promise<void> => {
    delete process.env.COSMOS_EMULATOR_MISSING;

    if (!(await Emulator.answersAsync())) {
      const consequence = process.env.CI
        ? "fail, because CI is set"
        : "are skipped";
      const message =
        `Nothing answers at ${Emulator.endpoint}, so the tests that need the Cosmos DB ` +
        `emulator ${consequence}. To start it, run: yarn workspace @es-aggregates/cosmos emulator`;
      console.warn(message);
      process.env.COSMOS_EMULATOR_MISSING = message;
    }
  };

  // without an emulator, the tests that need it are skipped, but never in CI
  public static get describe(): jest.Describe {
    const isSkipped = process.env.COSMOS_EMULATOR_MISSING && !process.env.CI;
    return isSkipped ? describe.skip : describe;
  }

  private static answersAsync = async (): Promise<boolean> => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        await fetch(Emulator.endpoint, { signal: AbortSignal.timeout(10000) });
        return true;
      } catch (error) {
        // an emulator that is still starting closes the connection
        const { cause } = error as { cause?: { code?: string } };
        if (cause?.code !== "UND_ERR_SOCKET" && cause?.code !== "ECONNRESET") {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return false;
  };

  // how many items there were on each page that was read
  public readonly pageSizes: number[] = [];

  /**
   * The emulator puts all the results of a query that sorts them on one page. This
   * splits them into pages of up to 100, which is what Cosmos DB does by default.
   */
  private readonly splitAsync: Plugin<any> = async (context, _, next) => {
    const headers = context.headers!;
    const [, start] =
      /^from (\d+)$/.exec(`${headers["x-ms-continuation"]}`) ?? [];
    if (start !== undefined) {
      delete headers["x-ms-continuation"];
    }

    const response = await next(context);
    const items = response.result?.Documents;
    if (items !== undefined) {
      const first = Number(start ?? 0);
      const page = items.slice(first, first + 100);
      if (first + page.length < items.length) {
        response.headers["x-ms-continuation"] = `from ${first + page.length}`;
      }
      response.result.Documents = page;
      this.pageSizes.push(page.length);
    }
    return response;
  };

  private readonly client = new CosmosClient({
    endpoint: Emulator.endpoint,
    key: Emulator.key,
    connectionPolicy: { enableEndpointDiscovery: false },
    // the SDK leaves these out of the type of the options, so that needs a cast
    plugins: [{ on: PluginOn.request, plugin: this.splitAsync }],
  } as CosmosClientOptions);

  public readonly container = this.client
    .database("es-aggregates-tests")
    .container("events");

  public startAsync = async (): Promise<void> => {
    if (process.env.COSMOS_EMULATOR_MISSING) {
      throw new Error(process.env.COSMOS_EMULATOR_MISSING);
    }

    await this.createContainerAsync(this.container.id, "/aggregateId");
  };

  public createContainerAsync = async (
    id: string,
    partitionKeyPath: string
  ): Promise<Container> => {
    const { database } = await this.client.databases.createIfNotExists({
      id: this.container.database.id,
    });
    const { container } = await database.containers.createIfNotExists({
      id,
      partitionKey: { paths: [partitionKeyPath] },
    });
    return container;
  };

  public stop = (): void => {
    this.client.dispose();
  };

  // an aggregate's items in version order
  public itemsAsync = async (
    aggregateId: string
  ): Promise<ItemDefinition[]> => {
    const { resources } = await this.container.items
      .query<ItemDefinition>("SELECT * FROM c", { partitionKey: aggregateId })
      .fetchAll();

    return resources.sort(
      (item, other) => item.aggregateVersion - other.aggregateVersion
    );
  };

  public putAsync = async (item: ItemDefinition): Promise<void> => {
    await this.container.items.upsert(item);
  };
}
