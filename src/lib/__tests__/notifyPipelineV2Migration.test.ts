import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ID, MIGRATION, docMigration, khungChuaBayGio, maLoi, taoDbThongBao, voiNguoi, voiVai } from './fixtures/notificationPipelineDb';

/**
 * Migration 20261021171249_notify_pipeline_v2 (gói B: B1 B2 B3 B4 B6 B8 B9 B10) chạy THẬT trên PGlite, hai lượt.
 * Mỗi bất biến chính một ca; ca đỏ nếu bỏ trigger canh, bỏ lọc dòng đã đọc, gộp chéo công ty, DUPLICATE→SENT
 * không có biên nhận, quên reset lượt E1, dọn nhầm dòng đã đọc, huỷ nhầm nhắc chốt sổ, settle bỏ qua sổ gửi,
 * HOLD tiêu lượt, lộ chuỗi lỗi drain, mở cổng quyền của RPC, hay bỏ ghim thân ($requires$).
 */
let db: PGlite;

beforeAll(async () => {
  db = await taoDbThongBao();
}, 60000);
afterAll(async () => {
  await db?.close();
});

async function donSach() {
  await db.exec(`
    DELETE FROM public.notifications; DELETE FROM public.push_subscriptions; DELETE FROM public.push_send_log;
    DELETE FROM app_private.notification_org_config; DELETE FROM public.notification_quiet_hours;
    DELETE FROM public.notification_preferences; DELETE FROM test_permissions; DELETE FROM public.cash_handovers;
    DELETE FROM public.accounts; DELETE FROM app_private.cashbook_closures;
    DELETE FROM public.income_expenses; DELETE FROM app_private.notification_maintenance_state;
    DELETE FROM app_private.notification_drain_runs;
    -- Mặc định cho các ca drain: không giờ yên công ty (start = end).
    INSERT INTO app_private.notification_org_config(organization_id, quiet_start, quiet_end) VALUES ('${ID.org}', 0, 0), ('${ID.orgKhac}', 0, 0);
  `);
}

