import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  testMatch: 'voice-task-lab.spec.ts',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {baseURL:'http://127.0.0.1:4187',headless:true,trace:'off',screenshot:'off'},
  projects: [
    {name:'android-layout',use:{...devices['Pixel 7'],defaultBrowserType:'chromium'}},
    {name:'iphone-layout',use:{...devices['iPhone 13'],defaultBrowserType:'webkit'}},
  ],
  webServer: {command:'node controlled/voice-lab-server.mjs',url:'http://127.0.0.1:4187',reuseExistingServer:false,timeout:30_000},
});
