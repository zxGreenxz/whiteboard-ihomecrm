import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ID, khungChuaBayGio, taoDbThongBao } from '../../__tests__/fixtures/notificationPipelineDb';

/**
 * Migration 20261021171251_nhac_viec_server_lifecycle_v1 (gói B mục B5): nhắc hoá đơn/HĐ/cọc chạy ở server qua lane
 * lifecycle. Chạy THẬT trên PGlite sau lane gốc 20260928024843 + 20261021171249 + 20261021171250 (mỗi file hai lượt).
 * Kiểm: khử trùng theo người/ngày/họ, số cập nhật mỗi lượt, về 0 ⇒ CANCELLED (không đụng READ), mở lại trong ngày,
 * ngày mới thay dòng cũ, người nhận theo quyền theo toà, cổng v2 theo họ, giờ yên khi claim, type/event đúng hợp đồng.
 */
let db: PGlite;
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const INV = { quaHan: u(601), sapHan: u(602), daThu: u(603), traDu: u(604), xa: u(605), toaKhac: u(606), moi: u(607) };
const HD = { sapHet: u(701), thieuCoc: u(702), coCocHoaDon: u(703), daKetThuc: u(704) };

beforeAll(async () => {
  db = await taoDbThongBao();
}, 60000);
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.notifications; DELETE FROM app_private.lifecycle_reminder_deliveries; DELETE FROM app_private.lifecycle_reminder_runs;
    DELETE FROM public.invoices; DELETE FROM public.contracts; DELETE FROM public.contract_exit_cases; DELETE FROM public.room_turnovers;
    DELETE FROM test_permissions; DELETE FROM public.notification_preferences; DELETE FROM public.push_subscriptions;
    DELETE FROM public.notification_quiet_hours; DELETE FROM app_private.notification_org_config;
    DELETE FROM app_private.lifecycle_reminder_sweep_state;
    INSERT INTO app_private.notification_org_config(organization_id, quiet_start, quiet_end) VALUES ('${ID.org}', 0, 0);
    UPDATE test_clock SET local_now = date_trunc('day', now()) + interval '9 hours';
    INSERT INTO test_permissions VALUES
      ('${ID.chu}', '${ID.org}', '${ID.toa}', 'buildings.view', true), ('${ID.chu}', '${ID.org}', '${ID.toa}', 'invoices.view', true),
      ('${ID.chu}', '${ID.org}', '${ID.toa}', 'contracts.view', true),
      ('${ID.nhanVien}', '${ID.org}', '${ID.toa}', 'buildings.view', true), ('${ID.nhanVien}', '${ID.org}', '${ID.toa}', 'contracts.view', true);
  `);
  const today = "(SELECT local_now::date FROM test_clock)";
  await db.exec(`
    INSERT INTO public.invoices(id, organization_id, building_id, room_id, status, due_date, total_amount, paid_amount) VALUES
      ('${INV.quaHan}', '${ID.org}', '${ID.toa}', '${ID.phong}', 'OVERDUE', ${today} - 5, 100, 0),
      ('${INV.sapHan}', '${ID.org}', '${ID.toa}', '${ID.phong}', 'APPROVED', ${today} + 2, 100, 40),
      ('${INV.daThu}', '${ID.org}', '${ID.toa}', '${ID.phong}', 'PAID', ${today} - 9, 100, 100),
      ('${INV.traDu}', '${ID.org}', '${ID.toa}', '${ID.phong}', 'APPROVED', ${today} - 1, 100, 100),
      ('${INV.xa}', '${ID.org}', '${ID.toa}', '${ID.phong}', 'APPROVED', ${today} + 10, 100, 0),
      ('${INV.toaKhac}', '${ID.org}', '${ID.toaKhac}', '${ID.phong}', 'PARTIAL_PAID', ${today} - 2, 100, 10);
    INSERT INTO public.contracts(id, organization_id, room_id, status, end_date, deposit_remaining, deposit_debt_mode) VALUES
      ('${HD.sapHet}', '${ID.org}', '${ID.phong}', 'ACTIVE', ${today} + 10, 0, null),
      ('${HD.thieuCoc}', '${ID.org}', '${ID.phong}', 'ACTIVE', ${today} + 200, 50000, null),
      ('${HD.coCocHoaDon}', '${ID.org}', '${ID.phong}', 'ACTIVE', ${today} + 200, 50000, 'FIRST_INVOICE'),
      ('${HD.daKetThuc}', '${ID.org}', '${ID.phong}', 'TERMINATED', ${today} + 5, 90000, 'DEBT');
  `);
});

const sweep = async () => (await db.query<{ r: { inserted: number; cancelled: number } }>('SELECT public.lifecycle_reminder_sweep_v1($1) r', [ID.org])).rows[0].r;
type Dong = { id: string; user_id: string; type: string; status: string; subject: string; content: string;
  metadata: { event: string; source_family: string; count: number; url: string; cancelled_reason?: string; day: string } };
const thongBao = async (user: string, family: string) => (await db.query<Dong>(
  "SELECT * FROM public.notifications WHERE user_id = $1 AND metadata->>'source_family' = $2 ORDER BY created_at, id", [user, family])).rows;

describe('bốn họ nhắc server', () => {
  it('nợ cũ kéo sang hoá đơn sau (previous_debt_sources) đếm MỘT lần ở hoá đơn gốc — công thức chung', async () => {
    // invoice_effective_outstanding_v1 giữ nợ ở hoá đơn phát sinh gốc (tuổi nợ theo hạn gốc) và trừ khỏi hoá đơn
    // gánh. Hoá đơn gánh chỉ gồm đúng phần nợ kéo (100) ⇒ nợ thực 0 ⇒ không nhắc "sắp đến hạn"; gốc vẫn quá hạn.
    await db.query(`INSERT INTO public.invoices(id, organization_id, building_id, room_id, status, due_date, total_amount,
        paid_amount, previous_debt_sources) VALUES ($1, $2, $3, $4, 'APPROVED', (SELECT local_now::date FROM test_clock) + 2, 100, 0,
        jsonb_build_array(jsonb_build_object('type', 'invoice', 'id', $5::text, 'amount', 100)))`,
      [INV.moi, ID.org, ID.toa, ID.phong, INV.quaHan]);
    await sweep();
    const [quaHan] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    expect(quaHan.metadata).toMatchObject({ count: 1 });
    const [sapHan] = await thongBao(ID.chu, 'INVOICE_DUE');
    expect(sapHan.metadata).toMatchObject({ count: 1 });
    // Hoá đơn gánh có thêm phát sinh mới (tổng 300 = 100 kéo + 200 mới) ⇒ còn nợ thực ⇒ được đếm.
    await db.query('UPDATE public.invoices SET total_amount = 300, updated_at = now() WHERE id = $1', [INV.moi]);
    await sweep();
    const [sapHan2] = await thongBao(ID.chu, 'INVOICE_DUE');
    expect(sapHan2.metadata).toMatchObject({ count: 2 });
  });

  it('đúng nguồn, đúng type/event/url, người nhận theo quyền theo toà; chạy lại cùng ngày không nhân dòng', async () => {
    expect((await sweep()).inserted).toBe(6);
    const [quaHan] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    expect(quaHan).toMatchObject({ type: 'OVERDUE_INVOICE', status: 'PENDING', subject: 'Hoá đơn quá hạn chưa thu đủ' });
    // inv toaKhac quá hạn nhưng chủ không có quyền ở toà đó ⇒ không đếm; hoá đơn đã thu/đã trả đủ không đếm.
    expect(quaHan.metadata).toMatchObject({ event: 'BILLING', count: 1, url: '/invoices' });
    expect(quaHan.content).toBe('1 hoá đơn đã quá hạn thanh toán.');
    const [sapHan] = await thongBao(ID.chu, 'INVOICE_DUE');
    expect(sapHan).toMatchObject({ type: 'PAYMENT_REMINDER' });
    expect(sapHan.metadata).toMatchObject({ event: 'BILLING', count: 1 });
    const [hetHan] = await thongBao(ID.chu, 'CONTRACT_EXPIRING');
    expect(hetHan).toMatchObject({ type: 'CONTRACT_EXPIRING' });
    expect(hetHan.metadata).toMatchObject({ event: 'CONTRACT_EXPIRY', count: 1, url: '/contracts' });
    const [coc] = await thongBao(ID.chu, 'DEPOSIT_SHORTFALL');
    expect(coc).toMatchObject({ type: 'DEPOSIT_SHORTFALL' });
    expect(coc.metadata).toMatchObject({ event: 'DEPOSIT', count: 1 });
    // Nhân viên không có invoices.view ⇒ chỉ hai họ hợp đồng.
    expect(await thongBao(ID.nhanVien, 'INVOICE_OVERDUE')).toHaveLength(0);
    expect(await thongBao(ID.nhanVien, 'CONTRACT_EXPIRING')).toHaveLength(1);
    expect(await thongBao(ID.nhanVien, 'DEPOSIT_SHORTFALL')).toHaveLength(1);

    expect((await sweep()).inserted).toBe(0);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM public.notifications')).rows[0].n).toBe(6);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM app_private.lifecycle_reminder_deliveries')).rows[0].n).toBe(6);
  });

  it('số cập nhật trên CÙNG dòng, không reset cờ đã đọc; về 0 ⇒ PENDING thành CANCELLED, READ giữ nguyên', async () => {
    await sweep();
    const [truoc] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    await db.query(`INSERT INTO public.invoices(id, organization_id, building_id, room_id, status, due_date, total_amount)
                    VALUES ($1, $2, $3, $4, 'APPROVED', (SELECT local_now::date FROM test_clock) - 3, 50)`, [INV.moi, ID.org, ID.toa, ID.phong]);
    await sweep();
    const [sau] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    expect(sau.id).toBe(truoc.id);
    expect(sau.metadata.count).toBe(2);
    expect(sau.content).toBe('2 hoá đơn đã quá hạn thanh toán.');

    // Hợp đồng sắp hết đã được người dùng đọc; nguồn hết ⇒ READ giữ nguyên.
    const [hd] = await thongBao(ID.chu, 'CONTRACT_EXPIRING');
    await db.query("UPDATE public.notifications SET status = 'READ' WHERE id = $1", [hd.id]);
    await db.exec(`UPDATE public.invoices SET paid_amount = total_amount; UPDATE public.contracts SET actual_end_date = end_date;`);
    const r = await sweep();
    expect(r.cancelled).toBeGreaterThanOrEqual(3);
    const [huy] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    expect(huy).toMatchObject({ status: 'CANCELLED', content: 'Không còn việc cần kiểm tra trong danh sách.' });
    expect(huy.metadata).toMatchObject({ cancelled_reason: 'SOURCE_RESOLVED', count: 0 });
    expect((await thongBao(ID.chu, 'CONTRACT_EXPIRING'))[0].status).toBe('READ');
    expect((await thongBao(ID.nhanVien, 'DEPOSIT_SHORTFALL'))[0].status).toBe('CANCELLED');

    // Nguồn quay lại trong ngày ⇒ dòng hôm nay mở lại PENDING (không đẻ dòng/push mới).
    await db.query('UPDATE public.invoices SET paid_amount = 0 WHERE id = $1', [INV.quaHan]);
    expect((await sweep()).inserted).toBe(0);
    const [moLai] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    expect(moLai.id).toBe(truoc.id);
    expect(moLai.status).toBe('PENDING');
    expect(moLai.metadata.cancelled_reason).toBeUndefined();
    expect(moLai.metadata.count).toBe(1);
  });

  it('lượt không đổi gì bỏ qua phần kiểm quyền; đổi quyền (authorization_version tăng) hay đổi cổng ⇒ tính lại', async () => {
    await sweep();
    // Gỡ quyền hoá đơn của chủ nhưng KHÔNG tăng version: vân tay như cũ ⇒ bỏ qua, dòng giữ nguyên.
    await db.query("UPDATE test_permissions SET allowed = false WHERE user_id = $1 AND permission = 'invoices.view'", [ID.chu]);
    const r1 = await sweep();
    expect(r1).toMatchObject({ inserted: 0, cancelled: 0 });
    expect((r1 as unknown as { unchanged: number }).unchanged).toBeGreaterThanOrEqual(14);
    expect((await thongBao(ID.chu, 'INVOICE_OVERDUE'))[0].status).toBe('PENDING');
    // Bảng quyền đổi ⇒ trigger production tăng authorization_version ⇒ tính lại ⇒ mất phạm vi ⇒ CANCELLED.
    await db.query('UPDATE public.organizations SET authorization_version = authorization_version + 1 WHERE id = $1', [ID.org]);
    await sweep();
    expect((await thongBao(ID.chu, 'INVOICE_OVERDUE'))[0].status).toBe('CANCELLED');
    // Cổng đổi (tắt trong app) cũng nằm trong vân tay — họ khác của cùng người không bị đụng.
    await db.query("INSERT INTO public.notification_preferences(user_id, organization_id, event_key, push) VALUES ($1, $2, 'DEPOSIT', false)", [ID.nhanVien, ID.org]);
    await sweep();
    const coc = await db.query<{ push_status: string }>(
      "SELECT push_status FROM app_private.lifecycle_reminder_deliveries WHERE user_id = $1 AND source_family = 'DEPOSIT_SHORTFALL'", [ID.nhanVien]);
    // Delivery hôm nay đã có (PENDING) — cổng đổi giữa ngày không đẻ delivery mới; claim/validate đọc cổng lúc gửi.
    expect(coc.rows).toHaveLength(1);
    expect((await thongBao(ID.nhanVien, 'DEPOSIT_SHORTFALL'))[0].status).toBe('PENDING');
  });

  it('ngày mới: dòng chưa đọc hôm trước cùng họ thành CANCELLED (SUPERSEDED), dòng mới thay', async () => {
    await sweep();
    const [homQua] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    await db.exec("UPDATE test_clock SET local_now = local_now + interval '1 day';");
    await sweep();
    const ca = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    expect(ca).toHaveLength(2);
    expect(ca.find((x) => x.id === homQua.id)).toMatchObject({ status: 'CANCELLED' });
    expect(ca.find((x) => x.id === homQua.id)!.metadata.cancelled_reason).toBe('SUPERSEDED');
    expect(ca.find((x) => x.id !== homQua.id)).toMatchObject({ status: 'PENDING' });
  });

  it('NOTICE/TURNOVER/EXIT cũng thành CANCELLED khi việc hết (chỉ PENDING)', async () => {
    const exit = u(801);
    await db.query("INSERT INTO public.contract_exit_cases VALUES ($1, $2, $3, 'PENDING', 1)", [exit, ID.org, ID.toa]);
    await sweep();
    expect((await thongBao(ID.chu, 'EXIT'))[0]).toMatchObject({ status: 'PENDING', type: 'ACTION_REQUIRED' });
    expect((await thongBao(ID.chu, 'EXIT'))[0].metadata.event).toBe('LIFECYCLE');
    await db.query("UPDATE public.contract_exit_cases SET state = 'DONE' WHERE id = $1", [exit]);
    await sweep();
    expect((await thongBao(ID.chu, 'EXIT'))[0]).toMatchObject({ status: 'CANCELLED' });
  });

  it('cổng v2 theo họ: tắt BILLING không tắt CONTRACT_EXPIRY; công ty tắt họ ⇒ không ai nhận', async () => {
    await db.query("INSERT INTO public.notification_preferences(user_id, organization_id, event_key, in_app, push, cadence) VALUES ($1, $2, 'BILLING', false, false, 'OFF')", [ID.chu, ID.org]);
    await db.query("INSERT INTO public.notification_preferences(user_id, organization_id, event_key, push) VALUES ($1, $2, 'DEPOSIT', false)", [ID.chu, ID.org]);
    await db.query(`UPDATE app_private.notification_org_config SET events = '{"CONTRACT_EXPIRY":{"enabled":false}}' WHERE organization_id = $1`, [ID.org]);
    await sweep();
    expect(await thongBao(ID.chu, 'INVOICE_OVERDUE')).toHaveLength(0);
    expect(await thongBao(ID.chu, 'CONTRACT_EXPIRING')).toHaveLength(0);
    expect(await thongBao(ID.nhanVien, 'CONTRACT_EXPIRING')).toHaveLength(0);
    expect(await thongBao(ID.chu, 'DEPOSIT_SHORTFALL')).toHaveLength(1);
    const st = await db.query<{ source_family: string; push_status: string }>(
      'SELECT source_family, push_status FROM app_private.lifecycle_reminder_deliveries WHERE user_id = $1 ORDER BY source_family', [ID.chu]);
    expect(st.rows.find((x) => x.source_family === 'DEPOSIT_SHORTFALL')?.push_status).toBe('DISABLED');
    expect(st.rows.find((x) => x.source_family === 'INVOICE_OVERDUE')?.push_status).toBe('DISABLED');
  });

  it('claim: giờ yên cá nhân hoãn; ngoài giờ yên trả payload có organization_id + url; dòng server không bị bảo trì huỷ nhầm', async () => {
    await db.query("INSERT INTO public.push_subscriptions(user_id, endpoint) VALUES ($1, 'ep')", [ID.chu]);
    await sweep();
    const { start, end } = khungChuaBayGio();
    await db.query('INSERT INTO public.notification_quiet_hours VALUES ($1, $2, true, $3, $4, now())', [ID.chu, ID.org, start, end]);
    const claim = async () => (await db.query<{ r: Array<{ organization_id: string; url: string; source_family?: string; title: string }> }>(
      'SELECT public.lifecycle_reminder_claim_v1(20) r')).rows[0].r;
    expect(await claim()).toEqual([]);
    await db.query('UPDATE public.notification_quiet_hours SET enabled = false');
    const lo = await claim();
    expect(lo).toHaveLength(4);
    expect(lo.every((x) => x.organization_id === ID.org)).toBe(true);
    expect(lo.map((x) => x.url).sort()).toEqual(['/contracts', '/contracts', '/invoices', '/invoices']);

    const m = (await db.query<{ v: { legacy_cancelled: number } }>('SELECT public.notification_maintenance_v1() v')).rows[0].v;
    expect(m.legacy_cancelled).toBe(0);
    expect((await thongBao(ID.chu, 'INVOICE_DUE'))[0].status).toBe('PENDING');
  });

  it('claim: dòng giờ yên (≥ p_limit) đứng đầu hàng không chặn dòng gửi được sau nó; hết ngày ⇒ SKIPPED trước payload; một payload, edge validate được', async () => {
    await db.query("INSERT INTO public.push_subscriptions(user_id, endpoint) VALUES ($1, 'ep-chu'), ($2, 'ep-nv')", [ID.chu, ID.nhanVien]);
    await sweep();
    // 4 delivery của chủ (đang giờ yên cá nhân) cũ hơn 2 delivery của nhân viên ⇒ đứng đầu ORDER BY.
    await db.query("UPDATE app_private.lifecycle_reminder_deliveries SET created_at = now() - interval '1 hour' WHERE user_id = $1", [ID.chu]);
    const homQua = (await db.query<{ id: string }>(`INSERT INTO app_private.lifecycle_reminder_deliveries
      (organization_id, user_id, reminder_day, source_family, push_status, created_at)
      VALUES ($1, $2, (SELECT local_now::date FROM test_clock) - 1, 'NOTICE', 'PENDING', now() - interval '2 hours') RETURNING id`,
      [ID.org, ID.chu])).rows[0].id;
    const { start, end } = khungChuaBayGio();
    await db.query('INSERT INTO public.notification_quiet_hours VALUES ($1, $2, true, $3, $4, now())', [ID.chu, ID.org, start, end]);
    type Lo = Array<{ id: string; lease: string; user_id: string; organization_id: string; idempotency_key: string; title: string;
      url: string; notification_ids: string[]; count: number }>;
    const lo = (await db.query<{ r: Lo }>('SELECT public.lifecycle_reminder_claim_v1(2) r')).rows[0].r;
    expect(lo).toHaveLength(2);
    expect(lo.every((x) => x.user_id === ID.nhanVien)).toBe(true);
    expect(Object.keys(lo[0]).sort()).toEqual(['body', 'count', 'id', 'idempotency_key', 'lease', 'notification_ids', 'organization_id',
      'sources', 'title', 'url', 'user_id']);
    // Dòng hôm qua đóng SKIPPED dù chủ đang giờ yên; 4 dòng giờ yên của chủ vẫn PENDING (lượt sau xét lại).
    const st = await db.query<{ id: string; push_status: string; last_error: string | null }>(
      'SELECT id, push_status, last_error FROM app_private.lifecycle_reminder_deliveries WHERE user_id = $1', [ID.chu]);
    expect(st.rows.find((x) => x.id === homQua)).toMatchObject({ push_status: 'SKIPPED', last_error: 'Reminder day expired before push' });
    expect(st.rows.filter((x) => x.id !== homQua).every((x) => x.push_status === 'PENDING')).toBe(true);
    // Edge validate ngay trước khi gửi: cùng lease, cùng payload.
    const v = (await db.query<{ v: Lo[number] | null }>('SELECT public.lifecycle_reminder_validate_v1($1, $2) v', [lo[0].id, lo[0].lease])).rows[0].v;
    expect(v).toMatchObject({ id: lo[0].id, lease: lo[0].lease, title: lo[0].title, count: lo[0].count });
  });

  it('tắt trong app (cá nhân hoặc công ty) ⇒ dòng PENDING của họ đó thành CANCELLED (PREFERENCE_DISABLED), READ giữ; bật lại trong ngày ⇒ mở lại', async () => {
    await sweep();
    const [quaHan] = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    const [sapHan] = await thongBao(ID.chu, 'INVOICE_DUE');
    await db.query("UPDATE public.notifications SET status = 'READ' WHERE id = $1", [sapHan.id]);
    await db.query("INSERT INTO public.notification_preferences(user_id, organization_id, event_key, in_app) VALUES ($1, $2, 'BILLING', false)", [ID.chu, ID.org]);
    expect((await sweep()).cancelled).toBeGreaterThanOrEqual(1);
    expect((await thongBao(ID.chu, 'INVOICE_OVERDUE'))[0]).toMatchObject({ id: quaHan.id, status: 'CANCELLED' });
    expect((await thongBao(ID.chu, 'INVOICE_OVERDUE'))[0].metadata.cancelled_reason).toBe('PREFERENCE_DISABLED');
    expect((await thongBao(ID.chu, 'INVOICE_DUE'))[0].status).toBe('READ');
    expect((await thongBao(ID.chu, 'CONTRACT_EXPIRING'))[0].status).toBe('PENDING');
    // Bật lại cùng ngày ⇒ dòng hôm nay mở lại, không đẻ dòng mới.
    await db.query("UPDATE public.notification_preferences SET in_app = true WHERE user_id = $1 AND event_key = 'BILLING'", [ID.chu]);
    await sweep();
    const moLai = await thongBao(ID.chu, 'INVOICE_OVERDUE');
    expect(moLai).toHaveLength(1);
    expect(moLai[0]).toMatchObject({ id: quaHan.id, status: 'PENDING' });
    expect(moLai[0].metadata.cancelled_reason).toBeUndefined();
    // Công ty tắt họ cũng vậy (mọi người nhận).
    await db.query(`UPDATE app_private.notification_org_config SET events = '{"CONTRACT_EXPIRY":{"enabled":false}}' WHERE organization_id = $1`, [ID.org]);
    await sweep();
    expect((await thongBao(ID.chu, 'CONTRACT_EXPIRING'))[0].status).toBe('CANCELLED');
    expect((await thongBao(ID.nhanVien, 'CONTRACT_EXPIRING'))[0].metadata.cancelled_reason).toBe('PREFERENCE_DISABLED');
  });

  it('tắt trong app TRƯỚC lượt đầu rồi bật lại trong ngày ⇒ delivery có sẵn được gắn dòng chuông mới', async () => {
    await db.query("INSERT INTO public.notification_preferences(user_id, organization_id, event_key, in_app) VALUES ($1, $2, 'DEPOSIT', false)", [ID.chu, ID.org]);
    await sweep();
    expect(await thongBao(ID.chu, 'DEPOSIT_SHORTFALL')).toHaveLength(0);
    await db.query("UPDATE public.notification_preferences SET in_app = true WHERE user_id = $1 AND event_key = 'DEPOSIT'", [ID.chu]);
    await sweep();
    const [coc] = await thongBao(ID.chu, 'DEPOSIT_SHORTFALL');
    expect(coc).toMatchObject({ status: 'PENDING', type: 'DEPOSIT_SHORTFALL' });
    const d = await db.query<{ n: number; linked: boolean }>(`SELECT count(*)::int n, bool_and(notification_id = $2) linked
      FROM app_private.lifecycle_reminder_deliveries WHERE user_id = $1 AND source_family = 'DEPOSIT_SHORTFALL'`, [ID.chu, coc.id]);
    expect(d.rows[0]).toEqual({ n: 1, linked: true });
  });

  it('người nhận mất quyền giữa ngày ⇒ các lượt bỏ qua sau đó vẫn báo NO_RECIPIENT (đếm theo had_payload)', async () => {
    const lanCuoi = async () => (await db.query<{ status: string; no_recipient_families: string[] }>(
      'SELECT status, no_recipient_families FROM app_private.lifecycle_reminder_runs WHERE organization_id = $1 ORDER BY finished_at DESC LIMIT 1',
      [ID.org])).rows[0];
    await sweep();
    expect(await lanCuoi()).toMatchObject({ status: 'OK' });
    await db.query("UPDATE test_permissions SET allowed = false WHERE user_id = $1 AND permission = 'invoices.view'", [ID.chu]);
    await db.query('UPDATE public.organizations SET authorization_version = authorization_version + 1 WHERE id = $1', [ID.org]);
    await sweep();
    expect(await lanCuoi()).toMatchObject({ status: 'NO_RECIPIENT', no_recipient_families: ['INVOICE_DUE', 'INVOICE_OVERDUE'] });
    // Lượt không đổi gì: vân tay như cũ ⇒ bỏ qua, nhưng vẫn không ai nhận (delivery buổi sáng không được tính).
    const r = await sweep();
    expect((r as unknown as { unchanged: number }).unchanged).toBeGreaterThanOrEqual(14);
    expect(await lanCuoi()).toMatchObject({ status: 'NO_RECIPIENT', no_recipient_families: ['INVOICE_DUE', 'INVOICE_OVERDUE'] });
  });

  it('lifecycle_reminder_org_ids_v1: công ty ACTIVE, chỉ service_role; sweep(<công ty>) chỉ đụng công ty đó', async () => {
    const ids = async () => (await db.query<{ v: string[] }>('SELECT public.lifecycle_reminder_org_ids_v1() v')).rows[0].v;
    expect(await ids()).toEqual([ID.org, ID.orgKhac].sort());
    await db.query("UPDATE public.organizations SET status = 'SUSPENDED' WHERE id = $1", [ID.orgKhac]);
    try {
      expect(await ids()).toEqual([ID.org]);
    } finally {
      await db.query("UPDATE public.organizations SET status = 'ACTIVE' WHERE id = $1", [ID.orgKhac]);
    }
    const acl = await db.query<Record<string, boolean>>(`SELECT
      has_function_privilege('service_role', 'public.lifecycle_reminder_org_ids_v1()', 'EXECUTE') svc,
      has_function_privilege('authenticated', 'public.lifecycle_reminder_org_ids_v1()', 'EXECUTE') auth,
      has_function_privilege('anon', 'public.lifecycle_reminder_org_ids_v1()', 'EXECUTE') anon`);
    expect(acl.rows[0]).toEqual({ svc: true, auth: false, anon: false });
    await db.query('SELECT public.lifecycle_reminder_sweep_v1($1)', [ID.orgKhac]);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM public.notifications')).rows[0].n).toBe(0);
    const runs = await db.query<{ organization_id: string }>('SELECT DISTINCT organization_id FROM app_private.lifecycle_reminder_runs');
    expect(runs.rows).toEqual([{ organization_id: ID.orgKhac }]);
  });

  it('người nhận: hai họ hoá đơn cần invoices.view, hai họ HĐ cần contracts.view; CHECK nhận đủ 7 họ', async () => {
    const ok = async (user: string, family: string) => (await db.query<{ v: boolean }>(
      'SELECT app_private.lifecycle_recipient_allowed_v1($1, $2, $3, $4) v', [user, ID.org, ID.toa, family])).rows[0].v;
    expect(await ok(ID.chu, 'INVOICE_DUE')).toBe(true);
    expect(await ok(ID.nhanVien, 'INVOICE_OVERDUE')).toBe(false);
    expect(await ok(ID.nhanVien, 'DEPOSIT_SHORTFALL')).toBe(true);
    await db.query("DELETE FROM test_permissions WHERE user_id = $1 AND permission = 'contracts.view'", [ID.nhanVien]);
    expect(await ok(ID.nhanVien, 'CONTRACT_EXPIRING')).toBe(false);
    await expect(db.query(`INSERT INTO app_private.lifecycle_reminder_deliveries(organization_id, user_id, reminder_day, source_family, push_status)
      VALUES ($1, $2, current_date, 'ZALO', 'PENDING')`, [ID.org, ID.chu])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query("SELECT app_private.lifecycle_family_event_v1('ZALO')")).rejects.toMatchObject({ code: '22023' });
  });
});
