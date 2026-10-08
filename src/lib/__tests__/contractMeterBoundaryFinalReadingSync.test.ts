import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Mốc trả phòng lấy từ chỉ số chốt khi quyết toán (20261008025958). Áp hai migration gốc, dựng hồ sơ
// cũ, rồi áp migration mới hai lần: lần đầu đổ lại, lần sau không đổi gì.
const BASE = ['supabase/migrations/20260928023413_contract_meter_boundaries.sql', 'supabase/migrations/20260928035400_contract_meter_followups.sql'];
const SYNC = 'supabase/migrations/20261008025958_contract_meter_boundary_final_reading_sync.sql';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const org = id(1), actor = id(2), settler = id(3), building = id(4), otherBuilding = id(5);
// Mỗi tình huống một phòng + một đồng hồ + một hợp đồng đã trả phòng.
const scene = (n: number) => ({ room: id(100 + n), meter: id(200 + n), contract: id(300 + n), exit: id(400 + n) });
const backfilled = scene(1), forfeit = scene(2), pending = scene(3), monthlyOnly = scene(4);
const SYNC_REASON = 'Lấy từ chỉ số chốt khi quyết toán';
const BACKFILL_REASON = 'Lấy từ chỉ số chốt khi quyết toán (đồng bộ lại 08/10/2026)';
const db = new PGlite();

type Row = Record<string, unknown>;
type Scene = ReturnType<typeof scene>;
const asActor = (user: string | null) => db.query("SELECT set_config('request.jwt.claims',$1,false)", [user ? JSON.stringify({ sub: user, role: 'authenticated' }) : '']);
async function seedScene(s: Scene, endDate: string, at = building) {
  await db.exec(`INSERT INTO rooms VALUES('${s.room}','${org}','${at}','AVAILABLE','P${s.room.slice(-3)}',NULL);
    INSERT INTO meters VALUES('${s.meter}','${org}','${s.room}','${at}','ACTIVE',NULL,'E${s.meter.slice(-3)}','ELECTRICITY');
    INSERT INTO contracts(id,organization_id,room_id,status,deleted_at,start_date,actual_end_date,contract_number)
      VALUES('${s.contract}','${org}','${s.room}','TERMINATED',NULL,'2026-01-01','${endDate}','HD-${s.contract.slice(-3)}');`);
}
const exitCase = (s: Scene, state: 'PENDING' | 'FINALIZED', kind = 'EARLY_RETURN') =>
  db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, state, kind, state === 'FINALIZED' ? actor : null]);
