/**
 * @type {import('@shelf/jest-dynamodb/lib').Config}')}
 */
const config = {
  tables: [
    {
      TableName: "test-service-event-dev",
      KeySchema: [
        { AttributeName: "aggregateId", KeyType: "HASH" },
        { AttributeName: "aggregateVersion", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "aggregateId", AttributeType: "S" },
        { AttributeName: "aggregateVersion", AttributeType: "N" },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    },
    // etc
  ],
  port: 8000,
};
module.exports = config;
