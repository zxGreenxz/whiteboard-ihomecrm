import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { login } from './auth';
import {
  RESERVATION_DEMO_ORG, createReservationLiveFixture, cleanupReservationLiveFixture,
  cleanupReservationSupplementFixture, snapshotReservationFinancialRows,
  type ReservationLiveFixture,
} from './reservation-settlement-admin';

test.use({ serviceWorkers: 'block' });
const OWNER = 'de6f33f3-349f-4bec-bd3d-106192f6715e';
const PROJECT = 'tryymsxyyckgbrmmvozx';
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const uuid = (s: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s)) throw new Error('Invalid fixture UUID');
  return `${literal(s)}::uuid`;
};
function checkedMarker(marker: string) {
  if (!/^\[E2E-RESERVATION:[0-9a-f-]{36}\]$/.test(marker)) throw new Error('Invalid owned fixture marker');
  return literal(marker);
}
async function sql<T>(query: string, readOnly = false): Promise<T[]> {
  if (process.env.FLEET_CONTRACT_SETTLEMENT_LIVE !== '1') throw new Error('FLEET_CONTRACT_SETTLEMENT_LIVE=1 required');
  const pat = process.env.SUPABASE_PAT;
  if (!pat) throw new Error('SUPABASE_PAT required for owned DEMO fixture');
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, read_only: readOnly }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`DEMO fixture SQL ${response.status}: ${body.replaceAll(pat, '[REDACTED]').slice(0, 1400)}`);
  return JSON.parse(body) as T[];
}

async function addOwnedPendingExpense(marker: string, fixture: ReservationLiveFixture) {
  const room = uuid(fixture.room_id), owned = checkedMarker(marker);
  await sql(`BEGIN; SET LOCAL statement_timeout='30s';
    SELECT set_config('request.jwt.claim.sub','${OWNER}',true);
    DO $seed$ DECLARE t uuid; v uuid; BEGIN
      IF NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=${room} AND organization_id='${RESERVATION_DEMO_ORG}' AND description=${owned})
        THEN RAISE EXCEPTION 'Room is not this owned DEMO fixture'; END IF;
      SELECT id INTO STRICT t FROM public.income_expense_types WHERE organization_id='${RESERVATION_DEMO_ORG}'
        AND type='expense' AND NOT COALESCE(system_only,false) AND (name ILIKE '%hoàn cọc%' OR name='HHMG') LIMIT 1;
      SELECT (public.ie_compat_insert_v2(
        jsonb_build_object('type','EXPENSE','name',${owned},'building_id',${uuid(fixture.building_id)},'room_id',${room},
          'account_id',${uuid(fixture.account_id)},'payer_name',${owned},'notes',${owned},
          'receive_bank_name','Vietcombank','receive_bank_account','0123456789',
          'voucher_date',public.org_today_v1('${RESERVATION_DEMO_ORG}')),
        jsonb_build_array(jsonb_build_object('income_expense_type_id',t,'description',${owned},'quantity',1,'unit_price',123000,'accounting_class','PNL'))
      )->>'id')::uuid INTO v;
      IF NOT EXISTS(SELECT 1 FROM public.income_expenses WHERE id=v AND organization_id='${RESERVATION_DEMO_ORG}'
        AND room_id=${room} AND notes=${owned} AND approval_status='UNAPPROVED' AND contract_id IS NULL)
        THEN RAISE EXCEPTION 'Pending DEMO expense not created'; END IF;
    END $seed$; COMMIT;`);
  const [voucher] = await sql<{ id: string; code: string }>(`SELECT id,code FROM public.income_expenses
    WHERE organization_id='${RESERVATION_DEMO_ORG}' AND room_id=${room} AND notes=${owned} AND type='EXPENSE'`, true);
  if (!voucher) throw new Error('Owned expense missing');
  return voucher;
}

function strictErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // Only the optional remote QR image may fail independently of the app.
    if (/^Failed to load resource/.test(message.text()) && /^https:\/\/img\.vietqr\.io\//.test(message.location().url)) return;
    errors.push(message.text());
  });
  return errors;
}

