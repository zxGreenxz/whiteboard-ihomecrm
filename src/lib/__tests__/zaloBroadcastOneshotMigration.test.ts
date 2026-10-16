import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Gửi phòng trống MỘT LẦN (20261016101450) trên PostgreSQL thật (PGlite): bảng, RPC người dùng,
// RPC worker, bản vá begin_provider/dừng khẩn cấp. Quyền chat_zalo.* và tài khoản Zalo là cổng
// giả lập tối thiểu; hàm khung giờ/trần ngày, begin_provider và dừng khẩn cấp là thân THẬT của
// 20261011052259 (+ dòng Hermes 20261013170125) để kiểm cả bước kiểm sha trước khi thay.
const MIGRATION = 'supabase/migrations/20261016101450_zalo_broadcast_oneshot_v1.sql';
// Review fixes (P2.1 stop blocks every one-shot job, P2.2 stop state vs latest save/toggle, P3 reclaim)
// attest the room-source body of 20261016102533, so it is replayed in order too.
const FOLLOW_UPS = ['supabase/migrations/20261016102533_zalo_worker_rooms_sale_page_parity_v1.sql',
  'supabase/migrations/20261016110539_zalo_broadcast_oneshot_review_fixes_v1.sql'];
const LIVE_STOP = 'supabase/migrations/20261016140535_hermes_zalo_broadcast_review_fixes_v1.sql';
const QUEUE = readFileSync('supabase/migrations/20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql', 'utf8').replace(/\r\n/g, '\n');
const ALBUM = 'supabase/migrations/20261012012329_zalo_broadcast_album_phong.sql';
const pick = (re: RegExp) => { const m = re.exec(QUEUE); if (!m) throw new Error(`missing ${re}`); return m[0]; };

const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), OTHER_ORG = id(2), ACTOR = id(3), VIEWER = id(4), NOSEND = id(5), ACC = id(6), OTHER_ACC = id(7);
const INSTANCE = id(8), OLD_INSTANCE = id(9);
const G1 = id(11), G2 = id(12), USER_CONV = id(13), UNMARKED = id(14), FOREIGN_GROUP = id(15);
const uuids = (ids: string[]) => `{${ids.join(',')}}`;
const WHOLE_DAY = { recipients: [], antiSpam: { allowedHours: { from: '00:00', to: '23:59' }, dailyCap: 120 } };

