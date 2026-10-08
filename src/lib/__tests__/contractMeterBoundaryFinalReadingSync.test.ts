import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Mốc trả phòng lấy từ chỉ số chốt khi quyết toán (20261008025958). Áp hai migration gốc, dựng hồ sơ
// cũ, rồi áp migration mới hai lần: lần đầu đổ lại, lần sau không đổi gì.
const BASE = ['supabase/migrations/20260928023413_contract_meter_boundaries.sql', 'supabase/migrations/20260928035400_contract_meter_followups.sql'];
const SYNC = 'supabase/migrations/20261008025958_contract_meter_boundary_final_reading_sync.sql';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const org = id(1), actor = id(2), settler = id(3), building = id(4);
// Mỗi tình huống một phòng + một đồng hồ + một hợp đồng đã trả phòng.
const scene = (n: number) => ({ room: id(100 + n), meter: id(200 + n), contract: id(300 + n), exit: id(400 + n) });
const backfilled = scene(1), forfeit = scene(2), pending = scene(3);
const db = new PGlite();

type Row = Record<string, unknown>;
const asActor = (user: string | null) => db.query("SELECT set_config('request.jwt.claims',$1,false)", [user ? JSON.stringify({ sub: user, role: 'authenticated' }) : '']);
async function seedScene(s: ReturnType<typeof scene>, endDate: string) {
  await db.exec(`INSERT INTO rooms VALUES('${s.room}','${org}','${building}','AVAILABLE','P${s.room.slice(-3)}',NULL);
    INSERT INTO meters VALUES('${s.meter}','${org}','${s.room}','${building}','ACTIVE',NULL,'E${s.meter.slice(-3)}','ELECTRICITY');
    INSERT INTO contracts(id,organization_id,room_id,status,deleted_at,start_date,actual_end_date,contract_number)
      VALUES('${s.contract}','${org}','${s.room}','TERMINATED',NULL,'2026-01-01','${endDate}','HD-${s.contract.slice(-3)}');`);
}
async function finalReading(s: ReturnType<typeof scene>, date: string, reading: number, extra: Partial<Record<'contract' | 'status' | 'deleted_at', string | null>> = {}) {
  await db.query(`INSERT INTO meter_readings(meter_id,contract_id,organization_id,room_id,building_id,reading_code,reading_date,current_reading,status,deleted_at)
    VALUES($1,$2,$3,$4,$5,'TLY-TEST',$6,$7,$8,$9)`, [s.meter, extra.contract ?? s.contract, org, s.room, building, date, reading, extra.status ?? 'APPROVED', extra.deleted_at ?? null]);
}
async function record(s: ReturnType<typeof scene>, date: string, payload: unknown = { state: 'MISSING', reason: 'Chưa đủ chỉ số khi nhận bàn giao, bổ sung sau', readings: [] }) {
  return (await db.query<{ r: Row }>('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) r', [org, s.contract, s.room, 'MOVE_OUT', date, JSON.stringify(payload)])).rows[0].r;
}
const read = async (s: ReturnType<typeof scene>, kind = 'MOVE_OUT') =>
  (await db.query<{ r: Row }>('SELECT read_contract_meter_boundary_set_v1($1,$2,$3) r', [org, s.contract, kind])).rows[0].r;
const followups = async () => (await db.query<{ v: { total: number; items: Row[] } }>('SELECT public.list_contract_meter_followups_v1($1) v', [org])).rows[0].v;
async function revise(set: Row, key: string, reading: number, meter: string, reason = 'Bổ sung số đồng hồ') {
  const payload = { state: 'VERIFIED', reason: null, readings: [{ meter_id: meter, reading, measured_at: '2026-10-01T10:00:00+07:00', evidence: null }] };
  return (await db.query<{ r: Row }>('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) r', [org, set.id, set.revision, key, reason, JSON.stringify(payload)])).rows[0].r;
}
async function tx(fn: () => Promise<void>) { await db.exec('BEGIN'); try { await fn(); } finally { await db.exec('ROLLBACK'); } }

