import { expect, test } from '@playwright/test';

import { login, trackConsoleErrors } from './auth';

/**
 * ÁN LỆ 30/07/2026 — tài khoản chủ bấm "Lưu" ở dialog THÊM SỔ QUỸ là ăn 403
 * "Không có quyền tạo sổ quỹ (cashbooks.create)" dù quyền ĐỦ.
 *
 * `create_cashbook_v1` là RPC sổ quỹ DUY NHẤT không có mốc neo (23 hàm còn lại
 * nhận `p_cashbook_id` nên lấy org từ chính sổ), nên nó tự suy ra org bằng:
 *
 *     group by m.organization_id having count(*)=1
 *
 * Vế này đếm số MEMBERSHIP TRONG TỪNG ORG, không đếm SỐ ORG. Người có 1
 * membership ở mỗi org × 2 org thì mọi nhóm đều thoả → query trả 2 dòng, và
 * `select … into` (không `strict`) lặng lẽ lấy dòng đầu = org DEMO. Hàm chấm
 * quyền trên DEMO (DEFAULT_DENY) trong khi người dùng đang đứng ở org thật
 * (ROLE_ALLOW). Cả DB chỉ có 1 người nhiều org nên lỗi sống rất lâu.
 *
 * Migration 20260730250000 phải ĐỔI CHỮ KÝ hàm (thêm `p_organization_id`) nên
 * buộc DROP + CREATE. Spec này gác đúng hai chỗ dễ vỡ nhất của cú đổi đó:
 *
 *   1. PostgREST còn khớp được hàm 11 tham số khi FE chỉ gửi 10 (bundle đang
 *      chạy trên prod không truyền `p_organization_id`).
 *   2. `GRANT EXECUTE … TO authenticated` còn nguyên sau DROP — hàm mới hứng
 *      `ALTER DEFAULT PRIVILEGES` của Supabase nên ACL phải được dọn lại tay;
 *      dọn sai là 403 cho MỌI người, không riêng người nhiều org.
 *
 * Nó đi đường bình thường (tài khoản 1 org) vì đó là đường mà mọi người dùng
 * còn lại đi — nếu grant hoặc overload vỡ thì đỏ ngay tại đây.
 *
 * Chỉ ghi vào org DEMO `dddd…0001`, và tự xoá sổ vừa tạo ở cuối bài. Lưu ý:
 * đường xoá của app (`archive_cashbook_v1`) là XOÁ MỀM — nó set `deleted_at`, nên
 * mỗi lần chạy còn lại một dòng `accounts` đã đánh dấu xoá cùng mấy mảnh auto-bind
 * (scope CASHBOOK + possession binding). Đó là trạng thái mà chính app tạo ra khi
 * người dùng xoá sổ quỹ, và là cách dọn duy nhất app phơi ra — không có đường xoá
 * cứng nào cho client.
 */

const FIXTURE = `ZZ E2E SO QUY ${Date.now()}`;

test('tạo sổ quỹ vẫn chạy sau khi create_cashbook_v1 đổi chữ ký', async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);

  // Bắt status của chính RPC tạo sổ: phân biệt "403 phân quyền" (bug cũ / grant
  // vỡ) với các lỗi khác vốn hiện cùng một toast đỏ trên UI.
  const rpcStatuses: number[] = [];
  const archiveStatuses: number[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/rpc/create_cashbook_v1')) rpcStatuses.push(r.status());
    if (r.url().includes('/rpc/archive_cashbook_v1')) archiveStatuses.push(r.status());
  });

  await login(page, 'chunha');
  await page.goto('/finance/cashbooks');

  await page.getByRole('button', { name: 'Thêm sổ quỹ' }).click();

  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Thêm sổ quỹ' }),
  });
  await expect(dialog).toBeVisible();

  // Chỉ cần điền tên: "Người phụ trách" mặc định là chính mình, ngày đầu kỳ mặc
  // định là hôm nay, số dư đầu kỳ mặc định 0.
  await dialog.getByRole('textbox').first().fill(FIXTURE);
  await dialog.getByRole('button', { name: 'Lưu' }).click();

  // Form chỉ đóng trong onSuccess → dialog biến mất = mutation đã xanh.
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  expect(
    rpcStatuses,
    `create_cashbook_v1 trả về [${rpcStatuses.join(', ')}] — 403 nghĩa là phân quyền/grant vỡ`,
  ).not.toContain(403);
  expect(
    rpcStatuses.some((s) => s >= 200 && s < 300),
    `create_cashbook_v1 không có phản hồi 2xx: [${rpcStatuses.join(', ')}]`,
  ).toBe(true);

  // Sổ mới phải thật sự lên danh sách, không chỉ "RPC không lỗi".
  const search = page.getByPlaceholder('Tìm theo mã hoặc tên sổ quỹ...');
  await search.fill(FIXTURE);
  await search.press('Enter');

  const row = page.getByRole('row').filter({ hasText: FIXTURE });
  await expect(row).toHaveCount(1, { timeout: 30_000 });

  // ── Dọn fixture: xoá sổ vừa tạo (org DEMO không được để rác lại).
  await row.locator('button[title="Xoá"]').click();
  // Radix AlertDialog mang role `alertdialog`, KHÔNG phải `dialog` — dùng
  // getByRole('dialog') ở đây là không bao giờ khớp.
  const confirm = page.getByRole('alertdialog').filter({
    has: page.getByRole('heading', { name: 'Xác nhận xoá sổ quỹ' }),
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Xoá', exact: true }).click();

  // Dòng biến mất KHÔNG chứng minh đã xoá — bảng có thể chỉ re-render/lọc lại.
  // Bằng chứng duy nhất đáng tin là archive_cashbook_v1 trả 2xx; thiếu vế này
  // thì bài test "xanh" mà fixture vẫn nằm lại trong org DEMO.
  await expect
    .poll(() => archiveStatuses.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect(
    archiveStatuses.every((s) => s >= 200 && s < 300),
    `archive_cashbook_v1 trả về [${archiveStatuses.join(', ')}] — fixture chưa được dọn`,
  ).toBe(true);
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  expect(consoleErrors, `Lỗi console: ${consoleErrors.join(' | ')}`).toEqual([]);
});
