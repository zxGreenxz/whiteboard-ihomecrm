import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { loadSupabaseAdminConfig } from '../../scripts/apply-accounting-rollout.mjs';
import { DEMO_ORG_ID, DEMO_OWNER_EMAIL, runQuery, fixtureInvoiceSql,
  committedAdjustmentFixtureTeardownSql, fixtureMarker, newRunId, sqlLiteral, uuidLiteral,
} from '../../scripts/lib/v5-collection-harness.mjs';

test('issued adjustment, collection, review, mobile history and edit after reversal', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000);
  const config = loadSupabaseAdminConfig({ readFile: (path: string | URL, encoding: BufferEncoding) =>
    readFileSync(String(path).includes('CLAUDE.local.md') && process.env.IHOMECRM_SECRET_FILE
      ? process.env.IHOMECRM_SECRET_FILE : path, encoding) });
  const query = <Row extends object = Record<string, unknown>>(sql: string) => runQuery<Row>(sql, config);
  const marker = fixtureMarker(`adjustment-ui-${newRunId()}`), month = '2098-10';
  const actor = (await query<{ id: string }>(`SELECT id FROM auth.users WHERE email=${sqlLiteral(DEMO_OWNER_EMAIL)}`))[0].id;
  expect((await query(`SELECT to_regprocedure('public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)') IS NOT NULL AS ready`))[0].ready,
    'Reviewed adjustment schema must be deployed before creating fixture').toBe(true);
  let invoiceId: string | undefined;
  const adjustmentIds = new Set<string>();
  const refs = new Set<string>();
  page.on('request', request => { const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\//.exec(request.url()); if (match) refs.add(match[1]); });
  const errors = trackConsoleErrors(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/rest/v1/rpc/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'POST' || !/\/(record_invoice_collection_v\d+|adjust_invoice_v\d+|review_invoice_adjustment_v\d+)$/.test(url.pathname)) return route.continue();
    const payload = request.postDataJSON();
    const allowed = url.origin === `https://${config.projectRef}.supabase.co` && invoiceId &&
      (url.pathname.endsWith('/review_invoice_adjustment_v2') ? adjustmentIds.has(payload.p_adjustment_id)
        : /\/(record_invoice_collection_v5|adjust_invoice_v2)$/.test(url.pathname) && payload.p_invoice_id === invoiceId);
    if (!allowed) { errors.push('Blocked invoice writer outside exact fixture scope'); return route.abort('blockedbyclient'); }
    await route.continue();
  });
  const state = async () => (await query<{ items: { id: string }[]; [key: string]: unknown }>(`SELECT i.*,
    i.paid_amount::bigint AS paid_amount,i.remaining_amount::bigint AS remaining_amount,i.total_amount::bigint AS total_amount,
    (SELECT count(*) FROM public.invoice_payment_collections c WHERE c.invoice_id=i.id AND c.status='ACTIVE') AS active,
    (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.sort_order,line.id) FROM public.invoice_items line WHERE line.invoice_id=i.id) AS items
    FROM public.invoices i WHERE i.id=${uuidLiteral(invoiceId!)} AND i.organization_id='${DEMO_ORG_ID}'`))[0];
  const waitRpc = (name: string, currentPage: Page = page) => currentPage.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().endsWith(`/rpc/${name}`), { timeout: 45_000 });
  const assertRpc = async (pending: ReturnType<typeof waitRpc>) => {
    const response = await pending, body = await response.json();
    expect(response.ok(), `HTTP ${response.status()}: ${JSON.stringify(body)}`).toBe(true);
    expect(body.invoice_id).toBe(invoiceId);
    if (response.url().endsWith('/rpc/adjust_invoice_v2')) adjustmentIds.add(body.id);
    return body;
  };
  const openEditor = async () => {
    await page.locator('button[title="Điều chỉnh hóa đơn"],button[title="Chỉnh sửa"]').click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /^Điều chỉnh hóa đơn / }) });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const accountantContext = await browser.newContext({ baseURL });
  try {
    await login(page, 'chunha');
    expect([...refs]).toEqual([config.projectRef]);
    const rows = await query<{ invoice_id?: string; building_id: string; room_name: string }>(`BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';
      ${fixtureInvoiceSql({ marker, billingMonth: month, rent: 5239000, deposit: 0 })}
      WITH fixture_account AS (
        INSERT INTO public.accounts(organization_id,user_id,name,code,description)
        VALUES ('${DEMO_ORG_ID}',${uuidLiteral(actor)},${sqlLiteral(`${marker} Thu`)},${sqlLiteral(marker)},${sqlLiteral(marker)}) RETURNING id
      ) SELECT set_config('v5h.account_tm',id::text,true) FROM fixture_account;
      INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from,reason)
      SELECT m.organization_id,current_setting('v5h.account_tm')::uuid,m.id,'KNOWER',now()-interval '1 minute',${sqlLiteral(marker)}
      FROM public.organization_memberships m WHERE m.organization_id='${DEMO_ORG_ID}' AND m.user_id=${uuidLiteral(actor)} AND m.status='ACTIVE';
      SELECT current_setting('v5h.invoice') AS invoice_id,current_setting('v5h.building') AS building_id,
        (SELECT name FROM public.rooms WHERE id=current_setting('v5h.room')::uuid) AS room_name; COMMIT;`);
    const fixture = rows.find((row: { invoice_id?: string }) => row.invoice_id);
    expect(fixture).toBeTruthy();
    if (!fixture?.invoice_id) throw new Error('Fixture identity was not returned');
    invoiceId = fixture.invoice_id;
    const initial = await state();
    await page.goto(`/invoices/${invoiceId}`);
    await page.getByRole('button', { name: 'Ghi nhận thanh toán', exact: true }).click();
    const payment = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Ghi nhận thanh toán', exact: true }) });
    await payment.locator('#amount').fill('3239000');
    const partial = waitRpc('record_invoice_collection_v5');
    await payment.getByRole('button', { name: 'Ghi nhận thanh toán', exact: true }).click();
    await assertRpc(partial); await expect(payment).toBeHidden();
    expect(await state()).toMatchObject({ paid_amount: 3239000, remaining_amount: 2000000, active: 1 });

    const editor = await openEditor();
    await editor.getByLabel('Đơn giá 1', { exact: true }).fill('6239000');
    await editor.getByLabel('Lý do điều chỉnh', { exact: true }).fill('E2E bổ sung tiền thuê');
    const edited = waitRpc('adjust_invoice_v2');
    await editor.getByRole('button', { name: 'Lưu điều chỉnh', exact: true }).click();
    const revision1 = await assertRpc(edited); await expect(editor).toBeHidden();
    expect(revision1).toMatchObject({ revision: 1, before_total: 5239000, after_total: 6239000 });
    expect(await state()).toMatchObject({ total_amount: 6239000, paid_amount: 3239000, remaining_amount: 3000000, adjustment_revision: 1 });
    expect((await state()).items.map((item: { id: string }) => item.id)).toEqual(initial.items.map((item: { id: string }) => item.id));
    await expect(page.getByText('Hóa đơn gốc', { exact: true })).toBeVisible();
    await expect(page.locator('[data-revision="1"]')).toContainText('E2E bổ sung tiền thuê');

    const accountant = await accountantContext.newPage();
    const roleErrors = trackConsoleErrors(accountant);
    accountant.on('pageerror', error => roleErrors.push(error.message));
    await login(accountant, 'ketoan');
    await accountant.goto(`/invoices/${invoiceId}`);
    await expect(accountant.locator('[data-revision="1"]')).toBeVisible();
    await expect(accountant.getByRole('button', { name: 'Xác nhận kiểm tra', exact: true })).toBeHidden();
    expect(roleErrors).toEqual([]);

    await page.evaluate(({ building, billingMonth }) => {
      sessionStorage.setItem('flt:thu-tien:buildingId', JSON.stringify(building));
      sessionStorage.setItem('flt:thu-tien:month', JSON.stringify(billingMonth));
      sessionStorage.setItem('flt:thu-tien:time', JSON.stringify('all'));
      sessionStorage.setItem('flt:thu-tien:status', JSON.stringify('all'));
    }, { building: fixture.building_id, billingMonth: month });
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/thu-tien');
    await page.locator('.icell').filter({ hasText: fixture.room_name }).getByRole('button', { name: 'THU', exact: true }).click();
    await expect(page.locator('.kp-amt')).toContainText('3.000.000');
    const remaining = waitRpc('record_invoice_collection_v5');
    await page.getByRole('button', { name: /^Thu đủ 3tr$/ }).click(); await assertRpc(remaining);
    expect(await state()).toMatchObject({ paid_amount: 6239000, remaining_amount: 0, status: 'PAID', active: 2 });
    await page.goto(`/invoices/${invoiceId}`);
    await expect(page.locator('[data-revision="1"]')).toBeVisible();
    const reviewed = waitRpc('review_invoice_adjustment_v2');
    await page.getByRole('button', { name: 'Xác nhận kiểm tra', exact: true }).click(); await assertRpc(reviewed);
    await expect(page.locator('[data-revision="1"]')).toContainText('Đã kiểm tra');

    await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
    const secondEditor = await openEditor();
    await secondEditor.getByLabel('Ghi chú giảm trừ', { exact: true }).fill('E2E chỉ cập nhật ghi chú');
    await secondEditor.getByLabel('Lý do điều chỉnh', { exact: true }).fill('E2E sửa ghi chú không đổi tiền');
    // Another real browser tab changes the document while this form remains open.
    const other = await page.context().newPage();
    const otherErrors = trackConsoleErrors(other);
    other.on('pageerror', error => otherErrors.push(error.message));
    try {
      await other.goto(`/invoices/${invoiceId}`);
      await other.locator('button[title="Điều chỉnh hóa đơn"]').click();
      const otherEditor = other.getByRole('dialog').filter({ has: other.getByRole('heading', { name: /^Điều chỉnh hóa đơn / }) });
      await otherEditor.getByLabel('Ghi chú giảm trừ', { exact: true }).fill('E2E tab thứ hai');
      await otherEditor.getByLabel('Lý do điều chỉnh', { exact: true }).fill('E2E tạo phiên bản cạnh tranh');
      const competing = waitRpc('adjust_invoice_v2', other);
      await otherEditor.getByRole('button', { name: 'Lưu điều chỉnh', exact: true }).click();
      expect(await assertRpc(competing)).toMatchObject({ revision: 2, delta: 0 });
    } finally { errors.push(...otherErrors); await other.close(); }
    const stale = waitRpc('adjust_invoice_v2');
    await secondEditor.getByRole('button', { name: 'Lưu điều chỉnh', exact: true }).click();
    const staleResponse = await stale;
    expect(staleResponse.status()).toBe(409);
    expect((await staleResponse.json()).code).toBe('PT409');
    await expect(secondEditor.getByRole('button', { name: 'Lưu điều chỉnh', exact: true })).toBeDisabled();
    await secondEditor.getByRole('button', { name: 'Tải lại hóa đơn', exact: true }).click();
    await expect(secondEditor.getByLabel('Ghi chú giảm trừ', { exact: true })).toHaveValue('E2E tab thứ hai');
    await secondEditor.getByLabel('Ghi chú giảm trừ', { exact: true }).fill('E2E chỉ cập nhật ghi chú');
    await secondEditor.getByLabel('Lý do điều chỉnh', { exact: true }).fill('E2E tải lại rồi sửa ghi chú');
    const secondEdit = waitRpc('adjust_invoice_v2');
    await secondEditor.getByRole('button', { name: 'Lưu điều chỉnh', exact: true }).click();
    const revision2 = await assertRpc(secondEdit); await expect(secondEditor).toBeHidden();
    expect(revision2).toMatchObject({ revision: 3, delta: 0 });
    expect(await state()).toMatchObject({ paid_amount: 6239000, total_amount: 6239000, adjustment_revision: 3, adjustment_review_status: 'PENDING' });
    await expect(page.locator('[data-revision="1"]').getByRole('button', { name: 'Xác nhận kiểm tra', exact: true })).toBeHidden();
    await expect(page.locator('[data-revision="2"]').getByRole('button', { name: 'Xác nhận kiểm tra', exact: true })).toBeHidden();
    await expect(page.locator('[data-revision="3"]').getByRole('button', { name: 'Xác nhận kiểm tra', exact: true })).toBeVisible();

    await page.evaluate(({ building, billingMonth }) => {
      sessionStorage.setItem('flt:invoices:filters', JSON.stringify({ building_id: building, billing_month: billingMonth, adjustment_review_status: 'pending' }));
      sessionStorage.setItem('flt:invoices:search', JSON.stringify(''));
    }, { building: fixture.building_id, billingMonth: month });
    const filtered = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/rest/v1/invoices' && url.searchParams.get('adjustment_review_status') === 'eq.PENDING' && response.request().method() === 'GET';
    });
    await page.goto('/invoices');
    const filterResponse = await filtered;
    expect(filterResponse.ok()).toBe(true);
    expect((await filterResponse.json()).some((row: { id: string }) => row.id === invoiceId)).toBe(true);
    await expect(page.getByRole('combobox').filter({ hasText: 'Bản mới nhất chưa kiểm tra' })).toBeVisible();

    // Canonical reversal, then the issued editor must remain available at paid_amount=0.
    await query(`BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';
      SELECT set_config('request.jwt.claims',jsonb_build_object('sub',${uuidLiteral(actor)},'role','authenticated')::text,true);
      DO $reverse$ DECLARE row record; BEGIN
        FOR row IN SELECT id,collection_date FROM public.invoice_payment_collections WHERE invoice_id=${uuidLiteral(invoiceId!)} AND status='ACTIVE' ORDER BY created_at DESC,id DESC LOOP
          PERFORM public.reverse_invoice_collection_v5(row.id,GREATEST(row.collection_date,public.org_today_v1('${DEMO_ORG_ID}')),'E2E reverse before issued edit','adjustment-ui-reverse-'||row.id::text);
        END LOOP; END $reverse$; COMMIT;`);
    expect(await state()).toMatchObject({ paid_amount: 0, active: 0 });
    await page.goto(`/invoices/${invoiceId}`);
    const afterReverse = await openEditor();
    await afterReverse.getByLabel('Đơn giá 1', { exact: true }).fill('4239000');
    await afterReverse.getByLabel('Lý do điều chỉnh', { exact: true }).fill('E2E giảm tiền sau hoàn tác');
    const thirdEdit = waitRpc('adjust_invoice_v2');
    await afterReverse.getByRole('button', { name: 'Lưu điều chỉnh', exact: true }).click();
    const revision3 = await assertRpc(thirdEdit); await expect(afterReverse).toBeHidden();
    expect(revision3).toMatchObject({ revision: 4, after_total: 4239000 });
    expect(await state()).toMatchObject({ paid_amount: 0, total_amount: 4239000, adjustment_revision: 4 });
    expect(errors, errors.join(' | ')).toEqual([]);
  } finally {
    try {
    const found = await query<{ id: string }>(`SELECT id FROM public.invoices WHERE organization_id='${DEMO_ORG_ID}' AND notes=${sqlLiteral(marker)}`);
    expect(found.length).toBeLessThanOrEqual(1);
    if (invoiceId) {
      const exact = await query(`SELECT organization_id,notes FROM public.invoices WHERE id=${uuidLiteral(invoiceId)}`);
      if (exact.length) expect(exact[0]).toMatchObject({ organization_id: DEMO_ORG_ID, notes: marker });
      if (found.length) expect(found[0].id).toBe(invoiceId);
    }
    if (found.length) {
      const id = found[0].id;
      const collections = await query<{ id: string }>(`SELECT id FROM public.invoice_payment_collections WHERE invoice_id=${uuidLiteral(id)}`);
      const vouchers = await query<{ id: string }>(`SELECT id FROM public.income_expenses WHERE invoice_id=${uuidLiteral(id)} OR payment_collection_id IN(SELECT id FROM public.invoice_payment_collections WHERE invoice_id=${uuidLiteral(id)})`);
      await query(committedAdjustmentFixtureTeardownSql({ marker, actorId: actor, invoiceId: id }));
      for (const table of ['invoices', 'invoice_adjustments', 'invoice_items', 'payments', 'invoice_payment_collections', 'finance_invoice_component_allocations', 'finance_invoice_components', 'finance_invoice_component_manifests']) {
        const column = table === 'invoices' ? 'id' : 'invoice_id';
        expect(await query(`SELECT ${column} FROM public.${table} WHERE ${column}=${uuidLiteral(id)}`), table).toEqual([]);
      }
      if (collections.length) for (const table of ['invoice_payment_tenders', 'invoice_payment_allocations']) {
        expect(await query(`SELECT collection_id FROM public.${table} WHERE collection_id IN(${collections.map((row: { id: string }) => uuidLiteral(row.id)).join(',')})`), table).toEqual([]);
      }
      if (vouchers.length) {
        const ids = vouchers.map((row: { id: string }) => uuidLiteral(row.id)).join(',');
        expect(await query(`SELECT id FROM public.income_expense_postings WHERE voucher_id IN(${ids})`)).toEqual([]);
        expect(await query(`SELECT income_expense_id FROM app_private.income_expense_cancellations WHERE income_expense_id IN(${ids})`)).toEqual([]);
      }
    }
    await query(`DELETE FROM public.cashbook_possession_bindings WHERE organization_id='${DEMO_ORG_ID}' AND reason=${sqlLiteral(marker)}`);
    await query(`DELETE FROM public.accounts WHERE organization_id='${DEMO_ORG_ID}' AND description=${sqlLiteral(marker)}`);
    } finally {
      await accountantContext.close();
    }
  }
});
