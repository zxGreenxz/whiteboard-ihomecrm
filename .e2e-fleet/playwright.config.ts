import { defineConfig } from '@playwright/test';

/**
 * Mở khoá bản preview của Vercel, và CHỈ khi được đưa chìa.
 *
 * Deployment preview bật **Vercel Authentication**: mọi request không mang chứng
 * chỉ đều nhận trang đăng nhập SSO thay vì app. Cách mở chính thức là "Protection
 * Bypass for Automation" — một giá trị bí mật gửi qua `x-vercel-protection-bypass`
 * (kèm `x-vercel-set-bypass-cookie` để Vercel đặt cookie, nhờ đó các request con
 * của trang — JS bundle, ảnh, API — đi qua mà không phải gắn lại header).
 *
 * Trả về object RỖNG khi biến môi trường không có, nên chạy tay trên production
 * hay trên máy local giữ NGUYÊN hành vi cũ: không thêm header lạ nào. Gửi một
 * header bypass rỗng thì vô hại nhưng cũng vô nghĩa, và nó khiến người đọc tưởng
 * cấu hình đang có bypass trong khi không.
 */
function headerMoKhoaPreview(): { extraHTTPHeaders: Record<string, string> } | Record<string, never> {
  const bimat = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!bimat) return {};
  return {
    extraHTTPHeaders: {
      'x-vercel-protection-bypass': bimat,
      'x-vercel-set-bypass-cookie': 'true',
    },
  };
}

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
    baseURL: process.env.FLEET_BASE_URL || 'https://ptcrm.vercel.app',
    headless: process.env.FLEET_HEADED ? false : true,
    launchOptions: { slowMo: process.env.FLEET_HEADED ? 350 : 0 }, // chậm lại để nhìn rõ thao tác
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'off',
    screenshot: 'off',
    ...headerMoKhoaPreview(),
  },
});
