import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import * as dynamodb from "../src";

describe("The package", () => {
  // 1.x did so too, and apps import them from here
  it("should export DynamoDBClient and unmarshall of the AWS SDK", () => {
    expect(dynamodb.DynamoDBClient).toBe(DynamoDBClient);
    expect(dynamodb.unmarshall).toBe(unmarshall);
  });
});
