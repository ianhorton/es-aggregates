import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Readable } from "stream";

export interface SentRequest {
  operation: string; // such as Query
  body: string; // the JSON that is sent
}

// an HTTP response, or an error for when there is none
export type Answer = { status: number; body: unknown } | Error;

/**
 * A client whose requests go nowhere. They are recorded, as the SDK would have sent
 * them, and each is given the next answer from a list.
 */
export class StubbedDynamoDB {
  public readonly requests: SentRequest[] = [];

  // what the SDK itself threw
  public readonly errors: unknown[] = [];

  public readonly client = new DynamoDBClient({
    region: "local-env",
    credentials: {
      accessKeyId: "fakeMyKeyId",
      secretAccessKey: "fakeSecretAccessKey",
    },
    maxAttempts: 1,
    requestHandler: {
      handle: async ({ headers, body }) => {
        const operation = headers["x-amz-target"].split(".")[1];
        this.requests.push({ operation, body });
        return { response: this.nextResponse() };
      },
      updateHttpClientConfig: () => {},
      httpHandlerConfigs: () => ({}),
    },
  });

  constructor(private readonly answers: Answer[]) {
    this.client.middlewareStack.add(
      (next) => async (args) => {
        try {
          return await next(args);
        } catch (error) {
          this.errors.push(error);
          throw error;
        }
      },
      { step: "initialize", priority: "high" }
    );
  }

  private nextResponse() {
    const answer = this.answers.shift();
    if (answer === undefined) {
      throw new Error("There is no answer left for this request.");
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return {
      statusCode: answer.status,
      headers: {},
      body: Readable.from([Buffer.from(JSON.stringify(answer.body))]),
    };
  }
}
