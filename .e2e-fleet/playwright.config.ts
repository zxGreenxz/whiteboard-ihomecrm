import { defineConfig } from '@playwright/test';

// Harness parallel: mỗi test() chạy trên 1 worker (browser context độc lập).
// Tăng workers = mở nhiều trình duyệt cùng lúc. Chạy headless trên prod.
export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: Number(process.env.FLEET_WORKERS || 8), // số trình duyệt song song
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'https://ptcrm.vercel.app',
    headless: process.env.FLEET_HEADED ? false : true,
    launchOptions: { slowMo: process.env.FLEET_HEADED ? 350 : 0 }, // chậm lại để nhìn rõ thao tác
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'off',
    screenshot: 'off',
  },
});
