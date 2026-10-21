import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 20261021171252_sua_producer_v5_thong_bao_v1 (gói B mục B11), chạy THẬT trên PGlite, hai lượt:
 *   - get_salary_v5_config: nhánh người gọi tin cậy (JWT service_role, hoặc không JWT + session postgres) CHỈ khi
 *     auth.uid() NULL và p_org tường minh; người dùng giữ nguyên cổng membership.
 *   - v5_route_candidates truyền công ty suy từ p_user (digest v5 chạy dưới service_role không còn 42501).
 *   - v5_appeal / report_device_issue ghi organization_id, người nhận = chủ công ty; không suy được công ty thì thao
 *     tác vẫn thành công (trước đây autofill_org_strict ném 23502 và rollback cả kháng nghị).
 */
const FILE = 'supabase/migrations/20261021171252_sua_producer_v5_thong_bao_v1.sql';
const ROUTE_FILE = 'supabase/migrations/20260721140000_v5_route_planning_phase12.sql';
const ANCHOR = 'v_cfg JSONB := public.get_salary_v5_config();';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG_A = u(1), ORG_B = u(2), STAFF = u(10), OWNER_A = u(11), OWNER_B = u(12), SUPER = u(13), SOLO = u(14), TOA = u(20);
const db = new PGlite();

