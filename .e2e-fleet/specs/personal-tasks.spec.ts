import { expect, test, type Locator, type Page } from '@playwright/test';
import { credentials, trackConsoleErrors } from './auth';

// Only browser-local fixtures; the existing DEMO account is used for sign-in.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
async function login(page: Page, role: 'quanly' | 'chunha' = 'quanly') {
  const user = credentials(role);
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Tài Khoản' }).fill(user.email);
  await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(user.pass);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'));
}
async function add(page: Page, text: string) {
  await page.getByRole('button', { name: 'Thêm việc', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nội dung công việc' }).fill(text);
  await page.getByRole('dialog').getByRole('button', { name: 'Thêm việc', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function gesture(row: Locator, dx: number, cancel = false, dy = 0) {
  const init = { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: 170, clientY: 200 };
  await row.dispatchEvent('pointerdown', init);
  // Browser capture requires a real active pointer; dispatch tests gesture classification separately.
  await row.evaluate(element => { element.setPointerCapture = () => {}; });
  await row.dispatchEvent('pointermove', { ...init, clientX: 170 + dx, clientY: 200 + dy });
  await row.dispatchEvent(cancel ? 'pointercancel' : 'pointerup', { ...init, clientX: 170 + dx, clientY: 200 + dy });
}
const activeRow = (page: Page) => page.locator('.ptask-column.active .ptask-row-face').first();

test('mobile launcher, lịch hẹn, hoàn thành, trả lại, lưu offline và tải bản sao', async ({ page, context }) => {
  const errors = trackConsoleErrors(page);
  await login(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Việc của tôi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Việc của tôi', exact: true })).toBeVisible();
  // Start from a fresh route so Home's existing heavy-page prefetch is not counted as task traffic.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Thêm việc', exact: true })).toBeEnabled();
  const taskRequests: string[] = [];
  page.on('request', request => { if (/\/rest\/v1\/(jobs|tasks|personal_tasks|web2_tasks)(\?|$|\/)/.test(request.url())) taskRequests.push(request.url()); });
  await add(page, 'Gọi điện cho gia đình');
  await add(page, '<img src=x onerror=alert(1)> Mua sách');
  await expect(page.locator('.ptask-app img')).toHaveCount(0);
  await gesture(activeRow(page), -90);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '20:00', exact: true }).click();
  await page.getByRole('button', { name: /^Lưu · 20:00/ }).click();
  await page.getByRole('tab', { name: 'Đang xử lý 1' }).click();
  await expect(page.locator('.ptask-column.active .ptask-due-chip')).toContainText('20:00');
  await page.getByRole('button', { name: 'Thao tác: Gọi điện cho gia đình' }).click();
  await page.getByRole('menuitem', { name: 'Đánh dấu xong' }).click();
  await expect(page.locator('.ptask-total')).toHaveText('còn 1 việc');
  await page.getByRole('tab', { name: 'Cần làm 1' }).click();
  await expect(page.locator('.ptask-column.active .ptask-row')).toHaveCount(2);
  await expect(page.locator('.ptask-column.active .ptask-done-check')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Đã xử lý 1' }).click();
  await expect(page.locator('.ptask-column.active .ptask-done-check')).toHaveCount(1);
  await gesture(activeRow(page), -90);
  await page.getByRole('tab', { name: 'Cần làm 2' }).click();
  await context.setOffline(true);
  await add(page, 'Việc được lưu khi mất mạng');
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('.ptask-total')).toHaveText('còn 3 việc');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải bản sao công việc' }).click();
  expect((await download).suggestedFilename()).toMatch(/^viec-cua-toi-.*\.json$/);
  expect(taskRequests).toEqual([]);
  await expect(page.getByTestId('copilot-launcher')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/personal-tasks-mobile.png' });
  expect(errors).toEqual([]);
});

test('ngưỡng vuốt, hủy cử chỉ, cuộn dọc và breakpoint 600/601', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page, 'chunha');
  await page.goto('/viec-cua-toi');
  await add(page, 'Kiểm tra cử chỉ cảm ứng');
  for (const [dx, cancel, dy] of [[71, false, 0], [100, true, 0], [100, false, 150]] as const) {
    await gesture(activeRow(page), dx, cancel, dy);
    await expect(page.locator('.ptask-total')).toHaveText('còn 1 việc');
  }
  // One real browser touch sequence in addition to deterministic pointer-cancel fixtures.
  const box = await activeRow(page).boundingBox();
  if (!box) throw new Error('Missing task row');
  const touch = await page.context().newCDPSession(page);
  const x = box.x + 55; const y = box.y + box.height / 2;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 40, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 100, y }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(page.locator('.ptask-total')).toHaveText('còn 0 việc');
  await page.setViewportSize({ width: 600, height: 844 });
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.setViewportSize({ width: 601, height: 844 });
  await expect(page.getByRole('tablist')).toBeHidden();
  await expect(page.locator('.ptask-column:visible')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'test-results/personal-tasks-desktop.png' });
  expect(errors).toEqual([]);
});

test('lỗi ghi không đóng sheet hoặc tăng số đếm; kho hỏng không bị ghi đè', async ({ page }) => {
  await login(page);
  await page.goto('/viec-cua-toi');
  await expect(page.locator('.ptask-total')).toHaveText('còn 0 việc');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('ihomecrm:personal-tasks:')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Thêm việc', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nội dung công việc' }).fill('Chưa lưu');
  await page.getByRole('dialog').getByRole('button', { name: 'Thêm việc', exact: true }).click();
  await expect(page.getByText(/Chưa lưu được công việc/)).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.ptask-total')).toHaveText('còn 0 việc');
  await page.reload();
  await add(page, 'Dữ liệu cần giữ');
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('ihomecrm:personal-tasks:'))!;
    localStorage.setItem(key, 'corrupt fixture');
  });
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Không đọc được việc' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm việc', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('ihomecrm:personal-tasks:')).map(key => localStorage.getItem(key)))).toEqual(['corrupt fixture']);
});

