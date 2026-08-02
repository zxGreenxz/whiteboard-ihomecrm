import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { credentials, login, trackConsoleErrors } from './auth';

const DEMO_MODE = process.env.FLEET_NETWORK_CENTER_MODE === 'demo';

test.describe('Network Center deterministic frontend', () => {
  test.skip(!DEMO_MODE, 'Local-only interaction coverage requires explicit demo mode');

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
    await expect(page.locator('.nc-maintenance-banner').getByText('Kiểm tra kết nối định kỳ', { exact: true })).toBeVisible();

    await tabList.getByRole('tab', { name: 'Sao lưu & so sánh', exact: true }).click();
    const revisionRowsBefore = await page.locator('tbody tr').count();
    await page.getByRole('button', { name: 'Chụp cấu hình' }).click();
    await expect.poll(() => page.locator('tbody tr').count()).toBe(revisionRowsBefore + 1);
    await page.getByRole('button', { name: 'So sánh hai bản' }).click();
    const diffDialog = page.getByRole('dialog', { name: 'So sánh cấu hình đã làm sạch' });
    await expect(diffDialog).toBeVisible();
    await expect(page.getByText(/hai bản cấu hình khác nhau.*Thông tin xác thực/i)).toBeVisible();
    await diffDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(diffDialog).toBeHidden();

    await tabList.getByRole('tab', { name: 'Cấu hình', exact: true }).click();
    await page.getByRole('button', { name: 'Thao tác MikroTik' }).click();
    const actionDialog = page.getByRole('dialog', { name: 'Mô phỏng thao tác MikroTik cục bộ' });
    await expect(actionDialog).toBeVisible();
    await expect(page.getByText('kiểm tra đầu vào → sao lưu → thực hiện → kiểm tra sau → hoàn tất', { exact: false })).toBeVisible();
    const actionPreview = page.getByLabel('Xem trước thao tác');
    await expect(actionPreview.getByText('Trước / Sau', { exact: true })).toBeVisible();
    await expect(actionPreview.getByText('Kiểm tra sau', { exact: true })).toBeVisible();
    await page.getByLabel('Lý do thao tác').fill('Làm mới DNS sau kiểm tra định kỳ');
    await page.getByRole('button', { name: 'Kiểm tra và mô phỏng cục bộ' }).click();
    await expect(page.getByText(/không có thiết bị thật nào bị thay đổi/i)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(actionDialog).toBeHidden();

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

test.describe('Network Center production repository', () => {
  test.skip(DEMO_MODE, 'Production repository coverage is disabled in explicit demo mode');

  test('shows live unprovisioned state without silently falling back to demo', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    await login(page, 'chunha');
    await page.goto('/network-center');

    await expect(page.getByRole('heading', { name: 'Trung tâm mạng', exact: true })).toBeVisible();
    await expect(page.getByText('Dữ liệu trực tiếp', { exact: true })).toBeVisible();
    await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toHaveCount(0);
    await expect(page.locator('.nc-building-link').first()).toBeVisible();

    await page.locator('.nc-building-link').first().click();
    await expect(page).toHaveURL(/\/network-center\/buildings\//);
    await expect(page.getByText('Chưa kết nối', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('-1 giờ', { exact: false })).toHaveCount(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('keeps RPC errors visible instead of fabricating demo fleet data', async ({ page }) => {
    await login(page, 'chunha');
    await page.route('**/rest/v1/rpc/network_center_list_fleet_v1', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'forced-network-center-failure' }),
      });
    });
    await page.goto('/network-center');

    await expect(page.getByRole('heading', { name: 'Không tải được toà nhà' })).toBeVisible();
    await expect(page.getByText(/không tự tạo dữ liệu thay thế/i)).toBeVisible();
    await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toHaveCount(0);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * Task 15 · Bước 2 — coverage headless cho production hardening.
 *
 * Nguyên tắc an toàn của khối này:
 *  - KHÔNG bài nào ghi dữ liệu lên server. Toàn bộ RPC ghi của Network Center
 *    đều bị fixture chặn lại trong trình duyệt; `dispose()` khẳng định không có
 *    RPC ghi nào lọt ra mạng. Đây là lựa chọn có chủ đích: base URL mặc định là
 *    production và các RPC này điều khiển thiết bị mạng thật.
 *  - Toà nhà dùng cho fixture được LẤY THẬT từ `GET /rest/v1/buildings` của tài
 *    khoản DEMO và bắt buộc `organization_id = dddd0000-…0001`. Nếu phản hồi có
 *    org thật `aaaa0000-…0001` thì `dispose()` fail.
 *  - Mật khẩu chỉ đọc qua `credentials()` (env FLEET_PASS_*) và không bao giờ
 *    được log, ghi file, đưa vào URL hay vào thông báo lỗi.
 *  - Trạng thái client duy nhất mà fixture tạo ra là localStorage intent
 *    registry; nó được xoá trong `finally`.
 * ─────────────────────────────────────────────────────────────────────────── */

const DEMO_ORGANIZATION_ID = 'dddd0000-0000-4000-8000-000000000001';
const REAL_ORGANIZATION_ID = 'aaaa0000-0000-4000-8000-000000000001';
const INTENT_STORAGE_KEY = 'ihomecrm:network-center:intents:v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FIXTURE_ROUTER_ID = 'dddd2222-0000-4000-8000-000000000201';
const FIXTURE_WAN_INTERFACE_ID = 'dddd2222-0000-4000-8000-000000000301';
const FIXTURE_LAN_INTERFACE_ID = 'dddd2222-0000-4000-8000-000000000302';
const FIXTURE_UPLINK_INTERFACE_ID = 'dddd2222-0000-4000-8000-000000000303';
const FIXTURE_INCIDENT_ID = 'dddd2222-0000-4000-8000-000000000401';
const FIXTURE_REVISION_ID = 'dddd2222-0000-4000-8000-000000000501';
const FIXTURE_ACTOR_ID = 'dddd2222-0000-4000-8000-000000000601';
const FIXTURE_COMMAND_ID = 'dddd2222-0000-4000-8000-000000000701';
const FIXTURE_DUPLICATE_COMMAND_ID = 'dddd2222-0000-4000-8000-000000000702';

const ROUTER_IDENTITY = 'ihome-demo-mikrotik-01';
const ROUTER_MODEL = 'RB5009UG+S+';
const ROUTER_FIRMWARE = '7.15.3';
const FIXTURE_CPU_PERCENT = 37;
const FIXTURE_MEMORY_USED_BYTES = 536_870_912;
const FIXTURE_MEMORY_TOTAL_BYTES = 1_073_741_824; // → 50%
const FIXTURE_WAN_RX_BPS = 12_000_000; // → 12 Mbps
const FIXTURE_WAN_TX_BPS = 3_400_000; // → 3.4 Mbps
const FIXTURE_ACTIVE_CLIENTS = 96;
const FIXTURE_LAST_SEEN_MS = 5 * 60_000; // → "5 phút trước"
const FIXTURE_BACKUP_AGE_MS = 2 * 3_600_000; // → "2h", backup còn mới
const FIXTURE_SNAPSHOT_HASH = `${'f'.repeat(56)}1a2b3c4d`;

const ARUBA_PAGE_SIZE = 100; // NETWORK_CENTER_ARUBA_PAGE_SIZE
const ARUBA_MAX_PAGE_SIZE = 250; // NETWORK_CENTER_ARUBA_MAX_PAGE_SIZE

/** RPC ghi của Network Center — không bài nào được để chúng chạm tới server. */
const NETWORK_CENTER_WRITE_RPCS = new Set([
  'network_center_execute_action_v1',
  'network_center_update_settings_v1',
  'network_center_ack_incident_v1',
  'network_center_create_maintenance_v1',
  'network_center_cancel_maintenance_v1',
  'network_center_request_snapshot_v1',
]);

type Json = Record<string, unknown>;

interface RpcCall {
  name: string;
  body: Json;
}

interface CommandSpec {
  id: string;
  status: string;
  actionType?: string;
  reason?: string;
  parameters?: Json;
  result?: Json | null;
  reconciliationState?: string;
  ageMinutes?: number;
}

interface FixtureContext {
  buildingId: string;
  buildingName: string;
}

type RpcHandler = (route: Route, body: Json, context: FixtureContext) => Promise<void>;

interface NetworkCenterFixtureOptions {
  /** Ghi đè `get_my_permissions` để dựng đúng ô ma trận quyền cần kiểm thử. */
  permissions?: Json;
  rolloutState?: 'OFF' | 'READ_ONLY' | 'EXECUTE';
  settingsVersion?: number;
  arubaTotal?: number;
  commands?: CommandSpec[];
  handlers?: Record<string, RpcHandler>;
}

interface ArubaPageObservation {
  afterSortOrder: number | null;
  limit: number;
  itemCount: number;
  chars: number;
}

interface NetworkCenterFixture {
  buildingId(): Promise<string>;
  calls: RpcCall[];
  callsOf(name: string): Json[];
  arubaPages: ArubaPageObservation[];
  setSettingsVersion(version: number): void;
  dispose(): Promise<void>;
}

const PERMISSIONS_WITHOUT_NETWORK_CENTER: Json = {
  dashboard: { view: true },
  buildings: { view: true },
  rooms: { view: true },
  customers: { view: true },
  contracts: { view: true },
  invoices: { view: true },
  income_expenses: { view: true },
  tasks: { view: true },
  // network_center bị bỏ trống có chủ đích → không có view, không có execute.
};
const PERMISSIONS_VIEW_ONLY: Json = {
  ...PERMISSIONS_WITHOUT_NETWORK_CENTER,
  network_center: { view: true, execute: false },
};
const PERMISSIONS_EXECUTE: Json = {
  ...PERMISSIONS_WITHOUT_NETWORK_CENTER,
  network_center: { view: true, execute: true },
};

const isoAgo = (milliseconds: number): string => new Date(Date.now() - milliseconds).toISOString();

async function fulfillJson(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function fulfillRpcError(
  route: Route,
  status: number,
  error: { code?: string; message: string; details?: string | null; hint?: string | null },
): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      code: error.code ?? 'P0001',
      message: error.message,
      details: error.details ?? null,
      hint: error.hint ?? null,
    }),
  });
}

function fleetItemDto(
  context: FixtureContext,
  rolloutState: string,
  arubaTotal: number,
): Json {
  return {
    buildingId: context.buildingId,
    buildingName: context.buildingName,
    rolloutState,
    roomsCount: 24,
    routerId: FIXTURE_ROUTER_ID,
    routerIdentity: ROUTER_IDENTITY,
    routerModel: ROUTER_MODEL,
    targetFirmware: ROUTER_FIRMWARE,
    lifecycleStatus: 'ONLINE',
    reachable: true,
    healthStatus: 'HEALTHY',
    lastSeenAt: isoAgo(FIXTURE_LAST_SEEN_MS),
    routerosVersion: ROUTER_FIRMWARE,
    cpuPercent: FIXTURE_CPU_PERCENT,
    memoryUsedBytes: FIXTURE_MEMORY_USED_BYTES,
    memoryTotalBytes: FIXTURE_MEMORY_TOTAL_BYTES,
    pppoeState: 'connected',
    connectionCount: 128,
    arubaCount: arubaTotal,
    openIncidents: 1,
    activeClients: FIXTURE_ACTIVE_CLIENTS,
    lastBackupAt: isoAgo(FIXTURE_BACKUP_AGE_MS),
    uptimePercent: 99.4,
    mttrSeconds: 900,
    maintenanceActive: false,
  };
}

function buildingDto(
  context: FixtureContext,
  rolloutState: string,
  settingsVersion: number,
): Json {
  return {
    buildingId: context.buildingId,
    buildingName: context.buildingName,
    rolloutState,
    roomsCount: 24,
    router: {
      id: FIXTURE_ROUTER_ID,
      identity: ROUTER_IDENTITY,
      externalKey: 'demo-mikrotik-01',
      model: ROUTER_MODEL,
      firmware: ROUTER_FIRMWARE,
      targetFirmware: ROUTER_FIRMWARE,
      lifecycleStatus: 'ONLINE',
      reachable: true,
      healthStatus: 'HEALTHY',
      lastSeenAt: isoAgo(FIXTURE_LAST_SEEN_MS),
      cpuPercent: FIXTURE_CPU_PERCENT,
      memoryUsedBytes: FIXTURE_MEMORY_USED_BYTES,
      memoryTotalBytes: FIXTURE_MEMORY_TOTAL_BYTES,
      diskUsedBytes: 41_943_040,
      diskTotalBytes: 134_217_728,
      temperatureC: 42,
      voltageV: 24,
      pppoeState: 'connected',
      connectionCount: 128,
    },
    interfaces: [
      {
        id: FIXTURE_WAN_INTERFACE_ID,
        name: 'ether1-wan',
        key: 'ether1',
        role: 'WAN',
        protected: true,
        enabled: true,
        linkState: 'UP',
        rxBps: FIXTURE_WAN_RX_BPS,
        txBps: FIXTURE_WAN_TX_BPS,
        utilizationPercent: 18,
        errors: 0,
        discards: 0,
        queueDrops: 0,
      },
      {
        id: FIXTURE_LAN_INTERFACE_ID,
        name: 'ether3-lan-tang2',
        key: 'ether3',
        role: 'LAN',
        protected: false,
        enabled: true,
        linkState: 'UP',
        rxBps: 2_000_000,
        txBps: 1_000_000,
        utilizationPercent: 6,
        errors: 0,
        discards: 0,
        queueDrops: 0,
      },
      {
        id: FIXTURE_UPLINK_INTERFACE_ID,
        name: 'sfp-uplink-aruba',
        key: 'sfp1',
        role: 'UPLINK',
        protected: true,
        enabled: true,
        linkState: 'UP',
        rxBps: 8_000_000,
        txBps: 5_000_000,
        utilizationPercent: 12,
        errors: 0,
        discards: 0,
        queueDrops: 0,
      },
    ],
    incidents: [
      {
        id: FIXTURE_INCIDENT_ID,
        title: 'Aruba nhánh 2 phản hồi chậm',
        detail: 'Một AP báo độ trễ cao liên tục trong 15 phút.',
        severity: 'WARNING',
        status: 'OPEN',
        openedAt: isoAgo(45 * 60_000),
        acknowledgedAt: null,
      },
    ],
    maintenance: null,
    revisions: [
      {
        id: FIXTURE_REVISION_ID,
        capturedAt: isoAgo(FIXTURE_BACKUP_AGE_MS),
        label: 'Bản chụp theo lịch',
        hash: FIXTURE_SNAPSHOT_HASH,
        source: 'SCHEDULED',
        schemaVersion: 1,
      },
    ],
    settings: {
      pollingSeconds: 60,
      backupHour: '03:00',
      alertSensitivity: 'standard',
      dependencyGrouping: true,
      changesPaused: false,
      version: settingsVersion,
    },
  };
}

const arubaUuid = (sortOrder: number): string =>
  `dddd3333-0000-4000-8000-${String(sortOrder).padStart(12, '0')}`;

/** Keyset page giống hợp đồng `network_center_list_aruba_v1` (sortOrder, id). */
function arubaPageDto(
  afterSortOrder: number | null,
  limit: number,
  total: number,
): { items: Json[]; nextCursor: Json | null } {
  const start = Math.max(0, afterSortOrder ?? 0);
  const end = Math.min(start + limit, total);
  const items: Json[] = [];
  for (let sortOrder = start + 1; sortOrder <= end; sortOrder += 1) {
    const offline = sortOrder % 12 === 0;
    const slow = !offline && sortOrder % 7 === 0;
    items.push({
      id: arubaUuid(sortOrder),
      name: `AP-${String(sortOrder).padStart(5, '0')}`,
      model: 'AP-505',
      externalKey: `aruba-${sortOrder}`,
      lifecycleStatus: 'ONLINE',
      reachable: !offline,
      healthStatus: slow ? 'DEGRADED' : 'HEALTHY',
      lastSeenAt: isoAgo(90_000),
      address: `10.20.${Math.floor(sortOrder / 254) % 254}.${(sortOrder % 254) + 1}`,
    });
  }
  return { items, nextCursor: end < total ? { sortOrder: end, id: arubaUuid(end) } : null };
}

function commandDto(spec: CommandSpec, context: FixtureContext): Json {
  return {
    id: spec.id,
    actionType: spec.actionType ?? 'FLUSH_DNS_CACHE',
    reason: spec.reason ?? 'Làm mới DNS sau kiểm tra định kỳ',
    parameters: spec.parameters ?? {},
    target: {
      buildingId: context.buildingId,
      buildingName: context.buildingName,
      routerIdentity: ROUTER_IDENTITY,
    },
    requestedBy: FIXTURE_ACTOR_ID,
    status: spec.status,
    attemptCount: 1,
    result: spec.result ?? null,
    rollback: null,
    reconciliationState: spec.reconciliationState ?? 'NOT_REQUIRED',
    createdAt: isoAgo((spec.ageMinutes ?? 5) * 60_000),
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Bắt lỗi mạng "bất thường": request fail ở tầng network + mọi phản hồi >= 500.
 *
 * Ngoại lệ duy nhất và có chủ đích: `ERR_ABORTED` — trình duyệt/React Query hủy
 * request khi điều hướng SPA, không phải lỗi ứng dụng. Bài nào cố ý giả lập lỗi
 * phải khai báo `allow` cho đúng URL đó.
 */
function trackNetworkFailures(page: Page, allow: RegExp[] = []): string[] {
  const failures: string[] = [];
  const allowed = (url: string) => allow.some((pattern) => pattern.test(url));
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? 'unknown';
    if (/ERR_ABORTED/i.test(reason) || allowed(request.url())) return;
    failures.push(`${request.method()} ${request.url()} → ${reason}`);
  });
  page.on('response', (response) => {
    if (response.status() < 500 || allowed(response.url())) return;
    failures.push(`${response.request().method()} ${response.url()} → HTTP ${response.status()}`);
  });
  return failures;
}

function serverGrants(permissions: Json | null, action: 'view' | 'execute'): boolean {
  if (!permissions) return false;
  if (permissions.__superadmin === true) return true;
  const moduleMap = permissions.network_center;
  if (!moduleMap || typeof moduleMap !== 'object') return false;
  return (moduleMap as Record<string, unknown>)[action] === true;
}

async function installNetworkCenterFixture(
  page: Page,
  options: NetworkCenterFixtureOptions = {},
): Promise<NetworkCenterFixture> {
  const rolloutState = options.rolloutState ?? 'EXECUTE';
  const arubaTotal = options.arubaTotal ?? 12;
  const commandSpecs = options.commands ?? [];
  const handlers = options.handlers ?? {};
  let settingsVersion = options.settingsVersion ?? 7;

  const calls: RpcCall[] = [];
  const arubaPages: ArubaPageObservation[] = [];
  const escapedWrites: string[] = [];
  const fixtureErrors: string[] = [];
  const observedOrganizationIds = new Set<string>();

  let resolveBuildingId: (value: string) => void = () => {};
  let rejectBuildingId: (reason: Error) => void = () => {};
  const buildingIdPromise = new Promise<string>((resolve, reject) => {
    resolveBuildingId = resolve;
    rejectBuildingId = reject;
  });
  // Tránh unhandled rejection khi test kết thúc trước lúc ai đó await promise này.
  buildingIdPromise.catch(() => undefined);
  const context: FixtureContext = { buildingId: '', buildingName: 'Toà nhà DEMO' };

  // Đi xuyên qua danh sách toà nhà THẬT để lấy đúng một toà thuộc org DEMO. Vì
  // handler chỉ fulfill sau khi đã parse xong, fleet RPC (chỉ chạy khi
  // buildings đã resolve) luôn thấy id sẵn sàng.
  await page.route('**/rest/v1/buildings*', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (!context.buildingId) {
      try {
        const parsed: unknown = JSON.parse(body);
        const rows = Array.isArray(parsed)
          ? (parsed as Array<{ id?: string; name?: string; organization_id?: string | null; is_virtual?: boolean }>)
          : [];
        for (const row of rows) {
          if (typeof row.organization_id === 'string') observedOrganizationIds.add(row.organization_id);
        }
        const demoRow = rows.find((row) =>
          typeof row.id === 'string'
          && row.organization_id === DEMO_ORGANIZATION_ID
          && row.is_virtual !== true);
        if (demoRow && typeof demoRow.id === 'string') {
          context.buildingId = demoRow.id.trim().toLowerCase();
          if (typeof demoRow.name === 'string' && demoRow.name.trim()) {
            context.buildingName = demoRow.name.trim();
          }
          resolveBuildingId(context.buildingId);
        } else if (rows.length > 0) {
          rejectBuildingId(new Error(
            `Không tìm thấy toà nhà nào thuộc org DEMO ${DEMO_ORGANIZATION_ID}; `
            + `org quan sát được: ${Array.from(observedOrganizationIds).join(', ') || '(rỗng)'}`,
          ));
        }
      } catch (error) {
        rejectBuildingId(new Error(`Không đọc được danh sách toà nhà: ${(error as Error).message}`));
      }
    }
    await route.fulfill({ response, body });
  });

  await page.route('**/rest/v1/rpc/*', async (route) => {
    const request = route.request();
    const rpcName = new URL(request.url()).pathname.split('/').filter(Boolean).pop() ?? '';
    let body: Json = {};
    try {
      body = (request.postDataJSON() ?? {}) as Json;
    } catch {
      body = {};
    }
    calls.push({ name: rpcName, body });

    if (rpcName === 'get_my_permissions') {
      if (options.permissions) {
        await fulfillJson(route, options.permissions);
        return;
      }
      await route.continue();
      return;
    }

    if (!rpcName.startsWith('network_center_')) {
      await route.continue();
      return;
    }

    try {
      await buildingIdPromise;
    } catch (error) {
      fixtureErrors.push((error as Error).message);
      await route.abort('failed');
      return;
    }

    const custom = handlers[rpcName];
    if (custom) {
      await custom(route, body, context);
      return;
    }

    switch (rpcName) {
      case 'network_center_list_fleet_v1':
        await fulfillJson(route, { items: [fleetItemDto(context, rolloutState, arubaTotal)] });
        return;
      case 'network_center_get_building_v1':
        await fulfillJson(route, buildingDto(context, rolloutState, settingsVersion));
        return;
      case 'network_center_list_clients_v1':
      case 'network_center_list_audit_v1':
        await fulfillJson(route, { items: [], nextCursor: null });
        return;
      case 'network_center_list_commands_v1':
        await fulfillJson(route, {
          items: commandSpecs.map((spec) => commandDto(spec, context)),
          nextCursor: null,
        });
        return;
      case 'network_center_list_aruba_v1': {
        const limit = Number(body.p_limit ?? ARUBA_PAGE_SIZE);
        const rawCursor = body.p_after_sort_order;
        const afterSortOrder = rawCursor === null || rawCursor === undefined ? null : Number(rawCursor);
        const payload = arubaPageDto(afterSortOrder, limit, arubaTotal);
        const serialized = JSON.stringify(payload);
        arubaPages.push({
          afterSortOrder,
          limit,
          itemCount: payload.items.length,
          chars: serialized.length,
        });
        await route.fulfill({ status: 200, contentType: 'application/json', body: serialized });
        return;
      }
      default:
        if (NETWORK_CENTER_WRITE_RPCS.has(rpcName)) {
          // Lưới an toàn: không có RPC ghi nào được rời trình duyệt.
          escapedWrites.push(rpcName);
          await route.abort('failed');
          return;
        }
        await route.continue();
    }
  });

  return {
    buildingId: () => buildingIdPromise,
    calls,
    callsOf: (name: string) => calls.filter((call) => call.name === name).map((call) => call.body),
    arubaPages,
    setSettingsVersion: (version: number) => {
      settingsVersion = version;
    },
    async dispose() {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
      await page
        .evaluate((key: string) => {
          try {
            window.localStorage.removeItem(key);
          } catch {
            /* storage bị chặn — không có gì để dọn */
          }
        }, INTENT_STORAGE_KEY)
        .catch(() => undefined);
      expect(escapedWrites, `RPC ghi lọt ra mạng: ${escapedWrites.join(', ')}`).toEqual([]);
      expect(fixtureErrors, `lỗi fixture: ${fixtureErrors.join(' | ')}`).toEqual([]);
      expect(
        Array.from(observedOrganizationIds),
        'fixture chỉ được chạm tới org DEMO',
      ).not.toContain(REAL_ORGANIZATION_ID);
    },
  };
}

/**
 * Chèn khung `postgres_changes` vào đúng socket Realtime thật.
 *
 * Ta `connectToServer()` nên bắt tay Phoenix vẫn do server thật thực hiện; test
 * chỉ đọc topic từ khung `phx_join` của client rồi gửi thêm một khung
 * `UPDATE` vào trang. KHÔNG bao giờ log payload `phx_join` vì nó chứa
 * `access_token`.
 */
interface RealtimeInjector {
  joinedTables(): Promise<string[]>;
  emitPostgresChange(record: Json, table?: string): Promise<void>;
}

async function installRealtimeInjector(page: Page): Promise<RealtimeInjector> {
  let resolveTopic: (value: string) => void = () => {};
  const topicPromise = new Promise<string>((resolve) => {
    resolveTopic = resolve;
  });
  let resolveTables: (value: string[]) => void = () => {};
  const tablesPromise = new Promise<string[]>((resolve) => {
    resolveTables = resolve;
  });
  let sendToPage: ((message: string) => void) | null = null;

  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    const server = ws.connectToServer();
    sendToPage = (message: string) => ws.send(message);
    ws.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString('utf8');
      try {
        const frame = JSON.parse(text) as { topic?: string; event?: string; payload?: Json };
        if (
          frame.event === 'phx_join'
          && typeof frame.topic === 'string'
          && frame.topic.startsWith('realtime:network-center-')
        ) {
          const config = (frame.payload?.config ?? {}) as Json;
          const changes = Array.isArray(config.postgres_changes)
            ? (config.postgres_changes as Array<{ table?: string }>)
            : [];
          resolveTables(changes
            .map((change) => (typeof change.table === 'string' ? change.table : ''))
            .filter(Boolean));
          resolveTopic(frame.topic);
        }
      } catch {
        /* khung nhị phân / heartbeat — bỏ qua */
      }
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(message);
    });
  });

  return {
    joinedTables: () => tablesPromise,
    async emitPostgresChange(record: Json, table = 'network_device_current') {
      const topic = await topicPromise;
      if (!sendToPage) throw new Error('Chưa có socket Realtime để phát khung postgres_changes.');
      sendToPage(JSON.stringify({
        topic,
        event: 'UPDATE',
        ref: null,
        payload: {
          schema: 'public',
          table,
          commit_timestamp: new Date().toISOString(),
          eventType: 'UPDATE',
          new: record,
          old: {},
          errors: null,
        },
      }));
    },
  };
}

