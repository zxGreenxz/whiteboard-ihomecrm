import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { loadSupabaseAdminConfig } from '../../scripts/apply-accounting-rollout.mjs';
import {
  DEMO_ORG_ID, DEMO_OWNER_EMAIL, runQuery, fixtureInvoiceSql,
  committedFixtureTeardownSql, fixtureMarker, newRunId, sqlLiteral, uuidLiteral,
} from '../../scripts/lib/v5-collection-harness.mjs';

// A fresh invoice on an existing DEMO contract avoids depending on empty rooms.
// All money goes through the production UI; teardown reverses before deleting.
test('invoice partial collection -> Thu tiền keypad completes the same invoice', async ({ page }) => {
  test.setTimeout(240_000);
  const config = loadSupabaseAdminConfig({ readFile: (path: string | URL, encoding: BufferEncoding) =>
    readFileSync(String(path).includes('CLAUDE.local.md') && process.env.IHOMECRM_SECRET_FILE
      ? process.env.IHOMECRM_SECRET_FILE : path, encoding) });
  const query = (sql: string) => runQuery(sql, config);
  const marker = fixtureMarker(`payment-ui-${newRunId()}`);
  const month = '2096-10';
  let fixtureInvoiceId: string | undefined;
  const voucherIds: string[] = [];
  const actor = (await query(`SELECT id FROM auth.users WHERE email=${sqlLiteral(DEMO_OWNER_EMAIL)}`))[0].id;
  const errors = trackConsoleErrors(page);
  page.on('pageerror', error => errors.push(error.message));
  const observedRefs = new Set<string>();
  page.on('request', request => {
    const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\//.exec(request.url());
    if (match) observedRefs.add(match[1]);
  });
  const state = async (id: string) => (await query(`SELECT i.paid_amount::bigint AS paid_amount, i.remaining_amount::bigint AS remaining_amount, i.status,
    (SELECT count(*) FROM public.invoice_payment_collections c WHERE c.invoice_id=i.id AND c.status='ACTIVE') AS active
    FROM public.invoices i WHERE i.id=${uuidLiteral(id)} AND i.organization_id='${DEMO_ORG_ID}'`))[0];
  const collectResponse = (currentPage: Page) => currentPage.waitForResponse(response =>
    response.request().method() === 'POST' && /\/rpc\/record_invoice_collection_v5\b/.test(response.url()),
  { timeout: 45_000 });
  const assertResponse = async (pending: ReturnType<typeof collectResponse>) => {
    const response = await pending;
    const body = await response.json();
    expect(response.ok(), `Collection HTTP ${response.status()}: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.collection_id).toMatch(/^[0-9a-f-]{36}$/);
    voucherIds.push(...body.tenders.map((tender: { voucher_id: string }) => tender.voucher_id));
  };
  try {
    await login(page, 'chunha');
    expect([...observedRefs]).toEqual([config.projectRef]);
    const rows = await query(`BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';
      ${fixtureInvoiceSql({ marker, billingMonth: month, rent: 5239000, deposit: 0 })}
      -- DEMO has no personal "...Thu" account required by the keypad resolver.
      -- Create a dedicated zero-balance fixture account instead of changing an existing cashbook.
      WITH fixture_account AS (
        INSERT INTO public.accounts(organization_id,user_id,name,code,description)
        VALUES ('${DEMO_ORG_ID}',${uuidLiteral(actor)},${sqlLiteral(`${marker} Thu`)},${sqlLiteral(marker)},${sqlLiteral(marker)})
        RETURNING id
      ) SELECT set_config('v5h.account_tm',id::text,true) FROM fixture_account;
      -- Grant possession only for the fixture account, if the DEMO actor lacks it.
      INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from,reason)
      SELECT m.organization_id,current_setting('v5h.account_tm')::uuid,m.id,'KNOWER',now()-interval '1 minute',${sqlLiteral(marker)}
      FROM public.organization_memberships m WHERE m.organization_id='${DEMO_ORG_ID}'
      AND m.user_id=current_setting('v5h.actor')::uuid AND m.status='ACTIVE'
      AND NOT app_private.ie_has_cashbook_possession_v1(m.organization_id,current_setting('v5h.account_tm')::uuid,m.id);
      SELECT current_setting('v5h.invoice') AS invoice_id,current_setting('v5h.building') AS building_id,
        (SELECT name FROM public.rooms WHERE id=current_setting('v5h.room')::uuid) AS room_name,
        (SELECT name FROM public.accounts WHERE id=current_setting('v5h.account_tm')::uuid) AS account_name;
      COMMIT;`);
    const fixture = rows.find((row: { invoice_id?: string }) => row.invoice_id);
    expect(fixture).toBeTruthy();
    fixtureInvoiceId = fixture.invoice_id;
    await page.goto(`/invoices/${fixture.invoice_id}`);
    await page.getByRole('button', { name: 'Ghi nhận thanh toán', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({
      has: page.getByRole('heading', { name: 'Ghi nhận thanh toán', exact: true }),
    });
    await expect(dialog.getByText('Sổ quỹ nhận *', { exact: true })).toBeHidden();
    await dialog.locator('#amount').fill('3239000');
    await dialog.locator('#notes').fill(marker);
    const first = collectResponse(page);
    await dialog.getByRole('button', { name: 'Ghi nhận thanh toán', exact: true }).click();
    await assertResponse(first);
    await expect(dialog).toBeHidden();
    expect(await state(fixture.invoice_id)).toMatchObject({ paid_amount: 3239000, remaining_amount: 2000000, active: 1 });

    await page.evaluate(({ building, billingMonth }) => {
      sessionStorage.setItem('flt:thu-tien:buildingId', JSON.stringify(building));
      sessionStorage.setItem('flt:thu-tien:month', JSON.stringify(billingMonth));
      sessionStorage.setItem('flt:thu-tien:time', JSON.stringify('all'));
      sessionStorage.setItem('flt:thu-tien:status', JSON.stringify('all'));
    }, { building: fixture.building_id, billingMonth: month });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/thu-tien');
    const cell = page.locator('.icell').filter({ hasText: fixture.room_name });
    await cell.getByRole('button', { name: 'THU', exact: true }).click();
    await expect(page.locator('.kp-amt')).toContainText('2.000.000');
    const second = collectResponse(page);
    await page.getByRole('button', { name: /^Thu đủ 2tr$/ }).click();
    await assertResponse(second);
    expect(await state(fixture.invoice_id)).toMatchObject({ paid_amount: 5239000, remaining_amount: 0, status: 'PAID', active: 2 });
    expect(errors, `Browser errors: ${errors.join(' | ')}`).toEqual([]);
  } finally {
    const postings = voucherIds.length ? await query(`SELECT id FROM public.income_expense_postings
      WHERE organization_id='${DEMO_ORG_ID}' AND voucher_id IN (${voucherIds.map(uuidLiteral).join(',')})`) : [];
    await query(committedFixtureTeardownSql({ marker, actorId: actor }));
    await query(`DELETE FROM public.cashbook_possession_bindings WHERE organization_id='${DEMO_ORG_ID}' AND reason=${sqlLiteral(marker)};`);
    await query(`DELETE FROM public.accounts WHERE organization_id='${DEMO_ORG_ID}' AND description=${sqlLiteral(marker)};`);
    const left = await query(`SELECT id FROM public.invoices WHERE organization_id='${DEMO_ORG_ID}' AND notes=${sqlLiteral(marker)}`);
    expect(left).toEqual([]);
    if (fixtureInvoiceId) {
      for (const table of ['finance_invoice_component_allocations', 'finance_invoice_components', 'finance_invoice_component_manifests']) {
        expect(await query(`SELECT id FROM public.${table} WHERE organization_id='${DEMO_ORG_ID}' AND invoice_id=${uuidLiteral(fixtureInvoiceId)}`), table).toEqual([]);
      }
    }
    if (postings.length) {
      const ids = postings.map((row: { id: string }) => uuidLiteral(row.id)).join(',');
      expect(await query(`SELECT id FROM public.income_expense_postings WHERE id IN (${ids})`)).toEqual([]);
      expect(await query(`SELECT id FROM public.income_expense_posting_lines WHERE posting_id IN (${ids})`)).toEqual([]);
    }
    if (voucherIds.length) {
      expect(await query(`SELECT id FROM public.income_expense_postings
        WHERE voucher_id IN (${voucherIds.map(uuidLiteral).join(',')})`)).toEqual([]);
      expect(await query(`SELECT income_expense_id FROM app_private.income_expense_cancellations
        WHERE income_expense_id IN (${voucherIds.map(uuidLiteral).join(',')})`)).toEqual([]);
    }
  }
});