async function openOwnedModal(page: Page, marker: string) {
  await page.goto('/thanh-toan');
  await page.locator('.ptt-panel .ptt-trigger').click();
  await page.locator('.ptt-panel .ptt-menu-item').filter({ hasText: 'Hợp đồng & quyết toán' }).click();
  const screen = page.locator('.cs-wrap');
  await screen.getByLabel('Phạm vi kỳ').selectOption('all');
  await screen.getByPlaceholder('Tìm phòng, khách, hợp đồng, phiếu…').fill(marker);
  const ownedRow = screen.locator('.cs-row').filter({ hasText: marker });
  await expect(ownedRow).toHaveCount(1);
  await ownedRow.getByRole('button').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(marker);
  await expect(dialog).not.toContainText('Ghi chú gốc của phiếu');
  await expect(dialog.getByRole('heading', { name: 'Bảng quyết toán · căn cứ' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Lịch sử bổ sung' })).toBeVisible();
  return dialog;
}

test('DEMO modal: request → done → request giữ đúng UUID, ba khóa và lịch sử realtime', async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  const base = new URL(process.env.FLEET_BASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('This fixture regression requires an explicit local app URL');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const marker = `[E2E-RESERVATION:${randomUUID()}]`, roomId = randomUUID();
  const notes = [`Kiểm chứng yêu cầu một ${roomId}`, `Đã đối chiếu lần một ${roomId}`, `Kiểm chứng yêu cầu hai ${roomId}`];
  const expectedNotes = [`[CẦN BỔ SUNG] ${notes[0]}`, `[ĐÃ BỔ SUNG] ${notes[1]}`, `[CẦN BỔ SUNG] ${notes[2]}`];
  const errors = strictErrors(page);
  let observerContext: BrowserContext | undefined;
  try {
    const fixture = await createReservationLiveFixture(marker, roomId);
    const voucher = await addOwnedPendingExpense(marker, fixture);
    const before = await snapshotReservationFinancialRows(marker, roomId);
    await login(page, 'chunha');
    const dialog = await openOwnedModal(page, marker);
    await expect(dialog).toContainText(voucher.code);
    await expect(dialog.locator('.cs-log')).toHaveCount(0);
    observerContext = await browser.newContext({ baseURL: base.origin, viewport: { width: 1440, height: 1000 } });
    const observer = await observerContext.newPage();
    const observerErrors = strictErrors(observer);
    // Separate session of the owner shares this fixture's building scope;
    // the accountant demo role intentionally cannot read every DEMO building.
    await login(observer, 'chunha');
    const observedDialog = await openOwnedModal(observer, marker);
    await expect(observedDialog.locator('.cs-log')).toHaveCount(0);
    const commands: { voucher: string; key: string; note: string }[] = [];

    for (let index = 0; index < notes.length; index++) {
      const done = index === 1;
      const input = dialog.getByPlaceholder(done ? 'Đã bổ sung gì…' : 'Cần bổ sung gì…');
      await expect(input).toBeVisible();
      await input.fill(notes[index]);
      if (done) await dialog.getByRole('checkbox').check();
      const button = dialog.getByRole('button', { name: done ? 'Xác nhận & Chuyển Chờ Duyệt' : 'Cần bổ sung', exact: true });
      try {
        await expect(button).toBeEnabled();
      } catch (error) {
        await info.attach('blocked-command.json', {
          body: JSON.stringify({ index, checked: done ? await dialog.getByRole('checkbox').isChecked() : null,
            modal: await dialog.innerText(), errors, observerErrors }), contentType: 'application/json',
        });
        throw error;
      }
      const saving = page.waitForResponse(r => r.url().endsWith('/rpc/append_income_expense_supplement_v1') && r.request().method() === 'POST');
      await button.click();
      const saved = await saving;
      expect(saved.status(), `supplement ${index + 1}`).toBe(200);
      const payload = saved.request().postDataJSON();
      expect(payload.p_voucher).toBe(voucher.id);
      expect(payload.p_note).toBe(expectedNotes[index]);
      expect(payload.p_attachments).toEqual([]);
      commands.push({ voucher: payload.p_voucher, key: payload.p_idempotency_key, note: payload.p_note });
      await expect(dialog.locator('.cs-log')).toHaveCount(index + 1);
      await expect(dialog.locator('.cs-log').filter({ hasText: expectedNotes[index] })).toHaveCount(1);
      // Observer never navigates/refetches: this is an actual realtime regression.
      await expect(observedDialog.locator('.cs-log').filter({ hasText: expectedNotes[index] })).toHaveCount(1, { timeout: 30_000 });
    }

    expect(new Set(commands.map(c => c.key)).size).toBe(3);
    const history = await sql<{ income_expense_id: string; note: string }>(`SELECT s.income_expense_id,s.note
      FROM public.income_expense_supplements s JOIN public.income_expenses v ON v.id=s.income_expense_id
      JOIN public.rooms r ON r.id=v.room_id WHERE s.organization_id='${RESERVATION_DEMO_ORG}'
        AND v.organization_id='${RESERVATION_DEMO_ORG}' AND r.organization_id='${RESERVATION_DEMO_ORG}'
        AND r.id=${uuid(roomId)} AND r.description=${checkedMarker(marker)} AND v.id=${uuid(voucher.id)}
      ORDER BY s.created_at,s.id`, true);
    expect(history.map(s => s.note)).toEqual(expectedNotes);
    expect(history.every(s => s.income_expense_id === voucher.id)).toBe(true);
    expect(await snapshotReservationFinancialRows(marker, roomId)).toEqual(before);
    expect(errors, 'actor console/page errors').toEqual([]);
    expect(observerErrors, 'observer console/page errors').toEqual([]);
    await info.attach('supplement-observation.json', { body: JSON.stringify({ voucherId: voucher.id, commands, savedRows: history.length, realtimeObserver: 'chunha-independent-session' }), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('supplements-desktop.png') });
  } catch (error) {
    await info.attach('actor-failure.json', {
      body: JSON.stringify({ dialogs: await page.getByRole('dialog').allTextContents(), errors }), contentType: 'application/json',
    });
    throw error;
  } finally {
    await observerContext?.close();
    await cleanupReservationSupplementFixture(marker, roomId);
    await cleanupReservationLiveFixture(marker, roomId);
  }
});