async function openFleet(page: Page): Promise<void> {
  await page.goto('/network-center');
  await expect(page.getByRole('heading', { name: 'Trung tâm mạng', exact: true })).toBeVisible();
  await expect(page.getByText('Dữ liệu trực tiếp', { exact: true })).toBeVisible();
  await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toHaveCount(0);
}

async function openBuildingTab(
  page: Page,
  fixture: NetworkCenterFixture,
  tab: string,
): Promise<string> {
  await openFleet(page);
  const buildingId = await fixture.buildingId();
  await page.goto(`/network-center/buildings/${buildingId}?tab=${tab}`);
  await expect(page.getByRole('tablist', { name: 'Khu chức năng toà nhà' })).toBeVisible();
  return buildingId;
}

test.describe('Network Center production hardening', () => {
  test.skip(DEMO_MODE, 'Bộ hardening chỉ chạy trên repository production');

  test('quyền: thiếu network_center.view thì bị chặn khỏi route', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_WITHOUT_NETWORK_CENTER,
    });
    try {
      await login(page, 'chunha');
      await page.goto('/network-center/buildings/dddd2222-0000-4000-8000-000000000999?tab=settings');

      await expect(page).not.toHaveURL(/\/network-center/);
      await expect(page.getByRole('heading', { name: 'Trung tâm mạng', exact: true })).toHaveCount(0);
      // Không có view thì không được phép chạm tới bất kỳ RPC Network Center nào.
      expect(fixture.calls.filter((call) => call.name.startsWith('network_center_'))).toEqual([]);
      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('quyền: chỉ có view thì mọi lối ghi bị khóa và không RPC ghi nào được gửi', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_VIEW_ONLY,
      rolloutState: 'EXECUTE',
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'overview');

      await expect(page.locator('.nc-header-tools .nc-status')).toHaveText(/Chỉ xem/);
      await expect(page.locator('.nc-locked-note')).toContainText(
        'Tài khoản chỉ có quyền xem. Cần network_center.execute để thực thi thao tác.',
      );

      const actionButton = page.getByRole('button', { name: 'Thao tác MikroTik' });
      await expect(actionButton).toHaveAttribute('aria-disabled', 'true');
      await actionButton.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const maintenanceButton = page.getByRole('button', { name: 'Tạo bảo trì' });
      await expect(maintenanceButton).toHaveAttribute('aria-disabled', 'true');
      await maintenanceButton.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.getByRole('tab', { name: 'Cài đặt', exact: true }).click();
      await expect(page.getByLabel('Chu kỳ kiểm tra (giây)')).toBeDisabled();
      const saveButton = page.getByRole('button', { name: /Lưu cài đặt/ });
      await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
      await saveButton.click();

      for (const writeRpc of NETWORK_CENTER_WRITE_RPCS) {
        expect(fixture.callsOf(writeRpc), `RPC ghi ${writeRpc} không được gọi`).toEqual([]);
      }
      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('quyền: có execute + rollout EXECUTE thì thao tác đi đúng RPC và khóa intent', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const executeBodies: Json[] = [];
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'EXECUTE',
      handlers: {
        network_center_execute_action_v1: async (route, body, context) => {
          executeBodies.push(body);
          await fulfillJson(route, {
            commandId: FIXTURE_COMMAND_ID,
            status: 'QUEUED',
            actionType: 'FLUSH_DNS_CACHE',
            reason: String(body.p_reason ?? ''),
            parameters: {},
            target: {
              buildingId: context.buildingId,
              buildingName: context.buildingName,
              routerIdentity: ROUTER_IDENTITY,
            },
          });
        },
        network_center_get_command_v1: async (route, _body, context) => {
          await fulfillJson(route, commandDto({ id: FIXTURE_COMMAND_ID, status: 'QUEUED' }, context));
        },
      },
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'overview');

      await expect(page.locator('.nc-header-tools .nc-status')).toHaveText(/Được thực thi/);
      await expect(page.locator('.nc-locked-note')).toHaveCount(0);

      await page.getByRole('button', { name: 'Thao tác MikroTik' }).click();
      const dialog = page.getByRole('dialog', { name: 'Thao tác MikroTik' });
      await expect(dialog).toBeVisible();
      await page.getByLabel('Lý do thao tác').fill('Làm mới DNS sau kiểm tra định kỳ');
      await page.getByRole('button', { name: 'Kiểm tra và thực thi' }).click();

      await expect.poll(() => executeBodies.length, { timeout: 30_000 }).toBe(1);
      expect(executeBodies[0].p_device_id).toBe(FIXTURE_ROUTER_ID);
      expect(executeBodies[0].p_action_type).toBe('FLUSH_DNS_CACHE');
      expect(executeBodies[0].p_reason).toBe('Làm mới DNS sau kiểm tra định kỳ');
      expect(String(executeBodies[0].p_request_id)).toMatch(UUID_PATTERN);

      // Sau khi gửi, intent còn sống → mở lại hộp thoại là theo dõi, không gửi mới.
      // Hộp thoại tự đóng mỗi lần intent/jobs đổi, nên mở lại theo kiểu chịu được
      // refetch sau mutation thay vì chờ mù.
      await expect(dialog).toBeHidden();
      await expect(async () => {
        if (await dialog.count() === 0) {
          await page.getByRole('button', { name: 'Thao tác MikroTik' }).click();
        }
        await expect(page.getByRole('button', { name: 'Đang theo dõi intent hiện tại' }))
          .toBeDisabled({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      expect(executeBodies).toHaveLength(1);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('rollout OFF khóa toàn bộ thao tác dù tài khoản có execute', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'OFF',
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'overview');

      await expect(page.locator('.nc-header-tools .nc-status')).toHaveText(/Đã tắt/);
      await expect(page.locator('.nc-building-statuses')).toContainText('Đã tắt');
      await expect(page.locator('.nc-locked-note')).toContainText(
        'Network Center đang tắt cho tòa nhà này',
      );

      const actionButton = page.getByRole('button', { name: 'Thao tác MikroTik' });
      await expect(actionButton).toHaveAttribute('aria-disabled', 'true');
      await actionButton.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.getByRole('tab', { name: 'Cài đặt', exact: true }).click();
      await expect(page.getByLabel('Chu kỳ kiểm tra (giây)')).toBeDisabled();
      const saveButton = page.getByRole('button', { name: /Lưu cài đặt/ });
      await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
      await saveButton.click();

      for (const writeRpc of NETWORK_CENTER_WRITE_RPCS) {
        expect(fixture.callsOf(writeRpc), `RPC ghi ${writeRpc} không được gọi`).toEqual([]);
      }
      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('rollout READ_ONLY cho đọc nhưng chặn mọi thay đổi', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'READ_ONLY',
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'overview');

      await expect(page.locator('.nc-header-tools .nc-status')).toHaveText(/Chỉ đọc/);
      await expect(page.locator('.nc-building-statuses')).toContainText('Chỉ đọc');
      await expect(page.locator('.nc-locked-note')).toContainText('Tòa nhà đang ở chế độ chỉ đọc');

      // Dữ liệu telemetry vẫn phải đọc được ở READ_ONLY.
      await expect(
        page.locator('.nc-building-kpis .nc-kpi').filter({ hasText: 'CPU / RAM' }).locator('strong'),
      ).toHaveText(`${FIXTURE_CPU_PERCENT}/50%`);

      const actionButton = page.getByRole('button', { name: 'Thao tác MikroTik' });
      await expect(actionButton).toHaveAttribute('aria-disabled', 'true');
      await actionButton.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.getByRole('tab', { name: 'Sao lưu & so sánh', exact: true }).click();
      const captureButton = page.getByRole('button', { name: /Chụp cấu hình/ });
      await expect(captureButton).toHaveAttribute('aria-disabled', 'true');
      await captureButton.click();

      for (const writeRpc of NETWORK_CENTER_WRITE_RPCS) {
        expect(fixture.callsOf(writeRpc), `RPC ghi ${writeRpc} không được gọi`).toEqual([]);
      }
      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('telemetry trực tiếp render đúng router, WAN, backup và tổng Aruba', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_VIEW_ONLY,
      rolloutState: 'READ_ONLY',
      arubaTotal: 12,
    });
    try {
      await login(page, 'chunha');
      await openFleet(page);

      const fleetRow = page.locator('.nc-desktop-table tbody tr').first();
      await expect(fleetRow).toContainText(ROUTER_IDENTITY);
      await expect(fleetRow).toContainText('UP');
      await expect(fleetRow).toContainText('12/3.4 Mbps');
      await expect(fleetRow).toContainText(`${FIXTURE_CPU_PERCENT}% / 50%`);
      await expect(fleetRow).toContainText(ROUTER_FIRMWARE);

      await openBuildingTab(page, fixture, 'overview');
      const kpi = (label: string) =>
        page.locator('.nc-building-kpis .nc-kpi').filter({ hasText: label });
      await expect(kpi('WAN').locator('strong')).toHaveText('UP');
      await expect(kpi('WAN').locator('small')).toHaveText('12/3.4 Mbps');
      await expect(kpi('CPU / RAM').locator('strong')).toHaveText(`${FIXTURE_CPU_PERCENT}/50%`);
      await expect(kpi('CPU / RAM').locator('small')).toHaveText('5 phút trước');
      await expect(kpi('Client').locator('strong')).toHaveText(String(FIXTURE_ACTIVE_CLIENTS));
      await expect(kpi('Backup').locator('strong')).toHaveText('2h');
      await expect(kpi('Backup').locator('small')).toHaveText('SHA-256 1a2b3c4d');
      // 12 định danh Aruba, 1 offline + 1 chậm → 10 online sau khi phân trang xong.
      await expect(kpi('Aruba').locator('strong')).toHaveText('10/12');

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('intent ổn định: cùng idempotency key sau khi đóng và mở lại hộp thoại', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    // Lần gửi đầu bị cắt mạng CÓ CHỦ ĐÍCH để dựng trạng thái SUBMISSION_UNKNOWN.
    const failures = trackNetworkFailures(page, [/network_center_execute_action_v1/]);
    const executeBodies: Json[] = [];
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'EXECUTE',
      handlers: {
        network_center_execute_action_v1: async (route, body, context) => {
          executeBodies.push(body);
          if (executeBodies.length === 1) {
            await route.abort('connectionfailed');
            return;
          }
          await fulfillJson(route, {
            commandId: FIXTURE_COMMAND_ID,
            status: 'QUEUED',
            actionType: 'FLUSH_DNS_CACHE',
            reason: String(body.p_reason ?? ''),
            parameters: {},
            target: {
              buildingId: context.buildingId,
              buildingName: context.buildingName,
              routerIdentity: ROUTER_IDENTITY,
            },
          });
        },
        network_center_get_command_v1: async (route, _body, context) => {
          if (executeBodies.length < 2) {
            // Chưa có lệnh nào ở server: intent phải ở SUBMISSION_UNKNOWN, không
            // được tự suy ra thành công.
            await fulfillRpcError(route, 400, {
              code: 'P0002',
              message: 'NETWORK_CENTER_COMMAND_NOT_FOUND',
            });
            return;
          }
          await fulfillJson(route, commandDto({ id: FIXTURE_COMMAND_ID, status: 'RUNNING' }, context));
        },
      },
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'overview');

      await page.getByRole('button', { name: 'Thao tác MikroTik' }).click();
      const dialog = page.getByRole('dialog', { name: 'Thao tác MikroTik' });
      await expect(dialog).toBeVisible();
      await page.getByLabel('Lý do thao tác').fill('Làm mới DNS sau kiểm tra định kỳ');
      await page.getByRole('button', { name: 'Kiểm tra và thực thi' }).click();

      await expect.poll(() => executeBodies.length, { timeout: 30_000 }).toBe(1);
      // Hộp thoại tự đóng khi intent chuyển sang trạng thái chưa biết kết quả.
      await expect(dialog).toBeHidden();

      const retryButton = page.getByRole('button', { name: 'Thử gửi lại an toàn' });
      await expect(async () => {
        if (await dialog.count() === 0) {
          await page.getByRole('button', { name: 'Thao tác MikroTik' }).click();
        }
        await expect(retryButton).toBeEnabled({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      // Bản nháp phải sống sót qua vòng đóng/mở: cùng loại thao tác, cùng lý do.
      await expect(page.getByLabel('Lý do thao tác')).toHaveValue('Làm mới DNS sau kiểm tra định kỳ');
      await retryButton.click();

      await expect.poll(() => executeBodies.length, { timeout: 30_000 }).toBe(2);
      expect(String(executeBodies[0].p_request_id)).toMatch(UUID_PATTERN);
      expect(executeBodies[1].p_request_id).toBe(executeBodies[0].p_request_id);
      expect(executeBodies[1].p_device_id).toBe(executeBodies[0].p_device_id);
      expect(executeBodies[1].p_action_type).toBe(executeBodies[0].p_action_type);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('xung đột trùng thao tác trả về đúng lệnh đang chạy, không tạo lệnh thứ hai', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const executeBodies: Json[] = [];
    const getCommandBodies: Json[] = [];
    const originalReason = 'Lý do gốc của lệnh đang chạy';
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'EXECUTE',
      commands: [
        { id: FIXTURE_DUPLICATE_COMMAND_ID, status: 'RUNNING', reason: originalReason },
      ],
      handlers: {
        network_center_execute_action_v1: async (route, body) => {
          executeBodies.push(body);
          await fulfillRpcError(route, 409, {
            code: 'P0001',
            message: 'NETWORK_CENTER_DUPLICATE_INTENT',
            details: JSON.stringify({
              code: 'NETWORK_CENTER_DUPLICATE_INTENT',
              commandId: FIXTURE_DUPLICATE_COMMAND_ID,
            }),
          });
        },
        network_center_get_command_v1: async (route, body, context) => {
          getCommandBodies.push(body);
          await fulfillJson(route, commandDto(
            { id: FIXTURE_DUPLICATE_COMMAND_ID, status: 'RUNNING', reason: originalReason },
            context,
          ));
        },
      },
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'overview');

      await page.getByRole('button', { name: 'Thao tác MikroTik' }).click();
      await expect(page.getByRole('dialog', { name: 'Thao tác MikroTik' })).toBeVisible();
      await page.getByLabel('Lý do thao tác').fill('Lý do gửi lại từ trình duyệt');
      await page.getByRole('button', { name: 'Kiểm tra và thực thi' }).click();

      await expect.poll(() => executeBodies.length, { timeout: 30_000 }).toBe(1);
      await expect
        .poll(() => getCommandBodies.some((body) => body.p_command_id === FIXTURE_DUPLICATE_COMMAND_ID))
        .toBe(true);

      // Hộp thoại tự đóng khi intent bám vào lệnh đang chạy → overlay modal không
      // còn chặn thao tác đổi tab.
      await expect(page.getByRole('dialog', { name: 'Thao tác MikroTik' })).toBeHidden();
      await page.getByRole('tab', { name: 'Thay đổi', exact: true }).click();
      const jobs = page.locator('.nc-job-list > li');
      await expect(jobs).toHaveCount(1);
      await expect(jobs.first()).toContainText(originalReason);
      await expect(jobs.first()).not.toContainText('Lý do gửi lại từ trình duyệt');
      await expect(jobs.first().locator('.nc-job-status')).toHaveText(/Đang chạy/);
      // Gửi trùng không được sinh thêm lệnh nào.
      expect(executeBodies).toHaveLength(1);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('tab Thay đổi hiển thị đủ 5 giai đoạn cho mọi trạng thái lệnh', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const expectations = [
      {
        reason: 'Lệnh đang chờ worker nhận',
        status: 'QUEUED',
        label: 'Đang chờ',
        stages: ['success', 'pending', 'pending', 'pending', 'pending'],
      },
      {
        reason: 'Lệnh đang được worker thực hiện',
        status: 'RUNNING',
        label: 'Đang chạy',
        stages: ['success', 'running', 'running', 'pending', 'pending'],
      },
      {
        reason: 'Lệnh đã hoàn tất và đối soát',
        status: 'SUCCEEDED',
        label: 'Thành công',
        stages: ['success', 'success', 'success', 'success', 'success'],
      },
      {
        reason: 'Lệnh thất bại khi hậu kiểm',
        status: 'FAILED',
        label: 'Thất bại',
        stages: ['success', 'success', 'failed', 'failed', 'failed'],
      },
    ];
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_VIEW_ONLY,
      rolloutState: 'READ_ONLY',
      commands: expectations.map((item, index) => ({
        id: `dddd2222-0000-4000-8000-00000000080${index}`,
        status: item.status,
        reason: item.reason,
        ageMinutes: index + 1,
      })),
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'changes');

      await expect(page.locator('.nc-job-list > li')).toHaveCount(expectations.length);
      const stageLabels = ['Kiểm tra đầu vào', 'Backup', 'Thực hiện', 'Kiểm tra sau', 'Hoàn tất'];
      for (const item of expectations) {
        const job = page.locator('.nc-job-list > li').filter({ hasText: item.reason });
        await expect(job).toHaveCount(1);
        await expect(job.locator('.nc-job-status')).toHaveText(new RegExp(item.label));
        const stages = job.locator('.nc-stage-list > li');
        await expect(stages).toHaveCount(5);
        for (let index = 0; index < 5; index += 1) {
          await expect(stages.nth(index)).toContainText(stageLabels[index]);
          await expect(stages.nth(index)).toHaveClass(new RegExp(`nc-stage-${item.stages[index]}`));
        }
      }

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('kết quả UNCERTAIN hiện là chưa kết luận, không bao giờ báo thành công', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_VIEW_ONLY,
      rolloutState: 'READ_ONLY',
      commands: [
        {
          id: FIXTURE_COMMAND_ID,
          status: 'UNCERTAIN',
          reason: 'Khởi động lại cổng truy cập tầng 2',
          actionType: 'CYCLE_ACCESS_PORT',
          reconciliationState: 'REQUIRED',
        },
      ],
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'changes');

      const job = page.locator('.nc-job-list > li').first();
      await expect(job.locator('.nc-job-status')).toHaveText(/Chưa thể kết luận/);
      await expect(job.locator('.nc-job-status')).toHaveClass(/nc-status-uncertain/);
      await expect(job).toContainText('chưa thể kết luận thành công hay thất bại');
      // Không có bất kỳ nhãn trạng thái lệnh "thành công" nào trên trang.
      await expect(page.locator('.nc-job-status.nc-status-success')).toHaveCount(0);
      // Chỉ giai đoạn kiểm tra đầu vào được coi là xong; hậu kiểm và hoàn tất chưa.
      await expect(job.locator('.nc-stage-list > li.nc-stage-success')).toHaveCount(1);
      await expect(job.locator('.nc-stage-list > li').last()).toHaveClass(/nc-stage-pending/);
      await expect(job.locator('.nc-stage-list > li').nth(3)).toHaveClass(/nc-stage-running/);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('xung đột phiên bản cài đặt được báo lỗi và luôn gửi đúng version đang hiển thị', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const updateBodies: Json[] = [];
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'EXECUTE',
      settingsVersion: 7,
      handlers: {
        network_center_update_settings_v1: async (route, body) => {
          updateBodies.push(body);
          await fulfillRpcError(route, 409, {
            code: '40001',
            message: 'could not serialize access due to concurrent update',
          });
        },
      },
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'settings');

      await page.getByLabel('Chu kỳ kiểm tra (giây)').fill('90');
      await page.getByRole('button', { name: /Lưu cài đặt/ }).click();

      await expect(page.locator('.nc-form-error')).toHaveText(
        'Cài đặt đã thay đổi; vui lòng tải lại trước khi lưu',
      );
      await expect.poll(() => updateBodies.length, { timeout: 30_000 }).toBe(1);
      expect(updateBodies[0].p_expected_version).toBe(7);
      expect((updateBodies[0].p_settings as Json).pollingSeconds).toBe(90);
      // Bản nháp không bị nuốt mất khi lưu hỏng.
      await expect(page.getByLabel('Chu kỳ kiểm tra (giây)')).toHaveValue('90');

      // Server nhảy version → lần lưu sau phải mang version mới, không phải version cũ.
      fixture.setSettingsVersion(9);
      await page.reload();
      await expect(page.getByRole('tablist', { name: 'Khu chức năng toà nhà' })).toBeVisible();
      await page.getByRole('button', { name: /Lưu cài đặt/ }).click();
      await expect.poll(() => updateBodies.length, { timeout: 30_000 }).toBe(2);
      expect(updateBodies[1].p_expected_version).toBe(9);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('Realtime postgres_changes làm mới dữ liệu toà nhà đang mở', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const realtime = await installRealtimeInjector(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_VIEW_ONLY,
      rolloutState: 'READ_ONLY',
    });
    try {
      await login(page, 'chunha');
      const buildingId = await openBuildingTab(page, fixture, 'overview');
      await expect(
        page.locator('.nc-building-kpis .nc-kpi').filter({ hasText: 'CPU / RAM' }).locator('strong'),
      ).toHaveText(`${FIXTURE_CPU_PERCENT}/50%`);

      // Kênh phải đăng ký đủ 5 bảng NETWORK_CENTER_REALTIME_TABLES.
      const joinedTables = await realtime.joinedTables();
      for (const table of [
        'network_device_current',
        'network_interface_current',
        'network_incidents',
        'network_command_events',
        'network_worker_building_status',
      ]) {
        expect(joinedTables, `kênh Realtime phải lắng nghe ${table}`).toContain(table);
      }

      const before = fixture.callsOf('network_center_get_building_v1').length;
      expect(before).toBeGreaterThan(0);
      await realtime.emitPostgresChange({ building_id: buildingId });

      await expect
        .poll(() => fixture.callsOf('network_center_get_building_v1').length, { timeout: 30_000 })
        .toBeGreaterThan(before);
      await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toHaveCount(0);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('50.000 định danh Aruba: chi phí trình duyệt không tăng theo tổng số', async ({ page }) => {
    /*
     * HỤT SO VỚI KẾ HOẠCH (ghi rõ, không nguỵ tạo con số):
     * 50.000 định danh ở đây được PHỤC VỤ qua đúng hợp đồng keyset
     * `network_center_list_aruba_v1` từ fixture route, KHÔNG phải 50.000 hàng
     * thật trong Postgres. Trình duyệt không có đường ghi nào vào kho Aruba
     * (worker sở hữu), và seed 50.000 hàng chỉ làm được bằng credential admin
     * ngoài phạm vi FLEET_PASS_* mà bộ e2e này được phép dùng — nên bài này
     * chứng minh BẤT BIẾN "chi phí trình duyệt bị chặn trên", còn phần seed
     * 50.000 hàng thật thuộc fixture worker/database của Task 15 Bước 2.
     */
    const ARUBA_TOTAL = 50_000;
    const PAGES_TO_WALK = 6;
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_VIEW_ONLY,
      rolloutState: 'READ_ONLY',
      arubaTotal: ARUBA_TOTAL,
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'topology');

      const nodes = page.locator('.nc-aruba-nodes-full .nc-aruba-node');
      await expect(nodes).toHaveCount(ARUBA_PAGE_SIZE);
      await expect(page.locator('.nc-heading-actions strong')).toHaveText(
        `Đang hiển thị ${ARUBA_PAGE_SIZE} · Tổng ${ARUBA_TOTAL}`,
      );
      const domAfterFirstPage = await page.evaluate(() => document.querySelectorAll('*').length);

      for (let pageIndex = 2; pageIndex <= PAGES_TO_WALK; pageIndex += 1) {
        await page.getByRole('button', { name: 'Xem trang Aruba tiếp theo' }).click();
        const firstName = `AP-${String((pageIndex - 1) * ARUBA_PAGE_SIZE + 1).padStart(5, '0')}`;
        await expect(nodes.first().locator('strong')).toHaveText(firstName);
        // Bất biến: cửa sổ hiển thị luôn đúng 1 trang, không cộng dồn.
        await expect(nodes).toHaveCount(ARUBA_PAGE_SIZE);
      }

      const domAfterLastPage = await page.evaluate(() => document.querySelectorAll('*').length);
      expect(
        Math.abs(domAfterLastPage - domAfterFirstPage),
        'số node DOM không được tăng theo số trang đã duyệt',
      ).toBeLessThanOrEqual(40);

      expect(fixture.arubaPages).toHaveLength(PAGES_TO_WALK);
      for (const observation of fixture.arubaPages) {
        expect(observation.limit).toBe(ARUBA_PAGE_SIZE);
        expect(observation.limit).toBeLessThanOrEqual(ARUBA_MAX_PAGE_SIZE);
        expect(observation.itemCount).toBeLessThanOrEqual(ARUBA_PAGE_SIZE);
        expect(observation.chars, 'payload mỗi trang phải bị chặn trên').toBeLessThan(64_000);
      }
      // Con trỏ keyset phải tiến đều, không quét lại từ đầu.
      const cursors = fixture.arubaPages.map((observation) => observation.afterSortOrder ?? 0);
      for (let index = 1; index < cursors.length; index += 1) {
        expect(cursors[index]).toBe(cursors[index - 1] + ARUBA_PAGE_SIZE);
      }
      const renderedRows = await nodes.count();
      expect(renderedRows).toBe(ARUBA_PAGE_SIZE);
      expect(
        renderedRows * 100,
        'số dòng render phải nhỏ hơn tổng định danh ít nhất 100 lần',
      ).toBeLessThan(ARUBA_TOTAL);
      const totalChars = fixture.arubaPages.reduce((sum, observation) => sum + observation.chars, 0);
      expect(totalChars, 'tổng payload Aruba phải chặn theo số trang, không theo tổng số')
        .toBeLessThan(PAGES_TO_WALK * 64_000);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('route mobile giữ đúng trạng thái rollout và không tràn ngang', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page);
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'READ_ONLY',
    });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, 'chunha');
      await openFleet(page);

      await expect(page.locator('.nc-mobile-site').first()).toBeVisible();
      await expect(page.locator('.nc-mobile-site').first()).toContainText(ROUTER_IDENTITY);
      expect(await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )).toBe(false);

      await page.locator('.nc-card-link').first().click();
      await expect(page).toHaveURL(/\/network-center\/buildings\//);
      await expect(page.locator('.nc-building-statuses')).toContainText('Chỉ đọc');
      const actionButton = page.getByRole('button', { name: 'Thao tác MikroTik' });
      await expect(actionButton).toHaveAttribute('aria-disabled', 'true');
      await actionButton.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )).toBe(false);

      await page.getByRole('tab', { name: 'Cài đặt', exact: true }).click();
      await expect(page.getByRole('button', { name: /Lưu cài đặt/ })).toHaveAttribute('aria-disabled', 'true');
      for (const writeRpc of NETWORK_CENTER_WRITE_RPCS) {
        expect(fixture.callsOf(writeRpc), `RPC ghi ${writeRpc} không được gọi`).toEqual([]);
      }

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('RPC lỗi hiển thị rõ, phục hồi được và không bịa dữ liệu thay thế', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const failures = trackNetworkFailures(page, [
      /network_center_list_aruba_v1/,
      /network_center_update_settings_v1/,
    ]);
    let arubaShouldFail = true;
    const arubaCalls: number[] = [];
    const updateBodies: Json[] = [];
    const fixture = await installNetworkCenterFixture(page, {
      permissions: PERMISSIONS_EXECUTE,
      rolloutState: 'EXECUTE',
      handlers: {
        network_center_list_aruba_v1: async (route, body) => {
          arubaCalls.push(Number(body.p_limit ?? ARUBA_PAGE_SIZE));
          if (arubaShouldFail) {
            await fulfillRpcError(route, 500, { message: 'forced-aruba-failure' });
            return;
          }
          await fulfillJson(route, arubaPageDto(null, Number(body.p_limit ?? ARUBA_PAGE_SIZE), 12));
        },
        network_center_update_settings_v1: async (route, body) => {
          updateBodies.push(body);
          await fulfillRpcError(route, 500, { message: 'forced-settings-failure' });
        },
      },
    });
    try {
      await login(page, 'chunha');
      await openBuildingTab(page, fixture, 'topology');

      const arubaAlert = page.getByRole('alert');
      await expect(arubaAlert).toHaveText('Không thể tải danh sách Aruba. Vui lòng thử lại.');
      await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toHaveCount(0);
      await expect(page.locator('.nc-aruba-nodes-full .nc-aruba-node')).toHaveCount(0);

      arubaShouldFail = false;
      await page.getByRole('button', { name: 'Thử lại' }).click();
      await expect(page.locator('.nc-aruba-nodes-full .nc-aruba-node')).toHaveCount(12);
      await expect(page.getByRole('alert')).toHaveCount(0);

      await page.getByRole('tab', { name: 'Cài đặt', exact: true }).click();
      await page.getByRole('button', { name: /Lưu cài đặt/ }).click();
      await expect(page.locator('.nc-form-error')).toHaveText('Dịch vụ Network Center từ chối yêu cầu');
      expect(updateBodies).toHaveLength(1);
      // Lỗi ghi không được biến thành trạng thái "đã lưu" giả.
      await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toHaveCount(0);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      expect(failures, `network failures: ${failures.join(' | ')}`).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('cổng quyền UI khớp đúng quyền server cho cả ba vai demo', async ({ browser }) => {
    const contexts: BrowserContext[] = [];
    try {
      for (const who of ['chunha', 'ketoan', 'quanly'] as const) {
        // credentials() ném lỗi rõ ràng khi thiếu env FLEET_PASS_*; mật khẩu
        // KHÔNG bao giờ được đọc ra ở đây.
        const account = credentials(who);
        expect(
          account.email.endsWith('@username.ihomecrm.local'),
          `vai ${who} phải dùng tài khoản DEMO`,
        ).toBe(true);

        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        const consoleErrors = trackConsoleErrors(page);
        const failures = trackNetworkFailures(page);
        const captured: { permissions: Json | null } = { permissions: null };
        await page.route('**/rest/v1/rpc/get_my_permissions', async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          try {
            const parsed: unknown = JSON.parse(body);
            captured.permissions = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Json)
              : {};
          } catch {
            captured.permissions = {};
          }
          await route.fulfill({ response, body });
        });

        await login(page, who);
        await page.goto('/network-center');
        await expect
          .poll(() => captured.permissions !== null, {
            message: `chưa nhận được get_my_permissions cho vai ${who}`,
            timeout: 30_000,
          })
          .toBe(true);

        if (serverGrants(captured.permissions, 'view')) {
          await expect(page).toHaveURL(/\/network-center/);
          await expect(page.getByRole('heading', { name: 'Trung tâm mạng', exact: true })).toBeVisible();
          await expect(page.getByText('Dữ liệu mô phỏng', { exact: true })).toHaveCount(0);
        } else {
          await expect(page).not.toHaveURL(/\/network-center/);
          await expect(page.getByRole('heading', { name: 'Trung tâm mạng', exact: true })).toHaveCount(0);
        }
        expect(consoleErrors, `console errors (${who}): ${consoleErrors.join(' | ')}`).toEqual([]);
        expect(failures, `network failures (${who}): ${failures.join(' | ')}`).toEqual([]);
      }
    } finally {
      for (const context of contexts) {
        await context.close().catch(() => undefined);
      }
    }
  });
});