type Them = {
  user?: string;
  org?: string | null;
  type?: string;
  status?: string;
  push?: string | null;
  metadata?: Record<string, unknown>;
  tuoiPhut?: number;
  attempts?: number;
  subject?: string;
  idem?: string | null;
  leaseTuoiPhut?: number | null;
};
async function them(p: Them = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.notifications(user_id, organization_id, type, channel, status, subject, content, metadata, push_state,
       push_attempts, push_idem_key, push_leased_at, created_at)
     VALUES ($1, $2, $3::public.notification_type, 'IN_APP', $4::public.notification_status, $5, 'nội dung', $6::jsonb, $7, $8, $9,
       CASE WHEN $10::int IS NULL THEN NULL ELSE now() - make_interval(mins => $10::int) END,
       now() - make_interval(mins => $11::int))
     RETURNING id`,
    [p.user ?? ID.chu, p.org === undefined ? ID.org : p.org, p.type ?? 'ACTION_REQUIRED', p.status ?? 'PENDING', p.subject ?? 'Tiêu đề',
      JSON.stringify(p.metadata ?? { event: 'E2', url: '/income-expense' }), p.push === undefined ? 'QUEUED' : p.push, p.attempts ?? 0,
      p.idem ?? null, p.leaseTuoiPhut ?? null, p.tuoiPhut ?? 30],
  );
  return r.rows[0].id;
}
const dong = async (id: string) =>
  (await db.query<Record<string, unknown>>('SELECT * FROM public.notifications WHERE id = $1', [id])).rows[0];
const thietBi = (user: string) => db.query('INSERT INTO public.push_subscriptions(user_id, endpoint) VALUES ($1, $2)', [user, `ep-${user}`]);

type Lo = { notification_ids: string[]; user_id: string; organization_id: string | null; idem_key: string; title: string; body: string;
  url: string; tag: string; data: { notificationIds: string[]; organizationId: string | null } };
const claim = async (limit = 100) => (await db.query<Lo>('SELECT * FROM public.notify_claim_push_batch_v2($1)', [limit])).rows;
const settle = async (ketQua: unknown[]) =>
  (await db.query<{ n: number }>('SELECT public.notify_settle_push_batch_v2($1::jsonb) n', [JSON.stringify(ketQua)])).rows[0].n;

describe('B1 — trigger canh dòng thông báo (vai không tin cậy)', () => {
  beforeEach(donSach);

  it('INSERT của client bị ép push_*/sent_at/created_at, không chiếm được hàng đợi', async () => {
    const r = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query<Record<string, unknown>>(
      `INSERT INTO public.notifications(user_id, organization_id, type, channel, content, push_state, push_attempts, push_idem_key,
         push_leased_at, created_at, sent_at)
       VALUES ($1, $2, 'CUSTOM', 'IN_APP', 'x', 'QUEUED', 2, 'k', '2020-01-01', '2000-01-01', '2020-01-01')
       RETURNING push_state, push_attempts, push_idem_key, push_leased_at, sent_at, created_at > now() - interval '1 minute' AS moi`,
      [ID.nhanVien, ID.org]));
    expect(r.rows[0]).toEqual({ push_state: null, push_attempts: 0, push_idem_key: null, push_leased_at: null, sent_at: null, moi: true });
  });

  it('INSERT 4 loại nhắc legacy thiếu metadata.event bị bỏ êm (0 dòng, không lỗi); có event thì giữ', async () => {
    for (const loai of ['PAYMENT_REMINDER', 'OVERDUE_INVOICE', 'CONTRACT_EXPIRING', 'DEPOSIT_SHORTFALL']) {
      const r = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
        `INSERT INTO public.notifications(user_id, organization_id, type, channel, status, content)
         VALUES ($1, $2, $3::public.notification_type, 'IN_APP', 'PENDING', 'nhắc cũ') RETURNING id`, [ID.nhanVien, ID.org, loai]));
      expect(r.rows).toHaveLength(0);
    }
    const coEvent = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
      `INSERT INTO public.notifications(user_id, organization_id, type, channel, content, metadata)
       VALUES ($1, $2, 'PAYMENT_REMINDER', 'IN_APP', 'x', '{"event":"BILLING"}') RETURNING id`, [ID.nhanVien, ID.org]));
    expect(coEvent.rows).toHaveLength(1);
    // Mã máy chủ (postgres) không bị chặn — lane nhắc server là SECURITY DEFINER.
    await them({ type: 'PAYMENT_REMINDER', metadata: {}, push: null });
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM public.notifications WHERE type = 'PAYMENT_REMINDER'")).rows[0].n).toBe(2);
  });

  it('guard bắn TRƯỚC autofill_org_strict: nhắc legacy không có công ty của bản web cũ ra 0 dòng, không 23502', async () => {
    // Bản web cũ insert nhắc không gắn công ty — a90_autofill_org (giả như production) ném 23502 nếu kịp bắn.
    const r = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
      `INSERT INTO public.notifications(user_id, type, channel, status, content)
       VALUES ($1, 'PAYMENT_REMINDER', 'IN_APP', 'PENDING', 'nhắc cũ không công ty') RETURNING id`, [ID.nhanVien]));
    expect(r.rows).toHaveLength(0);
    // Đối chứng: trigger autofill giả đang chạy thật — dòng thường không có công ty bị 23502.
    expect(await maLoi(voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
      `INSERT INTO public.notifications(user_id, type, channel, content) VALUES ($1, 'CUSTOM', 'IN_APP', 'x')`, [ID.nhanVien])))).toBe('23502');
  });

  it('UPDATE của client chỉ đổi được PENDING→READ; mọi cột khác giữ OLD; đọc ⇒ push QUEUED thành SKIPPED', async () => {
    const id = await them({ user: ID.nhanVien, subject: 'Gốc', push: 'QUEUED', tuoiPhut: 60 });
    const truoc = await dong(id);
    await voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
      `UPDATE public.notifications SET subject = 'Sửa', push_state = 'SENT', push_attempts = 0, created_at = '2000-01-01',
         organization_id = $2, metadata = '{}'::jsonb, status = 'READ' WHERE id = $1`, [id, ID.orgKhac]));
    const sau = await dong(id);
    expect(sau.status).toBe('READ');
    expect(sau.push_state).toBe('SKIPPED');
    expect(sau.subject).toBe('Gốc');
    expect(sau.organization_id).toBe(ID.org);
    expect(sau.metadata).toEqual(truoc.metadata);
    expect(String(sau.created_at)).toBe(String(truoc.created_at));
  });

  it('client không đưa READ về PENDING; CANCELLED→READ được (bản web cũ tự dọn); máy chủ giữ bất biến QUEUED→SKIPPED', async () => {
    const daDoc = await them({ user: ID.nhanVien, status: 'READ', push: 'SKIPPED' });
    const daHuy = await them({ user: ID.nhanVien, status: 'CANCELLED', push: 'SKIPPED', subject: 'Gốc huỷ' });
    await voiVai(db, 'authenticated', ID.nhanVien, async () => {
      await db.query("UPDATE public.notifications SET status = 'PENDING' WHERE id = $1", [daDoc]);
      await db.query("UPDATE public.notifications SET status = 'READ', subject = 'sửa' WHERE id = $1", [daHuy]);
    });
    expect((await dong(daDoc)).status).toBe('READ');
    expect(await dong(daHuy)).toMatchObject({ status: 'READ', subject: 'Gốc huỷ', push_state: 'SKIPPED' });

    const may = await them({ push: 'QUEUED' });
    await db.query("UPDATE public.notifications SET status = 'CANCELLED', subject = 'máy chủ sửa' WHERE id = $1", [may]);
    expect(await dong(may)).toMatchObject({ status: 'CANCELLED', push_state: 'SKIPPED', subject: 'máy chủ sửa' });
  });

  it('UPDATE không hợp lệ của client trả NULL: 0 dòng RETURNING, không ghi (đánh dấu tất cả chỉ đếm dòng thật đổi)', async () => {
    const chuaDoc = await them({ user: ID.nhanVien, push: 'QUEUED' });
    const daDoc = await them({ user: ID.nhanVien, status: 'READ', push: 'SKIPPED' });
    const daHuy = await them({ user: ID.nhanVien, status: 'CANCELLED', push: null });
    const truoc = await db.query<{ x: string }>('SELECT xmin::text x FROM public.notifications WHERE id = $1', [daDoc]);
    // Sửa nội dung dòng PENDING / đánh dấu lại dòng đã đọc / đưa CANCELLED về PENDING: không dòng nào trả về.
    const sua = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
      "UPDATE public.notifications SET subject = 'x' WHERE id = $1 RETURNING id", [chuaDoc]));
    expect(sua.rows).toHaveLength(0);
    const docLai = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
      "UPDATE public.notifications SET status = 'READ' WHERE id = $1 RETURNING id", [daDoc]));
    expect(docLai.rows).toHaveLength(0);
    // Tuple dòng đã đọc KHÔNG bị ghi lại (xmin giữ nguyên ⇒ không WAL, không sự kiện realtime).
    expect((await db.query<{ x: string }>('SELECT xmin::text x FROM public.notifications WHERE id = $1', [daDoc])).rows).toEqual(truoc.rows);
    // "Đánh dấu tất cả" kiểu bản cũ (.neq('status','READ')): chỉ PENDING + CANCELLED thật sự đổi.
    const tatCa = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query<{ id: string }>(
      "UPDATE public.notifications SET status = 'READ' WHERE user_id = $1 AND status <> 'READ' RETURNING id", [ID.nhanVien]));
    expect(tatCa.rows.map((x) => x.id).sort()).toEqual([chuaDoc, daHuy].sort());
    expect(await dong(chuaDoc)).toMatchObject({ status: 'READ', push_state: 'SKIPPED' });
  });

  it('trigger là SECURITY INVOKER, đứng ĐẦU mọi BEFORE INSERT theo thứ tự tên; bảng REPLICA IDENTITY FULL (B2)', async () => {
    const r = await db.query<{ prosecdef: boolean; ten: string }>(
      `SELECT p.prosecdef, t.tgname AS ten
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.notifications'::regclass AND NOT t.tgisinternal AND (t.tgtype & 2) <> 0 AND (t.tgtype & 4) <> 0
        ORDER BY t.tgname COLLATE "C"`);
    expect(r.rows.map((x) => x.ten)).toEqual(['a00_notifications_guard', 'a90_autofill_org']);
    expect(r.rows[0].prosecdef).toBe(false);
    const ri = await db.query<{ v: string }>("SELECT relreplident v FROM pg_class WHERE oid = 'public.notifications'::regclass");
    expect(ri.rows[0].v).toBe('f');
  });

  it('nghiệm thu dừng khi có trigger BEFORE INSERT đứng trước guard (vd. đổi tên autofill thành a00_a…)', async () => {
    // 'a00_autofill' < 'a00_notifications_guard' theo byte ⇒ bắn trước guard.
    await db.exec(`BEGIN; CREATE TRIGGER a00_autofill_som BEFORE INSERT ON public.notifications
                     FOR EACH ROW EXECUTE FUNCTION app_private.test_autofill_org_strict();`);
    try {
      await expect(db.exec(docMigration(MIGRATION.pipeline))).rejects.toThrow(/đứng trước a00_notifications_guard/);
    } finally {
      await db.exec('ROLLBACK');
    }
  });
});

describe('$requires$ — ghim thân hàm đang chạy', () => {
  it('thân hàm bị PR khác thay (md5 lạ) ⇒ migration dừng và nêu tên hàm; lượt hai (thân của chính file) chạy được', async () => {
    await db.exec(`BEGIN; CREATE OR REPLACE FUNCTION app_private.notification_prefs_read_v1(p_user uuid, p_org uuid) RETURNS jsonb
                     LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog' AS $fn$ SELECT '{"PR_KHAC":1}'::jsonb $fn$;`);
    try {
      await expect(db.exec(docMigration(MIGRATION.pipeline))).rejects.toThrow(/notification_prefs_read_v1\(uuid,uuid\) đã đổi/);
    } finally {
      await db.exec('ROLLBACK');
    }
    // Thân hiện hành = thân mới của file ⇒ lượt ba vẫn qua (idempotent).
    await db.exec(docMigration(MIGRATION.pipeline));
  });
});

