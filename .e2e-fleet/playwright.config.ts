import { defineConfig } from '@playwright/test';

import { DUONG_DAN_COOKIE_BYPASS } from './global-setup';

/**
 * Mở khoá bản preview của Vercel, và CHỈ khi được đưa chìa.
 *
 * Deployment preview bật **Vercel Authentication**: mọi request không mang chứng
 * chỉ đều nhận trang đăng nhập SSO thay vì app. Cách mở chính thức là "Protection
 * Bypass for Automation" — một giá trị bí mật gửi qua `x-vercel-protection-bypass`.
 *
 * Chìa đó được đưa MỘT LẦN trong `global-setup.ts`, đổi lấy cookie `_vercel_jwt`
 * gắn với host preview, rồi cả suite chạy bằng cookie đó (`storageState`).
 * TUYỆT ĐỐI không quay lại `use.extraHTTPHeaders`: Playwright gắn header đó vào
 * MỌI request của context, kể cả `fetch` của app sang `*.supabase.co`, và
 * preflight CORS ở đó từ chối `x-vercel-set-bypass-cookie` (đo 02/09/2026, 3/7
 * test Copilot đỏ). Cookie theo luật same-origin nên không bao giờ rời host
 * preview — xem chú thích dài trong `global-setup.ts`.
 *
 * Không có biến môi trường thì không có storageState: chạy tay trên production
 * hay trên máy local giữ NGUYÊN hành vi cũ.
 */
function trangThaiMoKhoaPreview(): { storageState: string } | Record<string, never> {
  if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET || !process.env.FLEET_BASE_URL) return {};
  return { storageState: DUONG_DAN_COOKIE_BYPASS };
}

// Harness parallel: mỗi test() chạy trên 1 worker (browser context độc lập).
// Tăng workers = mở nhiều trình duyệt cùng lúc. Chạy headless trên prod.
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: Number(process.env.FLEET_WORKERS || 8), // số trình duyệt song song
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.FLEET_BASE_URL || 'https://ptcrm.vercel.app',
    headless: process.env.FLEET_HEADED ? false : true,
    launchOptions: { slowMo: process.env.FLEET_HEADED ? 350 : 0 }, // chậm lại để nhìn rõ thao tác
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'off',
    screenshot: 'off',
    ...trangThaiMoKhoaPreview(),
  },
});
