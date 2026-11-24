import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Sale phòng đợt 1 (20261124171545): link chia sẻ và thống kê ghi rõ công ty.
// Lỗi gốc (đo production 25/11/2026): nick chủ thuộc hai công ty từ 03/09 ⇒ trg_autofill_org_strict không đoán được
// công ty từ owner_id ⇒ create_public_room_token ném 23502, log_public_room_events bỏ im lặng mọi sự kiện không có
// phòng/toà (phiên xem, lỗi, đổi kiểu xem). Fixture dùng NGUYÊN VĂN hàm trigger đang chạy production và thân cũ của hai
// hàm để tái hiện lỗi trước, rồi áp migration (hai lượt) và kiểm hành vi mới.
const FILE = 'supabase/migrations/20261124171545_link_chia_se_va_thong_ke_ghi_ro_cong_ty.sql';
const sql = readFileSync(FILE, 'utf8');
const oldTokenSql = readFileSync('supabase/migrations/20260607090300_create_public_room_token_rpc.sql', 'utf8');
const oldLoggerSql = readFileSync('supabase/migrations/20260902092508_public_room_events_budget_chiu_duoc_thieu_cron.sql', 'utf8');
const autofillFile = readFileSync('supabase/migrations/20261011042329_chan_null_org_va_khoa_dau_cong_ty.sql', 'utf8');
const autofillStart = autofillFile.indexOf('CREATE OR REPLACE FUNCTION app_private.autofill_org_strict()');
const autofillSql = autofillFile.slice(autofillStart, autofillFile.indexOf('$f$;', autofillStart) + 4);
// Thân hành vi: bỏ hai khối tiền kiểm / hậu kiểm md5 để kiểm đột biến thấy đúng ca hành vi đỏ (khối md5 được kiểm riêng).
const behaviourSql = sql.replace(/DO \$truoc\$[\s\S]*?\$truoc\$;/, '').replace(/DO \$sau\$[\s\S]*?\$sau\$;/, '');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [ORG_A, ORG_B, ORG_C] = [101, 102, 103].map(id);
const OWNER2 = id(1); // nick chủ: hai công ty A + B, quyền ở cả hai
const MANAGER = id(2); // quản lý: một công ty A, quyền theo toà
const NOPERM = id(3); // thành viên A, không có quyền link
const SUPER = id(4); // quản trị nền tảng, thành viên A, không có vai trò
const LEFT = id(5); // đã rời công ty C, còn ở A
const STRANGER = id(6); // không thuộc công ty nào
const BUILDING_B = id(201);

const fixture = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA app_private; CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  INSERT INTO auth.users VALUES ('${OWNER2}'),('${MANAGER}'),('${NOPERM}'),('${SUPER}'),('${LEFT}'),('${STRANGER}');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY);
  INSERT INTO public.organizations VALUES ('${ORG_A}'),('${ORG_B}'),('${ORG_C}');
  CREATE TABLE public.organization_memberships(user_id uuid, organization_id uuid, status text);
  INSERT INTO public.organization_memberships VALUES
    ('${OWNER2}','${ORG_A}','ACTIVE'),('${OWNER2}','${ORG_B}','ACTIVE'),('${MANAGER}','${ORG_A}','ACTIVE'),
    ('${NOPERM}','${ORG_A}','ACTIVE'),('${SUPER}','${ORG_A}','ACTIVE'),('${LEFT}','${ORG_A}','ACTIVE'),('${LEFT}','${ORG_C}','LEFT');
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  INSERT INTO public.super_admins VALUES ('${SUPER}');
  -- Thân production của hai hàm dưới (đo 25/11/2026).
  CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $$
  BEGIN
    RETURN (SELECT COALESCE(array_agg(organization_id), '{}'::uuid[]) FROM public.organization_memberships
             WHERE user_id = auth.uid() AND status = 'ACTIVE');
  END $$;
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  BEGIN RETURN (SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid())); END $$;
  -- authorized_scope_v3 thật luôn trả ĐÚNG MỘT dòng (không quyền ⇒ org_wide=false, building_ids rỗng).
  CREATE TABLE app_private.test_grants(user_id uuid, org uuid, org_wide boolean, building_ids uuid[]);
  INSERT INTO app_private.test_grants VALUES
    ('${OWNER2}','${ORG_A}',true,'{}'),('${OWNER2}','${ORG_B}',true,'{}'),('${MANAGER}','${ORG_A}',false,ARRAY['${id(301)}']::uuid[]),
    ('${LEFT}','${ORG_C}',true,'{}');
  CREATE FUNCTION app_private.authorized_scope_v3(p_permission_key text, p_org uuid)
  RETURNS TABLE(org_wide boolean, building_ids uuid[], cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$
    SELECT COALESCE(g.org_wide, false), COALESCE(g.building_ids, '{}'::uuid[]), '{}'::uuid[]
      FROM (SELECT 1) one
      LEFT JOIN app_private.test_grants g
        ON g.user_id = auth.uid() AND g.org = p_org AND 'sale_phong.manage_tokens' = p_permission_key
  $$;
  CREATE FUNCTION public.gen_contract_public_code(len integer DEFAULT 6) RETURNS text LANGUAGE sql AS $$
    SELECT left(replace(gen_random_uuid()::text, '-', ''), len) $$;
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid);
  CREATE TABLE public.rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid);
  INSERT INTO public.buildings VALUES ('${BUILDING_B}','${ORG_B}');
  CREATE TABLE public.public_room_share_tokens(
    token text PRIMARY KEY, owner_id uuid NOT NULL, label text, revoked boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), organization_id uuid REFERENCES public.organizations(id));
  CREATE TABLE public.public_room_events(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token text NOT NULL, owner_id uuid NOT NULL, session_id text NOT NULL,
    event_type text NOT NULL CHECK (event_type = ANY (ARRAY['session','impression','building_select','view_mode','room_open',
      'image_view','floorplan_view','contact_click','share','download','directions','favorite','deposit_dialog','error'])),
    room_id uuid, room_name text, room_code text, building_id uuid, building_name text, duration_ms integer, dwell_ms integer,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    organization_id uuid REFERENCES public.organizations(id));
  -- Trigger production: a90 điền theo toà trước, rồi trg_autofill_org_strict đoán theo cha / người.
  CREATE FUNCTION app_private.autofill_pre_room_event_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog','public','app_private' AS $$
  begin
    if new.organization_id is null and new.building_id is not null then
      select b.organization_id into new.organization_id from public.buildings b where b.id = new.building_id;
    end if;
    return new;
  end $$;
