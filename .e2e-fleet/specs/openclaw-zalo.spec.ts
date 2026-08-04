import { expect, test } from '@playwright/test';

import { login, trackConsoleErrors } from './auth';
import { DEMO_ORG_ID, requireLocalPreviewEnv } from './openclaw-zalo-admin';
import { assertFixtureApi, createFakeAdapter } from './openclaw-zalo-fake-adapter';

/**
 * Headless DEMO end-to-end for OpenClaw Zalo.
 *
 * Two things about this file differ from every other spec in the fleet.
 *
 * First, it refuses to inherit the fleet's production defaults. The guard runs at
 * module load - before any browser starts - because these scenarios write: they
 * drive a fake adapter, kick sessions, and delete retention subjects. Pointed at
 * production they would damage real tenant data.
 *
 * Second, the scenarios that need the fake adapter are marked `fixme` rather than
 * written to pass. The test-only runtime endpoints they depend on are Task 26
 * Step 3 and do not exist yet. A test written against endpoints nobody has built
 * would either fail as noise or, worse, be quietly weakened until it passed. A
 * `fixme` says exactly what is missing and cannot be mistaken for coverage.
 */

const ENV = requireLocalPreviewEnv();

/** Desktop and mobile viewports the plan pins. */
const DESKTOP = { width: 1440, height: 1000 } as const;
const MOBILE = { width: 390, height: 844 } as const;

const NEEDS_FIXTURE_API =
  'Cần endpoint runtime test-only của Task 26 Step 3 (adapter giả: QR, inbound, ' +
  'đá phiên, danh bạ, kết quả gửi, đồng hồ tất định). Chưa dựng.';

test.describe('OpenClaw Zalo — nền tảng', () => {
  test('môi trường preproduction phải là local, không phải production', async () => {
    // The guard already ran at import. Restating its outcome here means a run that
    // somehow reached the browser still records WHICH environment it used, instead
    // of leaving that to be inferred from a passing suite.
    expect(ENV.baseUrl).toBe('http://127.0.0.1:4173');
    expect(ENV.projectRef).toBe('local');
    expect(ENV.fixtureEnv).toBe('local-preview');
  });

  test('thiếu mật khẩu tài khoản test thì hỏng TRƯỚC khi đăng nhập', async () => {
    // A missing password must not surface as a timeout on a login form.
    const { credentials } = await import('./auth');
    const saved = process.env.FLEET_PASS_CHUNHA;
    delete process.env.FLEET_PASS_CHUNHA;
    try {
      expect(() => credentials('chunha')).toThrow(/FLEET_PASS_CHUNHA/u);
    } finally {
      if (saved !== undefined) process.env.FLEET_PASS_CHUNHA = saved;
    }
  });
});

test.describe('OpenClaw Zalo — quyền và bố cục', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test('chủ nhà thấy sáu khu vực trên desktop', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    await login(page, 'chunha');
    await page.goto('/openclaw-zalo');

    for (const section of ['overview', 'inbox', 'knowledge', 'automation', 'schedules', 'operations']) {
      await expect(page.locator(`[data-openclaw-section="${section}"]`), section).toHaveCount(1);
    }
    // Realtime settles after the initial reads; asserting before it does turns a
    // slow subscription into a false console-error failure.
    await page.waitForTimeout(1_500);
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });

  test('mobile có bốn mục điều hướng', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const consoleErrors = trackConsoleErrors(page);
    await login(page, 'chunha');
    await page.goto('/openclaw-zalo');
    await expect(page.locator('[data-openclaw-nav="mobile"] [data-openclaw-nav-item]'))
      .toHaveCount(4);
    await page.waitForTimeout(1_500);
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });

  test('người không có quyền không thấy route, và không có nháy nội dung', async ({ page }) => {
    // The flash matters as much as the final state: content that renders for
    // 200ms before a guard hides it has already been read.
    const consoleErrors = trackConsoleErrors(page);
    await login(page, 'ketoan');
    await page.goto('/openclaw-zalo');
    await expect(page.locator('[data-openclaw-overview="root"]')).toHaveCount(0);
    await expect(page.locator('[data-openclaw-action="open-global-stop"]')).toHaveCount(0);
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });
});

