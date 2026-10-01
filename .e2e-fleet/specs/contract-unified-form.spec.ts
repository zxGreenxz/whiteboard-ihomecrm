import { test, expect, type Page } from '@playwright/test';
import { credentials, type UserKey } from './auth';

const TEST_HOST = 'hzulujxgonszuleqticb.supabase.co';
const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const ACTOR_ID = 'e2e00000-0000-4000-8000-000000000029';
const READ_RPC = new Set([
  'get_dashboard_summary', 'revenue_by_month', 'get_contract_stats', 'get_my_context',
  'get_my_assignments', 'is_admin', 'is_super_admin', 'get_my_permissions', 'get_my_permissions_v2',
  'list_my_copilot_organizations_v1', 'business_performance_organizations_v1', 'my_org_ids',
  'get_notification_org_config_v1', 'get_my_notification_preferences_v1', 'list_cashbook_visibility_v2',
  'list_due_contract_move_out_notices_v1', 'list_contract_exit_cases_v1', 'list_contract_meter_followups_v1',
  'get_contract_move_out_notice_v1', 'read_contract_meter_boundary_set_v1', 'read_contract_transfer_links_v1',
  'list_contract_drafts', 'list_room_reservations_v1',
]);

type JsonRecord = Record<string, unknown>;

// Authenticate the real TEST role without letting the home page mount its
// unrelated legacy notification scheduler. The target page still uses a real
// session and every subsequent request passes through guardTestDemo.
async function openContracts(page: Page, role: UserKey) {
  const account = credentials(role);
  const authPage = await page.context().newPage();
  type Session = { access_token: string; refresh_token: string; expires_in: number; user: { email: string } };
  let resolveSession!: (session: Session) => void;
  let rejectSession!: (error: unknown) => void;
  const authenticated = new Promise<Session>((resolve, reject) => { resolveSession = resolve; rejectSession = reject; });
  await authPage.route(`https://${TEST_HOST}/auth/v1/token*`, async route => {
    try {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(new URL(request.url()).searchParams.get('grant_type')).toBe('password');
      expect(request.postDataJSON().email).toBe(account.email);
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.ok()).toBe(true);
      const session: Session = await response.json();
      expect(session.user.email).toBe(account.email);
      resolveSession(session);
    } catch (error) { rejectSession(error); }
    finally { await route.abort('aborted'); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await authPage.goto('/login');
    await authPage.getByRole('textbox', { name: 'Tài Khoản' }).fill(account.email);
    await authPage.getByRole('textbox', { name: 'Mật khẩu' }).fill(account.pass);
    await authPage.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    const session = await Promise.race([authenticated, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TEST role authentication timed out')), 45_000);
    })]);
    await page.addInitScript(({ session, host }) => {
      localStorage.setItem(`sb-${host.split('.')[0]}-auth-token`, JSON.stringify({
        ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in,
      }));
    }, { session, host: TEST_HOST });
  } finally {
    clearTimeout(timer);
    await authPage.close();
  }
  await page.goto('/contracts');
}