/** Chỉ số APPROVED của hợp đồng; mặc định là số chốt khi quyết toán (mã TLY…). */
async function reading(s: Scene, date: string, value: number, extra: Partial<Record<'contract' | 'status' | 'deleted_at' | 'code', string | null>> = {}) {
  await db.query(`INSERT INTO meter_readings(meter_id,contract_id,organization_id,room_id,building_id,reading_code,reading_date,current_reading,status,deleted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [s.meter, extra.contract ?? s.contract, org, s.room, building, extra.code ?? 'TLY-TEST', date, value, extra.status ?? 'APPROVED', extra.deleted_at ?? null]);
}
async function record(s: Scene, date: string, payload: unknown = { state: 'MISSING', reason: 'Chưa đủ chỉ số khi nhận bàn giao, bổ sung sau', readings: [] }) {
  return (await db.query<{ r: Row }>('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) r', [org, s.contract, s.room, 'MOVE_OUT', date, JSON.stringify(payload)])).rows[0].r;
}
const read = async (s: Scene, kind = 'MOVE_OUT') =>
  (await db.query<{ r: Row }>('SELECT read_contract_meter_boundary_set_v1($1,$2,$3) r', [org, s.contract, kind])).rows[0].r;
const followups = async (orgId = org, limit = 10) => (await db.query<{ v: { total: number; items: Row[] } }>('SELECT public.list_contract_meter_followups_v1($1,NULL,$2,0) v', [orgId, limit])).rows[0].v;
async function revise(set: Row, key: string, value: number | null, meter: string, reason = 'Bổ sung số đồng hồ') {
  const payload = value === null ? { state: 'MISSING', reason: 'Không đo được', readings: [] }
    : { state: 'VERIFIED', reason: null, readings: [{ meter_id: meter, reading: value, measured_at: '2026-10-01T10:00:00+07:00', evidence: null }] };
  return (await db.query<{ r: Row }>('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) r', [org, set.id, set.revision, key, reason, JSON.stringify(payload)])).rows[0].r;
}
async function tx(fn: () => Promise<void>) { await db.exec('BEGIN'); try { await fn(); } finally { await db.exec('ROLLBACK'); } }
async function denied(fn: () => Promise<unknown>, code: string) {
  await db.exec('SAVEPOINT denied');
  try { await expect(fn()).rejects.toMatchObject({ code }); } finally { await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied'); }
}

beforeAll(async () => {
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}'),('${settler}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
      (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);
    INSERT INTO buildings VALUES('${building}','${org}','B1',NULL),('${otherBuilding}','${org}','B2 ngoài phạm vi',NULL);
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text,name text,deleted_at timestamptz);
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text,deleted_at timestamptz,start_date date,actual_end_date date,
      created_at timestamptz DEFAULT now(),contract_number text);
    CREATE TABLE meters(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,building_id uuid,status text,deleted_at timestamptz,code text,meter_type text);
    CREATE TABLE meter_readings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),meter_id uuid,contract_id uuid,organization_id uuid,room_id uuid,building_id uuid,
      reading_code text,reading_date date,current_reading numeric(10,2),status text,deleted_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,billing_month text,status text,approved_at timestamptz,deleted_at timestamptz);
    CREATE TABLE contract_exit_cases(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid UNIQUE,state text,current_kind text,settlement_actor uuid);
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${building}'::uuid $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT can_access_building($3) $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-10-08'::date $$;
    CREATE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'Asia/Ho_Chi_Minh' $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE;RETURN 1;END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
      SELECT $1=auth.uid() AND $2=ANY(my_org_ids()) AND $3 IN ('contracts.edit','contracts.create') AND can_do_on_building('contracts',split_part($3,'.',2),$4) $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[]) LANGUAGE sql AS $$ SELECT false,ARRAY['${building}'::uuid] $$;`);
  for (const file of BASE) await db.exec(readFileSync(file, 'utf8'));
  // Hồ sơ trước migration: đã quyết toán có chỉ số chốt; bỏ cọc không chốt; còn chờ quyết toán;
  // đã quyết toán nhưng chỉ có chỉ số THÁNG trùng ngày trả phòng (không phải số chốt).
  await asActor(actor);
  for (const [s, kind, state] of [[backfilled, 'EARLY_RETURN', 'FINALIZED'], [forfeit, 'FORFEIT', 'FINALIZED'], [pending, 'NATURAL_EXPIRY', 'PENDING'], [monthlyOnly, 'NATURAL_EXPIRY', 'FINALIZED']] as const) {
    await seedScene(s, '2026-09-28');
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, state, kind, state === 'FINALIZED' ? settler : null]);
    await record(s, '2026-09-28');
  }
  await reading(backfilled, '2026-09-28', 1883);
  await reading(pending, '2026-09-28', 900);
  await reading(monthlyOnly, '2026-09-28', 4321, { code: 'CSS-TEST' });
  // Migration chạy không có phiên đăng nhập; lane kiểm idempotency bằng hai lượt áp.
  await asActor(null);
  await db.exec(readFileSync(SYNC, 'utf8'));
  await db.exec(readFileSync(SYNC, 'utf8'));
  await asActor(actor);
}, 30_000);
afterAll(() => db.close());

describe('đổ lại mốc trả phòng khi áp migration', () => {
  it('hồ sơ đã quyết toán có chỉ số chốt thành VERIFIED đúng số, người ghi là người quyết toán, lý do ghi rõ đồng bộ lại', async () => {
    const set = await read(backfilled);
    expect(set).toMatchObject({ state: 'VERIFIED', revision: 2, reason: null, readings: [{ meter_id: backfilled.meter, reading: 1883, state: 'VERIFIED' }] });
    expect(set.history).toMatchObject([{ revision: 2, reason: BACKFILL_REASON, changed_by: settler }]);
    const measured = new Date((set.readings as { measured_at: string }[])[0].measured_at).getTime();
    expect(measured).toBeLessThanOrEqual(new Date('2026-09-28T23:59:59+07:00').getTime());
  });
  it('bỏ cọc không chốt, hồ sơ còn chờ quyết toán (dù có số TLY) và hồ sơ chỉ có chỉ số tháng đều giữ MISSING', async () => {
    for (const s of [forfeit, pending, monthlyOnly]) expect(await read(s)).toMatchObject({ state: 'MISSING', revision: 1 });
  });
  it('khung chờ chỉ còn hồ sơ đã quyết toán thiếu số chốt; bỏ cọc và chờ quyết toán không vào', async () => {
    expect(await followups()).toMatchObject({ total: 1, items: [{ contract_id: monthlyOnly.contract, state: 'MISSING', exit_state: 'FINALIZED', exit_kind: 'NATURAL_EXPIRY' }] });
  });
});

