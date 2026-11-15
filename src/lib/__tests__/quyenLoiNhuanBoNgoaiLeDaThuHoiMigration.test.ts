import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261115024231 (gói 1A): authorize_v2 không còn tính ngoại lệ ĐÃ THU HỒI, và
 * profit_close_preview_v2 chỉ mở cho người chốt / mở chốt / chi lợi nhuận / quản lý cổ đông.
 *
 * Chạy THẬT trên PostgreSQL nhúng:
 *  - thân CŨ của authorize_v2 và profit_close_preview_v2 lấy từ chính file đã phát hành
 *    (đo md5 để chắc đúng bản production mà migration ghim);
 *  - app_private.authorized_scope_v3 là ĐỊNH NGHĨA SỐNG (file migration cuối cùng tạo nó),
 *    không phải stub — nên ca "đã thu hồi" đo đúng luật thật;
 *  - đo TRƯỚC migration để chứng minh lỗi có thật (phép kiểm có thể đỏ), rồi chạy migration
 *    HAI lượt và đo lại.
 */
const DIR = "supabase/migrations";
const FILE = `${DIR}/20261115024231_quyen_loi_nhuan_bo_ngoai_le_da_thu_hoi.sql`;
const FILE_AUTHZ_CU = `${DIR}/20260713110300_sprint2d_authorize_v2.sql`;
const BASELINE = "supabase/baseline/schema.sql";
const MD5_AUTHZ_CU = "13f230d17ac2139eb41b3843b065e04e";
const MD5_PREVIEW_CU = "839468e9ce78ca17d32be3133be6dfb2";
// md5 thân do migration ghi — migration ghim hai giá trị này cho lượt chạy lại; sửa thân thì phải sửa cả hai nơi.
const MD5_AUTHZ_MOI = "f0e0670ea071b367d6195f6c77614496";
const MD5_PREVIEW_MOI = "7cae35c3ac92fc625cc84d8f999e2ebd";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B] = [1, 2].map(id);
const [CHU, CO_DONG_GO, DENY_GO, ALLOW_SONG, DENY_SONG, HET_HAN, CHI_XEM, CHI_CHI, CHI_LOCK, SUPER, NGOAI,
  CHI_UNLOCK, CHI_QLCD, ALLOW_KHONG_PHAM_VI, VAI_TAT] =
  [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map(id);
const mem = (user: string) => user.replace("4000-8000-0000000000", "4000-8000-1000000000");
const [VAI_CHU_A, VAI_LOCK_VIEW_A, VAI_XEM_A, VAI_CHI_A, VAI_LOCK_A, VAI_CHU_B, VAI_UNLOCK_A, VAI_QLCD_A, VAI_TAT_A] =
  [31, 32, 33, 34, 35, 36, 37, 38, 39].map(id);
const [PHAM_VI_A, PHAM_VI_B] = [41, 42].map(id);
const [TOA_1, TOA_2, TOA_AO, TOA_B] = [51, 52, 53, 54].map(id);
const KHOA = ["view", "lock", "unlock", "distribute", "manage_shareholders", "view_percent", "view_building_totals"]
  .map((k) => `shareholder_profit.${k}`);

/** Cắt nguyên câu CREATE FUNCTION <tên> (tới hết dollar-quote đóng + dấu ;). */
function cauLenhTaoHam(sql: string, ten: string): string {
  const mo = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i").exec(sql);
  if (!mo) throw new Error(`Không thấy câu tạo hàm ${ten}`);
  const sau = sql.slice(mo.index);
  const the = /\bAS\s+(\$[a-z_]*\$)/i.exec(sau);
  if (!the) throw new Error(`Không thấy dollar-quote của ${ten}`);
  const batDau = the.index + the[0].length;
  const dong = sau.indexOf(the[1], batDau);
  const hetCau = sau.indexOf(";", dong);
  return sau.slice(0, hetCau + 1);
}
function dinhNghiaSong(ten: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${ten.replace(".", "\\.")}\\s*\\(`, "i");
  let hit: string | null = null;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${DIR}/${f}`, "utf8");
    if (re.test(sql)) hit = sql;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${ten}`);
  return cauLenhTaoHam(hit, ten);
}

const AUTHZ_CU = cauLenhTaoHam(readFileSync(FILE_AUTHZ_CU, "utf8"), "public.authorize_v2");
const PREVIEW_CU = cauLenhTaoHam(readFileSync(BASELINE, "utf8"), "public.profit_close_preview_v2");
const SCOPE_V3 = dinhNghiaSong("app_private.authorized_scope_v3");
const MIGRATION = readFileSync(FILE, "utf8");

const NEN = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ACTIVE');
  CREATE TABLE public.permission_definitions(key text PRIMARY KEY, permission_domain text NOT NULL DEFAULT 'TENANT', is_active boolean NOT NULL DEFAULT true,
    scope_kinds text[] NOT NULL DEFAULT '{ORGANIZATION}', requires_cashbook_possession boolean NOT NULL DEFAULT false,
    accepted_possession_kinds text[] NOT NULL DEFAULT '{}', required_dimensions text[] NOT NULL DEFAULT '{}');
  CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, status text DEFAULT 'ACTIVE',
    revoked_at timestamptz, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid, permission_key text, active_from timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_permission_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid,
    permission_key text, effect text, revoked_at timestamptz, expires_at timestamptz);
  CREATE TABLE public.member_override_scopes(organization_id uuid, override_id uuid, scope_id uuid);
  CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY, organization_id uuid, scope_type text, building_id uuid, cashbook_id uuid, area_id uuid);
  CREATE TABLE public.role_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, membership_id uuid, role_id uuid, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE public.organization_roles(id uuid PRIMARY KEY, organization_id uuid, status text);
  CREATE TABLE public.role_permissions(organization_id uuid, role_id uuid, permission_key text, effect text);
  CREATE TABLE public.role_binding_scopes(organization_id uuid, role_binding_id uuid, scope_id uuid);
  CREATE TABLE public.area_buildings(organization_id uuid, area_id uuid, building_id uuid);
  CREATE TABLE public.cashbook_possession_bindings(organization_id uuid, membership_id uuid, cashbook_id uuid, possession_kind text, valid_from timestamptz, valid_to timestamptz);
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz, is_virtual boolean NOT NULL DEFAULT false);
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
  -- Lõi xem trước và bước làm giàu: thay bằng bản ghi nhận lời gọi (migration không đụng hai hàm này).
  CREATE TABLE public.core_calls(permission text, n_buildings int);
  CREATE FUNCTION public._profit_close_preview_core_v2(p_organization_id uuid, p_period_month date, p_building_ids uuid[], p_adjustments jsonb, p_permission_key text, p_lock_sources boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO public.core_calls VALUES (p_permission_key, COALESCE(array_length(p_building_ids, 1), 0));
      RETURN jsonb_build_object('permission', p_permission_key, 'n_buildings', COALESCE(array_length(p_building_ids, 1), 0));
    END $$;
  CREATE FUNCTION public._profit_enrich_unallocated_v3(p_document jsonb, p_adjustments jsonb DEFAULT '[]'::jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT p_document $$;
`;

function duLieu(): string {
  const thanhVien = [CHU, CO_DONG_GO, DENY_GO, ALLOW_SONG, DENY_SONG, HET_HAN, CHI_XEM, CHI_CHI, CHI_LOCK,
    CHI_UNLOCK, CHI_QLCD, ALLOW_KHONG_PHAM_VI, VAI_TAT]
    .map((u) => `('${mem(u)}','${u}','${ORG_A}')`).concat(`('${mem(NGOAI)}','${NGOAI}','${ORG_B}')`).join(",");
  // [công ty, vai, khoá, trạng thái vai]
  const quyenVai: [string, string, string[], string][] = [
    [ORG_A, VAI_CHU_A, KHOA.slice(0, 5), "ACTIVE"],
    [ORG_A, VAI_LOCK_VIEW_A, [KHOA[0], KHOA[1]], "ACTIVE"],
    [ORG_A, VAI_XEM_A, [KHOA[5], KHOA[6]], "ACTIVE"],
    [ORG_A, VAI_CHI_A, [KHOA[3]], "ACTIVE"],
    [ORG_A, VAI_LOCK_A, [KHOA[1]], "ACTIVE"],
    [ORG_A, VAI_UNLOCK_A, [KHOA[2]], "ACTIVE"],
    [ORG_A, VAI_QLCD_A, [KHOA[4]], "ACTIVE"],
    [ORG_A, VAI_TAT_A, [KHOA[1]], "DISABLED"],
    [ORG_B, VAI_CHU_B, KHOA.slice(0, 5), "ACTIVE"],
  ];
  const ganVai: [string, string, string, string][] = [
    [ORG_A, CHU, VAI_CHU_A, PHAM_VI_A], [ORG_A, DENY_GO, VAI_LOCK_VIEW_A, PHAM_VI_A], [ORG_A, DENY_SONG, VAI_LOCK_VIEW_A, PHAM_VI_A],
    [ORG_A, CHI_XEM, VAI_XEM_A, PHAM_VI_A], [ORG_A, CHI_CHI, VAI_CHI_A, PHAM_VI_A], [ORG_A, CHI_LOCK, VAI_LOCK_A, PHAM_VI_A],
    [ORG_A, CHI_UNLOCK, VAI_UNLOCK_A, PHAM_VI_A], [ORG_A, CHI_QLCD, VAI_QLCD_A, PHAM_VI_A], [ORG_A, VAI_TAT, VAI_TAT_A, PHAM_VI_A],
    [ORG_B, NGOAI, VAI_CHU_B, PHAM_VI_B],
  ];
  // [người, khoá, effect, thu hồi?, hết hạn?, có cạnh phạm vi?]
  const ngoaiLe: [string, string, string, boolean, boolean, boolean][] = [
    [CO_DONG_GO, KHOA[0], "ALLOW", true, false, true],
    [DENY_GO, KHOA[1], "DENY", true, false, true],
    [ALLOW_SONG, KHOA[0], "ALLOW", false, false, true],
    [DENY_SONG, KHOA[1], "DENY", false, false, true],
    [HET_HAN, KHOA[0], "ALLOW", false, true, true],
    [ALLOW_KHONG_PHAM_VI, KHOA[1], "ALLOW", false, false, false],
  ];
  return `
    INSERT INTO public.organizations(id) VALUES ('${ORG_A}'),('${ORG_B}');
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.permission_definitions(key) VALUES ${KHOA.map((k) => `('${k}')`).join(",")};
    INSERT INTO public.organization_memberships(id, user_id, organization_id) VALUES ${thanhVien};
    INSERT INTO public.authorization_scopes(id, organization_id, scope_type) VALUES ('${PHAM_VI_A}','${ORG_A}','ORGANIZATION'),('${PHAM_VI_B}','${ORG_B}','ORGANIZATION');
    INSERT INTO public.organization_roles(id, organization_id, status) VALUES ${quyenVai.map(([o, r, , tt]) => `('${r}','${o}','${tt}')`).join(",")};
    INSERT INTO public.role_permissions(organization_id, role_id, permission_key, effect) VALUES
      ${quyenVai.flatMap(([o, r, ks]) => ks.map((k) => `('${o}','${r}','${k}','ALLOW')`)).join(",")};
    ${ganVai.map(([o, u, r, s], i) => `
      INSERT INTO public.role_bindings(id, organization_id, membership_id, role_id) VALUES ('${id(100 + i)}','${o}','${mem(u)}','${r}');
      INSERT INTO public.role_binding_scopes VALUES ('${o}','${id(100 + i)}','${s}');`).join("")}
    ${ngoaiLe.map(([u, k, e, thuHoi, hetHan, coCanh], i) => `
      INSERT INTO public.member_permission_overrides(id, organization_id, membership_id, permission_key, effect, revoked_at, expires_at)
        VALUES ('${id(200 + i)}','${ORG_A}','${mem(u)}','${k}','${e}', ${thuHoi ? "now() - interval '1 day'" : "NULL"}, ${hetHan ? "now() - interval '1 hour'" : "NULL"});
      ${coCanh ? `INSERT INTO public.member_override_scopes VALUES ('${ORG_A}','${id(200 + i)}','${PHAM_VI_A}');` : ""}`).join("")}
    INSERT INTO public.buildings(id, organization_id, is_virtual) VALUES
      ('${TOA_1}','${ORG_A}',false),('${TOA_2}','${ORG_A}',false),('${TOA_AO}','${ORG_A}',true),('${TOA_B}','${ORG_B}',false);
  `;
}

type Db = PGlite;
async function trongGiaoDich<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
/** Chạy một SELECT với auth.uid() = user. vai=authenticated để đo cả ACL; vai=chu để đo riêng thân hàm. */
async function goi<T>(db: Db, user: string | null, sql: string, vai: "authenticated" | "chu" = "chu"): Promise<T> {
  return trongGiaoDich(db, async () => {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
    if (vai === "authenticated") await db.exec("SET LOCAL ROLE authenticated");
    return (await db.query<{ v: T }>(sql)).rows[0].v;
  });
}
const authz = (db: Db, user: string | null, khoa: string, org = ORG_A) =>
  goi<boolean>(db, user, `SELECT public.authorize_v2('${khoa}','${org}','ORGANIZATION',NULL) AS v`);
const helper = (db: Db, user: string | null, khoa: string, org = ORG_A) =>
  goi<boolean>(db, user, `SELECT app_private.profit_viewer_can_v1('${org}','${khoa}') AS v`);
const preview = (db: Db, user: string | null, thang = "2026-09-01", org = ORG_A) =>
  goi<{ permission: string; n_buildings: number }>(db, user, `SELECT public.profit_close_preview_v2('${org}','${thang}') AS v`, "authenticated");
const soLanGoiLoi = async (db: Db) => (await db.query<{ n: number }>("SELECT count(*)::int n FROM public.core_calls")).rows[0].n;

const db = new PGlite();
const truoc: Record<string, unknown> = {};

beforeAll(async () => {
  await db.exec(NEN);
  await db.exec(SCOPE_V3);
  await db.exec("GRANT EXECUTE ON FUNCTION app_private.authorized_scope_v3(text, uuid) TO authenticated");
  await db.exec(AUTHZ_CU);
  await db.exec(PREVIEW_CU);
  await db.exec("GRANT EXECUTE ON FUNCTION public.profit_close_preview_v2(uuid, date, uuid[], jsonb) TO authenticated, service_role");
  await db.exec(duLieu());

  const md5 = async (ham: string) => (await db.query<{ m: string }>(
    `SELECT md5(replace(p.prosrc, chr(13), '')) m FROM pg_proc p WHERE p.oid = to_regprocedure('${ham}')`)).rows[0].m;
  truoc.md5Authz = await md5("public.authorize_v2(text,uuid,text,uuid)");
  truoc.md5Preview = await md5("public.profit_close_preview_v2(uuid,date,uuid[],jsonb)");
  truoc.allowDaGo = await authz(db, CO_DONG_GO, KHOA[0]);
  truoc.denyDaGo = await authz(db, DENY_GO, KHOA[1]);
  truoc.previewCoDongDaGo = await preview(db, CO_DONG_GO);

  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
}, 60000);
afterAll(() => db.close());

describe("trước migration: thân cũ đúng là bản production và lỗi có thật", () => {
  it("thân cũ nạp vào test trùng md5 mà migration ghim", () => {
    expect(truoc.md5Authz).toBe(MD5_AUTHZ_CU);
    expect(truoc.md5Preview).toBe(MD5_PREVIEW_CU);
  });
  it("ngoại lệ ALLOW đã thu hồi vẫn cấp quyền; DENY đã thu hồi vẫn chặn", () => {
    expect(truoc.allowDaGo).toBe(true);
    expect(truoc.denyDaGo).toBe(false);
  });
  it("người đã bị gỡ quyền xem vẫn mở được bảng xem trước của cả công ty", () => {
    expect(truoc.previewCoDongDaGo).toMatchObject({ permission: "shareholder_profit.view", n_buildings: 2 });
  });
});

describe("authorize_v2 sau migration", () => {
  it("ALLOW đã thu hồi không còn cấp quyền", async () => {
    expect(await authz(db, CO_DONG_GO, KHOA[0])).toBe(false);
  });
  it("DENY đã thu hồi không còn chặn quyền từ vai", async () => {
    expect(await authz(db, DENY_GO, KHOA[1])).toBe(true);
  });
  it("ngoại lệ còn sống giữ nguyên hiệu lực: ALLOW cấp, DENY chặn", async () => {
    expect(await authz(db, ALLOW_SONG, KHOA[0])).toBe(true);
    expect(await authz(db, DENY_SONG, KHOA[1])).toBe(false);
    expect(await authz(db, DENY_SONG, KHOA[0])).toBe(true);
  });
  it("ngoại lệ hết hạn, người ngoài công ty, không đăng nhập: không có quyền", async () => {
    expect(await authz(db, HET_HAN, KHOA[0])).toBe(false);
    expect(await authz(db, NGOAI, KHOA[1])).toBe(false);
    expect(await authz(db, null, KHOA[1])).toBe(false);
  });
  it("quyền từ vai không đổi", async () => {
    for (const k of KHOA.slice(0, 5)) expect(await authz(db, CHU, k)).toBe(true);
    expect(await authz(db, NGOAI, KHOA[1], ORG_B)).toBe(true);
  });
  it("authenticated không gọi thẳng được authorize_v2; anon cũng không có EXECUTE", async () => {
    await expect(goi(db, CHU, `SELECT public.authorize_v2('${KHOA[1]}','${ORG_A}','ORGANIZATION',NULL) AS v`, "authenticated"))
      .rejects.toMatchObject({ code: "42501" });
    const acl = await db.query<{ a: boolean; n: boolean }>(
      `SELECT has_function_privilege('authenticated','public.authorize_v2(text,uuid,text,uuid)','EXECUTE') a,
              has_function_privilege('anon','public.authorize_v2(text,uuid,text,uuid)','EXECUTE') n`);
    expect(acl.rows[0]).toEqual({ a: false, n: false });
  });
  it("thân sau migration đúng md5 mà migration ghim cho lượt chạy lại", async () => {
    const md5 = async (ham: string) => (await db.query<{ m: string }>(
      `SELECT md5(replace(p.prosrc, chr(13), '')) m FROM pg_proc p WHERE p.oid = to_regprocedure('${ham}')`)).rows[0].m;
    expect(await md5("public.authorize_v2(text,uuid,text,uuid)")).toBe(MD5_AUTHZ_MOI);
    expect(await md5("public.profit_close_preview_v2(uuid,date,uuid[],jsonb)")).toBe(MD5_PREVIEW_MOI);
    expect(MIGRATION).toContain(`'${MD5_AUTHZ_CU}', '${MD5_AUTHZ_MOI}'`);
    expect(MIGRATION).toContain(`'${MD5_PREVIEW_CU}', '${MD5_PREVIEW_MOI}'`);
  });
  it("luật cũ của authorize_v2 giữ nguyên: không xét cạnh phạm vi của ngoại lệ, không xét trạng thái vai", async () => {
    expect(await authz(db, ALLOW_KHONG_PHAM_VI, KHOA[1])).toBe(true);
    expect(await authz(db, VAI_TAT, KHOA[1])).toBe(true);
  });
});

describe("app_private.profit_viewer_can_v1", () => {
  it("vai còn hiệu lực ⇒ true; ngoại lệ đã thu hồi ⇒ false; ngoại lệ sống ⇒ true", async () => {
    expect(await helper(db, CHU, KHOA[1])).toBe(true);
    expect(await helper(db, CO_DONG_GO, KHOA[0])).toBe(false);
    expect(await helper(db, ALLOW_SONG, KHOA[0])).toBe(true);
  });
  it("DENY sống chặn; DENY đã thu hồi không chặn", async () => {
    expect(await helper(db, DENY_SONG, KHOA[1])).toBe(false);
    expect(await helper(db, DENY_GO, KHOA[1])).toBe(true);
  });
  it("khoá không tồn tại, công ty khác, không đăng nhập ⇒ false; super admin ⇒ true", async () => {
    expect(await helper(db, CHU, "shareholder_profit.khong_co")).toBe(false);
    expect(await helper(db, CHU, KHOA[1], ORG_B)).toBe(false);
    expect(await helper(db, null, KHOA[1])).toBe(false);
    expect(await helper(db, SUPER, KHOA[1])).toBe(true);
  });
  it("ACL để dùng trong policy: authenticated có EXECUTE, anon không", async () => {
    const acl = await db.query<{ a: boolean; n: boolean }>(
      `SELECT has_function_privilege('authenticated','app_private.profit_viewer_can_v1(uuid,text)','EXECUTE') a,
              has_function_privilege('anon','app_private.profit_viewer_can_v1(uuid,text)','EXECUTE') n`);
    expect(acl.rows[0]).toEqual({ a: true, n: false });
  });
});

describe("profit_close_preview_v2 sau migration", () => {
  it("người đã bị gỡ quyền xem bị chặn 42501 ngay ở khối kiểm trước (lõi giả không bao giờ ném 42501)", async () => {
    await expect(preview(db, CO_DONG_GO)).rejects.toMatchObject({
      code: "42501", message: expect.stringContaining("không có quyền xem bảng xem trước chốt lợi nhuận"),
    });
  });
  it("lõi chỉ được gọi khi qua khối kiểm trước: đếm lời gọi trong CÙNG giao dịch", async () => {
    const dem = (user: string) => trongGiaoDich(db, async () => {
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
      await db.exec("SAVEPOINT s");
      try { await db.query(`SELECT public.profit_close_preview_v2('${ORG_A}','2026-09-01')`); } catch { await db.exec("ROLLBACK TO SAVEPOINT s"); }
      return soLanGoiLoi(db);
    });
    expect(await dem(CO_DONG_GO)).toBe(0);
    expect(await dem(CHU)).toBe(1);
  });
  it("mỗi quyền quản lý tự nó đủ qua khối kiểm trước: chỉ-mở-chốt, chỉ-quản-lý-cổ-đông", async () => {
    expect(await preview(db, CHI_UNLOCK)).toEqual({ permission: "shareholder_profit.view", n_buildings: 2 });
    expect(await preview(db, CHI_QLCD)).toEqual({ permission: "shareholder_profit.view", n_buildings: 2 });
  });
  it("fail-closed theo luật v3: DENY sống trên quyền chốt, ngoại lệ không có cạnh phạm vi, vai đã tắt ⇒ bị chặn", async () => {
    await expect(preview(db, DENY_SONG)).rejects.toMatchObject({ code: "42501" });
    await expect(preview(db, ALLOW_KHONG_PHAM_VI)).rejects.toMatchObject({ code: "42501" });
    await expect(preview(db, VAI_TAT)).rejects.toMatchObject({ code: "42501" });
    expect(await helper(db, ALLOW_KHONG_PHAM_VI, KHOA[1])).toBe(false);
    expect(await helper(db, VAI_TAT, KHOA[1])).toBe(false);
  });
  it("người chỉ có quyền xem % và xem số toà bị chặn", async () => {
    await expect(preview(db, CHI_XEM)).rejects.toMatchObject({ code: "42501" });
  });
  it("người chỉ còn ngoại lệ 'view' sống (không chốt, không chi) cũng bị chặn", async () => {
    await expect(preview(db, ALLOW_SONG)).rejects.toMatchObject({ code: "42501" });
  });
  it("người ngoài công ty và người không đăng nhập bị chặn", async () => {
    await expect(preview(db, NGOAI)).rejects.toMatchObject({ code: "42501" });
    await expect(preview(db, null)).rejects.toMatchObject({ code: "42501" });
  });
  it("chủ công ty: tới lõi với quyền view, đủ toà thật (không tính toà ảo, không lẫn công ty khác)", async () => {
    expect(await preview(db, CHU)).toEqual({ permission: "shareholder_profit.view", n_buildings: 2 });
  });
  it("người chỉ có quyền chốt: tới lõi với quyền lock (hành vi cũ giữ nguyên)", async () => {
    expect(await preview(db, CHI_LOCK)).toEqual({ permission: "shareholder_profit.lock", n_buildings: 2 });
  });
  it("người chỉ có quyền chi: qua khối mới, lõi nhận quyền view để tự kiểm tiếp (fail-closed ở lõi thật)", async () => {
    expect(await preview(db, CHI_CHI)).toEqual({ permission: "shareholder_profit.view", n_buildings: 2 });
  });
  it("super admin vẫn xem được", async () => {
    expect(await preview(db, SUPER)).toMatchObject({ permission: "shareholder_profit.view" });
  });
  it("kiểm ngày đầu tháng vẫn đứng trước kiểm quyền (22023)", async () => {
    await expect(preview(db, CO_DONG_GO, "2026-09-15")).rejects.toMatchObject({ code: "22023" });
  });
  it("giữ nguyên chữ ký, search_path, volatility, ACL", async () => {
    const r = (await db.query<{ v: string; cfg: string[]; a: boolean; n: boolean; s: boolean; d: boolean }>(`
      SELECT p.provolatile v, p.proconfig cfg, p.prosecdef d,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') a,
             has_function_privilege('anon', p.oid, 'EXECUTE') n,
             has_function_privilege('service_role', p.oid, 'EXECUTE') s
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.profit_close_preview_v2(uuid,date,uuid[],jsonb)')`)).rows[0];
    expect(r).toMatchObject({ v: "v", d: true, a: true, n: false, s: true });
    expect(r.cfg).toEqual(["search_path=pg_catalog, public"]);
    expect(await preview(db, CHU, "2026-09-01")).toBeTruthy();
  });
});

describe("khối ghim md5", () => {
  it("thân authorize_v2 lạ (không phải bản đã rà, không mang dấu migration) ⇒ dừng 55000, không ghi đè", async () => {
    const la = new PGlite();
    try {
      await la.exec(NEN);
      await la.exec(SCOPE_V3);
      await la.exec(AUTHZ_CU.replace("IF v_user IS NULL THEN RETURN false; END IF;", "IF v_user IS NULL THEN RETURN NULL; END IF;"));
      await la.exec(PREVIEW_CU);
      await expect(la.exec(MIGRATION)).rejects.toMatchObject({ code: "55000" });
      await la.exec("ROLLBACK");
      const con = (await la.query<{ m: string }>(
        `SELECT p.prosrc m FROM pg_proc p WHERE p.oid = to_regprocedure('public.authorize_v2(text,uuid,text,uuid)')`)).rows[0].m;
      expect(con).toContain("RETURN NULL");
      expect(con).not.toContain("o.revoked_at IS NULL");
    } finally { await la.close(); }
  }, 60000);
  it("thân lạ có chứa đúng chuỗi dấu của migration vẫn bị từ chối (ghim theo md5, không theo chuỗi)", async () => {
    const la = new PGlite();
    try {
      await la.exec(NEN);
      await la.exec(SCOPE_V3);
      await la.exec(AUTHZ_CU.replace("IF v_user IS NULL THEN RETURN false; END IF;",
        "IF v_user IS NULL THEN RETURN false; END IF; -- AND o.revoked_at IS NULL"));
      await la.exec(PREVIEW_CU);
      await expect(la.exec(MIGRATION)).rejects.toMatchObject({ code: "55000" });
    } finally { await la.close(); }
  }, 60000);
  it("thân profit_close_preview_v2 lạ ⇒ dừng 55000", async () => {
    const la = new PGlite();
    try {
      await la.exec(NEN);
      await la.exec(SCOPE_V3);
      await la.exec(AUTHZ_CU);
      await la.exec(PREVIEW_CU.replace("AND b.is_virtual = false", "AND b.is_virtual IS NOT TRUE"));
      await expect(la.exec(MIGRATION)).rejects.toMatchObject({ code: "55000" });
    } finally { await la.close(); }
  }, 60000);
});
