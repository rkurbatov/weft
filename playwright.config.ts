// Browser tests: a small set, and only for what Node cannot show honestly.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  // A search over four million lines takes a second, and the corpus takes a
  // few to build: generous, but not endless.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // One at a time: these measure a busy worker, and two of them measure each
  // other instead.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm demo:build && pnpm exec vite preview --port 4173',
    url: 'http://localhost:4173/engine/',
    reuseExistingServer: true,
    timeout: 180_000,
  },
})