type Shot = { id: string; status: string; mode: string; run_at: string; send_now: boolean; recipients: string[]; origin: string; attempts?: number; result: Record<string, unknown> };
type CreateResult = { ok: boolean; reused?: boolean; code?: string; reason?: string; oneshot?: Shot; nguoi_nhan_loi?: string[]; khung_gio?: { from: string; to: string }; goi_y_run_at?: string };
type Claim = { status: string; code?: string; oneshot?: Shot & { attempts: number }; config?: Record<string, unknown>; con_lai?: number };
type Enqueue = { status: string; reused?: boolean; reason?: string; job_id?: string };

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY);
    CREATE TABLE public.fixture_grants(user_id uuid,organization_id uuid,action text);
    CREATE FUNCTION public.zalo_authorized_org_ids(p_action text) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT DISTINCT organization_id FROM public.fixture_grants WHERE user_id=auth.uid() AND action=p_action $$;
    CREATE FUNCTION public.zalo_can(_action text,_org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT _org IN (SELECT public.zalo_authorized_org_ids(_action)) $$;
    CREATE FUNCTION app_private.autofill_org_strict() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.organization_id IS NULL THEN RAISE EXCEPTION 'organization_id' USING ERRCODE='23502'; END IF; RETURN NEW; END $$;
    CREATE FUNCTION app_private.zalo_assert_attachment_v1(uuid,jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
    CREATE TABLE public.zalo_accounts(id uuid PRIMARY KEY,organization_id uuid,kind text,status text);
    CREATE TABLE public.zalo_conversations(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,account_id uuid,thread_type text,
      is_sale_partner boolean NOT NULL DEFAULT false,last_message_text text,last_message_at timestamptz,last_message_dir text);
    CREATE TABLE public.zalo_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,conversation_id uuid,account_id uuid,
      direction text,msg_type text,body text,media_url text,media_meta jsonb,status text,sent_at timestamptz,created_at timestamptz DEFAULT now(),client_dedup_key text);
    CREATE TABLE public.zalo_send_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,conversation_id uuid,account_id uuid,
      message_id uuid,channel text,payload jsonb,status text,not_before timestamptz,created_at timestamptz DEFAULT now(),processing_started_at timestamptz,
      provider_started_at timestamptz,processing_instance_id uuid,attempts integer DEFAULT 0,result jsonb,processed_at timestamptz,last_error text);
    CREATE TABLE public.zalo_automations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,kind text,enabled boolean DEFAULT false,
      config jsonb DEFAULT '{}',stats jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now(),UNIQUE(organization_id,kind));
    CREATE TABLE public.zalo_automation_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,account_id uuid,conversation_id uuid,kind text,
      mode text,reason text,recipients_count integer DEFAULT 0,messages_count integer DEFAULT 0,detail jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
    CREATE TABLE public.zalo_worker_lease(id text PRIMARY KEY,instance_id uuid,heartbeat_at timestamptz);
    CREATE TABLE app_private.hermes_group_jobs(job_id uuid PRIMARY KEY);
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
    INSERT INTO public.organizations VALUES('${ORG}'),('${OTHER_ORG}');
    INSERT INTO public.fixture_grants SELECT '${ACTOR}','${ORG}',a FROM unnest(ARRAY['manage_automation','send','view']) a;
    INSERT INTO public.fixture_grants VALUES('${VIEWER}','${ORG}','view'),('${NOSEND}','${ORG}','manage_automation'),('${NOSEND}','${ORG}','view');
    INSERT INTO public.zalo_accounts VALUES('${ACC}','${ORG}','personal','connected'),('${OTHER_ACC}','${OTHER_ORG}','personal','connected');
    INSERT INTO public.zalo_conversations(id,user_id,organization_id,account_id,thread_type,is_sale_partner) VALUES
      ('${G1}','${ACTOR}','${ORG}','${ACC}','group',true),('${G2}','${ACTOR}','${ORG}','${ACC}','group',true),
      ('${USER_CONV}','${ACTOR}','${ORG}','${ACC}','user',true),('${UNMARKED}','${ACTOR}','${ORG}','${ACC}','group',false),
      ('${FOREIGN_GROUP}','${ACTOR}','${OTHER_ORG}','${OTHER_ACC}','group',true);
  `);
  // Released dependencies exactly as shipped (begin_provider gets the 20261013170125 Hermes line).
  await db.exec(pick(/CREATE OR REPLACE FUNCTION app_private\.zalo_config_int_v1[\s\S]*?END \$\$;/));
  await db.exec(pick(/CREATE OR REPLACE FUNCTION app_private\.zalo_in_allowed_hours_v1[\s\S]*?END \$\$;/));
  await db.exec(pick(/CREATE OR REPLACE FUNCTION public\.zalo_worker_begin_provider_v1[\s\S]*?END \$\$;/).replace(
    'BEGIN\n  PERFORM 1 FROM public.zalo_worker_lease',
    'BEGIN\n  IF EXISTS(SELECT 1 FROM app_private.hermes_group_jobs WHERE job_id=p_job_id) THEN RETURN false; END IF;\n  PERFORM 1 FROM public.zalo_worker_lease'));
  await db.exec(pick(/CREATE OR REPLACE FUNCTION public\.zalo_dung_khan_cap[\s\S]*?END \$\$;/));
  await db.exec(readFileSync(ALBUM, 'utf8'));
  const migration = readFileSync(MIGRATION, 'utf8');
  await db.exec(migration);
  await db.exec(migration); // forward lane replays every file twice
  for (const file of FOLLOW_UPS) { const sql = readFileSync(file, 'utf8'); await db.exec(sql); await db.exec(sql); }
  // Live emergency-stop body (stop mark taken after the company lock). The rest of
  // that file is Hermes-only and is covered by infra/hermes-broker/zalo-broadcast-sql.test.mjs.
  const live = readFileSync(LIVE_STOP, 'utf8').replace(/\r\n/g, '\n').match(/CREATE OR REPLACE FUNCTION public\.zalo_dung_khan_cap[\s\S]*?END \$fn\$;/);
  if (!live) throw new Error('missing live public.zalo_dung_khan_cap');
  await db.exec(live[0]); await db.exec(live[0]);
}, 60_000);
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.zalo_automation_oneshots; DELETE FROM public.zalo_send_queue; DELETE FROM public.zalo_messages;
    DELETE FROM public.zalo_automation_runs; DELETE FROM public.zalo_automations; DELETE FROM app_private.hermes_group_jobs;
    UPDATE public.zalo_conversations SET is_sale_partner=(id<>'${UNMARKED}');
    UPDATE public.zalo_accounts SET status='connected';
    INSERT INTO public.zalo_automations(organization_id,kind,enabled,config) VALUES('${ORG}','broadcast_vacant',false,'${JSON.stringify(WHOLE_DAY)}');
    DELETE FROM public.zalo_worker_lease; INSERT INTO public.zalo_worker_lease VALUES('singleton','${INSTANCE}',clock_timestamp());
  `);
});

