import { expect, test, type Page } from "@playwright/test";
import { login, trackConsoleErrors } from "./auth";

/**
 * Kiểm tra bản THIẾT KẾ LẠI trang Báo cáo Lợi Nhuận (desktop):
 * dải hero xanh (thương hiệu + bước tháng + tab pill + KPI + chip cảnh báo),
 * sổ 2 cột Thu/Chi kiểu mới, và 5 tab đều dựng được không lỗi console.
 *
 * Chạy trên build LOCAL (vite preview) khi thay đổi chưa deploy:
 *   FLEET_BASE_URL=http://localhost:4173 npx playwright test specs/profit-hub-redesign.spec.ts
 */

const ROUTE = "/reports/finance/profit-distribution";

async function openHub(page: Page) {
  await login(page, "chunha");
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(ROUTE);
  await expect(page.locator(".ph-hero")).toBeVisible({ timeout: 45_000 });
  // Hero dựng ngay cả khi quyền chưa tải xong (tab rỗng) → chờ tab thật xuất hiện.
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 45_000 });
}

/** Mở easter egg (nhấp 3 lần vào logo) để lộ các tab nhạy cảm. */
async function revealSecretTabs(page: Page) {
  const logo = page.locator(".ph-brand__icon");
  await logo.click();
  await logo.click();
  await logo.click();
}

test("hero + sổ 2 cột dựng đúng hệ thiết kế mới", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await openHub(page);

  // Hero: thương hiệu + breadcrumb phụ
  await expect(page.locator(".ph-brand__title")).toHaveText("Báo cáo Lợi Nhuận");
  await expect(page.locator(".ph-brand__sub")).toHaveText("Báo cáo Tài chính → Lợi nhuận");

  // Nền tối của hero đúng gradient xanh đậm của mock.
  const heroBg = await page
    .locator(".ph-hero")
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(heroBg).toContain("rgb(12, 59, 42)");

  // Bộ lọc kỳ nằm TRÊN hero (không còn trong thân trang).
  await expect(page.locator(".ph-stepper")).toBeVisible();
  const monthLabel = page.locator(".ph-stepper__select");
  const before = (await monthLabel.textContent())?.trim();
  await page.locator(".ph-stepper__btn").first().click();
  await expect(monthLabel).not.toHaveText(before ?? "", { timeout: 15_000 });
  await page.locator(".ph-stepper__btn").last().click();
  await expect(monthLabel).toHaveText(before ?? "", { timeout: 15_000 });

  // Dải KPI: Doanh thu − Chi phí = Lợi nhuận + cột 6 tháng.
  await expect(page.locator(".ph-kpi__label", { hasText: "Doanh thu" })).toBeVisible();
  await expect(page.locator(".ph-kpi__label", { hasText: "Chi phí" })).toBeVisible();
  await expect(page.locator(".ph-kpi__label", { hasText: "Lợi nhuận 6 tháng" })).toBeVisible();
  expect(await page.locator(".ph-spark__bar").count()).toBe(6);
  expect(await page.locator(".ph-op").count()).toBe(2);

  // Chip kiểm chứng luôn có (OK / lệch / đang tải).
  await expect(page.locator(".ph-chip--push")).toBeVisible();

  // Sổ 2 cột + chú thích màu.
  await expect(page.locator(".ph-panel--income .ph-panel__name")).toHaveText("Khoản thu");
  await expect(page.locator(".ph-panel--expense .ph-panel__name")).toHaveText("Khoản chi");
  expect(await page.locator(".ph-legend__item").count()).toBe(5);
  await expect(page.locator(".ph-panel--income .ph-row").first()).toBeVisible();

  // Thanh kiểm chứng vẫn còn (bản chi tiết) và chip cuộn tới được.
  await expect(page.locator("#ph-verify")).toBeAttached();

  // Chờ dữ liệu thật (hết skeleton) rồi mới chụp — org DEMO có phiếu tháng này.
  await expect(page.locator(".ph-panel--income .ph-row__desc").first()).toBeVisible({
    timeout: 60_000,
  });
  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("màn 1280 vẫn giữ sổ 2 cột và không tràn ngang", async ({ page }) => {
  await login(page, "chunha");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(ROUTE);
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".ph-panel--income .ph-row__desc").first()).toBeVisible({
    timeout: 60_000,
  });

  const [incomeBox, expenseBox] = await Promise.all([
    page.locator(".ph-panel--income").boundingBox(),
    page.locator(".ph-panel--expense").boundingBox(),
  ]);
  // Cùng hàng ⇒ 2 cột (không rơi xuống dòng dưới).
  expect(Math.abs((incomeBox?.y ?? 0) - (expenseBox?.y ?? 1))).toBeLessThan(4);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("chuyển đủ 5 tab, mỗi tab tự nạp KPI riêng lên hero", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await openHub(page);
  await revealSecretTabs(page);

  // Chấm "•" của tab nhạy cảm là aria-hidden → tên khả truy cập KHÔNG có nó.
  const labels = await page.getByRole("tab").evaluateAll((els) =>
    els.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s*•\s*$/, "").trim()),
  );
  expect(labels.length).toBeGreaterThanOrEqual(4);
  expect(labels).toContain("Chốt LN tháng");
  expect(labels).toContain("Cổ đông & tỷ lệ");

  for (const label of labels) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    // Panel đang mở phải có nội dung, và hero phải có ít nhất 1 ô KPI của tab đó.
    await expect(page.locator('[role="tabpanel"]:not([hidden])')).toBeVisible();
    await expect(page.locator(".ph-kpis .ph-kpi").first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[role="tabpanel"]:not([hidden]) .ph-card, [role="tabpanel"]:not([hidden]) .ph-panel').first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});