describe('đồng bộ khi quyết toán', () => {
  it('quyết toán ngay: chỉ số chốt ghi trước mốc trong cùng giao dịch ⇒ mốc tạo ra đã VERIFIED', () => tx(async () => {
    const s = scene(10);
    await seedScene(s, '2026-10-01');
    await exitCase(s, 'FINALIZED');
    await reading(s, '2026-10-01', 5050);
    const set = await record(s, '2026-10-01');
    expect(set).toMatchObject({ state: 'VERIFIED', revision: 2, readings: [{ reading: 5050, state: 'VERIFIED' }] });
    expect(set.history).toMatchObject([{ reason: SYNC_REASON, changed_by: actor }]);
  }));
  it('quyết toán sau: chỉ số tháng trùng ngày không khoá mốc; FINALIZED thì lấy đúng số chốt TLY', () => tx(async () => {
    const s = scene(11);
    await seedScene(s, '2026-09-30');
    await exitCase(s, 'PENDING');
    await reading(s, '2026-09-30', 1500, { code: 'CSS-TEST' });
    expect(await record(s, '2026-09-30')).toMatchObject({ state: 'MISSING', revision: 1 });
    await reading(s, '2026-09-30', 1520);
    expect((await db.query<{ ok: boolean }>('SELECT app_private.sync_move_out_boundary_from_final_reading_v1(id) ok FROM contract_meter_boundary_sets WHERE contract_id=$1', [s.contract])).rows[0].ok).toBe(false);
    await db.query("UPDATE contract_exit_cases SET state='FINALIZED',settlement_actor=$2 WHERE id=$1", [s.exit, actor]);
    expect(await read(s)).toMatchObject({ state: 'VERIFIED', revision: 2, readings: [{ reading: 1520 }] });
  }));
  it('quyết toán ngay không nhập điện, chỉ có chỉ số tháng cùng ngày ⇒ vẫn MISSING', () => tx(async () => {
    const s = scene(12);
    await seedScene(s, '2026-10-01');
    await exitCase(s, 'FINALIZED');
    await reading(s, '2026-10-01', 777, { code: 'CSS-TEST' });
    expect(await record(s, '2026-10-01')).toMatchObject({ state: 'MISSING', revision: 1 });
  }));
  it('không lấy số chốt của hợp đồng khác, ngày khác, đã xoá hay chưa duyệt', () => tx(async () => {
    const s = scene(13);
    await seedScene(s, '2026-10-01');
    await exitCase(s, 'FINALIZED');
    await reading(s, '2026-10-01', 10, { contract: id(999) });
    await reading(s, '2026-10-31', 20);
    await reading(s, '2026-10-01', 30, { deleted_at: '2026-10-02T00:00:00Z' });
    await reading(s, '2026-10-01', 40, { status: 'PENDING' });
    expect(await record(s, '2026-10-01')).toMatchObject({ state: 'MISSING', revision: 1 });
  }));
  it('phòng hai đồng hồ mà chỉ một có số chốt thì không tự điền', () => tx(async () => {
    const s = scene(14);
    await seedScene(s, '2026-10-01');
    await db.exec(`INSERT INTO meters VALUES('${id(714)}','${org}','${s.room}','${building}','ACTIVE',NULL,'W1','WATER')`);
    await exitCase(s, 'FINALIZED');
    await reading(s, '2026-10-01', 50);
    expect(await record(s, '2026-10-01')).toMatchObject({ state: 'MISSING', revision: 1 });
  }));
  it('không có phiên đăng nhập thì không ghi gì, kể cả trigger khi FINALIZED', () => tx(async () => {
    const s = scene(15);
    await seedScene(s, '2026-10-01');
    await exitCase(s, 'PENDING');
    const set = await record(s, '2026-10-01');
    await reading(s, '2026-10-01', 60);
    await asActor(null);
    try {
      await db.query("UPDATE contract_exit_cases SET state='FINALIZED',settlement_actor=$2 WHERE id=$1", [s.exit, actor]);
      expect((await db.query<{ ok: boolean }>('SELECT app_private.sync_move_out_boundary_from_final_reading_v1($1) ok', [set.id])).rows[0].ok).toBe(false);
    } finally { await asActor(actor); }
    expect(await read(s)).toMatchObject({ state: 'MISSING', revision: 1 });
  }));
  it('phòng không có đồng hồ đang chạy: không vào khung chờ; xác nhận "đã kiểm tra" rỗng thì VERIFIED, không kẹt REVIEW', () => tx(async () => {
    const s = scene(17);
    await seedScene(s, '2026-10-01');
    await db.query("UPDATE meters SET status='INACTIVE' WHERE id=$1", [s.meter]);
    await exitCase(s, 'FINALIZED');
    await db.query("INSERT INTO invoices VALUES($1,$2,$3,'2026-10','PAID',now(),NULL)", [id(517), org, s.contract]);
    const set = await record(s, '2026-10-01');
    expect(set).toMatchObject({ state: 'MISSING', readings: [] });
    expect((await followups()).items.some(i => i.contract_id === s.contract)).toBe(false);
    const verified = (await db.query<{ r: Row }>('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) r',
      [org, set.id, set.revision, 'no-meter-key-0001', 'Phòng không có đồng hồ', JSON.stringify({ state: 'VERIFIED', reason: null, readings: [] })])).rows[0].r;
    expect(verified).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
  }));
  it('khoá lịch sử của đồng bộ không chiếm được bằng revise (regex khoá của revise không nhận "~")', () => tx(async () => {
    const s = scene(16);
    await seedScene(s, '2026-10-01');
    await exitCase(s, 'FINALIZED');
    await reading(s, '2026-10-01', 66);
    const set = await record(s, '2026-10-01');
    expect(set).toMatchObject({ state: 'VERIFIED' });
    const key = (await db.query<{ k: string }>('SELECT idempotency_key k FROM app_private.contract_meter_boundary_history WHERE set_id=$1', [set.id])).rows[0].k;
    expect(key.startsWith('~')).toBe(true);
    await denied(() => revise(set, key, 66, s.meter), '22023');
  }));
});

