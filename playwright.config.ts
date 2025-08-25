import { defineConfig } from '@playwright/test';
export default defineConfig({
  timeout: 60000,
  use: { headless: true, viewport: { width: 1366, height: 900 } },
});
