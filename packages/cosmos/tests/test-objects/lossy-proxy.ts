import { Container, CosmosClient } from "@azure/cosmos";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";

import { Emulator } from "./emulator";
import { StubbedCosmos } from "./stubbed-cosmos";

/**
 * Stands between the SDK and the emulator, and loses the answer to the first batch: the
 * emulator has stored it, but the SDK is told that the service is unavailable. The account
 * is one on which the SDK then sends the batch again.
 */
export class LossyProxy {
  public static startAsync = async (
    emulator: Emulator
  ): Promise<LossyProxy> => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    return new LossyProxy(emulator, server);
  };

  // the status codes with which the emulator answered the batches
  public readonly batches: number[] = [];

  // that of the emulator, by way of the proxy
  public readonly container: Container;

  private readonly client: CosmosClient;

  private constructor(emulator: Emulator, private readonly server: Server) {
    server.on("request", this.passOnAsync);

    const { port } = server.address() as AddressInfo;
    this.client = new CosmosClient({
      endpoint: `http://127.0.0.1:${port}/`,
      key: Emulator.key,
      connectionPolicy: StubbedCosmos.sendAgain,
    });
    this.container = this.client
      .database(emulator.container.database.id)
      .container(emulator.container.id);
  }

  public stopAsync = async (): Promise<void> => {
    this.client.dispose();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  };

  private passOnAsync = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const { host, connection, ...headers } = request.headers;
    const answer = await fetch(new URL(request.url!, Emulator.endpoint), {
      method: request.method,
      headers: headers as Record<string, string>,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });
    const body = await answer.text();

    if (headers["x-ms-cosmos-is-batch-request"]) {
      this.batches.push(answer.status);
      if (this.batches.length === 1) {
        response.writeHead(503).end('{"message":"It is unavailable."}');
        return;
      }
    }

    response.writeHead(
      answer.status,
      [...answer.headers].filter(([name]) => name.startsWith("x-ms-")).flat()
    );
    response.end(
      request.url === "/" ? this.withFailover(JSON.parse(body), host!) : body
    );
  };

  // the account, with the proxy as its only region
  private withFailover = (account: object, host: string): string => {
    const locations = [
      { name: "proxy", databaseAccountEndpoint: `http://${host}/` },
    ];
    return JSON.stringify({
      ...account,
      writableLocations: locations,
      readableLocations: locations,
      enablePerPartitionFailoverBehavior: true,
    });
  };
}