async function as<T>(user: string | null, role: string, sql: string, params: unknown[] = []): Promise<T> {
  await db.exec('BEGIN');
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [user ? JSON.stringify({ sub: user, role }) : '']);
    await db.exec(`SET LOCAL ROLE ${role}`);
    const value = (await db.query<{ v: T }>(sql, params)).rows[0].v;
    await db.exec('COMMIT');
    return value;
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
}
const create = (args: { recipients?: string[]; mode?: string | null; runAt?: string | null; requestId?: string; origin?: string; org?: string | null } = {}, user = ACTOR) =>
  as<CreateResult>(user, 'authenticated', `SELECT public.zalo_hen_gui_phong_trong_v1(p_recipients=>$1::uuid[],p_mode=>COALESCE($2,'full'),
    p_run_at=>$3::timestamptz,p_request_id=>$4,p_origin=>$5,p_organization_id=>$6::uuid) v`,
  [uuids(args.recipients ?? [G1, G2]), args.mode ?? null, args.runAt ?? null, args.requestId ?? 'req-1', args.origin ?? 'hermes', args.org === undefined ? ORG : args.org]);
const createDefaultMode = (user = ACTOR) =>
  as<CreateResult>(user, 'authenticated', `SELECT public.zalo_hen_gui_phong_trong_v1(p_recipients=>$1::uuid[],p_request_id=>'req-default',p_organization_id=>$2::uuid) v`, [uuids([G1]), ORG]);
const claim = (instance = INSTANCE) => as<Claim>(null, 'service_role', 'SELECT public.zalo_worker_claim_oneshot_v1($1::uuid,$2::uuid[]) v', [instance, uuids([ORG])]);
const enqueue = (shot: string, conv: string, logical = 'link', instance = INSTANCE) =>
  as<Enqueue>(null, 'service_role', 'SELECT public.zalo_enqueue_broadcast_oneshot_v1($1,$2,$3,$4,clock_timestamp(),$5,NULL) v',
    [shot, instance, conv, `Phòng trống ${logical}`, `oneshot:${shot}:${conv}:${logical}`]);
const finish = (shot: string, ok: boolean, instance = INSTANCE) =>
  as<{ ok: boolean; reason?: string; status?: string }>(null, 'service_role', 'SELECT public.zalo_worker_finish_oneshot_v1($1,$2,$3,$4::jsonb) v',
    [shot, instance, ok, JSON.stringify({ so_tin: 2 })]);
