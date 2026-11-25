import { ConnectionPolicy, Container, CosmosClient } from "@azure/cosmos";
import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from "http";
import { AddressInfo } from "net";

export interface SentRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

// an HTTP response, or the end of the connection without one
export type Answer =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "hang up";

// what an account has, besides its regions
export interface Account {
  enableMultipleWriteLocations?: boolean;
  enablePerPartitionFailoverBehavior?: boolean;
}

/**
 * A container that is not in Cosmos DB, but on a server that records the requests, as
 * the SDK sends them, and that gives each the next answer from a list. Requests for the
 * account are only counted. They have a list of their own, and when that is empty, they
 * get the account.
 *
 * Without an account, the SDK sends each request once. With one, it does what it does in
 * most apps: it finds out which regions the account has, and it sends some requests again,
 * if they fail. The path of each request begins with the region.
 */
export class StubbedCosmos {
  private static readonly sendAgain: ConnectionPolicy = {
    // the default since version 4.6.0 of the SDK
    enablePartitionLevelFailover: true,
  };

  private static readonly sendOnce: ConnectionPolicy = {
    enableEndpointDiscovery: false,
    retryOptions: {
      maxRetryAttemptCount: 0,
      fixedRetryIntervalInMilliseconds: 0,
      maxWaitTimeInSeconds: 0,
    },
  };

  public static readonly key = "bm90IGEgcmVhbCBrZXk=";

  public static startAsync = async (
    answers: Answer[],
    account?: Account
  ): Promise<StubbedCosmos> => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const cosmos = new StubbedCosmos(answers, server, account);
    if (account) {
      // before its first request, the SDK asks for the account. It must know that when it
      // sends a batch, to be able to send it to another region
      await cosmos.container.read();
    }
    return cosmos;
  };

  public readonly requests: SentRequest[] = [];

  // how many requests there were for the account
  public accountRequests = 0;

  // the answers to the next ones
  public readonly accountAnswers: Answer[] = [];

  // what the SDK itself returned, or threw, for each batch
  public readonly outcomes: unknown[] = [];

  public readonly container: Container;

  public readonly endpoint: string;

  private readonly client: CosmosClient;

  private constructor(
    private readonly answers: Answer[],
    private readonly server: Server,
    private readonly account?: Account
  ) {
    server.on("request", this.answerAsync);

    const { port } = server.address() as AddressInfo;
    this.endpoint = `http://127.0.0.1:${port}/`;
    this.client = new CosmosClient({
      endpoint: this.endpoint,
      key: StubbedCosmos.key,
      connectionPolicy: account
        ? StubbedCosmos.sendAgain
        : StubbedCosmos.sendOnce,
    });
    this.container = this.client.database("db").container("events");

    const { items } = this.container;
    const batch = items.batch.bind(items);
    items.batch = async (...args) => {
      try {
        const response = await batch(...args);
        this.outcomes.push(response);
        return response;
      } catch (error) {
        this.outcomes.push(error);
        throw error;
      }
    };
  }

  public stopAsync = async (): Promise<void> => {
    this.client.dispose();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  };

  private answerAsync = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    // with every query, the SDK asks for this too, but it does not need it for one
    // that reads a single partition
    if (request.headers["x-ms-cosmos-is-query-plan-request"]) {
      response.writeHead(400).end("{}");
      return;
    }

    if (request.method === "GET" && request.url === "/") {
      this.accountRequests++;
      this.send(this.accountAnswers.shift() ?? this.accountAnswer(), response);
      return;
    }

    const metadata = this.metadata(request);
    if (metadata !== undefined) {
      this.send({ status: 200, body: metadata }, response);
      return;
    }

    const body = Buffer.concat(chunks).toString();
    this.requests.push({
      path: request.url!,
      headers: request.headers,
      body: body === "" ? undefined : JSON.parse(body),
    });
    this.send(
      this.answers.shift() ?? {
        status: 500,
        body: { message: "There is no answer left." },
      },
      response
    );
  };

  private send = (answer: Answer, response: ServerResponse): void => {
    if (answer === "hang up") {
      response.socket!.destroy();
      return;
    }
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  };

  private accountAnswer = (): Answer => {
    const [west, east] = ["west", "east"].map((name) => ({
      name,
      databaseAccountEndpoint: `${this.endpoint}${name}/`,
    }));
    return {
      status: 200,
      body: {
        id: "account",
        writableLocations: this.account?.enableMultipleWriteLocations
          ? [west, east]
          : [west],
        readableLocations: [west, east],
        ...this.account,
      },
    };
  };

  // what the SDK asks for, besides the account and the items, to find out where to send a
  // request
  private metadata = ({ method, url }: IncomingMessage): unknown => {
    if (this.account === undefined || method !== "GET") {
      return undefined;
    }
    if (url!.endsWith("/colls/events")) {
      return { id: "events", partitionKey: { paths: ["/aggregateId"] } };
    }
    if (url!.endsWith("/pkranges")) {
      return {
        PartitionKeyRanges: [{ id: "0", minInclusive: "", maxExclusive: "FF" }],
        _count: 1,
      };
    }
    return undefined;
  };
}