async function guardTestDemo(page: Page, email: string) {
  expect(process.env.FLEET_BASE_URL).toBe('http://127.0.0.1:5197');
  const blocked: string[] = [];
  const errors: string[] = [];
  const unexpectedWriters: string[] = [];
  let observedTest = false;
  let savedDraft: JsonRecord | null = null;
  let savedPayload: JsonRecord | null = null;
  let interceptedSaves = 0;
  await page.context().addInitScript(org => localStorage.setItem('ihomecrm.selectedOrganizationId', org), DEMO_ORG);
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    const block = async () => {
      blocked.push(`${method} ${url.hostname}${url.pathname}`);
      if (rpc && !READ_RPC.has(rpc)) unexpectedWriters.push(rpc);
      await route.abort('blockedbyclient');
    };
    if (url.hostname.endsWith('.supabase.co')) {
      if (url.hostname !== TEST_HOST) return block();
      observedTest = true;
      if (url.pathname.startsWith('/functions/')) return block();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
      if (url.pathname === '/auth/v1/token' && method === 'POST') {
        const grant = url.searchParams.get('grant_type');
        const body = request.postDataJSON();
        if (grant === 'refresh_token' || (grant === 'password' && body.email === email)) return route.continue();
      }
      if (rpc === 'save_contract_draft' && method === 'POST') {
        const body = request.postDataJSON();
        if (body?.p_organization_id !== DEMO_ORG || !body?.p_building_id || !body?.p_draft_id
          || !body?.p_payload || body?.p_room_id) return block();
        interceptedSaves++;
        savedPayload = body.p_payload as JsonRecord;
        const now = new Date().toISOString();
        savedDraft = { id: body.p_draft_id, organization_id: DEMO_ORG, building_id: body.p_building_id,
          room_id: null, template_id: body.p_template_id ?? null, revision: 1, payload: body.p_payload,
          created_by: ACTOR_ID, created_at: now, updated_at: now, documents: [], status: 'EDITABLE',
          converted_contract_id: null };
        return route.fulfill({ status: 200, contentType: 'application/json',
          headers: { 'access-control-allow-origin': 'http://127.0.0.1:5197', 'access-control-allow-credentials': 'true' },
          body: JSON.stringify(savedDraft) });
      }
      if (rpc === 'list_contract_drafts' && savedDraft && method === 'POST') {
        const body = request.postDataJSON();
        if (body?.p_organization_id !== DEMO_ORG) return block();
        return route.fulfill({ status: 200, contentType: 'application/json',
          headers: { 'access-control-allow-origin': 'http://127.0.0.1:5197', 'access-control-allow-credentials': 'true' },
          body: JSON.stringify([savedDraft]) });
      }
      if (rpc && READ_RPC.has(rpc) && method === 'POST') {
        const body = request.postDataJSON();
        if (body?.p_organization_id && body.p_organization_id !== DEMO_ORG) return block();
        if (body?.p_org && body.p_org !== DEMO_ORG) return block();
        return route.continue();
      }
      return block();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return block();
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return { blocked, errors, unexpectedWriters, observedTest: () => observedTest,
    savedDraft: () => savedDraft, savedPayload: () => savedPayload, interceptedSaves: () => interceptedSaves };
}

async function assertSharedSections(dialog: ReturnType<Page['getByRole']>) {
  for (const title of ['Thông tin chung', 'Khách hàng', 'Tiền thuê & Tiền cọc', 'Tiền phí dịch vụ',
    'Xem trước hoá đơn cọc + tháng đầu']) {
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole('button', { name: 'Lưu', exact: true })).toBeVisible();
  await expect(dialog.getByText('Mẫu hợp đồng', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Thông tin chủ nhà trên tài liệu', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Lưu và xuất nháp .docx', exact: true })).toHaveCount(0);
}

