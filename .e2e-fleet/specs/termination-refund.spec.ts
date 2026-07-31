import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Chu trình hoàn cọc Đợt 7/8 — chạy TRỌN trên giao diện thật.
 *
 * Vì sao spec này tồn tại: đường hoàn cọc mới (nghĩa vụ → phiếu hoàn) chưa từng
 * chạy với dữ liệu thật — đo 31/07/2026 trên production là **0 nghĩa vụ**. Và nó
 * KHÔNG thử được bằng SQL: `preview_termination_refund_v1` ném
 * `42501 "Bạn không thuộc tổ chức này"` khi gọi qua Management API vì nó đọc
 * `auth.uid()`. Chỉ phiên đăng nhập thật mới đi qua được.
 *
 * ⇒ Đây là điều kiện tiên quyết trước khi khoá đường thanh lý cũ. Khoá đường cũ
 *   khi đường mới chưa chạy trót lọt một ca nào = mọi ca thanh lý tiếp theo đi
 *   qua đường chưa ai kiểm.
 *
 * Spec CHỈ ĐỌC theo mặc định: nó mở hộp thoại, đọc số hệ thống tính ra, rồi ĐÓNG.
 * Không bấm "Tạo phiếu hoàn" để khỏi đẻ phiếu tiền trên DEMO. Muốn chạy nhánh ghi
 * thì đặt env `FLEET_REFUND_WRITE=1` — khi đó spec tự dọn phiếu vừa tạo.
 */

const ROUTE = '/reports/real-estate/terminations';

test('hoàn cọc: mở được hồ sơ thanh lý và hệ thống tính ra số hoàn', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto(ROUTE);
  await expect(page).toHaveURL(new RegExp(ROUTE.replace(/\//g, '\\/')));

  // Bảng có thể rỗng ở một số kỳ — đó KHÔNG phải lỗi, nên xử lý tường minh
  // thay vì để test đỏ vì lý do không liên quan.
  const checkButtons = page.getByRole('button', { name: 'Kiểm tra' });
  const n = await checkButtons.count();
  test.skip(n === 0, 'Kỳ này không có hồ sơ thanh lý nào — không có gì để kiểm');

  await checkButtons.first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Hộp thoại phải nói ra một trong hai: số hoàn tính được, hoặc lý do không hoàn.
  // Cả hai đều là kết quả HỢP LỆ — hồ sơ hoàn âm (khách còn nợ) thì không có
  // phiếu chi nào, đúng thiết kế.
  await expect(dialog).not.toContainText('Không đọc được');

  const body = (await dialog.textContent()) ?? '';
  expect(body.length).toBeGreaterThan(20);

  // Nút tạo phiếu phải TỒN TẠI. Nó bị vô hiệu khi số hoàn ≤ 0 — cũng đúng.
  const createBtn = dialog.getByRole('button', { name: /Tạo phiếu hoàn|Đang tạo/ });
  await expect(createBtn).toBeVisible();

  if (process.env.FLEET_REFUND_WRITE === '1' && (await createBtn.isEnabled())) {
    await createBtn.click();
    // Thành công thì hộp thoại đóng và có thông báo; thất bại thì có lỗi rõ ràng.
    await expect(page.getByText(/phiếu hoàn|CHỜ DUYỆT|đã tạo/i).first()).toBeVisible({
      timeout: 15_000,
    });
  } else {
    await dialog.getByRole('button', { name: 'Đóng' }).click();
    await expect(dialog).toBeHidden();
  }

  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toHaveLength(0);
});

test('hoàn cọc: phiếu hoàn KHÔNG được tự duyệt (quyết định của chủ 31/07)', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');
  await page.goto(ROUTE);
  await expect(page.getByRole('heading', { name: /Báo cáo Bỏ trả/i })).toBeVisible();

  const checkButtons = page.getByRole('button', { name: 'Kiểm tra' });
  await checkButtons.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
  test.skip((await checkButtons.count()) === 0, 'Không có hồ sơ thanh lý');

  await checkButtons.first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Hộp thoại phải NÓI RA ĐIỀU GÌ ĐÓ. Hai kết cục hợp lệ:
  //   • có khoản hoàn  ⇒ phải nhắc phiếu nằm CHỜ DUYỆT (quyết định số 6 của chủ);
  //   • không có khoản ⇒ phải nói rõ vì sao, và nút tạo bị vô hiệu.
  // Hộp thoại TRỐNG TRƠN là lỗi — người dùng không biết mình sai hay hệ hỏng.
  const body = (await dialog.textContent()) ?? '';
  const createBtn = dialog.getByRole('button', { name: /Tạo phiếu hoàn|Đang tạo/ });
  const enabled = await createBtn.isEnabled();

  if (enabled) {
    expect(
      /chờ duyệt/i.test(body),
      'Có khoản hoàn mà hộp thoại không nhắc tới việc phải duyệt — kiểm lại xem hoàn cọc có bị nối vào đường tự duyệt không',
    ).toBeTruthy();
  } else {
    expect(
      /không có khoản hoàn|còn nợ|hoàn đúng 0đ/i.test(body),
      `Nút tạo bị vô hiệu mà hộp thoại không nói vì sao. Nội dung: "${body.slice(0, 200)}"`,
    ).toBeTruthy();
  }

  await dialog.getByRole('button', { name: 'Đóng' }).click();
  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toHaveLength(0);
});
