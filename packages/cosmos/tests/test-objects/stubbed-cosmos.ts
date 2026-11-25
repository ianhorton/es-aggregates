import { Container, CosmosClient } from "@azure/cosmos";
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

/**
 * A container that is not in Cosmos DB, but on a server that records the requests, as
 * the SDK sends them, and that gives each the next answer from a list.
 */
export class StubbedCosmos {
  public static startAsync = async (
    answers: Answer[]
  ): Promise<StubbedCosmos> => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    return new StubbedCosmos(answers, server);
  };

  public readonly requests: SentRequest[] = [];

  // what the SDK itself returned, or threw, for each batch
  public readonly outcomes: unknown[] = [];

  public readonly container: Container;

  private readonly client: CosmosClient;

  private constructor(
    private readonly answers: Answer[],
    private readonly server: Server
  ) {
    server.on("request", this.answerAsync);

    const { port } = server.address() as AddressInfo;
    this.client = new CosmosClient({
      endpoint: `http://127.0.0.1:${port}`,
      key: "bm90IGEgcmVhbCBrZXk=",
      connectionPolicy: {
        enableEndpointDiscovery: false,
        retryOptions: {
          maxRetryAttemptCount: 0,
          fixedRetryIntervalInMilliseconds: 0,
          maxWaitTimeInSeconds: 0,
        },
      },
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

    const body = Buffer.concat(chunks).toString();
    this.requests.push({
      path: request.url!,
      headers: request.headers,
      body: body === "" ? undefined : JSON.parse(body),
    });
    const answer = this.answers.shift();
    if (answer === undefined) {
      response.writeHead(500).end('{"message":"There is no answer left."}');
    } else if (answer === "hang up") {
      request.socket.destroy();
    } else {
      response.writeHead(answer.status, answer.headers);
      response.end(
        answer.body === undefined ? "" : JSON.stringify(answer.body)
      );
    }
  };
}
