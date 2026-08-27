import { test, expect } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Hai bất biến TIỀN của trang /deposits — thứ vừa được sửa ở Slice −1 §−1.7 và
 * được audit 27/08 xếp vào "đã sửa đúng, đừng để hồi quy":
 *
 *   1. "Đã hoàn" CHỈ hiện khi có phiếu chi termination.refund APPROVED + POSTED
 *      + posting sống. Hồ sơ COMPLETED hay có refund_date KHÔNG đủ. Trên prod
 *      27/08: cả 52 hồ sơ đều COMPLETED và 0 hồ sơ có refund_date — quy tắc cũ
 *      (`!!refund_date || status==='COMPLETED'`) sẽ tuyên bố "Đã hoàn" cho TOÀN
 *      BỘ. Hồi quy về quy tắc cũ = mọi hồ sơ đều xanh — spec này bắt được vì
 *      DEMO chắc chắn có hồ sơ chưa hoàn.
 *
 *   2. Hồ sơ net ÂM phải hiện "Khách còn nợ", tuyệt đối không "Đã hoàn 0đ" —
 *      DEMO có sẵn 2 hồ sơ −2.241.000đ làm fixture tự nhiên (HD-2026-00015/16).
 *
 * Spec CHỈ ĐỌC. Đây là 1 trong 2 spec mà audit §6 nói "không gate nào bảo vệ
 * hai bất biến tiền vừa sửa".
 */

test('/deposits: tab Hoàn / Bỏ cọc — net âm hiện "Khách còn nợ", không có "Đã hoàn 0đ"', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/deposits');
  // Ô KPI phải mang đúng ngữ nghĩa đã chốt 30/07: tiền ĐÃ RA KHỎI KÉT.
  await expect(page.getByText(/Đã hoàn cọc \(tiền đã ra khỏi két\)/i)).toBeVisible({
    timeout: 20_000,
  });

  // Trang mở ở chế độ "Cần xử lý" (triage); bốn tab sổ cọc chỉ render ở chế độ
  // "Sổ cọc đầy đủ" — bấm toggle trước rồi mới tới tab.
  await page.getByRole('button', { name: /Sổ cọc đầy đủ/ }).click();
  await page.getByRole('tab', { name: /Hoàn \/ Bỏ cọc/i }).click();

  // Chờ bảng render: hoặc có dòng dữ liệu, hoặc thông báo rỗng.
  const anyRow = page.getByRole('row').nth(1);
  await anyRow.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});

  const bodyText = (await page.locator('body').textContent()) ?? '';

  // Bất biến 2: không bao giờ có "Đã hoàn 0đ" — đó chính là ca clamp
  // Math.max(0,…) đã sửa. Xuất hiện lại là hồi quy.
  expect(
    /Đã hoàn\s*0\s*[₫đ]/iu.test(bodyText),
    'Thấy "Đã hoàn 0đ" — nhánh REFUND đã hồi quy về clamp Math.max(0,…)',
  ).toBeFalsy();

  // DEMO có 2 hồ sơ net âm (−2.241.000đ) ⇒ tab này phải nói "Khách còn nợ" /
  // "Khách nợ" ở đâu đó. Nếu DEMO bị reseed mất fixture tự nhiên này thì skip
  // thay vì fail mù.
  const negativeShown = /Khách còn nợ|Khách nợ/iu.test(bodyText);
  const hasRows = await page.getByRole('row').count();
  test.skip(hasRows <= 1, 'Tab Hoàn / Bỏ cọc không có dòng nào trên DEMO — không có gì để kiểm');
  expect(
    negativeShown,
    'Không thấy "Khách còn nợ" trên tab Hoàn / Bỏ cọc — hoặc fixture DEMO đổi, hoặc nhánh net âm đã hồi quy',
  ).toBeTruthy();

  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toHaveLength(0);
});

test('/deposits: "Đã hoàn" nếu xuất hiện thì phải kèm mã phiếu — không phải suy từ trạng thái hồ sơ', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');

  await page.goto('/deposits');
  await expect(page.getByText(/Đã hoàn cọc \(tiền đã ra khỏi két\)/i)).toBeVisible({
    timeout: 20_000,
  });
  // Trang mở ở chế độ "Cần xử lý" (triage); bốn tab sổ cọc chỉ render ở chế độ
  // "Sổ cọc đầy đủ" — bấm toggle trước rồi mới tới tab.
  await page.getByRole('button', { name: /Sổ cọc đầy đủ/ }).click();
  await page.getByRole('tab', { name: /Hoàn \/ Bỏ cọc/i }).click();
  await page
    .getByRole('row')
    .nth(1)
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => {});

  // Đếm huy hiệu "Đã hoàn <số tiền>" trong BẢNG (ô KPI header là "Đã hoàn cọc",
  // không lọt filter này). Quy tắc thật nằm ở useDepositDashboard: refund_done ⇔
  // có phiếu POSTED + posting sống, và UI gắn mã phiếu vào tooltip
  // (`title="Phiếu đã vào sổ: PC…"`). Nếu DEMO không có phiếu hoàn POSTED nào
  // thì KHÔNG một dòng nào được phép nói "Đã hoàn" — chính là điểm quy tắc cũ
  // sẽ vỡ (mọi hồ sơ đều COMPLETED nên quy tắc cũ tô xanh tất).
  const rows = page.locator('tbody tr').filter({ hasText: /Đã hoàn(?! cọc)/ });
  const claimed = await rows.count();
  for (let i = 0; i < claimed; i++) {
    // Mỗi dòng tuyên bố "Đã hoàn" phải dẫn được mã phiếu làm bằng chứng —
    // badge mang tooltip "Phiếu đã vào sổ: PC…" do posted_refund_codes đổ vào.
    const title =
      (await rows
        .nth(i)
        .locator('span[title*="Phiếu đã vào sổ"]')
        .first()
        .getAttribute('title')
        .catch(() => null)) ?? '';
    expect(
      /PC\d+/.test(title),
      `Dòng nói "Đã hoàn" mà tooltip không dẫn mã phiếu nào: "${title}"`,
    ).toBeTruthy();
  }

  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toHaveLength(0);
});
