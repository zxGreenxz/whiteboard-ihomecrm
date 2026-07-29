import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Án lệ 29/07/2026 (NATHAN, phòng 405 toà 1392QT): Thu chi → Thêm phiếu →
 * hạng mục "Tiền Cọc" + CHỌN PHÒNG → bấm Lưu ra toast
 *   "Writer phiếu nháp tổng quát đã tác động trạng thái giữ phòng"
 * và KHÔNG có phiếu nào được tạo.
 *
 * Gốc: 20260727120000 bỏ system_only của hạng mục cọc nên phiếu cọc lần đầu đi
 * qua create_income_expense_v1, trong khi writer còn hậu kiểm "rooms.status
 * không được đổi" — mà phiếu cọc thì BẮT BUỘC lật phòng AVAILABLE → RESERVED
 * (recompute_room_reservation). Writer tự bắn 23514 vào chính lớp phiếu nó vừa
 * được mở cửa cho. Vá ở 20260729120000: nới đúng khe đó.
 *
 * Bài này đi UI THẬT trên phòng TRỐNG (đúng điều kiện gây lỗi) và chốt luôn hệ
 * quả nghiệp vụ: phòng phải bị khoá RESERVED, và huỷ phiếu thì mở lại AVAILABLE.
 * Phòng cọc-đã-gắn-HĐ (hậu kiểm contracts.deposit_paid) không test ở đây vì
 * không có HĐ DEMO nào dọn sạch được sau bài — ca đó chốt bằng probe DB.
 */

const CANONICAL = /\/rest\/v1\/rpc\/create_income_expense_v1\b/;
const BUILDING = 'Tòa DEMO A';

async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  return {
    base: new URL(req.url()).origin,
    apikey: h['apikey'] as string,
    auth: h['authorization'] as string,
  };
}
type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;

const jsonHeaders = (a: SbAuth) => ({
  apikey: a.apikey,
  Authorization: a.auth,
  'Content-Type': 'application/json',
  'Content-Profile': 'public',
  'Accept-Profile': 'public',
});

async function sbGet(a: SbAuth, path: string) {
  const r = await fetch(`${a.base}/rest/v1/${path}`, {
    headers: { apikey: a.apikey, Authorization: a.auth, 'Accept-Profile': 'public' },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const roomStatus = async (a: SbAuth, roomId: string) =>
  ((await sbGet(a, `rooms?select=status&id=eq.${roomId}`)) as { status: string }[])[0]?.status;

test('phieu-coc-chon-phong-trong-tao-duoc-va-khoa-phong', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const name = `E2E coc giu cho ${Date.now()}`;
  let voucherId: string | null = null;
  let auth: SbAuth | null = null;
  let roomId: string | null = null;

  await login(page, 'chunha');
  const nav = page.goto('/income-expense');
  auth = await captureSupabaseAuth(page);
  await nav;

  // Phòng TRỐNG, chưa có HĐ hiệu lực — đúng điều kiện làm recompute lật trạng thái.
  const [building] = await sbGet(
    auth,
    `buildings?select=id&name=eq.${encodeURIComponent(BUILDING)}&limit=1`,
  );
  expect(building, `phải có toà "${BUILDING}" trong org DEMO`).toBeTruthy();
  const freeRooms = (await sbGet(
    auth,
    `rooms?select=id,name&building_id=eq.${building.id}&status=eq.AVAILABLE&deleted_at=is.null&order=name`,
  )) as { id: string; name: string }[];
  expect(freeRooms.length, 'DEMO phải còn ít nhất 1 phòng trống').toBeGreaterThan(0);
  const room = freeRooms[0];
  roomId = room.id;

  try {
    await page.getByRole('button', { name: 'Thêm phiếu' }).click();
    await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
    await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();

    await page.getByRole('combobox', { name: 'Tòa nhà *' }).click();
    await page.getByRole('option', { name: BUILDING, exact: true }).click();
    await page.getByRole('combobox', { name: 'Phòng' }).click();
    await page.getByRole('option', { name: room.name, exact: true }).click();
    await page.getByRole('combobox', { name: 'Sổ quỹ *' }).click();
    await page.getByRole('option').first().click();
    await page.getByRole('textbox', { name: /Tên phiếu thu/i }).fill(name);

    await page.getByRole('button', { name: 'Thêm hạng mục' }).click();
    await page.getByRole('checkbox', { name: /Tiền cọc/i }).first().click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await page.getByRole('textbox', { name: 'Số tiền' }).first().fill('2000000');

    // Phòng trống thì phiếu cọc phải để trống HĐ (cọc giữ chỗ, HĐ chưa có).
    // Nếu form auto-gắn nhầm một HĐ đã xoá mềm, writer trả 42501 khó hiểu.
    const [resp] = await Promise.all([
      page.waitForResponse((r) => CANONICAL.test(r.url()), { timeout: 30_000 }),
      page.getByRole('button', { name: /^Lưu$/ }).last().click(),
    ]);
    expect(
      resp.status(),
      `writer canonical phải nhận phiếu cọc có phòng: ${await resp.text()}`,
    ).toBe(200);
    const row = (await resp.json()) as { id: string; approval_status: string };
    voucherId = row.id;
    expect(row.approval_status, 'phiếu thu cọc tự duyệt ngay').toBe('APPROVED');

    // KHÔNG được thấy đúng thông báo của án lệ này.
    await expect(page.getByText(/tác động trạng thái giữ phòng/i)).toHaveCount(0);

    // Hệ quả nghiệp vụ: cọc giữ chỗ phải KHOÁ phòng.
    await expect
      .poll(() => roomStatus(auth!, roomId!), { timeout: 15_000 })
      .toBe('RESERVED');

    expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    if (voucherId && auth) {
      await fetch(`${auth.base}/rest/v1/rpc/cancel_income_expense_v1`, {
        method: 'POST',
        headers: jsonHeaders(auth),
        body: JSON.stringify({ p_voucher_id: voucherId, p_reason: 'E2E cleanup' }),
      }).catch(() => {});
      // Huỷ cọc → phòng phải mở lại (fixture tự dọn, không để phòng kẹt RESERVED).
      await expect
        .poll(() => roomStatus(auth!, roomId!), { timeout: 15_000 })
        .toBe('AVAILABLE');
    }
  }
});