describe('B3 — claim v2', () => {
  beforeEach(async () => {
    await donSach();
    await thietBi(ID.chu);
  });

  it('dòng đã đọc/đã huỷ ⇒ SKIPPED, không bao giờ vào lô', async () => {
    const daDoc = await them({ status: 'READ' });
    const daHuy = await them({ status: 'CANCELLED' });
    const chuaDoc = await them();
    const lo = await claim();
    expect(lo.flatMap((x) => x.notification_ids)).toEqual([chuaDoc]);
    expect((await dong(daDoc)).push_state).toBe('SKIPPED');
    expect((await dong(daHuy)).push_state).toBe('SKIPPED');
  });

  it('gộp theo (người, công ty): hai công ty ⇒ hai lô, mang organization_id + data {notificationIds, organizationId}', async () => {
    const a1 = await them({ tuoiPhut: 40 });
    const a2 = await them({ tuoiPhut: 30 });
    const b1 = await them({ org: ID.orgKhac, tuoiPhut: 35 });
    const lo = await claim();
    expect(lo).toHaveLength(2);
    const loA = lo.find((x) => x.organization_id === ID.org)!;
    const loB = lo.find((x) => x.organization_id === ID.orgKhac)!;
    expect(loA.notification_ids).toEqual([a1, a2]);
    expect(loA.title).toBe('2 thông báo mới');
    expect(loA.data).toEqual({ notificationIds: [a2, a1], organizationId: ID.org });
    expect(loA.tag).toBe(`crm-${ID.chu}-${ID.org}`);
    expect(loB.notification_ids).toEqual([b1]);
    expect(loB.tag).toBe(`crm-${b1}`);
    expect(loB.data).toEqual({ notificationIds: [b1], organizationId: ID.orgKhac });
    expect(loA.idem_key).not.toBe(loB.idem_key);
    const sauA = await dong(a1);
    expect(sauA).toMatchObject({ push_state: 'SENDING', push_attempts: 1 });
    expect(String(sauA.push_idem_key)).toBe(`${loA.idem_key}:${a1}`);
  });

  it('data.notificationIds tối đa 20 id mới nhất; url ngoài app bị thay bằng /my-day', async () => {
    for (let i = 0; i < 25; i += 1) await them({ tuoiPhut: 100 - i, metadata: { event: 'E2', url: '//evil.example' } });
    const [lo] = await claim();
    expect(lo.notification_ids).toHaveLength(25);
    expect(lo.data.notificationIds).toHaveLength(20);
    expect(lo.url).toBe('/my-day');
    const [moiNhat] = (await db.query<{ id: string }>('SELECT id FROM public.notifications ORDER BY created_at DESC LIMIT 1')).rows;
    expect(lo.data.notificationIds[0]).toBe(moiNhat.id);
  });

  it('giờ yên CÁ NHÂN hoãn push của đúng người×công ty; công ty kia vẫn gửi', async () => {
    const { start, end } = khungChuaBayGio();
    await db.query(`INSERT INTO public.notification_quiet_hours(user_id, organization_id, enabled, quiet_start, quiet_end)
                    VALUES ($1, $2, true, $3, $4)`, [ID.chu, ID.org, start, end]);
    const a = await them();
    const b = await them({ org: ID.orgKhac });
    const lo = await claim();
    expect(lo.flatMap((x) => x.notification_ids)).toEqual([b]);
    expect((await dong(a)).push_state).toBe('QUEUED');
    await db.query('UPDATE public.notification_quiet_hours SET enabled = false');
    expect((await claim()).flatMap((x) => x.notification_ids)).toEqual([a]);
  });

  it('giờ yên CÔNG TY hoãn (không bỏ); start = end là không có giờ yên', async () => {
    const { start, end } = khungChuaBayGio();
    await db.query('UPDATE app_private.notification_org_config SET quiet_start = $1, quiet_end = $2 WHERE organization_id = $3', [start, end, ID.org]);
    const a = await them();
    expect(await claim()).toEqual([]);
    expect((await dong(a)).push_state).toBe('QUEUED');
    await db.query('UPDATE app_private.notification_org_config SET quiet_start = 5, quiet_end = 5 WHERE organization_id = $1', [ID.org]);
    expect((await claim()).flatMap((x) => x.notification_ids)).toEqual([a]);
  });

  it('kiểm lại cổng: tắt đẩy về máy sau khi đã vào hàng ⇒ SKIPPED; E1 không bị lọc lại theo ngưỡng tiền', async () => {
    await db.query(`INSERT INTO public.notification_preferences(user_id, organization_id, event_key, in_app, push)
                    VALUES ($1, $2, 'E2', true, false)`, [ID.chu, ID.org]);
    await db.query(`UPDATE app_private.notification_org_config SET events = '{"E1":{"min_amount":1000000}}' WHERE organization_id = $1`, [ID.org]);
    const e2b = await them({ metadata: { event: 'E2b' } });
    const e1 = await them({ metadata: { event: 'E1', kind: 'ie_pending', amount: 5 }, tuoiPhut: 30 });
    const lo = await claim();
    expect(lo.flatMap((x) => x.notification_ids)).toEqual([e1]);
    expect(await dong(e2b)).toMatchObject({ push_state: 'SKIPPED', error_message: 'push: cài đặt thông báo đã tắt đẩy về máy' });
  });

  it('đã 3 lượt ⇒ FAILED (không nằm QUEUED vĩnh viễn); không thiết bị ⇒ NO_DEVICE; E1 dưới 10 phút chưa gửi', async () => {
    const het = await them({ attempts: 3 });
    const khongMay = await them({ user: ID.nhanVien });
    const e1Moi = await them({ metadata: { event: 'E1', kind: 'ie_pending' }, tuoiPhut: 2 });
    expect(await claim()).toEqual([]);
    expect((await dong(het)).push_state).toBe('FAILED');
    expect((await dong(khongMay)).push_state).toBe('NO_DEVICE');
    expect((await dong(e1Moi)).push_state).toBe('QUEUED');
  });

  it('khoá theo lượt: gửi lại sau lỗi mang khoá MỚI; SENDING treo có biên nhận SENT ⇒ SENT, không gửi lại', async () => {
    const a = await them();
    const [lan1] = await claim();
    expect(await settle([{ idem_key: lan1.idem_key, outcome: 'PROVIDER_ERROR', retryable: true, error: '503' }])).toBe(1);
    expect(await dong(a)).toMatchObject({ push_state: 'QUEUED', push_attempts: 1 });
    const [lan2] = await claim();
    expect(lan2.notification_ids).toEqual([a]);
    expect(lan2.idem_key).not.toBe(lan1.idem_key);

    // Edge chết sau khi send-push đã gửi: lease hết hạn, sổ của khoá lượt đó là SENT ⇒ SENT.
    await db.query("UPDATE public.notifications SET push_leased_at = now() - interval '20 minutes' WHERE id = $1", [a]);
    await db.query("INSERT INTO public.push_send_log(idempotency_key, user_id, outcome, sent) VALUES ($1, $2, 'SENT', 1)", [lan2.idem_key, ID.chu]);
    expect(await claim()).toEqual([]);
    expect((await dong(a)).push_state).toBe('SENT');

    // Treo mà sổ không có gì ⇒ QUEUED, lượt sau khoá mới.
    const b = await them();
    const [lb] = await claim();
    await db.query("UPDATE public.notifications SET push_leased_at = now() - interval '20 minutes' WHERE id = $1", [b]);
    const [lb2] = await claim();
    expect(lb2.notification_ids).toEqual([b]);
    expect(lb2.idem_key).not.toBe(lb.idem_key);
  });

  it('bản v1 giữ chữ ký, uỷ quyền v2 (cùng bỏ dòng đã đọc)', async () => {
    await them({ status: 'READ' });
    const a = await them();
    // public.notify_claim_push_batch_v1 chỉ là vỏ gọi bản app_private (20260729170000) — fixture không dựng vỏ.
    const r = await db.query<Record<string, unknown>>('SELECT * FROM app_private.notify_claim_push_batch_v1(10)');
    expect(Object.keys(r.rows[0]).sort()).toEqual(['body', 'idem_key', 'notification_ids', 'tag', 'title', 'url', 'user_id']);
    expect(r.rows[0].notification_ids).toEqual([a]);
  });
});

