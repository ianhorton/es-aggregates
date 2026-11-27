
const tsPreset = require('ts-jest/jest-preset')


module.exports = {
  //preset: "ts-jest",
  ...tsPreset,
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/**/*.+(ts|tsx|js)",
    "**/?(*.)+(spec|test).+(ts|tsx|js)",
  ],
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest",
  },
  // finds out whether Postgres is running
  globalSetup: "<rootDir>/tests/global-setup.ts",
};