const stop = () => as<{ da_huy: number; hen_gio_huy: number; con_dang_gui: number }>(ACTOR, 'authenticated', 'SELECT public.zalo_dung_khan_cap($1) v', [ORG]);
async function beginProvider(jobId: string): Promise<boolean> {
  await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$2 WHERE id=$1", [jobId, INSTANCE]);
  return as<boolean>(null, 'service_role', 'SELECT public.zalo_worker_begin_provider_v1($1,$2) v', [jobId, INSTANCE]);
}
const scalar = async <T,>(sql: string, params: unknown[] = []) => (await db.query<{ v: T }>(sql, params)).rows[0].v;
const setConfig = (config: unknown, enabled = false) =>
  db.query("UPDATE public.zalo_automations SET config=$1::jsonb,enabled=$2 WHERE organization_id=$3 AND kind='broadcast_vacant'", [JSON.stringify(config), enabled, ORG]);
/** A window that excludes the current Vietnam minute (handles the overnight form too). */
async function windowExcludingNow() {
  const minute = await scalar<number>("SELECT (extract(hour FROM clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')*60+extract(minute FROM clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int v");
  const hhmm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;
  return { from: hhmm(minute + 120), to: hhmm(minute + 130) };
}
async function claimed(recipients = [G1, G2], requestId = 'req-1') {
  const made = await create({ recipients, requestId });
  expect(made.ok).toBe(true);
  const c = await claim();
  expect(c.status).toBe('claimed');
  return c.oneshot!.id;
}