describe('B3 — settle v2', () => {
  beforeEach(async () => {
    await donSach();
    await thietBi(ID.chu);
  });

  const moiLo = async () => {
    const id = await them();
    const [lo] = await claim();
    return { id, key: lo.idem_key };
  };

  it('DUPLICATE chỉ thành SENT khi sổ của khoá là SENT/PARTIAL; sổ trống ⇒ thử lại; sổ SENDING ⇒ không đụng', async () => {
    const coSo = await moiLo();
    await db.query("INSERT INTO public.push_send_log VALUES ($1, $2, 'SENT', 2, now())", [coSo.key, ID.chu]);
    const khongSo = await moiLo();
    const dangBay = await moiLo();
    await db.query("INSERT INTO public.push_send_log VALUES ($1, $2, 'SENDING', 0, now())", [dangBay.key, ID.chu]);
    const n = await settle([
      { idem_key: coSo.key, outcome: 'DUPLICATE' },
      { idem_key: khongSo.key, outcome: 'DUPLICATE' },
      { idem_key: dangBay.key, outcome: 'DUPLICATE' },
    ]);
    expect(n).toBe(2);
    expect((await dong(coSo.id)).push_state).toBe('SENT');
    expect(await dong(khongSo.id)).toMatchObject({ push_state: 'QUEUED', sent_at: null });
    expect(String((await dong(khongSo.id)).error_message)).toContain('sổ=không có');
    expect((await dong(dangBay.id)).push_state).toBe('SENDING');
  });

  it('SENT/PARTIAL ⇒ SENT có sent_at; NO_DEVICE ⇒ NO_DEVICE; lỗi không thử lại ⇒ FAILED; không đụng status', async () => {
    const a = await moiLo();
    const b = await moiLo();
    const c = await moiLo();
    await settle([
      { idem_key: a.key, outcome: 'PARTIAL', sent: 1 },
      { idem_key: b.key, outcome: 'NO_DEVICE' },
      { idem_key: c.key, outcome: 'BAD_REQUEST', retryable: false, error: 'x' },
    ]);
    const sa = await dong(a.id);
    expect(sa).toMatchObject({ push_state: 'SENT', status: 'PENDING', error_message: null });
    expect(sa.sent_at).not.toBeNull();
    expect((await dong(b.id)).push_state).toBe('NO_DEVICE');
    expect((await dong(c.id)).push_state).toBe('FAILED');
    expect(await settle([])).toBe(0);
    expect(await settle([{ outcome: 'SENT' }, 'rác'])).toBe(0);
  });

  it('sổ push_send_log xét TRƯỚC nhánh lỗi: timeout (PROVIDER_ERROR) mà sổ SENT ⇒ SENT, không gửi lại; sổ SENDING ⇒ giữ nguyên', async () => {
    const daGui = await moiLo();
    await db.query("INSERT INTO public.push_send_log VALUES ($1, $2, 'SENT', 1, now())", [daGui.key, ID.chu]);
    const dangGui = await moiLo();
    await db.query("INSERT INTO public.push_send_log VALUES ($1, $2, 'SENDING', 0, now())", [dangGui.key, ID.chu]);
    const soKhong = await moiLo();
    await db.query("INSERT INTO public.push_send_log VALUES ($1, $2, 'SENT', 0, now())", [soKhong.key, ID.chu]);
    const n = await settle([
      { idem_key: daGui.key, outcome: 'PROVIDER_ERROR', retryable: true, error: 'timeout 8s' },
      { idem_key: dangGui.key, outcome: 'PROVIDER_ERROR', retryable: true, error: 'timeout 8s' },
      { idem_key: soKhong.key, outcome: 'PROVIDER_ERROR', retryable: true, error: 'timeout 8s' },
    ]);
    expect(n).toBe(2);
    const a = await dong(daGui.id);
    expect(a).toMatchObject({ push_state: 'SENT', error_message: null, push_attempts: 1 });
    expect(a.sent_at).not.toBeNull();
    expect(await dong(dangGui.id)).toMatchObject({ push_state: 'SENDING', push_attempts: 1 });
    // Sổ SENT nhưng sent = 0 không phải bằng chứng đã tới máy ⇒ thử lại như cũ.
    expect(await dong(soKhong.id)).toMatchObject({ push_state: 'QUEUED', push_attempts: 1 });
    // Lượt claim sau không gửi lại dòng đã SENT.
    expect((await claim()).flatMap((x) => x.notification_ids)).toEqual([soKhong.id]);
  });

  it('DEFERRED / CONFIG_ERROR ⇒ HOLD: về QUEUED, không tiêu lượt (push_attempts lùi 1, tối thiểu 0), bỏ lease', async () => {
    const hoan = await moiLo();
    const cauHinh = await moiLo();
    // Dòng đã thử 2 lần rồi, lượt này (3) bị hoãn ⇒ về 2 — vẫn còn lượt, không FAILED.
    const lanBa = await them({ attempts: 2 });
    const [lo3] = await claim();
    await db.query('UPDATE public.notifications SET push_attempts = 0 WHERE id = $1', [cauHinh.id]);
    const n = await settle([
      { idem_key: hoan.key, outcome: 'DEFERRED', retryable: true },
      { idem_key: cauHinh.key, outcome: 'CONFIG_ERROR', retryable: false, error: 'thiếu VAPID' },
      { idem_key: lo3.idem_key, outcome: 'DEFERRED' },
    ]);
    expect(n).toBe(3);
    expect(await dong(hoan.id)).toMatchObject({ push_state: 'QUEUED', push_attempts: 0, push_leased_at: null, sent_at: null });
    expect(await dong(cauHinh.id)).toMatchObject({ push_state: 'QUEUED', push_attempts: 0, push_leased_at: null });
    expect(String((await dong(cauHinh.id)).error_message)).toContain('CONFIG_ERROR');
    expect(await dong(lanBa)).toMatchObject({ push_state: 'QUEUED', push_attempts: 2 });
  });
});

describe('B4 — E1 reset lượt khi số phiếu tăng', () => {
  beforeEach(donSach);

  it('bump reset push_attempts=0 + lease; giảm số không bump; về 0 xoá dòng', async () => {
    await db.query(`INSERT INTO test_permissions VALUES ($1, $2, $3, 'income_expenses.approve', true)`, [ID.chu, ID.org, ID.toa]);
    await db.query(`INSERT INTO public.income_expenses(organization_id, building_id, approval_status, review_state, total_amount)
                    VALUES ($1, $2, 'UNAPPROVED', 'PENDING', 100)`, [ID.org, ID.toa]);
    const refresh = () => db.query('SELECT app_private.notify_ie_pending_refresh_v1($1, $2)', [ID.org, ID.chu]);
    await refresh();
    const e1 = () => db.query<Record<string, unknown>>("SELECT * FROM public.notifications WHERE metadata->>'kind' = 'ie_pending'").then((r) => r.rows);
    expect(await e1()).toHaveLength(1);
    // Đã gửi 3 lượt trong đời dòng gộp.
    await db.query("UPDATE public.notifications SET push_state = 'SENT', push_attempts = 3, push_leased_at = now()");
    await db.query(`INSERT INTO public.income_expenses(organization_id, building_id, approval_status, review_state, total_amount)
                    VALUES ($1, $2, 'UNAPPROVED', 'PENDING', 50)`, [ID.org, ID.toa]);
    await refresh();
    expect((await e1())[0]).toMatchObject({ push_state: 'QUEUED', push_attempts: 0, push_leased_at: null });
    expect((await e1())[0].metadata).toMatchObject({ count: 2 });

    await db.query("UPDATE public.notifications SET push_state = 'SENT', push_attempts = 1");
    await db.query("DELETE FROM public.income_expenses WHERE total_amount = 50");
    await refresh();
    expect((await e1())[0]).toMatchObject({ push_state: 'SENT', push_attempts: 1 });
    await db.query('DELETE FROM public.income_expenses');
    await refresh();
    expect(await e1()).toHaveLength(0);
  });
});

