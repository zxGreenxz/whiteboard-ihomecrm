import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * CHU TRÌNH GHI TRỌN VÒNG của đường hoàn cọc mới, trên DEMO:
 *
 *     hồ sơ thanh lý → nghĩa vụ (record) → phiếu hoàn (create, CHỜ DUYỆT)
 *
 * Đây chính là điều kiện §17.6 / §16.8 của bộ tài liệu thu-tien đặt ra từ
 * 31/07/2026 để được phép khoá đường thanh lý cũ: "đường mới phải chạy trót lọt
 * một ca thật trước". Spec đọc-only (`termination-refund.spec.ts`) không đo được
 * điều đó — nút tạo phiếu vô hiệu với mọi hồ sơ DEMO sẵn có (toàn khách-còn-nợ).
 *
 * FIXTURE: spec KHÔNG tự seed. Chạy trước:
 *     node scripts/seed-demo-hoan-coc.mjs --seed
 * lệnh đó in ra contract number — truyền vào spec qua env:
 *     FLEET_FIXTURE_CONTRACT='HD-...' npx playwright test specs/termination-refund-full-cycle.spec.ts
 * Xong thì dọn:
 *     node scripts/seed-demo-hoan-coc.mjs --don
 * Thiếu env ⇒ spec TỰ SKIP — nó không bao giờ bấm "Tạo phiếu hoàn" trên hồ sơ
 * không phải của nó.
 *
 * Fixture cố ý KHÔNG có cọc thật đã thu ⇒ nghĩa vụ thường cảnh báo và spec đi
 * qua đường ÉP của chủ tổ chức (demo.chunha giữ vai TENANT_OWNER từ 28/08) —
 * đường nhiều chốt chặn nhất: đòi vai + lý do ≥ 8 ký tự. Nếu hợp đồng fixture
 * tình cờ CÓ cọc thật đủ (nghĩa vụ OK) thì spec đi đường thường — cả hai đều là
 * chu trình trọn vòng hợp lệ. Chạy xong nghĩa là: preview → record (khoá trước
 * khi chụp cơ sở, vá F11) → create (marker termination.refund, vá F1; một phiếu
 * sống một hồ sơ, vá F2; cổng APPROVED/COMPLETED, vá F3) đều sống với phiên
 * đăng nhập thật.
 */

const ROUTE = '/reports/real-estate/terminations';
const FIXTURE = process.env.FLEET_FIXTURE_CONTRACT;

test('hoàn cọc trọn vòng: sinh phiếu trên hồ sơ fixture, phiếu ra CHỜ DUYỆT, gọi lại không đẻ phiếu thứ hai', async ({ page }) => {
  test.skip(!FIXTURE, 'Thiếu FLEET_FIXTURE_CONTRACT — seed rồi truyền contract number vào');
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto(ROUTE);
  await expect(page.getByRole('heading', { name: /Báo cáo Bỏ trả/i })).toBeVisible();

  // Tìm ĐÚNG dòng fixture theo mã hợp đồng seeder in ra. Kỳ lọc mặc định là
  // tháng hiện tại — fixture có actual_end_date = hôm nay nên luôn lọt kỳ.
  const row = page.getByRole('row').filter({ hasText: FIXTURE! }).first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });

  await row.getByRole('button', { name: 'Kiểm tra' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Số hoàn trên hồ sơ/i).first()).toBeVisible({ timeout: 20_000 });

  // Nghĩa vụ cảnh báo ⇒ điền lý do (đường ép của chủ). Nghĩa vụ OK ⇒ đi thẳng.
  const reasonBox = dialog.getByPlaceholder(/Lý do vẫn hoàn/i);
  if (await reasonBox.isVisible().catch(() => false)) {
    await reasonBox.fill(
      'E2E chu trình trọn vòng: fixture cố ý không có cọc thật, chủ chấp nhận chi để kiểm đường ép',
    );
  }

  const createBtn = dialog.getByRole('button', { name: /Tạo phiếu hoàn|Đang tạo/ });
  await expect(createBtn).toBeEnabled();
  await createBtn.click();

  // Điểm đo quan trọng nhất: phiếu ĐƯỢC TẠO nhưng KHÔNG tự duyệt, không tự vào
  // sổ (quyết định của chủ 31/07) — toast phải nêu mã phiếu + CHỜ DUYỆT.
  const toast = page.getByText(/Đã tạo phiếu hoàn .*CHỜ DUYỆT/i).first();
  await expect(toast).toBeVisible({ timeout: 20_000 });
  const toastText = (await toast.textContent()) ?? '';
  const code = toastText.match(/PC\d+/)?.[0] ?? null;
  expect(code, `Toast không nêu mã phiếu: "${toastText}"`).not.toBeNull();

  // GỌI LẠI trên cùng hồ sơ ⇒ phải trả ĐÚNG phiếu cũ (F2: một phiếu sống một hồ
  // sơ — kể cả khi lần bấm thứ hai record thêm một phiên bản nghĩa vụ mới).
  await row.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Số hoàn trên hồ sơ/i).first()).toBeVisible({ timeout: 20_000 });
  const reasonBox2 = dialog.getByPlaceholder(/Lý do vẫn hoàn/i);
  if (await reasonBox2.isVisible().catch(() => false)) {
    await reasonBox2.fill('gọi lại lần hai — phải trả phiếu cũ, không đẻ phiếu mới');
  }
  await dialog.getByRole('button', { name: /Tạo phiếu hoàn|Đang tạo/ }).click();
  await expect(
    page.getByText(new RegExp(`đã có phiếu hoàn\\s+${code}`, 'i')).first(),
    'Lần hai phải báo "đã có phiếu hoàn <mã cũ>" — nếu ra mã MỚI là F2 đã hở lại',
  ).toBeVisible({ timeout: 20_000 });

  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toHaveLength(0);
});