describe('zalo broadcast one-shot — tạo lượt', () => {
  it('gửi ngay được khi lịch định kỳ TẮT, mặc định ĐẦY ĐỦ, không cần nằm trong config.recipients', async () => {
    const made = await createDefaultMode();
    expect(made).toMatchObject({ ok: true, reused: false, oneshot: { status: 'queued', mode: 'full', send_now: true, origin: 'ui', recipients: [G1] } });
    const c = await claim();
    expect(c).toMatchObject({ status: 'claimed', con_lai: 120, oneshot: { id: made.oneshot!.id, status: 'running', attempts: 1 } });
    const queued = await enqueue(made.oneshot!.id, G1);
    expect(queued).toMatchObject({ status: 'queued', reused: false });
    const job = await scalar<{ tu_dong: boolean; oneshot_id: string }>('SELECT payload v FROM public.zalo_send_queue WHERE id=$1', [queued.job_id]);
    expect(job).toMatchObject({ tu_dong: true, oneshot_id: made.oneshot!.id });
    expect(await beginProvider(queued.job_id!)).toBe(true);
    // Scheduled path is unchanged: still refused while the switch is off.
    const legacy = await as<Enqueue>(null, 'service_role', "SELECT public.zalo_enqueue_broadcast_v1($1,'x',clock_timestamp(),'scheduled:x',NULL) v", [G1]);
    expect(legacy).toMatchObject({ status: 'skipped', reason: 'Lịch gửi đang tắt' });
  });

  it('từ chối ngoài khung giờ kèm khung và gợi ý giờ hẹn; hẹn đúng gợi ý thì nhận', async () => {
    const window = await windowExcludingNow();
    await setConfig({ antiSpam: { allowedHours: window } });
    const rejected = await create();
    expect(rejected).toMatchObject({ ok: false, code: 'ngoai_khung_gio', khung_gio: window });
    expect(Date.parse(rejected.goi_y_run_at!)).toBeGreaterThan(Date.now());
    expect(await scalar<number>('SELECT count(*)::int v FROM public.zalo_automation_oneshots')).toBe(0);
    const later = await create({ runAt: rejected.goi_y_run_at!, requestId: 'req-later' });
    expect(later).toMatchObject({ ok: true, oneshot: { status: 'queued', send_now: false } });
    expect((await claim()).status).toBe('none'); // not due yet
  });

  it('xếp hàng lúc chạy vẫn chặn ngoài khung giờ (cả begin_provider)', async () => {
    const shot = await claimed();
    const first = await enqueue(shot, G1);
    expect(first.status).toBe('queued');
    await setConfig({ antiSpam: { allowedHours: await windowExcludingNow() } });
    expect(await enqueue(shot, G2)).toMatchObject({ status: 'skipped', reason: 'Ngoài khung giờ được phép' });
    expect(await beginProvider(first.job_id!)).toBe(false);
  });

  it('tính vào trần ngày: hết trần thì từ chối tạo, chạm trần giữa lượt thì dừng xếp', async () => {
    await db.exec(`INSERT INTO public.zalo_send_queue(organization_id,conversation_id,account_id,payload,status) VALUES
      ('${ORG}','${G1}','${ACC}','{"tu_dong":true}','sent'),('${ORG}','${G1}','${ACC}','{"tu_dong":true}','sent'),
      ('${ORG}','${G1}','${ACC}','{"tu_dong":true,"auto_reply":true}','sent')`);
    await setConfig({ ...WHOLE_DAY, antiSpam: { ...WHOLE_DAY.antiSpam, dailyCap: 2 } });
    expect(await create()).toMatchObject({ ok: false, code: 'het_tran_ngay', tran_ngay: 2, da_xep: 2 });
    await setConfig({ ...WHOLE_DAY, antiSpam: { ...WHOLE_DAY.antiSpam, dailyCap: 3 } });
    const shot = (await create({ requestId: 'req-cap' })).oneshot!.id;
    expect(await claim()).toMatchObject({ status: 'claimed', con_lai: 1 });
    expect((await enqueue(shot, G1)).status).toBe('queued');
    expect(await enqueue(shot, G2)).toMatchObject({ status: 'skipped', reason: 'Đã chạm trần gửi phòng trống trong ngày' });
  });

  it('chỉ nhận NHÓM đã đánh dấu sale của đúng công ty; một người nhận sai làm hỏng cả yêu cầu', async () => {
    for (const bad of [USER_CONV, UNMARKED, FOREIGN_GROUP, id(99)]) {
      const r = await create({ recipients: [G1, bad], requestId: `req-${bad}` });
      expect(r).toMatchObject({ ok: false, code: 'nguoi_nhan_khong_hop_le', nguoi_nhan_loi: [bad] });
    }
    expect(await scalar<number>('SELECT count(*)::int v FROM public.zalo_automation_oneshots')).toBe(0);
    const shot = await claimed([G1]);
    expect(await enqueue(shot, G2)).toMatchObject({ status: 'skipped', reason: 'Hội thoại không nằm trong danh sách của lượt gửi' });
    const ok = await enqueue(shot, G1);
    await db.query('UPDATE public.zalo_conversations SET is_sale_partner=false WHERE id=$1', [G1]);
    expect(await enqueue(shot, G1, 'table_image')).toMatchObject({ status: 'skipped', reason: 'Hội thoại không còn là nhóm sale' });
    expect(await beginProvider(ok.job_id!)).toBe(false);
  });

  it('trùng request_id: cùng nội dung trả lại lượt cũ, khác nội dung báo xung đột 23505', async () => {
    const first = await create();
    const again = await create();
    expect(again).toMatchObject({ ok: true, reused: true, oneshot: { id: first.oneshot!.id } });
    await expect(create({ mode: 'compact' })).rejects.toMatchObject({ code: '23505' });
    expect(await scalar<number>('SELECT count(*)::int v FROM public.zalo_automation_oneshots')).toBe(1);
  });

  it('kiểm quyền: cần manage_automation VÀ send; anon/authenticated không gọi được RPC worker', async () => {
    await expect(create({}, VIEWER)).rejects.toMatchObject({ code: '42501' });
    await expect(create({}, NOSEND)).rejects.toMatchObject({ code: '42501' });
    await expect(create({ org: OTHER_ORG })).rejects.toMatchObject({ code: '42501' });
    await expect(as(null, 'anon', "SELECT public.zalo_hen_gui_phong_trong_v1('{}'::uuid[]) v")).rejects.toMatchObject({ code: '42501' });
    await expect(as(ACTOR, 'authenticated', 'SELECT public.zalo_worker_claim_oneshot_v1($1,NULL) v', [INSTANCE])).rejects.toMatchObject({ code: '42501' });
    await expect(as(ACTOR, 'authenticated', 'SELECT count(*) v FROM public.zalo_automation_oneshots')).rejects.toMatchObject({ code: '42501' });
    const shot = (await create()).oneshot!.id;
    const list = await as<{ items: Shot[]; dang_dung_khan_cap: boolean }>(VIEWER, 'authenticated', 'SELECT public.zalo_ds_hen_gui_phong_trong_v1($1) v', [ORG]);
    expect(list).toMatchObject({ dang_dung_khan_cap: false, items: [{ id: shot }] });
    await expect(as(VIEWER, 'authenticated', 'SELECT public.zalo_huy_hen_gui_phong_trong_v1($1) v', [shot])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('zalo broadcast one-shot — worker và dừng khẩn cấp', () => {
  it('chiếm một lần; lease mất thì không chiếm; lượt của instance chết được chiếm lại với cùng khoá, instance cũ bị chặn', async () => {
    const shot = await claimed();
    expect((await claim()).status).toBe('none');
    const first = await enqueue(shot, G1);
    await db.query("UPDATE public.zalo_worker_lease SET instance_id=$1", [OLD_INSTANCE]);
    expect((await claim()).status).toBe('lease_lost');
    await db.query("UPDATE public.zalo_worker_lease SET instance_id=$1,heartbeat_at=clock_timestamp()", [INSTANCE]);
    await db.query("UPDATE public.zalo_automation_oneshots SET claimed_by_instance=$1 WHERE id=$2", [OLD_INSTANCE, shot]);
    expect(await claim()).toMatchObject({ status: 'claimed', oneshot: { id: shot, attempts: 2 } });
    expect(await enqueue(shot, G2, 'link', OLD_INSTANCE)).toMatchObject({ status: 'skipped', reason: 'Lượt gửi đã bị huỷ hoặc không còn do worker này giữ' });
    expect(await enqueue(shot, G1)).toMatchObject({ status: 'queued', reused: true, job_id: first.job_id });
    expect(await scalar<number>('SELECT count(*)::int v FROM public.zalo_send_queue')).toBe(1);
    expect(await finish(shot, true, OLD_INSTANCE)).toMatchObject({ ok: false, reason: 'lease_lost' });
    expect(await finish(shot, true)).toMatchObject({ ok: true, status: 'done' });
    expect(await scalar<string>('SELECT status v FROM public.zalo_automation_oneshots WHERE id=$1', [shot])).toBe('done');
    await expect(enqueue(id(98), G1)).resolves.toMatchObject({ status: 'skipped' });
  });

  it('quá 180 phút sau giờ hẹn thì không gửi bù', async () => {
    const shot = (await create()).oneshot!.id;
    await db.query("UPDATE public.zalo_automation_oneshots SET run_at=clock_timestamp()-interval '4 hours' WHERE id=$1", [shot]);
    expect(await claim()).toMatchObject({ status: 'expired', code: 'qua_han' });
    expect(await scalar<string>('SELECT status v FROM public.zalo_automation_oneshots WHERE id=$1', [shot])).toBe('failed');
    expect((await claim()).status).toBe('none');
  });

  it('huỷ chỉ áp lượt chưa chạy', async () => {
    const queued = (await create({ requestId: 'req-q', runAt: new Date(Date.now() + 3_600_000).toISOString() })).oneshot!.id;
    const cancel = (shot: string) => as<{ ok: boolean; code?: string; reused?: boolean; oneshot: Shot }>(ACTOR, 'authenticated', 'SELECT public.zalo_huy_hen_gui_phong_trong_v1($1) v', [shot]);
    expect(await cancel(queued)).toMatchObject({ ok: true, reused: false, oneshot: { status: 'cancelled' } });
    expect(await cancel(queued)).toMatchObject({ ok: true, reused: true });
    const running = await claimed([G1], 'req-r');
    expect(await cancel(running)).toMatchObject({ ok: false, code: 'da_chay' });
  });

  it('dừng khẩn cấp huỷ lượt chờ và lượt đang chạy, chặn tạo mới tới khi người quản lý lưu lại cấu hình', async () => {
    const future = (await create({ requestId: 'req-f', runAt: new Date(Date.now() + 3_600_000).toISOString() })).oneshot!.id;
    const running = await claimed([G1, G2], 'req-now');
    const sending = await enqueue(running, G1);
    const waiting = await enqueue(running, G2);
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$2 WHERE id=$1", [sending.job_id, INSTANCE]);
    expect(await stop()).toMatchObject({ da_huy: 1, hen_gio_huy: 2, con_dang_gui: 1 });
    expect((await db.query<{ id: string; status: string }>('SELECT id,status FROM public.zalo_automation_oneshots ORDER BY id')).rows.map(r => r.status)).toEqual(['cancelled', 'cancelled']);
    expect(await scalar<string>('SELECT status v FROM public.zalo_send_queue WHERE id=$1', [waiting.job_id])).toBe('failed');
    expect(await as<boolean>(null, 'service_role', 'SELECT public.zalo_worker_begin_provider_v1($1,$2) v', [sending.job_id, INSTANCE])).toBe(false);
    expect(await enqueue(running, G1, 'table_image')).toMatchObject({ status: 'skipped' });
    expect(await finish(running, true)).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(await scalar<string>('SELECT status v FROM public.zalo_automation_oneshots WHERE id=$1', [running])).toBe('cancelled');
    expect(future).toBeTruthy();
    expect(await create({ requestId: 'req-after' })).toMatchObject({ ok: false, code: 'dang_dung_khan_cap' });
    const listed = await as<{ dang_dung_khan_cap: boolean }>(ACTOR, 'authenticated', 'SELECT public.zalo_ds_hen_gui_phong_trong_v1($1) v', [ORG]);
    expect(listed.dang_dung_khan_cap).toBe(true);
    // zalo_luu_tu_dong_hoa (lưu cấu hình) là hành động gỡ dừng của người quản lý.
    await db.query("UPDATE public.zalo_automations SET updated_at=clock_timestamp() WHERE organization_id=$1 AND kind='broadcast_vacant'", [ORG]);
    expect(await create({ requestId: 'req-resumed' })).toMatchObject({ ok: true });
  });

  it('job định kỳ (không oneshot) giữ nguyên điều kiện cũ ở begin_provider', async () => {
    await setConfig({ ...WHOLE_DAY, recipients: [G1] }, true);
    const job = (await as<Enqueue>(null, 'service_role', "SELECT public.zalo_enqueue_broadcast_v1($1,'x',clock_timestamp(),'scheduled:a',NULL) v", [G1])).job_id!;
    expect(await beginProvider(job)).toBe(true);
    const second = (await as<Enqueue>(null, 'service_role', "SELECT public.zalo_enqueue_broadcast_v1($1,'y',clock_timestamp(),'scheduled:b',NULL) v", [G1])).job_id!;
    await setConfig({ ...WHOLE_DAY, recipients: [G2] }, true);
    expect(await beginProvider(second)).toBe(false); // removed from the schedule's list
    await setConfig({ ...WHOLE_DAY, recipients: [G1] }, false);
    expect(await beginProvider(second)).toBe(false);
    await db.query('INSERT INTO app_private.hermes_group_jobs VALUES($1)', [second]);
    await setConfig({ ...WHOLE_DAY, recipients: [G1] }, true);
    expect(await beginProvider(second)).toBe(false);
  });
});

describe('zalo broadcast one-shot — sửa sau review', () => {
  const saveConfig = (kind = 'broadcast_vacant') =>
    db.query('UPDATE public.zalo_automations SET updated_at=clock_timestamp() WHERE organization_id=$1 AND kind=$2', [ORG, kind]);

  it('P2.1: dừng khẩn cấp chặn job của lượt đã done (processing lúc bấm dừng, hoặc được recover xếp lại), kể cả sau khi gỡ dừng', async () => {
    const shot = await claimed([G1, G2], 'req-done');
    const sending = await enqueue(shot, G1);
    const waiting = await enqueue(shot, G2);
    expect(await finish(shot, true)).toMatchObject({ ok: true, status: 'done' });
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$2 WHERE id=$1", [sending.job_id, INSTANCE]);
    expect(await stop()).toMatchObject({ da_huy: 1, hen_gio_huy: 0, con_dang_gui: 1 });
    expect(await scalar<string>('SELECT status v FROM public.zalo_automation_oneshots WHERE id=$1', [shot])).toBe('done');
    expect(await as<boolean>(null, 'service_role', 'SELECT public.zalo_worker_begin_provider_v1($1,$2) v', [sending.job_id, INSTANCE])).toBe(false);
    // recover_jobs puts an un-started job back to queued; it must still never reach the provider.
    await db.query("UPDATE public.zalo_send_queue SET status='queued',processing_instance_id=NULL WHERE id=ANY($1::uuid[])", [uuids([sending.job_id!, waiting.job_id!])]);
    expect(await beginProvider(sending.job_id!)).toBe(false);
    expect(await beginProvider(waiting.job_id!)).toBe(false);
    await saveConfig();
    expect(await beginProvider(sending.job_id!)).toBe(false); // created before the stop: never sends
    const fresh = await claimed([G1], 'req-after-lift');
    const job = await enqueue(fresh, G1);
    expect(await beginProvider(job.job_id!)).toBe(true);
  });

  it('P2.2: chỉ chặn khi lần dừng mới hơn lần lưu/bật lại gần nhất của bất kỳ dòng tự động hoá nào', async () => {
    await db.exec(`INSERT INTO public.zalo_automations(organization_id,kind,enabled) VALUES('${ORG}','auto_reply',false)`);
    await stop();
    expect(await create({ requestId: 'req-blocked' })).toMatchObject({ ok: false, code: 'dang_dung_khan_cap' });
    await saveConfig('auto_reply'); // zalo_toggle_automation/zalo_luu_tu_dong_hoa on either row stamps updated_at
    expect(await create({ requestId: 'req-lifted' })).toMatchObject({ ok: true });
    // An OLD stop never blocks once any later save exists.
    await db.query("UPDATE public.zalo_automation_runs SET created_at=created_at-interval '1 day' WHERE mode='stopped'");
    await db.query("UPDATE public.zalo_automations SET updated_at=clock_timestamp()-interval '1 hour' WHERE organization_id=$1", [ORG]);
    expect(await create({ requestId: 'req-old-stop' })).toMatchObject({ ok: true });
    // No automation row at all: a stop stays until someone saves settings.
    await db.query('DELETE FROM public.zalo_automations WHERE organization_id=$1', [ORG]);
    await db.query("UPDATE public.zalo_automation_runs SET created_at=clock_timestamp() WHERE mode='stopped'");
    expect(await create({ requestId: 'req-no-row' })).toMatchObject({ ok: false, code: 'dang_dung_khan_cap' });
  });

  it('P3a: lượt running của chính instance được chiếm lại sau 10 phút, không sớm hơn', async () => {
    const shot = await claimed([G1], 'req-stuck');
    expect((await claim()).status).toBe('none');
    await db.query("UPDATE public.zalo_automation_oneshots SET updated_at=clock_timestamp()-interval '11 minutes' WHERE id=$1", [shot]);
    expect(await claim()).toMatchObject({ status: 'claimed', oneshot: { id: shot, attempts: 2 } });
  });
});