describe('B6 — dọn lỗi thời + bảo trì', () => {
  beforeEach(donSach);

  it('nhắc legacy PENDING và E5 trỏ bàn giao đã rời PENDING ⇒ CANCELLED có lý do; READ, dòng server, bàn giao đang chờ giữ nguyên', async () => {
    const hDone = '00000000-0000-4000-8000-000000000501';
    const hOpen = '00000000-0000-4000-8000-000000000502';
    const hHuy = '00000000-0000-4000-8000-000000000503';
    await db.query(`INSERT INTO public.cash_handovers(id, status, organization_id, confirmed_at) VALUES
      ($1, 'CONFIRMED', $4, now()), ($2, 'PENDING', $4, null), ($3, 'CANCELLED', $4, null)`, [hDone, hOpen, hHuy, ID.org]);
    const legacy = await them({ type: 'PAYMENT_REMINDER', metadata: {}, push: null });
    const legacyDoc = await them({ type: 'OVERDUE_INVOICE', metadata: {}, push: null, status: 'READ' });
    const server = await them({ type: 'PAYMENT_REMINDER', metadata: { event: 'BILLING', delivery_id: 'x' }, push: null });
    const e5Done = await them({ metadata: { event: 'E5', handover_id: hDone }, push: 'QUEUED' });
    const e5Huy = await them({ metadata: { event: 'E5', handover_id: hHuy }, push: null });
    const e5Open = await them({ metadata: { event: 'E5', handover_id: hOpen }, push: null });

    const r = (await db.query<{ v: Record<string, number> }>('SELECT public.notification_maintenance_v1() v')).rows[0].v;
    expect(r).toMatchObject({ reconciled: 3, legacy_cancelled: 1, handover_cancelled: 2, cashbook_closed_cancelled: 0 });
    expect(await dong(legacy)).toMatchObject({ status: 'CANCELLED' });
    expect((await dong(legacy)).metadata).toMatchObject({ cancelled_reason: 'LEGACY_CLIENT_REMINDER_REPLACED', cancelled_by: 'notification_reconcile_stale_v1' });
    expect(await dong(e5Done)).toMatchObject({ status: 'CANCELLED', push_state: 'SKIPPED' });
    expect((await dong(e5Done)).metadata).toMatchObject({ cancelled_reason: 'HANDOVER_RESOLVED' });
    expect((await dong(e5Huy)).status).toBe('CANCELLED');
    expect((await dong(legacyDoc)).status).toBe('READ');
    expect((await dong(server)).status).toBe('PENDING');
    expect((await dong(e5Open)).status).toBe('PENDING');
    // Lượt sau không còn gì để dọn.
    expect((await db.query<{ v: Record<string, number> }>('SELECT public.notification_maintenance_v1() v')).rows[0].v).toMatchObject({ reconciled: 0 });
  });

  it('E6a (nhắc chốt sổ) sinh đúng lúc bàn giao CONFIRMED: két CHƯA chốt ⇒ giữ PENDING + push QUEUED; két đã chốt tới ngày xác nhận / sổ ảo / sổ đã xoá ⇒ CASHBOOK_CLOSED', async () => {
    const so = { chuaChot: '00000000-0000-4000-8000-000000000511', daChot: '00000000-0000-4000-8000-000000000512',
      khoa: '00000000-0000-4000-8000-000000000513', ao: '00000000-0000-4000-8000-000000000514', xoa: '00000000-0000-4000-8000-000000000515' };
    const h = (n: number) => `00000000-0000-4000-8000-00000000052${n}`;
    // "Hôm nay" theo GIỜ CÔNG TY — đúng mốc hàm dọn so (confirmed_at AT TIME ZONE org_timezone_v1). `current_date`
    // theo múi giờ tiến trình test thì lệch một ngày dưới Pacific/Midway vào buổi sáng UTC (timezone-gate).
    const homNay = (thamSoOrg: string) => `(now() AT TIME ZONE app_private.org_timezone_v1(${thamSoOrg}))::date`;
    await db.query(`INSERT INTO public.accounts(id, organization_id, name, is_virtual, deleted_at, lock_date) VALUES
      ($1, $6, 'Két A', false, null, null), ($2, $6, 'Két B', false, null, null), ($3, $6, 'Két C', false, null, ${homNay('$6')}),
      ($4, $6, 'Thối', true, null, null), ($5, $6, 'Két cũ', false, now(), null)`,
      [so.chuaChot, so.daChot, so.khoa, so.ao, so.xoa, ID.org]);
    // Két A chốt tới HÔM QUA — bàn giao xác nhận hôm nay vẫn phải chốt. Két B chốt tới hôm nay. Két C khoá sổ tới hôm nay.
    await db.query(`INSERT INTO app_private.cashbook_closures VALUES ($1, ${homNay('$3')} - 1), ($2, ${homNay('$3')})`,
      [so.chuaChot, so.daChot, ID.org]);
    const ds = [so.chuaChot, so.daChot, so.khoa, so.ao, so.xoa];
    for (let i = 0; i < ds.length; i += 1) {
      await db.query("INSERT INTO public.cash_handovers VALUES ($1, 'CONFIRMED', $2, $3, now())", [h(i), ID.org, ds[i]]);
    }
    const e6a: string[] = [];
    for (let i = 0; i < ds.length; i += 1) e6a.push(await them({ metadata: { event: 'E6a', handover_id: h(i), cashbook_id: ds[i] }, push: 'QUEUED' }));

    const r = (await db.query<{ v: Record<string, number> }>('SELECT public.notification_maintenance_v1() v')).rows[0].v;
    expect(r).toMatchObject({ reconciled: 4, handover_cancelled: 0, cashbook_closed_cancelled: 4 });
    expect(await dong(e6a[0])).toMatchObject({ status: 'PENDING', push_state: 'QUEUED' });
    for (const id of e6a.slice(1)) {
      expect(await dong(id)).toMatchObject({ status: 'CANCELLED', push_state: 'SKIPPED' });
      expect((await dong(id)).metadata).toMatchObject({ cancelled_reason: 'CASHBOOK_CLOSED', cancelled_by: 'notification_reconcile_stale_v1' });
    }
    // Chốt két A tới hôm nay ⇒ nhịp bảo trì sau huỷ nốt.
    await db.query(`INSERT INTO app_private.cashbook_closures VALUES ($1, ${homNay('$2')})`, [so.chuaChot, ID.org]);
    expect((await db.query<{ v: Record<string, number> }>('SELECT public.notification_maintenance_v1() v')).rows[0].v)
      .toMatchObject({ cashbook_closed_cancelled: 1 });
    expect((await dong(e6a[0])).status).toBe('CANCELLED');
  });

  it('lần dọn đầu của migration ghi cancelled_by_migration (câu khôi phục chọn đúng tập dòng)', async () => {
    const legacy = await them({ type: 'DEPOSIT_SHORTFALL', metadata: {}, push: null });
    await db.query("SELECT app_private.notification_reconcile_stale_v1('20261021171249_notify_pipeline_v2')");
    expect((await dong(legacy)).metadata).toMatchObject({ cancelled_by_migration: '20261021171249_notify_pipeline_v2' });
  });

  it('push_send_log > 30 ngày dọn tối đa một lần mỗi ngày', async () => {
    await db.query("INSERT INTO public.push_send_log VALUES ('cu-1', $1, 'SENT', 1, now() - interval '40 days'), ('moi', $1, 'SENT', 1, now())", [ID.chu]);
    expect((await db.query<{ v: Record<string, number> }>('SELECT public.notification_maintenance_v1() v')).rows[0].v.push_log_deleted).toBe(1);
    await db.query("INSERT INTO public.push_send_log VALUES ('cu-2', $1, 'SENT', 1, now() - interval '40 days')", [ID.chu]);
    expect((await db.query<{ v: Record<string, number> }>('SELECT public.notification_maintenance_v1() v')).rows[0].v.push_log_deleted).toBe(0);
    await db.query("UPDATE app_private.notification_maintenance_state SET last_run_at = now() - interval '25 hours'");
    expect((await db.query<{ v: Record<string, number> }>('SELECT public.notification_maintenance_v1() v')).rows[0].v.push_log_deleted).toBe(1);
    expect((await db.query<{ k: string }>('SELECT idempotency_key k FROM public.push_send_log')).rows).toEqual([{ k: 'moi' }]);
  });
});