`;
const triggers = `
  CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.public_room_share_tokens
    FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
  CREATE TRIGGER a90_autofill_org BEFORE INSERT ON public.public_room_events
    FOR EACH ROW EXECUTE FUNCTION app_private.autofill_pre_room_event_v1();
  CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.public_room_events
    FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(autofillSql);
  await db.exec(triggers);
  await db.exec(oldTokenSql);
  await db.exec(oldLoggerSql);
  return db;
}
async function asUser<T>(db: PGlite, uid: string | null, text: string, params: unknown[] = []) {
  await db.query("SELECT set_config('test.uid', $1, false)", [uid ?? '']);
  return db.query<T>(text, params);
}
const md5Of = async (db: PGlite, fn: string) =>
  (await db.query<{ m: string }>(`SELECT md5(replace(prosrc, chr(13), '')) m FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])).rows[0]?.m;
const createToken = (db: PGlite, uid: string | null, org: string | null, label: string | null = 'Sale') =>
  asUser<{ token: string; owner_id: string; organization_id: string; label: string | null }>(
    db, uid, 'SELECT * FROM public.create_public_room_token($1, $2::uuid)', [label, org]);
const logEvents = async (db: PGlite, token: string, events: unknown[]) =>
  (await asUser<{ n: number }>(db, null, 'SELECT public.log_public_room_events($1, $2::jsonb) n', [token, JSON.stringify(events)])).rows[0].n;

let db: PGlite;
let guard: PGlite;
let legacyToken: string;

beforeAll(async () => {
  db = await freshDb();
  // Trạng thái production trước migration: link cũ của nick chủ đã có organization_id (tạo trước 03/09).
  legacyToken = 'demo';
  await db.query('INSERT INTO public.public_room_share_tokens(token, owner_id, organization_id) VALUES ($1,$2,$3)', [legacyToken, OWNER2, ORG_A]);
  guard = await freshDb();
}, 60000);
afterAll(async () => { await db?.close(); await guard?.close(); });

describe('fixture tái hiện đúng lỗi production', () => {
  it('trigger trong fixture là nguyên văn thân production', async () => {
    expect(createHash('md5').update(autofillSql.slice(autofillSql.indexOf('$f$') + 3, autofillSql.lastIndexOf('$f$')).replace(/\r/g, '')).digest('hex'))
      .toBe('ffc89eb36fa19d996d27f1d10e3adc15');
    expect(await md5Of(db, 'public.create_public_room_token(text)')).toBe('a58a58892c46a5d5f6e3bfd2bc948134');
    expect(await md5Of(db, 'public.log_public_room_events(text,jsonb)')).toBe('6793a043ee3eed5ab05e9f041eeeebdf');
  });
  it('trước migration: chủ hai công ty không tạo được link (23502) và mất im lặng phiên xem', async () => {
    await expect(asUser(db, OWNER2, "SELECT public.create_public_room_token('x')")).rejects.toMatchObject({ code: '23502' });
    expect(await logEvents(db, legacyToken, [{ session_id: 's-old', event_type: 'session', duration_ms: 30000 }])).toBe(0);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM public.public_room_events WHERE session_id='s-old'")).rows[0].n).toBe(0);
  });
});

describe('migration 20261124171545', () => {
  beforeAll(async () => {
    await db.exec(behaviourSql);
    await db.exec(behaviourSql);
  }, 30000);

  it('người thuộc hai công ty gửi công ty đang chọn thì tạo được, link ghi đúng công ty đó', async () => {
    const a = (await createToken(db, OWNER2, ORG_A, '  Gửi sale A  ')).rows[0];
    expect(a).toMatchObject({ owner_id: OWNER2, organization_id: ORG_A, label: 'Gửi sale A' });
    const b = (await createToken(db, OWNER2, ORG_B)).rows[0];
    expect(b.organization_id).toBe(ORG_B);
    expect(a.token).toMatch(/^[0-9a-f]{6}$/);
  });

  it('không gửi công ty: một công ty thì lấy công ty đó; nhiều công ty thì bắt chọn (22023), không đoán', async () => {
    expect((await createToken(db, MANAGER, null)).rows[0].organization_id).toBe(ORG_A);
    await expect(createToken(db, OWNER2, null)).rejects.toMatchObject({ code: '22023', message: 'public_room_token_org_required' });
  });

  it('công ty mình không thuộc (hoặc đã rời) bị từ chối', async () => {
    await expect(createToken(db, MANAGER, ORG_B)).rejects.toMatchObject({ code: '42501', message: 'public_room_token_not_member' });
    await expect(createToken(db, LEFT, ORG_C)).rejects.toMatchObject({ code: '42501', message: 'public_room_token_not_member' });
    await expect(createToken(db, STRANGER, null)).rejects.toMatchObject({ code: '42501', message: 'public_room_token_not_member' });
  });

  it('thiếu quyền sale_phong.manage_tokens bị từ chối dù là thành viên', async () => {
    await expect(createToken(db, NOPERM, ORG_A)).rejects.toMatchObject({ code: '42501', message: 'public_room_token_permission' });
    await expect(createToken(db, NOPERM, null)).rejects.toMatchObject({ code: '42501', message: 'public_room_token_permission' });
  });

  it('quyền theo toà đủ để tạo link; quản trị nền tảng là thành viên giữ đường cũ', async () => {
    expect((await createToken(db, MANAGER, ORG_A)).rows[0].organization_id).toBe(ORG_A);
    expect((await createToken(db, SUPER, ORG_A)).rows[0].organization_id).toBe(ORG_A);
  });

  it('chưa đăng nhập bị từ chối', async () => {
    await expect(createToken(db, null, ORG_A)).rejects.toMatchObject({ code: '42501', message: 'Not authenticated' });
  });

  it('chỉ còn một bản hàm tạo link; authenticated gọi được, anon và PUBLIC thì không', async () => {
    const r = (await db.query<{ n: number; auth: boolean; anon: boolean }>(`SELECT
      (SELECT count(*)::int FROM pg_proc WHERE proname='create_public_room_token') n,
      has_function_privilege('authenticated','public.create_public_room_token(text,uuid)','EXECUTE') auth,
      has_function_privilege('anon','public.create_public_room_token(text,uuid)','EXECUTE') anon`)).rows[0];
    expect(r).toEqual({ n: 1, auth: true, anon: false });
    expect((await db.query<{ a: boolean }>("SELECT has_function_privilege('anon','public.log_public_room_events(text,jsonb)','EXECUTE') a")).rows[0].a).toBe(true);
  });

  it('phiên xem không có phòng/toà của link nick chủ được ghi, có thời lượng, đúng công ty của link', async () => {
    const token = (await createToken(db, OWNER2, ORG_B)).rows[0].token;
    const n = await logEvents(db, token, [
      { session_id: 's-1', event_type: 'session', duration_ms: 31000 },
      { session_id: 's-1', event_type: 'error', metadata: { kind: 'chunk', msg: 'x' } },
      { session_id: 's-1', event_type: 'view_mode', metadata: { mode: 'grid' } },
    ]);
    expect(n).toBe(3);
    const rows = (await db.query<{ event_type: string; organization_id: string; duration_ms: number | null; owner_id: string }>(
      "SELECT event_type, organization_id, duration_ms, owner_id FROM public.public_room_events WHERE token=$1 ORDER BY event_type", [token])).rows;
    expect(rows).toEqual([
      { event_type: 'error', organization_id: ORG_B, duration_ms: null, owner_id: OWNER2 },
      { event_type: 'session', organization_id: ORG_B, duration_ms: 31000, owner_id: OWNER2 },
      { event_type: 'view_mode', organization_id: ORG_B, duration_ms: null, owner_id: OWNER2 },
    ]);
    // Link cũ (tạo trước migration, đã có công ty) cũng hết mất phiên xem.
    expect(await logEvents(db, legacyToken, [{ session_id: 's-legacy', event_type: 'session', duration_ms: 1 }])).toBe(1);
  });

  it('công ty của sự kiện là công ty của link, không phải công ty của toà khách gửi lên', async () => {
    const token = (await createToken(db, OWNER2, ORG_A)).rows[0].token;
    expect(await logEvents(db, token, [{ session_id: 's-x', event_type: 'building_select', building_id: BUILDING_B }])).toBe(1);
    expect((await db.query<{ o: string }>('SELECT organization_id o FROM public.public_room_events WHERE token=$1', [token])).rows[0].o).toBe(ORG_A);
  });

  it('dòng hỏng chỉ mất chính nó nhưng được đếm (so_loi, SQLSTATE cuối), trả số dòng ghi thật', async () => {
    const token = (await createToken(db, OWNER2, ORG_A)).rows[0].token;
    const n = await logEvents(db, token, [
      { session_id: 's-2', event_type: 'session', duration_ms: 1e20 },
      { session_id: 's-2', event_type: 'impression' },
    ]);
    expect(n).toBe(1);
    const b = (await db.query<{ so_dong: number; so_loi: number; loi_cuoi_ma: string; co_gio: boolean }>(
      'SELECT so_dong, so_loi, loi_cuoi_ma, loi_cuoi_luc IS NOT NULL co_gio FROM app_private.public_room_event_budgets WHERE token=$1', [token])).rows[0];
    expect(b).toEqual({ so_dong: 1, so_loi: 1, loi_cuoi_ma: '22003', co_gio: true });
    // Lô toàn dòng hỏng vẫn được đếm (trước đây không cập nhật gì).
    expect(await logEvents(db, token, [{ session_id: 's-3', event_type: 'session', duration_ms: 1e20 }])).toBe(0);
    expect((await db.query<{ so_loi: number }>('SELECT so_loi FROM app_private.public_room_event_budgets WHERE token=$1', [token])).rows[0].so_loi).toBe(2);
  });

  it('giữ hạn mức 5.000 dòng/link/ngày, trần 50/lô, lọc loại lạ, link thu hồi thì không ghi', async () => {
    const token = (await createToken(db, OWNER2, ORG_A)).rows[0].token;
    await db.query("INSERT INTO app_private.public_room_event_budgets(token, ngay, so_dong) VALUES ($1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 4998)", [token]);
    const ev = { session_id: 's-4', event_type: 'impression' };
    expect(await logEvents(db, token, [ev, ev, ev])).toBe(2);
    expect(await logEvents(db, token, [ev])).toBe(0);
    const other = (await createToken(db, OWNER2, ORG_A)).rows[0].token;
    expect(await logEvents(db, other, Array.from({ length: 60 }, () => ev))).toBe(50);
    expect(await logEvents(db, other, [{ session_id: 's-5', event_type: 'hack' }])).toBe(0);
    await db.query('UPDATE public.public_room_share_tokens SET revoked=true WHERE token=$1', [other]);
    expect(await logEvents(db, other, [ev])).toBe(0);
  });
});

describe('tiền kiểm và hậu kiểm md5 của file migration', () => {
  it('từ chối khi thân đang chạy khác thân đã rà, không ghi gì', async () => {
    await guard.exec(oldTokenSql.replace("tries >= 10", "tries >= 11"));
    await expect(guard.exec(sql)).rejects.toThrow(/KHÁC thân đã rà/);
    expect((await guard.query<{ n: number }>("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='public_room_event_budgets' AND column_name='so_loi'")).rows[0].n).toBe(0);
    await guard.exec(oldTokenSql);
  });
  it('chạy hai lượt sạch, thân sau áp đúng bản ghim', async () => {
    await guard.exec(sql);
    await guard.exec(sql);
    expect(await md5Of(guard, 'public.create_public_room_token(text,uuid)')).toBe('9b182ad493533270469d384a4c6d986f');
    expect(await md5Of(guard, 'public.log_public_room_events(text,jsonb)')).toBe('e8f80d246c4fd5c85b882dfc5ae34aac');
    expect(await md5Of(guard, 'public.create_public_room_token(text)')).toBeUndefined();
  });
});