test('sheet hủy, bàn phím Enter, focus và hẹn lại đúng dữ liệu cũ', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await login(page);
  await page.goto('/viec-cua-toi');
  await page.getByRole('button', { name: 'Thêm việc', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Nội dung công việc' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Nội dung công việc' }).fill('   ');
  await page.getByRole('textbox', { name: 'Nội dung công việc' }).press('Enter');
  await expect(page.getByText('Nhập nội dung công việc', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Thêm việc', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Thêm việc', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Nội dung công việc' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Nội dung công việc' }).fill('Đi dạo');
  await page.getByRole('textbox', { name: 'Nội dung công việc' }).press('Enter');
  await gesture(activeRow(page), -90);
  await page.getByLabel('Giờ hoàn thành').fill('09:35');
  await page.getByRole('button', { name: /^Lưu · 09:35/ }).click();
  await page.getByRole('tab', { name: 'Đang xử lý 1' }).click();
  await gesture(activeRow(page), -90);
  await expect(page.getByLabel('Giờ hoàn thành')).toHaveValue('09:35');
  await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds?.x).toBe(0);
  expect(bounds?.width).toBe(390);
  await page.screenshot({ path: 'test-results/personal-tasks-calendar.png' });
  await page.getByRole('button', { name: 'Xóa hẹn', exact: true }).click();
  await page.getByRole('tab', { name: 'Cần làm 1' }).click();
  await expect(page.locator('.ptask-column.active')).toContainText('Đi dạo');
  expect(errors).toEqual([]);
});

test.describe('chuột và bàn phím', () => {
  test.use({ hasTouch: false, viewport: { width: 390, height: 844 } });
  test('cửa sổ hẹp có nút thao tác, lịch không cần vuốt', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await login(page);
    await page.goto('/viec-cua-toi');
    await add(page, 'Việc thao tác bằng chuột');
    await page.getByRole('button', { name: 'Hẹn giờ', exact: true }).click();
    await page.getByRole('button', { name: 'Tháng sau', exact: true }).click();
    const date = page.locator('.ptask-day:not(.outside)').nth(5);
    const selected = await date.getAttribute('aria-label');
    await date.click();
    await expect(date).toHaveAttribute('aria-pressed', 'true');
    expect(selected).toMatch(/^Ngày \d{4}-\d{2}-06$/);
    await page.getByRole('button', { name: '08:00', exact: true }).click();
    await page.getByRole('button', { name: /^Lưu · 08:00/ }).click();
    await page.getByRole('tab', { name: 'Cần làm 0' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Đang xử lý 1' })).toBeFocused();
    await page.getByRole('button', { name: 'Đánh dấu xong', exact: true }).click();
    await page.getByRole('tab', { name: 'Đã xử lý 1' }).click();
    await page.getByRole('button', { name: 'Trả lại Cần làm', exact: true }).click();
    await expect(page.locator('.ptask-total')).toHaveText('còn 1 việc');
    expect(errors).toEqual([]);
  });
});