describe('sửa mốc trả phòng: REVIEW khi chưa khớp số đã tính tiền, có đường ra', () => {
  it('chưa từng chốt số mà đã có hoá đơn ⇒ REVIEW (phần điện cuối chưa tính); đối soát xong ⇒ VERIFIED; khớp số chốt ⇒ VERIFIED; lệch ⇒ REVIEW', () => tx(async () => {
    const s = scene(20);
    await seedScene(s, '2026-10-01');
    await exitCase(s, 'FINALIZED');
    await db.query("INSERT INTO invoices VALUES($1,$2,$3,'2026-10','PAID',now(),NULL)", [id(520), org, s.contract]);
    const missing = await record(s, '2026-10-01');
    // Chỉ số tháng cùng ngày, cùng số: vẫn không phải số đã tính tiền khi quyết toán.
    await reading(s, '2026-10-01', 100, { code: 'CSS-TEST' });
    const unbilled = await revise(missing, 'meter-fix-key-0001', 100, s.meter);
    expect(unbilled).toMatchObject({ state: 'REVIEW', affected_invoice_ids: [id(520)] });
    expect((await followups()).items).toMatchObject(expect.arrayContaining([expect.objectContaining({ contract_id: s.contract, state: 'REVIEW' })]));
    const reconciled = await revise(unbilled, 'meter-fix-key-0002', 100, s.meter, 'Đã thu thêm tiền điện kỳ cuối');
    expect(reconciled).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [], reason: null });
    await reading(s, '2026-10-01', 100);
    const same = await revise(reconciled, 'meter-fix-key-0003', 100, s.meter, 'Ghi lại đúng số');
    expect(same).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
    const differs = await revise(same, 'meter-fix-key-0004', 110, s.meter, 'Đọc lại đồng hồ');
    expect(differs).toMatchObject({ state: 'REVIEW', affected_invoice_ids: [id(520)], readings: [{ reading: 110, state: 'REVIEW' }] });
    const back = await revise(differs, 'meter-fix-key-0005', 100, s.meter, 'Trả về số đã tính tiền');
    expect(back).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
    expect(await revise(back, 'meter-fix-key-0006', null, s.meter, 'Không đo được')).toMatchObject({ state: 'MISSING', affected_invoice_ids: [] });
  }));
  it('bỏ cọc chưa từng chốt số ⇒ bổ sung là VERIFIED; bỏ cọc có số chốt Thu thêm mà lệch ⇒ REVIEW và hiện ở khung chờ', () => tx(async () => {
    const noReading = scene(21), withExtra = scene(22);
    for (const s of [noReading, withExtra]) {
      await seedScene(s, '2026-10-02');
      await exitCase(s, 'FINALIZED', 'FORFEIT');
      await db.query("INSERT INTO invoices VALUES(gen_random_uuid(),$1,$2,'2026-10','PAID',now(),NULL)", [org, s.contract]);
    }
    expect(await revise(await record(noReading, '2026-10-02'), 'forfeit-key-0001', 300, noReading.meter)).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
    await reading(withExtra, '2026-10-02', 400);
    const synced = await record(withExtra, '2026-10-02');
    expect(synced).toMatchObject({ state: 'VERIFIED' });
    expect(await revise(synced, 'forfeit-key-0002', 450, withExtra.meter)).toMatchObject({ state: 'REVIEW' });
    expect((await followups()).items).toMatchObject(expect.arrayContaining([expect.objectContaining({ contract_id: withExtra.contract, state: 'REVIEW', exit_kind: 'FORFEIT' })]));
  }));
  it('mốc nhận phòng giữ luật cũ (có hoá đơn thì REVIEW) nhưng xác nhận lại đúng số thì VERIFIED', () => tx(async () => {
    const s = scene(23);
    await db.exec(`INSERT INTO rooms VALUES('${s.room}','${org}','${building}','AVAILABLE','P023',NULL);
      INSERT INTO meters VALUES('${s.meter}','${org}','${s.room}','${building}','ACTIVE',NULL,'E023','ELECTRICITY');
      INSERT INTO contracts(id,organization_id,room_id,status,start_date) VALUES('${s.contract}','${org}','${s.room}','ACTIVE','2026-10-01');
      INSERT INTO invoices VALUES('${id(523)}','${org}','${s.contract}','2026-10','APPROVED',now(),NULL);`);
    const payload = { state: 'VERIFIED', reason: null, readings: [{ meter_id: s.meter, reading: 0, measured_at: '2026-10-01T09:00:00+07:00', evidence: null }] };
    const start = (await db.query<{ r: Row }>('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) r', [org, s.contract, s.room, 'MOVE_IN', '2026-10-01', JSON.stringify(payload)])).rows[0].r;
    const review = await revise(start, 'meter-in-key-0001', 5, s.meter);
    expect(review).toMatchObject({ state: 'REVIEW', affected_invoice_ids: [id(523)] });
    expect(await revise(review, 'meter-in-key-0002', 5, s.meter, 'Đã đối soát')).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
  }));
});