describe('B8 — giờ yên cá nhân (RPC)', () => {
  beforeEach(donSach);
  const get = (uid: string | null, org: string) =>
    voiNguoi(db, uid, () => db.query<{ v: Record<string, unknown> }>('SELECT public.get_my_notification_quiet_hours_v1($1) v', [org]));
  const set = (uid: string | null, org: string, on: boolean | null, s: number | null, e: number | null) =>
    voiNguoi(db, uid, () => db.query<{ v: Record<string, unknown> }>('SELECT public.set_my_notification_quiet_hours_v1($1, $2, $3, $4) v', [org, on, s, e]));

  it('chưa có dòng ⇒ tắt, 21, 7, updated_at null; set trả biên nhận; NULL = giữ nguyên', async () => {
    expect((await get(ID.nhanVien, ID.org)).rows[0].v).toMatchObject({ enabled: false, quiet_start: 21, quiet_end: 7, updated_at: null, organization_id: ID.org });
    const r = (await set(ID.nhanVien, ID.org, true, 22, 6)).rows[0].v;
    expect(r).toMatchObject({ enabled: true, quiet_start: 22, quiet_end: 6 });
    expect(r.updated_at).not.toBeNull();
    expect((await set(ID.nhanVien, ID.org, false, null, null)).rows[0].v).toMatchObject({ enabled: false, quiet_start: 22, quiet_end: 6 });
    expect((await get(ID.nhanVien, ID.org)).rows[0].v).toMatchObject({ enabled: false, quiet_start: 22, quiet_end: 6 });
  });

  it('chỉ thành viên ACTIVE; giờ ngoài 0..23 là 22023; client không ghi thẳng bảng; anon không gọi được', async () => {
    expect(await maLoi(get(ID.nguoiNgoai, ID.org))).toBe('42501');
    expect(await maLoi(get(null, ID.org))).toBe('42501');
    expect(await maLoi(set(ID.nhanVien, ID.org, true, 24, 6))).toBe('22023');
    expect(await maLoi(set(ID.nhanVien, ID.org, true, 1, -1))).toBe('22023');
    await set(ID.nhanVien, ID.org, true, 22, 6);
    const doc = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query('SELECT * FROM public.notification_quiet_hours'));
    expect(doc.rows).toHaveLength(1);
    const nguoiKhacDoc = await voiVai(db, 'authenticated', ID.chu, () => db.query('SELECT * FROM public.notification_quiet_hours'));
    expect(nguoiKhacDoc.rows).toHaveLength(0);
    expect(await maLoi(voiVai(db, 'authenticated', ID.nhanVien, () => db.query(
      'INSERT INTO public.notification_quiet_hours(user_id, organization_id) VALUES ($1, $2)', [ID.nhanVien, ID.orgKhac])))).toBe('42501');
    const acl = await db.query<{ a: boolean; b: boolean }>(
      "SELECT has_function_privilege('anon', 'public.set_my_notification_quiet_hours_v1(uuid,boolean,integer,integer)', 'EXECUTE') a, has_function_privilege('authenticated', 'public.get_my_notification_quiet_hours_v1(uuid)', 'EXECUTE') b");
    expect(acl.rows[0]).toEqual({ a: false, b: true });
  });

  it('helper giờ yên: khung vắt nửa đêm, start = end là không có, giờ công ty theo múi giờ công ty', async () => {
    const r = await db.query<Record<string, boolean>>(`SELECT
      app_private.notify_hour_in_window_v1(23, 21, 7) a, app_private.notify_hour_in_window_v1(6, 21, 7) b,
      app_private.notify_hour_in_window_v1(7, 21, 7) c, app_private.notify_hour_in_window_v1(12, 9, 9) d,
      app_private.notify_hour_in_window_v1(10, 9, 17) e`);
    expect(r.rows[0]).toEqual({ a: true, b: true, c: false, d: false, e: true });
    // Chưa có dòng config ⇒ mặc định 21→7 (giữ ngữ nghĩa drain cũ). 03:00 UTC nằm trong khung; 12:00 thì không.
    await db.query('DELETE FROM app_private.notification_org_config');
    const m = await db.query<Record<string, boolean>>(`SELECT
      app_private.notify_in_quiet_hours_v1($1, $2, '2026-10-22 03:00+00') dem,
      app_private.notify_in_quiet_hours_v1($1, $2, '2026-10-22 12:00+00') trua`, [ID.chu, ID.org]);
    expect(m.rows[0]).toEqual({ dem: true, trua: false });
    // Múi giờ công ty: 12:00 UTC = 19:00 Asia/Ho_Chi_Minh, khung 18→20 của công ty.
    await db.query("INSERT INTO test_tz VALUES ($1, 'Asia/Ho_Chi_Minh') ON CONFLICT (organization_id) DO UPDATE SET tz = excluded.tz", [ID.org]);
    await db.query('INSERT INTO app_private.notification_org_config(organization_id, quiet_start, quiet_end) VALUES ($1, 18, 20)', [ID.org]);
    const tz = await db.query<{ v: boolean }>("SELECT app_private.notify_in_quiet_hours_v1($1, $2, '2026-10-22 12:00+00') v", [ID.chu, ID.org]);
    expect(tz.rows[0].v).toBe(true);
    await db.query('DELETE FROM test_tz');
  });
});