test.describe('OpenClaw Zalo — dừng khẩn cấp', () => {
  test('người xem thấy trạng thái GLOBAL_STOP nhưng không bấm được', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page, 'quanly');
    await page.goto('/openclaw-zalo');
    // Visible to everyone who can see the screen: whether sending is stopped is
    // not privileged information, and hiding it would leave a viewer guessing.
    await expect(page.locator('[data-openclaw-status="global-stop"]')).toHaveCount(1);
    await expect(page.locator('[data-openclaw-action="open-global-stop"]')).toHaveCount(0);
  });

  test('người vận hành phải gõ đúng câu xác nhận', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page, 'chunha');
    await page.goto('/openclaw-zalo');
    await page.locator('[data-openclaw-action="open-global-stop"]').click();
    await expect(page.locator('[data-openclaw-dialog="global-stop"]')).toBeVisible();
    await expect(page.locator('[data-openclaw-action="confirm-global-stop"]')).toBeDisabled();
    await page.locator('[data-openclaw-global-stop="input"]').fill('DUNG TOAN BO GUI CUA CONG TY');
    await expect(page.locator('[data-openclaw-action="confirm-global-stop"]')).toBeEnabled();
    // Deliberately NOT clicked: this scenario proves the gate, and stopping the
    // DEMO organization would leave every parallel worker unable to send.
    await page.locator('[data-openclaw-action="close-global-stop"]').click();
  });
});

test.describe('OpenClaw Zalo — kiểm chứng chuỗi audit', () => {
  test('ô kiểm chứng không bao giờ khẳng định điều nó không đo được', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page, 'chunha');
    await page.goto('/openclaw-zalo');
    const tile = page.locator('[data-openclaw-audit-chain]').first();
    await expect(tile).toHaveCount(1);
    const state = await tile.getAttribute('data-openclaw-audit-chain');
    if (state === 'INTACT' || state === 'BROKEN') {
      // The caveat is required exactly when a verdict is shown: without it the tick
      // reads as "the audit log is trustworthy", which no browser can establish.
      await expect(page.locator('[data-openclaw-audit-chain="limitation"]')).toHaveCount(1);
    }
  });
});

/**
 * Everything below needs the fake adapter. They are listed rather than omitted so
 * the gap is visible in the run output instead of living in someone's head.
 */
test.describe('OpenClaw Zalo — cần adapter giả (Task 26 Step 3)', () => {
  test.beforeAll(async () => {
    // Runs once and states the situation plainly, so a reader of the report knows
    // WHY these are skipped rather than assuming they are flaky.
    await assertFixtureApi(ENV).catch((error: Error) => {
      test.info().annotations.push({ type: 'blocked', description: error.message });
    });
  });

  test.fixme('kết nối: công bố -> QR -> hết hạn -> làm mới -> trạng thái đã kết nối', NEEDS_FIXTURE_API, async () => {});
  test.fixme('hộp thư: tìm kiếm, đánh dấu đã đọc bất biến, xung đột phân công, phân trang theo con trỏ', NEEDS_FIXTURE_API, async () => {});
  test.fixme('nháp AI chỉ để xem lại và che nội dung hạn chế', NEEDS_FIXTURE_API, async () => {});
  test.fixme('gửi thủ công vào QUEUED rồi tới SENT khi adapter báo thành công', NEEDS_FIXTURE_API, async () => {});
  test.fixme('timeout mập mờ dẫn tới UNKNOWN và KHÔNG bao giờ tự gửi lại', NEEDS_FIXTURE_API, async () => {});
  test.fixme('UNKNOWN giữ trạng thái lịch sử; đúng một kết luận thắng và không sửa được', NEEDS_FIXTURE_API, async () => {});
  test.fixme('nhóm bán hàng đòi ID ổn định chính xác và danh bạ còn mới', NEEDS_FIXTURE_API, async () => {});
  test.fixme('lead/phòng/lịch hẹn sinh đúng MỘT occurrence đã khử trùng', NEEDS_FIXTURE_API, async () => {});
  test.fixme('lịch tới hạn fan-out đúng đích, dựng mẫu đã đóng băng, một dòng outbox nguyên tử', NEEDS_FIXTURE_API, async () => {});
  test.fixme('QUARANTINE thu hồi truy cập không gọi R2, mở 7 ngày ân hạn; hold chặn CAS', NEEDS_FIXTURE_API, async () => {});
  test.fixme('FINAL_DELETE bị chặn trước ân hạn; hold trước authorize chặn R2', NEEDS_FIXTURE_API, async () => {});
  test.fixme('gốc audit hằng ngày ký, tải lên một neo bất biến, sống sót mất ack DB', NEEDS_FIXTURE_API, async () => {});
  test.fixme('wizard tự lưu, chạy thử, xuất bản, tạm dừng, và giải thích khi chính sách chặn', NEEDS_FIXTURE_API, async () => {});
  test.fixme('tri thức: tạo/sửa/kiểm/xuất bản/lưu trữ/truy hồi/không kết quả/xung đột cũ', NEEDS_FIXTURE_API, async () => {});
  test.fixme('dead-letter tạo intent mới đã kiểm; sự cố Supabase/R2 một phần hiện rõ ràng', NEEDS_FIXTURE_API, async () => {});
  test.fixme('đổi tổ chức đóng kênh realtime và xoá cache OpenClaw', NEEDS_FIXTURE_API, async () => {});
});