beforeAll(async () => {
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}'),('${settler}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
      (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);INSERT INTO buildings VALUES('${building}','${org}','B1',NULL);
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
  // Hồ sơ trước migration: đã quyết toán có chỉ số chốt; bỏ cọc không chốt; còn chờ quyết toán.
  await asActor(actor);
  for (const [s, kind, state] of [[backfilled, 'EARLY_RETURN', 'FINALIZED'], [forfeit, 'FORFEIT', 'FINALIZED'], [pending, 'NATURAL_EXPIRY', 'PENDING']] as const) {
    await seedScene(s, '2026-09-28');
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, state, kind, state === 'FINALIZED' ? settler : null]);
    await record(s, '2026-09-28');
  }
  await finalReading(backfilled, '2026-09-28', 1883);
  // Migration chạy không có phiên đăng nhập; lane kiểm idempotency bằng hai lượt áp.
  await asActor(null);
  await db.exec(readFileSync(SYNC, 'utf8'));
  await db.exec(readFileSync(SYNC, 'utf8'));
  await asActor(actor);
}, 30_000);
afterAll(() => db.close());

describe('đổ lại mốc trả phòng khi áp migration', () => {
  it('hồ sơ đã quyết toán có chỉ số chốt thành VERIFIED đúng số, người ghi là người quyết toán, áp lại không đổi', async () => {
    const set = await read(backfilled);
    expect(set).toMatchObject({ state: 'VERIFIED', revision: 2, reason: null, readings: [{ meter_id: backfilled.meter, reading: 1883, state: 'VERIFIED' }] });
    expect(set.history).toMatchObject([{ revision: 2, reason: 'Lấy từ chỉ số chốt khi quyết toán', changed_by: settler }]);
    const measured = new Date((set.readings as { measured_at: string }[])[0].measured_at).getTime();
    expect(measured).toBeLessThanOrEqual(new Date('2026-09-28T23:59:59+07:00').getTime());
  });
  it('bỏ cọc không có chỉ số chốt và hồ sơ còn chờ quyết toán giữ nguyên MISSING', async () => {
    expect(await read(forfeit)).toMatchObject({ state: 'MISSING', revision: 1 });
    expect(await read(pending)).toMatchObject({ state: 'MISSING', revision: 1 });
  });
  it('khung chờ không còn hồ sơ nào: bỏ cọc và chờ quyết toán không vào khung', async () => {
    expect(await followups()).toMatchObject({ total: 0, items: [] });
  });
});