async function openChoice(page: Page, dialog: ReturnType<Page['getByRole']>) {
  await dialog.getByRole('button', { name: 'Lưu', exact: true }).click();
  const choice = page.getByRole('dialog', { name: 'Bạn muốn lưu hợp đồng thế nào?' });
  await expect(choice).toBeVisible();
  await expect(choice.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible();
  await expect(choice.getByRole('button', { name: 'Xác nhận ký', exact: true })).toBeVisible();
  return choice;
}

async function openSupport(dialog: ReturnType<Page['getByRole']>) {
  const header = dialog.getByRole('button', { name: /^Lịch hỗ trợ tiền thuê/ });
  if (await header.getAttribute('aria-expanded') === 'false') await header.click();
}

async function enterSupportSchedule(page: Page, dialog: ReturnType<Page['getByRole']>) {
  await dialog.getByRole('combobox').first().click();
  await page.getByRole('option').first().click();
  for (const [name, value] of [['start_date', '20/09/2026'], ['end_date', '20/09/2027'], ['start_billing_date', '20/09/2026'], ['end_billing_date', '05/10/2026']]) {
    await dialog.locator(`input[name="${name}"]`).fill(value); await dialog.locator(`input[name="${name}"]`).blur();
  }
  await openSupport(dialog);
  await dialog.getByLabel('Số tháng giai đoạn 1', { exact: true }).fill('3');
  await dialog.getByLabel('Hỗ trợ mỗi tháng giai đoạn 1', { exact: true }).fill('300000');
  await dialog.getByRole('button', { name: 'Thêm giai đoạn kế tiếp' }).click();
  await dialog.getByLabel('Số tháng giai đoạn 2', { exact: true }).fill('9');
  await dialog.getByLabel('Hỗ trợ mỗi tháng giai đoạn 2', { exact: true }).fill('100000');
  await expect(dialog.getByText('09/2026 · 10/2026 · 11/2026')).toBeVisible();
  await expect(dialog.getByText(/Tổng hỗ trợ khách: 1.800.000/)).toBeVisible();
  await dialog.locator('input[name="end_billing_date"]').fill('31/10/2026');
  await dialog.locator('input[name="end_billing_date"]').blur();
  await expect(dialog.getByText(/09\/2026 chưa có kỳ hóa đơn đủ điều kiện/)).toBeVisible();
  await expect(dialog.getByText(/Kỳ đầu dự kiến: 10\/2026/)).toBeVisible();
}

for (const role of ['chunha', 'quanly'] as const) {
  test(`TEST DEMO ${role}: official create and draft use one form without financial writers`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const audit = await guardTestDemo(page, `demo.${role}@username.ihomecrm.local`);
    await openContracts(page, role);
    await expect(page.locator('main')).toBeVisible();
    await expect(page).toHaveURL(/\/contracts$/);
    await expect(page.getByRole('tablist', { name: 'Các mục hợp đồng' })).toBeVisible();

    await page.locator('button.bg-green-500').first().click();
    const create = page.getByRole('dialog', { name: /Tạo hợp đồng mới/ });
    await expect(create).toBeVisible();
    await assertSharedSections(create);
    await enterSupportSchedule(page, create);
    if (role === 'chunha') await create.screenshot({ path: testInfo.outputPath('owner-official-create.png'), animations: 'disabled' });
    const createChoice = await openChoice(page, create);
    await createChoice.getByRole('button', { name: 'Close' }).click();
    await expect(createChoice).toHaveCount(0);
    await create.getByRole('button', { name: 'Hủy', exact: true }).click();
    await expect(create).toHaveCount(0);

    await page.getByRole('tablist', { name: 'Các mục hợp đồng' }).getByRole('tab', { name: /Hợp đồng nháp/ }).click();
    const workspace = page.getByRole('region', { name: 'Hợp đồng nháp', exact: true });
    await expect(workspace).toBeVisible();
    await workspace.getByRole('button', { name: 'Soạn nháp', exact: true }).click();
    const draft = page.getByRole('dialog', { name: /Tạo hợp đồng mới/ });
    await expect(draft).toBeVisible();
    await assertSharedSections(draft);
    await enterSupportSchedule(page, draft);
    if (role === 'chunha') await draft.screenshot({ path: testInfo.outputPath('owner-draft-same-editor.png'), animations: 'disabled' });
    const choice = await openChoice(page, draft);

    if (role === 'chunha') {
      await choice.getByRole('button', { name: 'Close' }).click();
      await expect(choice).toHaveCount(0);
      const marker = `E2E UI-only draft ${crypto.randomUUID()}`;
      await draft.getByPlaceholder('Ghi chú hợp đồng...').fill(marker);
      await draft.getByRole('button', { name: 'Sửa tiền thuê' }).click();
      await draft.locator('input[name="rent_price"]').fill('1234567');
      const saveChoice = await openChoice(page, draft);
      await saveChoice.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
      await expect.poll(() => audit.interceptedSaves()).toBe(1);
      const savedPayload = audit.savedPayload();
      expect(savedPayload?.form).toMatchObject({ room_id: '', notes: marker, rent_price: 1234567 });
      expect(savedPayload?.customers).toEqual([]);
      expect(savedPayload?.rent_support).toMatchObject({ version: 2, start_billing_month: '2026-09', payer: 'BUILDING',
        segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] });
      expect(savedPayload?.editor_state).toMatchObject({ version: 1, rent_unlocked: true });
      expect(savedPayload).not.toHaveProperty('deposit_receipts');
      expect(savedPayload).not.toHaveProperty('first_invoice');
      expect(savedPayload).not.toHaveProperty('existing_deposit_voucher_ids');
      await expect(draft.getByText(/Nháp · phiên bản 1/)).toBeVisible();
      await draft.getByRole('button', { name: 'Hủy', exact: true }).click();
      await expect(draft).toHaveCount(0);
      const row = workspace.getByText('Bản nháp · Chưa chọn khách đại diện', { exact: true });
      await expect(row).toBeVisible();
      await row.locator('..').locator('..').getByRole('button', { name: 'Sửa nháp', exact: true }).click();
      const reopened = page.getByRole('dialog', { name: /Tạo hợp đồng mới/ });
      await expect(reopened.getByPlaceholder('Ghi chú hợp đồng...')).toHaveValue(marker);
      await expect(reopened.locator('input[name="rent_price"]')).toHaveValue('1.234.567');
      await openSupport(reopened);
      await expect(reopened.getByText(/Tổng hỗ trợ khách: 1.800.000/)).toBeVisible();
      await reopened.getByRole('button', { name: 'Hủy', exact: true }).click();
      const savedRow = row.locator('..').locator('..');
      await expect(savedRow.getByRole('button', { name: 'Xuất nháp', exact: true })).toHaveCount(0);
      await expect(savedRow.getByRole('button', { name: /^Tải v\d+$/ })).toHaveCount(0);
      await savedRow.getByRole('button', { name: 'In', exact: true }).click();
      const print = page.getByRole('dialog', { name: 'In hợp đồng' });
      await expect(print.getByText('Chọn mẫu hợp đồng', { exact: true })).toBeVisible();
      await expect(print.getByRole('button', { name: 'Tải xuống .docx', exact: true })).toBeVisible();
      await print.getByRole('button', { name: 'Hủy', exact: true }).click();
    } else {
      await choice.getByRole('button', { name: 'Close' }).click();
      await expect(choice).toHaveCount(0);
      await draft.getByRole('button', { name: 'Hủy', exact: true }).click();
    }

    expect(audit.observedTest()).toBe(true);
    expect(audit.unexpectedWriters).toEqual([]);
    expect(audit.blocked).toEqual([]);
    expect(audit.errors).toEqual([]);
    if (role === 'chunha') expect(audit.savedDraft()).not.toBeNull();
  });
}
