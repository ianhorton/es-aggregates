export * from "./aggregate/aggregate-root";
export * from "./aggregate/entity";
export * from "./event/event-base";
export * from "./aggregate/repository";
export * from "./aggregate/snapshot";
export * from "./aggregate/snapshot-serializer";
export * from "./event/models/event";

export * from "./event/event-router";
export * from "./event/models/persisted-event";

export { DynamoDBClient } from "@aws-sdk/client-dynamodb";
export { unmarshall } from "@aws-sdk/util-dynamodb";