describe('đồng bộ khi quyết toán', () => {
  it('quyết toán ngay: chỉ số chốt ghi trước mốc trong cùng giao dịch ⇒ mốc tạo ra đã VERIFIED', () => tx(async () => {
    const s = scene(10);
    await seedScene(s, '2026-10-01');
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, 'FINALIZED', 'EARLY_RETURN', actor]);
    await finalReading(s, '2026-10-01', 5050);
    const set = await record(s, '2026-10-01');
    expect(set).toMatchObject({ state: 'VERIFIED', revision: 2, readings: [{ reading: 5050, state: 'VERIFIED' }] });
    expect(set.history).toMatchObject([{ reason: 'Lấy từ chỉ số chốt khi quyết toán', changed_by: actor }]);
  }));
  it('quyết toán sau: hồ sơ chuyển FINALIZED thì mốc tự lấy chỉ số chốt', () => tx(async () => {
    const s = scene(11);
    await seedScene(s, '2026-10-01');
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, 'PENDING', 'NATURAL_EXPIRY', null]);
    expect(await record(s, '2026-10-01')).toMatchObject({ state: 'MISSING', revision: 1 });
    await finalReading(s, '2026-10-01', 7784);
    await db.query("UPDATE contract_exit_cases SET state='FINALIZED',settlement_actor=$2 WHERE id=$1", [s.exit, actor]);
    expect(await read(s)).toMatchObject({ state: 'VERIFIED', revision: 2, readings: [{ reading: 7784 }] });
  }));
  it('không lấy chỉ số của hợp đồng khác, ngày khác, đã xoá hay chưa duyệt', () => tx(async () => {
    const s = scene(12);
    await seedScene(s, '2026-10-01');
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, 'FINALIZED', 'EARLY_RETURN', actor]);
    await finalReading(s, '2026-10-01', 10, { contract: id(999) });
    await finalReading(s, '2026-10-31', 20);
    await finalReading(s, '2026-10-01', 30, { deleted_at: '2026-10-02T00:00:00Z' });
    await finalReading(s, '2026-10-01', 40, { status: 'PENDING' });
    expect(await record(s, '2026-10-01')).toMatchObject({ state: 'MISSING', revision: 1 });
  }));
  it('phòng hai đồng hồ mà chỉ một có số chốt thì không tự điền', () => tx(async () => {
    const s = scene(13);
    await seedScene(s, '2026-10-01');
    await db.exec(`INSERT INTO meters VALUES('${id(713)}','${org}','${s.room}','${building}','ACTIVE',NULL,'W1','WATER')`);
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, 'FINALIZED', 'EARLY_RETURN', actor]);
    await finalReading(s, '2026-10-01', 50);
    expect(await record(s, '2026-10-01')).toMatchObject({ state: 'MISSING', revision: 1 });
    expect(await followups()).toMatchObject({ total: 1, items: [{ contract_id: s.contract, state: 'MISSING', exit_state: 'FINALIZED', exit_kind: 'EARLY_RETURN' }] });
  }));
  it('không có phiên đăng nhập thì không ghi gì', () => tx(async () => {
    const s = scene(14);
    await seedScene(s, '2026-10-01');
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, 'PENDING', 'EARLY_RETURN', null]);
    const set = await record(s, '2026-10-01');
    await finalReading(s, '2026-10-01', 60);
    await asActor(null);
    try {
      expect((await db.query<{ ok: boolean }>('SELECT app_private.sync_move_out_boundary_from_final_reading_v1($1) ok', [set.id])).rows[0].ok).toBe(false);
    } finally { await asActor(actor); }
    expect(await read(s)).toMatchObject({ state: 'MISSING', revision: 1 });
  }));
});

