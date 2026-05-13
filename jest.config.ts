import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  // Legacy IIFE/ts-node runner files — not Jest suites; run with: npx ts-node <file>
  testPathIgnorePatterns: [
    '/node_modules/',
    'src/lib/encryption.test.ts',
    'src/jobs/maintenance.test.ts',
    'src/jobs/workOrderCreation.test.ts',
    'src/routes/messages.test.ts',
    'src/routes/t033.test.ts',
    'src/routes/t034.test.ts',
    'src/routes/t035.test.ts',
    'src/routes/t036.test.ts',
    'src/routes/t037.test.ts',
    'src/routes/t045.test.ts',
    'src/routes/t046.test.ts',
    'src/routes/t047.test.ts',
    'src/routes/t049.test.ts',
    'src/e2e-integration.test.ts',
  ],
};

export default config;
