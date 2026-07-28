import { expect, test } from '@playwright/test';

import { login, trackConsoleErrors } from './auth';

test.describe('Network Center deterministic frontend', () => {
  test('renders fleet, preserves URL-backed tabs, and runs local-only interactions', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    await login(page, 'chunha');
    await page.goto('/network-center');

    await expect(page.getByRole('heading', { name: 'Trung tâm mạng', exact: true })).toBeVisible();
    await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Chỉ số toàn hệ thống' }).locator('article')).toHaveCount(6);
    await expect(page.locator('.nc-building-link').first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Firmware' })).toBeVisible();
    await expect(page.locator('.nc-fleet-panel')).toHaveCSS('grid-area', 'fleet');
    await expect(page.locator('.nc-incident-rail')).toHaveCSS('grid-area', 'incidents');
    const railPrecedesFleet = await page.evaluate(() => {
      const rail = document.querySelector('.nc-incident-rail');
      const fleet = document.querySelector('.nc-fleet-panel');
      return Boolean(rail && fleet && (rail.compareDocumentPosition(fleet) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(railPrecedesFleet).toBe(true);

    const openIncidentKpi = page.locator('.nc-kpi').filter({ hasText: 'Sự cố đang mở' }).locator('strong');
    expect(Number(await openIncidentKpi.textContent())).toBeGreaterThan(0);
    await page.getByRole('combobox', { name: 'Mức sự cố' }).click();
    await page.getByRole('option', { name: 'Thấp', exact: true }).click();
    await expect(openIncidentKpi).toHaveText('0');
    await expect(page.locator('.nc-incident-card')).toHaveCount(0);
    await expect(page.getByText('Không có sự cố đang mở.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Đặt lại' }).click();

    await page.locator('.nc-building-link').first().click();
    await expect(page).toHaveURL(/\/network-center\/buildings\//);
    const tabList = page.getByRole('tablist', { name: 'Khu chức năng toà nhà' });
    await expect(tabList.getByRole('tab')).toHaveCount(10);

    const tabNames = [
      'Cổng giao tiếp',
      'Thiết bị kết nối',
      'Aruba & sơ đồ',
      'Sự cố & SLA',
      'Cấu hình',
      'Sao lưu & so sánh',
      'Thay đổi',
      'Nhật ký & Bảo mật',
      'Cài đặt',
      'Tổng quan',
    ];
    for (const tabName of tabNames) {
      await tabList.getByRole('tab', { name: tabName, exact: true }).click();
      await expect(tabList.getByRole('tab', { name: tabName, exact: true })).toHaveAttribute('data-state', 'active');
      await expect(page).toHaveURL(/\?tab=/);
    }

    await tabList.getByRole('tab', { name: 'Sự cố & SLA', exact: true }).click();
    await expect(page.getByText('Dòng thời gian sự cố', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Tạo bảo trì' }).click();
    await page.getByLabel('Lý do').fill('Kiểm tra kết nối định kỳ');
    await page.getByRole('button', { name: 'Tạo mô phỏng cục bộ' }).click();
    await expect(page.getByText('Kiểm tra kết nối định kỳ', { exact: true })).toBeVisible();

    await tabList.getByRole('tab', { name: 'Sao lưu & so sánh', exact: true }).click();
    const revisionRowsBefore = await page.locator('tbody tr').count();
    await page.getByRole('button', { name: 'Chụp cấu hình' }).click();
    await expect.poll(() => page.locator('tbody tr').count()).toBe(revisionRowsBefore + 1);
    await page.getByRole('button', { name: 'So sánh hai bản' }).click();
    await expect(page.getByRole('heading', { name: 'So sánh cấu hình đã làm sạch' })).toBeVisible();
    await expect(page.getByText(/hai bản cấu hình khác nhau.*Thông tin xác thực/i)).toBeVisible();
    await page.keyboard.press('Escape');

    await tabList.getByRole('tab', { name: 'Cấu hình', exact: true }).click();
    await page.getByRole('button', { name: 'Thao tác MikroTik' }).click();
    await expect(page.getByText('kiểm tra đầu vào → sao lưu → thực hiện → kiểm tra sau → hoàn tất', { exact: false })).toBeVisible();
    await expect(page.getByText('Trước / Sau', { exact: true })).toBeVisible();
    await expect(page.getByText('Kiểm tra sau', { exact: true })).toBeVisible();
    await page.getByLabel('Lý do thao tác').fill('Làm mới DNS sau kiểm tra định kỳ');
    await page.getByRole('button', { name: 'Kiểm tra và mô phỏng cục bộ' }).click();
    await expect(page.getByText(/không có thiết bị thật nào bị thay đổi/i)).toBeVisible();
    await page.getByRole('button', { name: 'Đóng' }).click();

    await tabList.getByRole('tab', { name: 'Thay đổi', exact: true }).click();
    await expect(page.getByText('Làm mới bộ nhớ đệm DNS', { exact: true })).toBeVisible();
    await expect(page.getByText('Mã thao tác:', { exact: true })).toBeVisible();
    await expect(page.getByText('Tham số thao tác:', { exact: true })).toBeVisible();
    await expect(page.getByText('Không có tham số', { exact: true })).toBeVisible();

    await tabList.getByRole('tab', { name: 'Nhật ký & Bảo mật', exact: true }).click();
    await expect(page.getByText('Lý do ghi nhật ký:', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Tham số ghi nhận:', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Kết quả mô phỏng:', { exact: true }).first()).toBeVisible();
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('mobile uses complete cards without page-level horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const consoleErrors = trackConsoleErrors(page);
    await login(page, 'chunha');
    await page.goto('/network-center');

    await expect(page.locator('.nc-mobile-site').first()).toBeVisible();
    await expect(page.locator('.nc-mobile-site').first().getByText('Firmware', { exact: true })).toBeVisible();
    const railBox = await page.locator('.nc-incident-rail').boundingBox();
    const fleetBox = await page.locator('.nc-fleet-panel').boundingBox();
    expect(railBox).not.toBeNull();
    expect(fleetBox).not.toBeNull();
    expect(railBox!.y).toBeLessThan(fleetBox!.y);

    const resetButton = page.getByRole('button', { name: 'Đặt lại' });
    await resetButton.focus();
    const focusStyle = await resetButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        boxShadow: style.boxShadow,
      };
    });
    expect(focusStyle.outlineStyle).not.toBe('none');
    expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(1);
    expect(focusStyle.boxShadow).toBe('none');

    const mobileMetrics = await page.evaluate(() => {
      const fontSize = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
      };
      const targetHeight = (selector: string) => {
        const element = document.querySelector(selector);
        return element?.getBoundingClientRect().height ?? null;
      };
      return {
        rootFont: fontSize('.network-center'),
        eyebrowFont: fontSize('.nc-eyebrow'),
        cardCaptionFont: fontSize('.nc-mobile-site-heading p'),
        cardLabelFont: fontSize('.nc-mobile-site-grid dt'),
        cardValueFont: fontSize('.nc-mobile-site-grid dd'),
        returnLinkHeight: targetHeight('.nc-back-link'),
        buildingLinkHeight: targetHeight('.nc-card-link'),
        selectHeight: targetHeight('[role="combobox"]'),
        resetHeight: targetHeight('.nc-filters button'),
      };
    });
    expect(mobileMetrics.rootFont).toBeGreaterThanOrEqual(16);
    expect(mobileMetrics.eyebrowFont).toBeGreaterThanOrEqual(16);
    expect(mobileMetrics.cardCaptionFont).toBeGreaterThanOrEqual(16);
    expect(mobileMetrics.cardLabelFont).toBeGreaterThanOrEqual(16);
    expect(mobileMetrics.cardValueFont).toBeGreaterThanOrEqual(16);
    expect(mobileMetrics.returnLinkHeight).toBeGreaterThanOrEqual(44);
    expect(mobileMetrics.buildingLinkHeight).toBeGreaterThanOrEqual(44);
    expect(mobileMetrics.selectHeight).toBeGreaterThanOrEqual(44);
    expect(mobileMetrics.resetHeight).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    await page.locator('.nc-card-link').first().click();
    const tabList = page.getByRole('tablist', { name: 'Khu chức năng toà nhà' });
    await tabList.getByRole('tab', { name: 'Cài đặt', exact: true }).click();
    const switchMetrics = await page.getByRole('switch').evaluateAll((switches) => switches.map((element) => {
      const box = element.getBoundingClientRect();
      const thumb = element.querySelector(':scope > span');
      const thumbStyle = thumb ? getComputedStyle(thumb) : null;
      return {
        width: box.width,
        height: box.height,
        thumbBorderRadius: thumbStyle?.borderRadius ?? null,
        thumbBoxShadow: thumbStyle?.boxShadow ?? null,
      };
    }));
    expect(switchMetrics.length).toBeGreaterThan(0);
    for (const metric of switchMetrics) {
      expect(metric.width).toBeGreaterThanOrEqual(44);
      expect(metric.height).toBeGreaterThanOrEqual(44);
      expect(metric.thumbBorderRadius).toBe('0px');
      expect(metric.thumbBoxShadow).toBe('none');
    }

    await tabList.getByRole('tab', { name: 'Sao lưu & so sánh', exact: true }).click();
    const backupSummaryFontSize = await page.locator('.nc-backup-summary').evaluate((element) => (
      Number.parseFloat(getComputedStyle(element).fontSize)
    ));
    expect(backupSummaryFontSize).toBeGreaterThanOrEqual(16);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