async function maLoi(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'khong-ma';
  }
}
async function voi<T>(uid: string | null, claims: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('test.uid', $1, false), set_config('request.jwt.claims', $2, false)", [uid ?? '', claims ?? '']);
  try {
    return await fn();
  } finally {
    await db.query("SELECT set_config('test.uid', '', false), set_config('request.jwt.claims', '', false)");
  }
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
    CREATE TABLE public.organization_memberships(organization_id uuid, user_id uuid, status text);
    INSERT INTO public.organization_memberships VALUES
      ('${ORG_A}', '${STAFF}', 'ACTIVE'), ('${ORG_B}', '${STAFF}', 'ACTIVE'), ('${ORG_A}', '${OWNER_A}', 'ACTIVE'),
      ('${ORG_B}', '${OWNER_B}', 'ACTIVE'), ('${ORG_A}', '${SOLO}', 'ACTIVE');
    CREATE TABLE public.super_admins(user_id uuid, created_at timestamptz DEFAULT now());
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text);
    INSERT INTO public.profiles VALUES ('${STAFF}', 'Nhân viên A'), ('${SOLO}', 'Nhân viên B');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text);
    INSERT INTO public.buildings VALUES ('${TOA}', '${ORG_B}', 'Toà B1');
    CREATE TABLE public.salary_attendance_day(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, work_date date, status text,
      audit jsonb NOT NULL DEFAULT '[]', updated_at timestamptz, organization_id uuid, UNIQUE (user_id, work_date));
    CREATE TABLE public.inspection_sessions(id uuid PRIMARY KEY, user_id uuid, building_id uuid, organization_id uuid, device_issue jsonb,
      updated_at timestamptz);
    CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, organization_id uuid,
      type text, channel text, status text, subject text, content text, metadata jsonb);
    -- Như trg_autofill_org_strict production: dòng không có công ty ⇒ 23502, rollback cả lệnh gọi.
    CREATE FUNCTION public.strict_org() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id IS NULL THEN RAISE EXCEPTION 'organization_id bắt buộc' USING ERRCODE = '23502'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.strict_org();

    CREATE TABLE test_salary_org(user_id uuid PRIMARY KEY, organization_id uuid);
    INSERT INTO test_salary_org VALUES ('${STAFF}', '${ORG_A}'), ('${SOLO}', '${ORG_A}');
    CREATE FUNCTION app_private.v5_salary_org_of_user_v1(uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT organization_id FROM public.test_salary_org WHERE user_id = $1 $$;
    CREATE FUNCTION app_private.v5_salary_config_for_org_v1(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('org', $1) $$;
    CREATE FUNCTION app_private.single_org_of_user_v1(p_uid uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
      select (array_agg(distinct organization_id))[1] from public.organization_memberships
       where user_id = p_uid and status = 'ACTIVE' having count(distinct organization_id) = 1 $$;
    CREATE TABLE test_owners(organization_id uuid, user_id uuid);
    INSERT INTO test_owners VALUES ('${ORG_A}', '${OWNER_A}'), ('${ORG_B}', '${OWNER_B}');
    CREATE FUNCTION app_private.ie_actor_is_company_owner_v1(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.test_owners WHERE organization_id = $1 AND user_id = $2) $$;

    -- Bản cũ (chỉ cần tồn tại cho điều kiện tiên quyết; migration thay).
    CREATE FUNCTION public.get_salary_v5_config(p_org uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
      BEGIN IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF; RETURN '{}'; END $$;
    CREATE FUNCTION public.v5_appeal(p_date date, p_text text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.report_device_issue(p_session uuid, p_reason text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    -- v5_route_candidates rút gọn, giữ NGUYÊN dòng khai báo cấu hình của bản production (neo của bản vá).
    CREATE FUNCTION public.v5_route_candidates(p_user uuid) RETURNS TABLE(cfg jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
      SET search_path TO 'public' AS $fn$
    DECLARE
      ${ANCHOR}
    BEGIN
      RETURN QUERY SELECT v_cfg;
    END $fn$;
    GRANT EXECUTE ON FUNCTION public.get_salary_v5_config(uuid), public.v5_appeal(date, text), public.report_device_issue(uuid, text)
      TO anon, authenticated, service_role;
  `);
  const sql = readFileSync(FILE, 'utf8');
  await db.exec(sql);
  await db.exec(sql);
}, 60000);
afterAll(async () => {
  await db.close();
});

describe('get_salary_v5_config — nhánh máy chủ', () => {
  const cfg = (org: string | null) => db.query<{ v: { org: string } | null }>('SELECT public.get_salary_v5_config($1) v', [org]);

  it('JWT service_role hoặc pg_cron (không JWT, session postgres) + công ty tường minh ⇒ đọc được', async () => {
    expect((await voi(null, '{"role":"service_role"}', () => cfg(ORG_A))).rows[0].v).toEqual({ org: ORG_A });
    expect((await voi(null, null, () => cfg(ORG_B))).rows[0].v).toEqual({ org: ORG_B });
  });

  it('thiếu công ty, hoặc JWT không phải service_role ⇒ 42501 như cũ', async () => {
    expect(await maLoi(voi(null, '{"role":"service_role"}', () => cfg(null)))).toBe('42501');
    expect(await maLoi(voi(null, '{"role":"anon"}', () => cfg(ORG_A)))).toBe('42501');
    expect(await maLoi(voi(null, '{"role":"authenticated"}', () => cfg(ORG_A)))).toBe('42501');
  });

  it('người dùng giữ nguyên cổng membership (không lách bằng p_org)', async () => {
    expect((await voi(STAFF, '{"role":"authenticated","sub":"x"}', () => cfg(null))).rows[0].v).toEqual({ org: ORG_A });
    expect(await maLoi(voi(OWNER_A, '{"role":"service_role"}', () => cfg(ORG_B)))).toBe('42501');
  });
});

describe('v5_route_candidates — digest dưới service_role', () => {
  it('neo vá có đúng một lần ở bản nguồn (thân production khớp byte với file này)', () => {
    const src = readFileSync(ROUTE_FILE, 'utf8');
    expect(src.split(ANCHOR)).toHaveLength(2);
  });

  it('đã vá đúng một lần (hai lượt migration), truyền công ty của p_user', async () => {
    const def = (await db.query<{ d: string }>("SELECT pg_get_functiondef('public.v5_route_candidates(uuid)'::regprocedure) d")).rows[0].d;
    expect(def.split('get_salary_v5_config(app_private.v5_salary_org_of_user_v1(p_user))')).toHaveLength(2);
    expect(def).not.toContain(ANCHOR);
    const r = await voi(null, '{"role":"service_role"}', () => db.query<{ cfg: { org: string } }>('SELECT * FROM public.v5_route_candidates($1)', [STAFF]));
    expect(r.rows[0].cfg).toEqual({ org: ORG_A });
    const self = await voi(SOLO, '{"role":"authenticated"}', () => db.query<{ cfg: { org: string } }>('SELECT * FROM public.v5_route_candidates($1)', [SOLO]));
    expect(self.rows[0].cfg).toEqual({ org: ORG_A });
  });
});

describe('v5_appeal / report_device_issue — đúng công ty, người nhận là chủ công ty', () => {
  it('kháng nghị: ngày có công ty ⇒ chuông cho chủ của ĐÚNG công ty, không cho super admin toàn cục', async () => {
    await db.query("INSERT INTO public.salary_attendance_day(user_id, work_date, status, organization_id) VALUES ($1, '2026-10-20', 'flagged', $2)", [STAFF, ORG_B]);
    const r = await voi(STAFF, '{"role":"authenticated"}', () => db.query<{ v: unknown }>("SELECT public.v5_appeal('2026-10-20', 'Em có đi') v"));
    expect(r.rows[0].v).toEqual({ appealed: true });
    const n = await db.query("SELECT user_id, organization_id, subject FROM public.notifications WHERE metadata->>'v5' = 'appeal'");
    expect(n.rows).toEqual([{ user_id: OWNER_B, organization_id: ORG_B, subject: 'Kháng nghị nghi án' }]);
  });

  it('kháng nghị: ngày thiếu công ty + người thuộc 2 công ty ⇒ vẫn lưu kháng nghị, không gửi chuông (trước đây 23502 rollback)', async () => {
    await db.query("INSERT INTO public.salary_attendance_day(user_id, work_date, status) VALUES ($1, '2026-10-21', 'flagged')", [STAFF]);
    await voi(STAFF, '{"role":"authenticated"}', () => db.query("SELECT public.v5_appeal('2026-10-21', 'Em xin giải trình')"));
    const audit = await db.query<{ audit: Array<{ action: string }> }>("SELECT audit FROM public.salary_attendance_day WHERE work_date = '2026-10-21'");
    expect(audit.rows[0].audit.map((x) => x.action)).toEqual(['appeal']);
    expect((await db.query("SELECT 1 FROM public.notifications WHERE metadata->>'date' = '2026-10-21'")).rows).toHaveLength(0);
    expect(await maLoi(voi(STAFF, '{"role":"authenticated"}', () => db.query("SELECT public.v5_appeal('2026-10-22', 'x')")))).not.toBeNull();
  });

  it('báo sự cố: phiên thiếu công ty ⇒ suy từ toà; chuông cho chủ công ty của toà, ghi organization_id', async () => {
    const s = u(900);
    await db.query('INSERT INTO public.inspection_sessions(id, user_id, building_id) VALUES ($1, $2, $3)', [s, STAFF, TOA]);
    const r = await voi(STAFF, '{"role":"authenticated"}', () => db.query<{ v: unknown }>("SELECT public.report_device_issue($1, 'Mất GPS') v", [s]));
    expect(r.rows[0].v).toEqual({ reported: true });
    const n = await db.query<{ user_id: string; organization_id: string; content: string }>(
      "SELECT user_id, organization_id, content FROM public.notifications WHERE metadata->>'v5' = 'device_issue'");
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]).toMatchObject({ user_id: OWNER_B, organization_id: ORG_B });
    expect(n.rows[0].content).toBe('Nhân viên A báo sự cố tại toà Toà B1: Mất GPS');
    expect(await maLoi(voi(OWNER_A, '{"role":"authenticated"}', () => db.query("SELECT public.report_device_issue($1, 'x')", [s])))).not.toBeNull();
  });

  it('ACL: anon không gọi được ba hàm; helper người gọi tin cậy không lộ ra ngoài', async () => {
    const r = await db.query<Record<string, boolean>>(`SELECT
      has_function_privilege('anon', 'public.get_salary_v5_config(uuid)', 'EXECUTE') a,
      has_function_privilege('anon', 'public.v5_appeal(date,text)', 'EXECUTE') b,
      has_function_privilege('anon', 'public.report_device_issue(uuid,text)', 'EXECUTE') c,
      has_function_privilege('authenticated', 'public.v5_appeal(date,text)', 'EXECUTE') d,
      has_function_privilege('authenticated', 'app_private.trusted_server_caller_v1()', 'EXECUTE') e`);
    expect(r.rows[0]).toEqual({ a: false, b: false, c: false, d: true, e: false });
  });
});
