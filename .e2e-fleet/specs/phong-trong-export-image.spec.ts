import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Nút "Tải ảnh" trên trang công khai Phòng trống (/r/:token).
 * Chạy trên DEV local: FLEET_BASE_URL=http://localhost:8080 npx playwright test specs/phong-trong-export-image.spec.ts
 * Chạy trên prod sau khi deploy: bỏ FLEET_BASE_URL.
 *
 * Kiểm: nút nằm ngay trái ô Live, bấm thì tải được PNG hợp lệ, không lỗi console.
 */
const OUT = path.resolve(process.cwd(), '../.playwright-out');

function trackConsoleErrors(page: import('@playwright/test').Page): string[] {
  const errs: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Lọc nhiễu mạng/ảnh placeholder — không phải lỗi của tính năng.
    if (/net::ERR_|Failed to load resource|picsum|favicon|ERR_BLOCKED/i.test(t)) return;
    errs.push(t);
  });
  page.on('pageerror', (e) => errs.push(String(e)));
  return errs;
}

for (const token of ['demo', 'dsphongtrong']) {
  test(`/r/${token}: nút Tải ảnh xuất PNG danh sách phòng trống`, async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await page.goto(`/r/${token}`);

    const btn = page.locator('button.hdr-dl');
    const live = page.locator('.live');
    await expect(btn).toBeVisible();
    await expect(live).toBeVisible();
    await expect(btn).toHaveText(/Tải ảnh/);

    // Nút phải nằm BÊN TRÁI ô Live trên cùng một hàng.
    const b = (await btn.boundingBox())!;
    const l = (await live.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(l.x + 1);
    expect(Math.abs(b.y - l.y)).toBeLessThan(20);

    // Chờ danh sách phòng nạp xong rồi mới bấm (tránh xuất ảnh rỗng).
    await expect(page.locator('.ov-bld').first()).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      btn.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^danh-sach-phong-trong-\d{8}\.png$/);
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${token}-${download.suggestedFilename()}`);
    await download.saveAs(file);

    const buf = fs.readFileSync(file);
    // PNG magic + kích thước đọc từ chunk IHDR (không cần thư viện ảnh).
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    expect(w).toBe(2800);            // 1400px @ DPR 2
    expect(h).toBeGreaterThan(600);  // tiêu đề + thông tin chung + ít nhất vài hàng
    expect(buf.length).toBeGreaterThan(20_000);
    console.log(`[${token}] ${path.basename(file)} — ${w}×${h}, ${(buf.length / 1024).toFixed(0)} kB`);

    // .toast của trang này, KHÔNG phải <li class="toast"> của sonner (toaster chung).
    await expect(page.locator('div.toast.show')).toContainText(/Đã tải ảnh \d+ phòng trống/);

    // Toaster chung không được nổi toast lỗi nào trên trang công khai.
    const sonner = await page.locator('[data-sonner-toast]').allInnerTexts();
    expect(sonner, `sonner toasts: ${JSON.stringify(sonner)}`).toEqual([]);

    expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
  });
}

test('màn hẹp: nút Tải ảnh + ô Live vẫn nằm trên 1 dòng với thanh thương hiệu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14
  await page.goto('/r/dsphongtrong');

  const mark = page.locator('.brand-mark');
  const btn = page.locator('button.hdr-dl');
  const live = page.locator('.live');
  await expect(btn).toBeVisible();

  const [m, b, l] = await Promise.all([mark.boundingBox(), btn.boundingBox(), live.boundingBox()]);
  // Cùng một hàng: tâm theo trục dọc lệch nhau không quá vài px.
  const midY = (r: { y: number; height: number }) => r.y + r.height / 2;
  expect(Math.abs(midY(b!) - midY(m!))).toBeLessThan(6);
  expect(Math.abs(midY(l!) - midY(m!))).toBeLessThan(6);
  // Thứ tự trái → phải: logo … nút … ô Live, không đè nhau.
  expect(b!.x).toBeGreaterThan(m!.x + m!.width);
  expect(b!.x + b!.width).toBeLessThanOrEqual(l!.x + 1);
  // Ô Live không bị bó thành 2 dòng (cao gấp đôi).
  expect(l!.height).toBeLessThan(30);
});