describe('sửa mốc trả phòng: REVIEW chỉ khi lệch số đã tính tiền, có đường ra', () => {
  it('bổ sung đúng số chốt sau quyết toán không thành REVIEW; khác số thì REVIEW; xác nhận lại hoặc sửa về số chốt thì VERIFIED', () => tx(async () => {
    const s = scene(20);
    await seedScene(s, '2026-10-01');
    await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, 'FINALIZED', 'EARLY_RETURN', actor]);
    await db.query("INSERT INTO invoices VALUES($1,$2,$3,'2026-10','PAID',now(),NULL)", [id(520), org, s.contract]);
    const missing = await record(s, '2026-10-01');
    expect(missing).toMatchObject({ state: 'MISSING' });
    // Chưa có số chốt nào lên hoá đơn ⇒ bổ sung không lệch tiền.
    const supplied = await revise(missing, 'meter-fix-key-0001', 100, s.meter);
    expect(supplied).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
    await finalReading(s, '2026-10-01', 100);
    const same = await revise(supplied, 'meter-fix-key-0002', 100, s.meter, 'Ghi lại đúng số');
    expect(same).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
    const differs = await revise(same, 'meter-fix-key-0003', 110, s.meter, 'Đọc lại đồng hồ');
    expect(differs).toMatchObject({ state: 'REVIEW', affected_invoice_ids: [id(520)], readings: [{ reading: 110, state: 'REVIEW' }] });
    expect((await followups()).items).toMatchObject([{ contract_id: s.contract, state: 'REVIEW' }]);
    const acknowledged = await revise(differs, 'meter-fix-key-0004', 110, s.meter, 'Đã đối soát hoá đơn quyết toán');
    expect(acknowledged).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [], reason: null });
    const again = await revise(acknowledged, 'meter-fix-key-0005', 120, s.meter, 'Đọc lại lần nữa');
    expect(again).toMatchObject({ state: 'REVIEW' });
    expect(await revise(again, 'meter-fix-key-0006', 100, s.meter, 'Trả về số đã tính tiền')).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
    expect(await followups()).toMatchObject({ total: 0 });
  }));
  it('mốc nhận phòng giữ luật cũ (có hoá đơn thì REVIEW) nhưng xác nhận lại đúng số thì VERIFIED', () => tx(async () => {
    const s = scene(21);
    await db.exec(`INSERT INTO rooms VALUES('${s.room}','${org}','${building}','AVAILABLE','P021',NULL);
      INSERT INTO meters VALUES('${s.meter}','${org}','${s.room}','${building}','ACTIVE',NULL,'E021','ELECTRICITY');
      INSERT INTO contracts(id,organization_id,room_id,status,start_date) VALUES('${s.contract}','${org}','${s.room}','ACTIVE','2026-10-01');
      INSERT INTO invoices VALUES('${id(521)}','${org}','${s.contract}','2026-10','APPROVED',now(),NULL);`);
    const payload = { state: 'VERIFIED', reason: null, readings: [{ meter_id: s.meter, reading: 0, measured_at: '2026-10-01T09:00:00+07:00', evidence: null }] };
    const start = (await db.query<{ r: Row }>('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) r', [org, s.contract, s.room, 'MOVE_IN', '2026-10-01', JSON.stringify(payload)])).rows[0].r;
    const review = await revise(start, 'meter-in-key-0001', 5, s.meter);
    expect(review).toMatchObject({ state: 'REVIEW', affected_invoice_ids: [id(521)] });
    expect(await revise(review, 'meter-in-key-0002', 5, s.meter, 'Đã đối soát')).toMatchObject({ state: 'VERIFIED', affected_invoice_ids: [] });
  }));
});

describe('khung chờ và quyền', () => {
  it('chỉ còn đã quyết toán chưa có số chốt (không phải bỏ cọc) và REVIEW, có trạng thái để hiển thị', () => tx(async () => {
    const done = scene(30), dropped = scene(31);
    for (const [s, kind] of [[done, 'NATURAL_EXPIRY'], [dropped, 'FORFEIT']] as const) {
      await seedScene(s, '2026-10-02');
      await db.query('INSERT INTO contract_exit_cases VALUES($1,$2,$3,$4,$5,$6)', [s.exit, org, s.contract, 'FINALIZED', kind, actor]);
      await record(s, '2026-10-02');
    }
    expect(await followups()).toMatchObject({ total: 1, items: [{ contract_id: done.contract, contract_number: 'HD-330', state: 'MISSING', exit_state: 'FINALIZED', exit_kind: 'NATURAL_EXPIRY' }] });
  }));
  it('hàm đồng bộ là nội bộ; anon không gọi được khung chờ hay sửa mốc', async () => {
    const privilege = async (role: string, fn: string) => (await db.query<{ ok: boolean }>('SELECT has_function_privilege($1,$2,$3) ok', [role, fn, 'EXECUTE'])).rows[0].ok;
    expect(await privilege('authenticated', 'app_private.sync_move_out_boundary_from_final_reading_v1(uuid)')).toBe(false);
    expect(await privilege('authenticated', 'app_private.sync_move_out_boundary_on_exit_finalized_v1()')).toBe(false);
    expect(await privilege('authenticated', 'app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text)')).toBe(false);
    expect(await privilege('anon', 'public.list_contract_meter_followups_v1(uuid,uuid[],integer,integer)')).toBe(false);
    expect(await privilege('anon', 'public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb)')).toBe(false);
    expect(await privilege('authenticated', 'public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb)')).toBe(true);
  });
});