describe('B8 — cấu hình công ty v2 + cổng', () => {
  beforeEach(async () => {
    await donSach();
    await db.query('DELETE FROM app_private.notification_org_config');
  });
  type Cfg = { organization_id: string; organization_name: string; configured: boolean; events: Record<string, { enabled: boolean; min_amount: number | null }>;
    quiet_start: number; quiet_end: number; updated_at: string | null };
  const get = (uid: string, org: string) =>
    voiNguoi(db, uid, () => db.query<{ v: Cfg }>('SELECT public.get_notification_org_config_v2($1) v', [org]).then((r) => r.rows[0].v));
  const set = (uid: string, org: string, events: unknown, s: number | null, e: number | null, expected: string | null) =>
    voiNguoi(db, uid, () => db.query<{ v: Cfg }>('SELECT public.set_notification_org_config_v2($1, $2::jsonb, $3, $4, $5) v',
      [org, events === null ? null : JSON.stringify(events), s, e, expected]).then((r) => r.rows[0].v));

  it('get cần settings.view của ĐÚNG công ty; trả tên công ty + đủ 10 họ (có BILLING/CONTRACT_EXPIRY/DEPOSIT)', async () => {
    expect(await maLoi(get(ID.chu, ID.org))).toBe('42501');
    await db.query("INSERT INTO test_permissions VALUES ($1, $2, null, 'settings.view', true)", [ID.chu, ID.org]);
    const v = await get(ID.chu, ID.org);
    expect(v).toMatchObject({ organization_id: ID.org, organization_name: 'Công ty A', configured: false, quiet_start: 21, quiet_end: 7, updated_at: null });
    expect(Object.keys(v.events).sort()).toEqual(['BILLING', 'CONTRACT_EXPIRY', 'DEPOSIT', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'LIFECYCLE']);
    expect(await maLoi(get(ID.chu, ID.orgKhac))).toBe('42501');
  });

  it('set cần settings.edit; lệch updated_at ⇒ PT409; merge theo họ không xoá họ khác', async () => {
    await db.query("INSERT INTO test_permissions VALUES ($1, $2, null, 'settings.view', true)", [ID.chu, ID.org]);
    expect(await maLoi(set(ID.chu, ID.org, { E5: { enabled: false } }, null, null, null))).toBe('42501');
    await db.query("INSERT INTO test_permissions VALUES ($1, $2, null, 'settings.edit', true)", [ID.chu, ID.org]);
    const lan1 = await set(ID.chu, ID.org, { E5: { enabled: false }, BILLING: { enabled: false } }, 22, 6, null);
    expect(lan1).toMatchObject({ configured: true, quiet_start: 22, quiet_end: 6 });
    expect(lan1.events.E5.enabled).toBe(false);
    // Bản nháp cũ (đọc lúc chưa có dòng) ghi đè ⇒ 409.
    expect(await maLoi(set(ID.chu, ID.org, { E1: { enabled: false } }, null, null, null))).toBe('PT409');
    expect(await maLoi(set(ID.chu, ID.org, { E1: { enabled: false } }, null, null, '2000-01-01T00:00:00Z'))).toBe('PT409');
    const lan2 = await set(ID.chu, ID.org, { E1: { min_amount: 5 } }, null, null, lan1.updated_at);
    expect(lan2.events.E5.enabled).toBe(false);
    expect(lan2.events.BILLING.enabled).toBe(false);
    expect(lan2.events.E1.min_amount).toBe(5);
    expect(lan2.quiet_start).toBe(22);
    expect(await maLoi(set(ID.chu, ID.org, { KHONG_CO: {} }, null, null, lan2.updated_at))).toBe('22023');
    expect(await maLoi(set(ID.chu, ID.org, null, 24, null, lan2.updated_at))).toBe('22023');
  });

  it('notify_gate_v1: ngưỡng tiền chỉ áp E2*/E3 (đúng ô ngưỡng của UI) — E5, E6a, E6c dưới ngưỡng vẫn tới', async () => {
    await db.query(`INSERT INTO app_private.notification_org_config(organization_id, events) VALUES ($1,
      '{"E2":{"min_amount":1000},"E3":{"min_amount":1000},"E5":{"min_amount":1000},"E6":{"min_amount":1000}}')`, [ID.org]);
    const g = async (ev: string) => (await db.query<{ g_in_app: boolean; g_push: boolean }>(
      'SELECT * FROM app_private.notify_gate_v1($1, $2, $3, 10)', [ID.chu, ID.org, ev])).rows[0];
    expect(await g('E5')).toEqual({ g_in_app: true, g_push: true });
    expect(await g('E6a')).toEqual({ g_in_app: true, g_push: true });
    expect(await g('E6c')).toEqual({ g_in_app: true, g_push: true });
    expect(await g('E2b')).toEqual({ g_in_app: false, g_push: false });
    expect(await g('E3')).toEqual({ g_in_app: false, g_push: false });
  });

  it('khoá sở thích mới qua CHECK + normalize + read', async () => {
    await db.query("INSERT INTO public.notification_preferences(user_id, organization_id, event_key, push) VALUES ($1, $2, 'BILLING', false)", [ID.chu, ID.org]);
    const read = (await db.query<{ v: Record<string, { push: boolean }> }>('SELECT app_private.notification_prefs_read_v1($1, $2) v', [ID.chu, ID.org])).rows[0].v;
    expect(Object.keys(read)).toHaveLength(10);
    expect(read.BILLING.push).toBe(false);
    expect((await db.query<{ v: unknown }>(`SELECT app_private.notification_prefs_normalize_v1('{"DEPOSIT":{"push":false}}') v`)).rows[0].v)
      .toEqual({ DEPOSIT: { in_app: null, push: false, cadence: null } });
    expect(await maLoi(db.query(`SELECT app_private.notification_prefs_normalize_v1('{"ZALO":{}}')`))).toBe('22023');
    expect(await maLoi(db.query("INSERT INTO public.notification_preferences(user_id, organization_id, event_key) VALUES ($1, $2, 'ZALO')", [ID.chu, ID.org]))).toBe('23514');
  });
});

