import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261011091502 (K11-09 / S1-F11 / C-05, Q17): Chủ công ty ĐỌC được cổ đông,
 * lợi nhuận phân bổ và quản lý lợi nhuận của CÔNG TY MÌNH. Chạy THẬT trên PostgreSQL nhúng
 * với vai authenticated; policy cũ dựng giống production (owner_all theo user_id + ranh giới
 * org RESTRICTIVE). Migration chạy HAI lượt.
 */
const FILE = "supabase/migrations/20261011091502_chu_cong_ty_doc_co_dong_va_loi_nhuan.sql";
const BANG = [
  "shareholders", "building_shareholders", "profit_monthly", "profit_allocations",
  "profit_managers", "profit_manager_allocations", "profit_manager_salaries", "profit_manager_salary_buildings",
] as const;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, CHU_A, NGUOI_TAO, NHAN_VIEN_A, CHU_B] = [1, 2, 3, 4, 5, 6].map(id);
const db = new PGlite();

async function asUser(user: string) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user]);
  await db.exec("SET LOCAL ROLE authenticated");
}
async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
async function dem(bang: string, user: string) {
  return trongGiaoDich(async () => { await asUser(user); return (await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.${bang}`)).rows[0].n; });
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth; CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE public.memberships(user_id uuid, organization_id uuid, is_owner boolean);
    INSERT INTO public.memberships VALUES ('${CHU_A}','${ORG_A}',true),('${NGUOI_TAO}','${ORG_A}',false),('${NHAN_VIEN_A}','${ORG_A}',false),('${CHU_B}','${ORG_B}',true);
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT COALESCE(array_agg(organization_id),'{}') FROM public.memberships WHERE user_id=auth.uid() $$;
    CREATE FUNCTION app_private.my_company_owner_org_ids_v1() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT organization_id FROM public.memberships WHERE user_id=auth.uid() AND is_owner $$;
    GRANT EXECUTE ON FUNCTION app_private.my_company_owner_org_ids_v1() TO authenticated;
  `);
  for (const t of BANG) {
    await db.exec(`
      CREATE TABLE public.${t}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, user_id uuid);
      ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${t}_owner_all ON public.${t} FOR ALL TO authenticated USING (auth.uid() = user_id OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())) WITH CHECK (auth.uid() = user_id OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()));
      CREATE POLICY ${t}_org_boundary ON public.${t} AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids()))) WITH CHECK ((SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.${t} TO authenticated;
      INSERT INTO public.${t}(organization_id, user_id) VALUES ('${ORG_A}','${NGUOI_TAO}'),('${ORG_A}','${NGUOI_TAO}'),('${ORG_B}','${CHU_B}');
    `);
  }
  const sql = readFileSync(FILE, "utf8");
  await db.exec(sql);
  await db.exec(sql);
}, 30000);
afterAll(() => db.close());

describe("Q17 / K11-09 — chủ công ty đọc cổ đông & lợi nhuận của công ty mình", () => {
  it.each(BANG)("%s: chủ công ty A đọc đủ dòng của công ty A, không thấy công ty B", async (t) => {
    expect(await dem(t, CHU_A)).toBe(2);
  });
  it.each(BANG)("%s: nhân viên A không phải chủ vẫn 0 dòng; người tạo vẫn thấy dòng mình", async (t) => {
    expect(await dem(t, NHAN_VIEN_A)).toBe(0);
    expect(await dem(t, NGUOI_TAO)).toBe(2);
  });
  it("chỉ ĐỌC: chủ công ty không sửa/xoá/thêm được qua nhánh mới", async () => {
    for (const t of BANG) {
      const ketQua = await trongGiaoDich(async () => {
        await asUser(CHU_A);
        const sua = (await db.query(`UPDATE public.${t} SET user_id = user_id WHERE organization_id = $1`, [ORG_A])).affectedRows;
        const xoa = (await db.query(`DELETE FROM public.${t} WHERE organization_id = $1`, [ORG_A])).affectedRows;
        return { sua, xoa };
      });
      expect(ketQua).toEqual({ sua: 0, xoa: 0 });
      await trongGiaoDich(async () => {
        await asUser(CHU_A);
        await expect(db.query(`INSERT INTO public.${t}(organization_id, user_id) VALUES ($1, $2)`, [ORG_A, NGUOI_TAO])).rejects.toMatchObject({ code: "42501" });
      });
    }
  });
});