describe('khung chờ và quyền trên định nghĩa mới', () => {
  it('ẩn toà ngoài phạm vi; từ chối org khác và phân trang sai', () => tx(async () => {
    const outside = scene(30);
    await seedScene(outside, '2026-10-02', otherBuilding);
    await exitCase(outside, 'FINALIZED');
    await db.query(`INSERT INTO contract_meter_boundary_sets(organization_id,building_id,room_id,contract_id,kind,effective_on,state,reason,recorded_by,initial_payload_hash)
      VALUES($1,$2,$3,$4,'MOVE_OUT','2026-10-02','MISSING','Chưa đo',$5,'x')`, [org, otherBuilding, outside.room, outside.contract, actor]);
    expect((await followups()).items.some(i => i.contract_id === outside.contract)).toBe(false);
    await denied(() => followups(id(77)), '42501');
    await denied(() => followups(org, 0), '22023');
  }));
  it('hàm đồng bộ là nội bộ; anon không gọi được khung chờ hay sửa mốc', async () => {
    const privilege = async (role: string, fn: string) => (await db.query<{ ok: boolean }>('SELECT has_function_privilege($1,$2,$3) ok', [role, fn, 'EXECUTE'])).rows[0].ok;
    expect(await privilege('authenticated', 'app_private.sync_move_out_boundary_from_final_reading_v1(uuid,text)')).toBe(false);
    expect(await privilege('authenticated', 'app_private.sync_move_out_boundary_on_exit_finalized_v1()')).toBe(false);
    expect(await privilege('authenticated', 'app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text)')).toBe(false);
    expect(await privilege('anon', 'public.list_contract_meter_followups_v1(uuid,uuid[],integer,integer)')).toBe(false);
    expect(await privilege('anon', 'public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb)')).toBe(false);
    expect(await privilege('authenticated', 'public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb)')).toBe(true);
  });
});
