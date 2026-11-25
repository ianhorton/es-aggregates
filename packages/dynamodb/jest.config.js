
const tsPreset = require('ts-jest/jest-preset')
const jestDynamoDbPreset = require('@shelf/jest-dynamodb/jest-preset')


module.exports = {
  //preset: "ts-jest",
  ...tsPreset,
  ...jestDynamoDbPreset,
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/**/*.+(ts|tsx|js)",
    "**/?(*.)+(spec|test).+(ts|tsx|js)",
  ],
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest",
  },
};