describe('B9 — sức khoẻ giao thông báo + nhật ký push của tôi', () => {
  beforeEach(donSach);

  it('cần settings.view; đếm thành viên/thiết bị/hàng đợi; push_log_7d chỉ đếm khoá gắn với công ty; có last_drain_at', async () => {
    const health = () => voiNguoi(db, ID.chu, () => db.query<{ v: Record<string, unknown> }>(
      'SELECT public.get_notification_delivery_health_v1($1) v', [ID.org]).then((r) => r.rows[0].v));
    expect(await maLoi(health())).toBe('42501');
    await db.query("INSERT INTO test_permissions VALUES ($1, $2, null, 'settings.view', true)", [ID.chu, ID.org]);
    await thietBi(ID.chu);
    await them({ push: 'QUEUED' });
    await them({ push: 'SENT', idem: 'khoa-cong-ty:x' });
    await them({ org: ID.orgKhac, push: 'SENT', idem: 'khoa-cong-ty-khac:y' });
    await db.query(`INSERT INTO public.push_send_log VALUES ('khoa-cong-ty', $1, 'SENT', 1, now()),
      ('khoa-cong-ty-khac', $1, 'ALL_FAILED', 0, now()), ('usr:gui-thu', $1, 'NO_DEVICE', 0, now())`, [ID.chu]);
    await db.query("SELECT public.notify_drain_record_run_v1(2, 3, '{\"SENT\":3}'::jsonb)");
    const v = await health();
    expect(v).toMatchObject({ organization_id: ID.org, members_total: 2, members_with_device: 1, active_devices: 1, push_log_7d: { SENT: 1 } });
    expect(v.queue).toMatchObject({ queued: 1, sending: 0 });
    expect(v.last_7d).toMatchObject({ sent: 1 });
    expect(v.last_drain_at).not.toBeNull();
    expect(Object.keys(v).sort()).toEqual(expect.arrayContaining(['generated_at', 'lifecycle', 'no_recipient_7d', 'last_drain_at']));
    expect(await maLoi(db.query("SELECT public.notify_drain_record_run_v1(-1, 0, '{}'::jsonb)"))).toBe('22023');
  });

  it('hàng chờ tách dòng HOÃN vì giờ yên (deferred_quiet) khỏi dòng đủ điều kiện (oldest_eligible_queued_at)', async () => {
    await db.query("INSERT INTO test_permissions VALUES ($1, $2, null, 'settings.view', true)", [ID.chu, ID.org]);
    const { start, end } = khungChuaBayGio();
    // nhanVien đang giờ yên cá nhân: dòng cũ nhất của họ là hoãn hợp lệ, không phải drain hỏng.
    await db.query(`INSERT INTO public.notification_quiet_hours(user_id, organization_id, enabled, quiet_start, quiet_end)
                    VALUES ($1, $2, true, $3, $4)`, [ID.nhanVien, ID.org, start, end]);
    await them({ user: ID.nhanVien, push: 'QUEUED', tuoiPhut: 300 });
    await them({ user: ID.nhanVien, push: 'QUEUED', tuoiPhut: 200 });
    await them({ user: ID.chu, push: 'QUEUED', tuoiPhut: 40 });
    const v = (await voiNguoi(db, ID.chu, () => db.query<{ v: { queue: Record<string, unknown> } }>(
      'SELECT public.get_notification_delivery_health_v1($1) v', [ID.org]))).rows[0].v;
    expect(v.queue).toMatchObject({ queued: 3, deferred_quiet: 2 });
    const tuoi = (iso: unknown) => Math.round((Date.now() - Date.parse(String(iso))) / 60000);
    expect(tuoi(v.queue.oldest_queued_at)).toBeGreaterThanOrEqual(299);
    expect(tuoi(v.queue.oldest_eligible_queued_at)).toBeLessThanOrEqual(41);
    // Hết giờ yên ⇒ không còn dòng hoãn.
    await db.query('UPDATE public.notification_quiet_hours SET enabled = false');
    const v2 = (await voiNguoi(db, ID.chu, () => db.query<{ v: { queue: Record<string, unknown> } }>(
      'SELECT public.get_notification_delivery_health_v1($1) v', [ID.org]))).rows[0].v;
    expect(v2.queue).toMatchObject({ deferred_quiet: 0 });
    expect(tuoi(v2.queue.oldest_eligible_queued_at)).toBeGreaterThanOrEqual(299);
  });

  it('last_drain_* là phạm vi hệ thống; chuỗi lỗi thô chỉ super admin đọc được', async () => {
    await db.query("INSERT INTO test_permissions VALUES ($1, $2, null, 'settings.view', true)", [ID.chu, ID.org]);
    await db.query(`SELECT public.notify_drain_record_run_v1(1, 0, '{}'::jsonb, 'claim: lỗi PostgREST {"code":"57014"}')`);
    const health = () => voiNguoi(db, ID.chu, () => db.query<{ v: Record<string, unknown> }>(
      'SELECT public.get_notification_delivery_health_v1($1) v', [ID.org]).then((r) => r.rows[0].v));
    const thuong = await health();
    expect(thuong).toMatchObject({ drain_scope: 'system', last_drain_error: null });
    expect(thuong.last_drain_at).not.toBeNull();
    // Super admin (đổi tạm hàm is_super_admin trong một giao dịch).
    await db.exec(`BEGIN; CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS
                     $$ SELECT auth.uid() = '${ID.chu}'::uuid $$;`);
    try {
      expect((await health()).last_drain_error).toBe('claim: lỗi PostgREST {"code":"57014"}');
    } finally {
      await db.exec('ROLLBACK');
    }
    expect((await health()).last_drain_error).toBeNull();
  });

  it('get_my_push_log_v1 chỉ trả dòng của chính mình, trần 1..50', async () => {
    await db.query(`INSERT INTO public.push_send_log VALUES ('a', $1, 'SENT', 1, now() - interval '1 hour'), ('b', $1, 'NO_DEVICE', 0, now()),
      ('c', $2, 'SENT', 1, now())`, [ID.chu, ID.nhanVien]);
    const r = await voiNguoi(db, ID.chu, () => db.query<{ outcome: string; sent: number }>('SELECT outcome, sent FROM public.get_my_push_log_v1(10)'));
    expect(r.rows).toEqual([{ outcome: 'NO_DEVICE', sent: 0 }, { outcome: 'SENT', sent: 1 }]);
    expect(await maLoi(voiNguoi(db, ID.chu, () => db.query('SELECT * FROM public.get_my_push_log_v1(0)')))).toBe('22023');
    expect(await maLoi(voiNguoi(db, ID.chu, () => db.query('SELECT * FROM public.get_my_push_log_v1(51)')))).toBe('22023');
    expect(await maLoi(voiNguoi(db, null, () => db.query('SELECT * FROM public.get_my_push_log_v1(5)')))).toBe('42501');
  });
});

describe('ACL (B10 + RPC mới)', () => {
  it('RPC client chỉ authenticated; RPC edge chỉ service_role; anon mất quyền bảng push_subscriptions/logs/templates', async () => {
    const r = await db.query<Record<string, boolean>>(`SELECT
      has_function_privilege('anon', 'public.get_notification_delivery_health_v1(uuid)', 'EXECUTE') anon_health,
      has_function_privilege('authenticated', 'public.notify_claim_push_batch_v2(integer)', 'EXECUTE') auth_claim,
      has_function_privilege('service_role', 'public.notify_claim_push_batch_v2(integer)', 'EXECUTE') svc_claim,
      has_function_privilege('authenticated', 'public.notification_maintenance_v1()', 'EXECUTE') auth_maint,
      has_function_privilege('service_role', 'public.notify_drain_record_run_v1(integer,integer,jsonb,text)', 'EXECUTE') svc_run,
      has_function_privilege('authenticated', 'app_private.notify_in_quiet_hours_v1(uuid,uuid,timestamptz)', 'EXECUTE') auth_helper,
      has_table_privilege('anon', 'public.push_subscriptions', 'SELECT') anon_sub,
      has_table_privilege('anon', 'public.notification_templates', 'SELECT') anon_tpl,
      has_table_privilege('authenticated', 'public.push_subscriptions', 'TRUNCATE') auth_truncate,
      has_table_privilege('authenticated', 'public.push_subscriptions', 'INSERT') auth_insert`);
    expect(r.rows[0]).toEqual({ anon_health: false, auth_claim: false, svc_claim: true, auth_maint: false, svc_run: true,
      auth_helper: false, anon_sub: false, anon_tpl: false, auth_truncate: false, auth_insert: true });
  });

  it('push_subscriptions.revoked_at (SETTINGS-1): cột có, mặc định NULL, chủ dòng cập nhật được bằng UPDATE thường', async () => {
    await donSach();
    await thietBi(ID.nhanVien);
    const r = await voiVai(db, 'authenticated', ID.nhanVien, () => db.query<{ revoked: boolean; is_active: boolean }>(
      `UPDATE public.push_subscriptions SET is_active = false, revoked_at = now() WHERE user_id = $1
       RETURNING revoked_at IS NOT NULL AS revoked, is_active`, [ID.nhanVien]));
    expect(r.rows).toEqual([{ revoked: true, is_active: false }]);
    const cot = await db.query<{ is_nullable: string; data_type: string }>(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'push_subscriptions' AND column_name = 'revoked_at'");
    expect(cot.rows).toEqual([{ is_nullable: 'YES', data_type: 'timestamp with time zone' }]);
  });

  it('bật lại (is_active false→true, như bản web cũ upsert) xoá dấu gỡ; đổi cột khác giữ nguyên dấu', async () => {
    await donSach();
    await thietBi(ID.nhanVien);
    const doc = async (sql: string) => (await voiVai(db, 'authenticated', ID.nhanVien, () => db.query<{ revoked: boolean; is_active: boolean }>(
      `${sql} WHERE user_id = $1 RETURNING revoked_at IS NOT NULL AS revoked, is_active`, [ID.nhanVien]))).rows;
    expect(await doc('UPDATE public.push_subscriptions SET is_active = false, revoked_at = now()')).toEqual([{ revoked: true, is_active: false }]);
    expect(await doc("UPDATE public.push_subscriptions SET endpoint = endpoint || '-x'")).toEqual([{ revoked: true, is_active: false }]);
    expect(await doc('UPDATE public.push_subscriptions SET is_active = true')).toEqual([{ revoked: false, is_active: true }]);
  });
});
