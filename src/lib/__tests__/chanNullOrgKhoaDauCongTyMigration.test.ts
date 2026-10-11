import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261011042329 (plan 0.1 / N-A6-11, rà soát 11/10/2026 F2 + F3):
 *   - 35 bảng ghi từ client: trigger điền org fail-closed + NOT NULL + policy
 *     ranh giới bỏ nhánh `organization_id IS NULL`;
 *   - khoá dấu công ty: BEFORE UPDATE OF organization_id trên mọi bảng có cột
 *     org (trừ sổ miễn trừ), SECURITY INVOKER, cho mã máy chủ đi qua.
 *
 * Chạy THẬT trên PostgreSQL nhúng (PGlite) với vai authenticated / service_role,
 * chạy migration HAI lượt (idempotent). Test đỏ nếu bỏ trigger khoá, đổi nó sang
 * DEFINER, để lọt nhánh NULL, hay mất cột cha mới của hàm suy org.
 */
const FILE = "supabase/migrations/20261011042329_chan_null_org_va_khoa_dau_cong_ty.sql";
const sql = readFileSync(FILE, "utf8");

const BANG_35 = [
  "materials", "material_categories", "material_purchases", "material_purchase_items",
  "material_adjustments", "material_adjustment_items", "income_expense_templates",
  "job_groups", "lead_activities", "hotlines", "ct01_declarations",
  "service_quotas", "service_quota_tiers",
  "asset_handovers", "asset_movements", "asset_maintenance", "asset_warehouses",
  "auto_debt_config", "area_buildings",
  "areas", "shareholders", "building_shareholders", "profit_managers",
  "profit_manager_salaries", "profit_manager_salary_buildings", "manager_salary_config",
  "salary_bonus_rules", "salary_holidays", "salary_work_ledger_snapshot",
  "user_subscriptions", "push_subscriptions", "invoice_generation_settings",
  "material_usages", "material_usage_items", "settings",
] as const;
const BANG_GIU = ["settings", "push_subscriptions", "invoice_generation_settings"];
const BANG_LOI = ["rooms", "buildings", "customers", "contracts", "invoices", "payments", "income_expenses", "accounts"];
/** Cột cha riêng của từng bảng trong fixture (ngoài id / organization_id / user_id). */
const COT_CHA: Record<string, string[]> = {
  material_purchase_items: ["purchase_id uuid", "material_id uuid"],
  material_adjustment_items: ["adjustment_id uuid", "material_id uuid"],
  material_usage_items: ["usage_id uuid", "material_id uuid"],
  service_quota_tiers: ["quota_id uuid"],
  asset_movements: ["asset_id uuid"],
  asset_maintenance: ["asset_id uuid"],
  lead_activities: ["lead_id uuid"],
  profit_manager_salaries: ["manager_id uuid"],
  salary_work_ledger_snapshot: ["salary_monthly_id uuid"],
  asset_handovers: ["contract_id uuid"],
  ct01_declarations: ["customer_id uuid"],
  area_buildings: ["building_id uuid"],
  building_shareholders: ["building_id uuid"],
  profit_manager_salary_buildings: ["building_id uuid"],
  asset_warehouses: ["building_id uuid"],
  auto_debt_config: ["building_id uuid"],
  settings: ["key text", "value text", "UNIQUE (user_id, key)"],
  push_subscriptions: ["endpoint text UNIQUE"],
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, U_MOT, U_HAI] = [1, 2, 3, 4].map(id);
const db = new PGlite();

async function loi(cau: string): Promise<string | null> {
  try {
    await db.exec(cau);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "khong-ma";
  }
}
async function voiVai<T>(vai: "authenticated" | "service_role", fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${vai}`);
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
  }
}
async function org(bang: string, dong: string): Promise<string | null> {
  const r = await db.query<{ organization_id: string | null }>(
    `SELECT organization_id FROM public.${bang} WHERE id = '${dong}'`,
  );
  return r.rows[0]?.organization_id ?? null;
}

beforeAll(async () => {
  const bien = "organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids()))";
  const bang = (ten: string, them: string[] = []) =>
    `CREATE TABLE public.${ten} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid, name text${
      them.length ? ", " + them.join(", ") : ""
    });` +
    // Ranh giới như production (có nhánh NULL) — riêng hotlines bỏ trống để thử nhánh CREATE POLICY.
    (ten === "hotlines"
      ? ""
      : `CREATE POLICY ${ten}_org_boundary ON public.${ten} AS RESTRICTIVE FOR ALL TO authenticated USING (${bien}) WITH CHECK (${bien});`);
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA app_private;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${ORG_A}'::uuid] $$;
    CREATE TABLE public.organization_memberships (user_id uuid, organization_id uuid, status text);
    INSERT INTO public.organization_memberships VALUES
      ('${U_MOT}', '${ORG_A}', 'ACTIVE'),
      ('${U_HAI}', '${ORG_A}', 'ACTIVE'), ('${U_HAI}', '${ORG_B}', 'ACTIVE');
    CREATE TABLE app_private.org_boundary_exemptions (table_name text PRIMARY KEY);
    INSERT INTO app_private.org_boundary_exemptions VALUES ('personal_transactions');
    CREATE TABLE public.personal_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid);
    CREATE TABLE public.khong_org (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ghi_chu text);
    -- Bảng cha của các cột cha mới / cũ dùng trong phép thử.
    CREATE TABLE public.assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL);
    CREATE TABLE public.leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid);
    CREATE TABLE public.salary_monthly (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid);
    -- "Đã có trigger strict" như production (settings, material_usages, material_usage_items):
    -- bản giả trước migration, migration thay thân hàm và KHÔNG gắn trùng.
    CREATE FUNCTION app_private.autofill_org_strict() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;
  `);
  for (const t of BANG_LOI) await db.exec(bang(t, t === "rooms" ? ["building_id uuid"] : []));
  for (const t of BANG_35) await db.exec(bang(t, COT_CHA[t] ?? []));
  await db.exec(`
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.settings FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.material_usages FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.material_usage_items FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
  `);
  // Hai lượt: migration phải idempotent.
  await db.exec(sql);
  await db.exec(sql);
  await db.exec(`
    INSERT INTO public.rooms (id, organization_id, name) VALUES ('${id(10)}', '${ORG_A}', 'P101');
    INSERT INTO public.material_purchases (id, organization_id, user_id) VALUES ('${id(11)}', '${ORG_B}', '${U_HAI}');
    INSERT INTO public.assets (id, organization_id) VALUES ('${id(12)}', '${ORG_B}');
    INSERT INTO public.salary_monthly (id, organization_id) VALUES ('${id(13)}', '${ORG_B}');
    INSERT INTO public.settings (id, organization_id, user_id, key, value) VALUES ('${id(14)}', '${ORG_A}', '${U_HAI}', 'k', 'cu');
    -- Hàm máy chủ (DEFINER, chủ = postgres) được đổi dấu công ty: luồng hợp lệ phải đi qua.
    CREATE FUNCTION public.may_chu_doi_org(p_room uuid, p_org uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
      AS $$ UPDATE public.rooms SET organization_id = p_org WHERE id = p_room $$;
    GRANT EXECUTE ON FUNCTION public.may_chu_doi_org(uuid, uuid) TO authenticated;
  `);
}, 60000);

afterAll(async () => {
  await db.close();
});

describe("35 bảng: NOT NULL + trigger điền org + ranh giới không nhánh NULL", () => {
  it("danh sách bảng trong migration đúng 35 bảng của test (cả khối sửa lẫn khối nghiệm thu)", () => {
    const khoi = [...sql.matchAll(/ds text\[\] := ARRAY\[([\s\S]*?)\];/g)].map((m) =>
      [...m[1].replace(/--.*$/gm, "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]).sort(),
    );
    expect(khoi).toHaveLength(2);
    for (const ds of khoi) expect(ds).toEqual([...BANG_35].sort());
    expect(sql).not.toMatch(/'profiles'/);
  });

  it.each(BANG_35)("%s: organization_id NOT NULL, đúng một trigger autofill_org_strict", async (t) => {
    const r = await db.query<{ nn: boolean; trg: number }>(`
      SELECT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass AND attname = 'organization_id') AS nn,
             (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.${t}'::regclass
                AND tgfoid = 'app_private.autofill_org_strict()'::regprocedure AND NOT tgisinternal) AS trg`);
    expect(r.rows[0]).toEqual({ nn: true, trg: 1 });
  });

  it.each(BANG_35)("%s: policy ranh giới RESTRICTIVE, không còn IS NULL ở USING lẫn WITH CHECK", async (t) => {
    const r = await db.query<{ q: string; w: string; permissive: boolean }>(`
      SELECT pg_get_expr(polqual, polrelid) AS q, pg_get_expr(polwithcheck, polrelid) AS w, polpermissive AS permissive
        FROM pg_policy WHERE polrelid = 'public.${t}'::regclass AND polname = '${t}_org_boundary'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].permissive).toBe(false);
    expect(r.rows[0].q).not.toMatch(/IS NULL/i);
    expect(r.rows[0].w).not.toMatch(/IS NULL/i);
    expect(r.rows[0].q).toMatch(/my_org_ids/);
  });

  it("bảng ngoài danh sách giữ nguyên (rooms vẫn cho NULL, policy cũ không bị sửa)", async () => {
    const r = await db.query<{ nn: boolean; q: string }>(`
      SELECT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.rooms'::regclass AND attname = 'organization_id') AS nn,
             (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'rooms_org_boundary') AS q`);
    expect(r.rows[0].nn).toBe(false);
    expect(r.rows[0].q).toMatch(/IS NULL/);
  });
});

describe("autofill_org_strict: cột cha mới + fail-closed", () => {
  it("người thuộc HAI công ty, không gửi org, không có cha ⇒ 23502", async () => {
    expect(await voiVai("authenticated", () => loi(`INSERT INTO public.materials (user_id, name) VALUES ('${U_HAI}', 'Ống nước')`))).toBe("23502");
  });

  it("người thuộc MỘT công ty, không gửi org ⇒ điền theo người", async () => {
    await voiVai("authenticated", () => db.exec(`INSERT INTO public.materials (id, user_id, name) VALUES ('${id(20)}', '${U_MOT}', 'Bóng đèn')`));
    expect(await org("materials", id(20))).toBe(ORG_A);
  });

  it("client gửi org của công ty đang chọn ⇒ giữ nguyên", async () => {
    await voiVai("authenticated", () => db.exec(`INSERT INTO public.hotlines (id, organization_id, user_id, name) VALUES ('${id(21)}', '${ORG_B}', '${U_HAI}', 'Hotline')`));
    expect(await org("hotlines", id(21))).toBe(ORG_B);
  });

  it.each([
    ["material_purchase_items", "purchase_id", id(11)],
    ["asset_movements", "asset_id", id(12)],
    ["salary_work_ledger_snapshot", "salary_monthly_id", id(13)],
  ])("%s suy org từ %s (cha thuộc công ty B) dù người ghi thuộc hai công ty", async (bang, cot, cha) => {
    const dong = id(30 + bang.length);
    await voiVai("authenticated", () => db.exec(`INSERT INTO public.${bang} (id, user_id, ${cot}) VALUES ('${dong}', '${U_HAI}', '${cha}')`));
    expect(await org(bang, dong)).toBe(ORG_B);
  });

  it("thứ tự 15 cột cha cũ giữ nguyên, 7 cột mới nằm cuối mảng", () => {
    const than = /CREATE OR REPLACE FUNCTION app_private\.autofill_org_strict\(\)[\s\S]*?cha\s+text\[\]\[\] := ARRAY\[([\s\S]*?)\];/.exec(sql);
    expect(than).not.toBeNull();
    const cot = [...than![1].matchAll(/ARRAY\['([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(cot).toEqual([
      "building_id", "room_id", "contract_id", "invoice_id", "income_expense_id", "account_id", "customer_id",
      "session_id", "usage_id", "handover_id", "batch_id", "meter_id", "deposit_id", "job_id", "tenant_id",
      "purchase_id", "adjustment_id", "quota_id", "asset_id", "lead_id", "manager_id", "salary_monthly_id",
    ]);
  });
});

describe("khoá dấu công ty (F3)", () => {
  it("client (authenticated) gỡ dấu: SET organization_id = NULL ⇒ 42501", async () => {
    expect(await voiVai("authenticated", () => loi(`UPDATE public.rooms SET organization_id = NULL WHERE id = '${id(10)}'`))).toBe("42501");
    expect(await org("rooms", id(10))).toBe(ORG_A);
  });

  it("client chuyển dòng sang công ty khác ⇒ 42501", async () => {
    expect(await voiVai("authenticated", () => loi(`UPDATE public.rooms SET organization_id = '${ORG_B}' WHERE id = '${id(10)}'`))).toBe("42501");
  });

  it("client sửa cột khác, hoặc gửi lại đúng org cũ ⇒ đi qua", async () => {
    expect(await voiVai("authenticated", () => loi(`UPDATE public.rooms SET name = 'P101A' WHERE id = '${id(10)}'`))).toBeNull();
    expect(await voiVai("authenticated", () => loi(`UPDATE public.rooms SET organization_id = '${ORG_A}', name = 'P101' WHERE id = '${id(10)}'`))).toBeNull();
  });

  it("hàm máy chủ SECURITY DEFINER do client gọi ⇒ được đổi (luồng hợp lệ)", async () => {
    await voiVai("authenticated", () => db.exec(`SELECT public.may_chu_doi_org('${id(10)}', '${ORG_B}')`));
    expect(await org("rooms", id(10))).toBe(ORG_B);
  });

  it("service_role và postgres ⇒ được đổi", async () => {
    await voiVai("service_role", () => db.exec(`UPDATE public.rooms SET organization_id = '${ORG_A}' WHERE id = '${id(10)}'`));
    expect(await org("rooms", id(10))).toBe(ORG_A);
    await db.exec(`UPDATE public.rooms SET organization_id = '${ORG_B}' WHERE id = '${id(10)}'`);
    expect(await org("rooms", id(10))).toBe(ORG_B);
  });

  it("bảng cấu hình theo người (chế độ giu): upsert khác công ty ⇒ giữ org cũ, vẫn lưu giá trị", async () => {
    await voiVai("authenticated", () =>
      db.exec(`INSERT INTO public.settings (organization_id, user_id, key, value) VALUES ('${ORG_B}', '${U_HAI}', 'k', 'moi')
               ON CONFLICT (user_id, key) DO UPDATE SET organization_id = EXCLUDED.organization_id, value = EXCLUDED.value`));
    const r = await db.query<{ organization_id: string; value: string }>(`SELECT organization_id, value FROM public.settings WHERE id = '${id(14)}'`);
    expect(r.rows[0]).toEqual({ organization_id: ORG_A, value: "moi" });
  });

  it("trigger gắn trên MỌI bảng có cột organization_id trừ sổ miễn trừ; đúng chế độ từng bảng", async () => {
    const r = await db.query<{ relname: string; def: string | null }>(`
      SELECT c.relname, (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'zz_khoa_organization_id') AS def
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`);
    const theoBang = new Map(r.rows.map((x) => [x.relname, x.def]));
    expect(theoBang.get("personal_transactions")).toBeNull();
    for (const t of [...BANG_35, ...BANG_LOI]) {
      const def = theoBang.get(t);
      expect(def, `${t} thiếu trigger khoá`).toMatch(/BEFORE UPDATE OF organization_id ON public\.\S+ FOR EACH ROW/);
      expect(def).toContain(`khoa_organization_id_v1('${BANG_GIU.includes(t) ? "giu" : "chan"}')`);
    }
    const khongOrg = await db.query(`SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.khong_org'::regclass AND NOT tgisinternal`);
    expect(khongOrg.rows).toHaveLength(0);
  });

  it("hàm khoá là SECURITY INVOKER, canh current_user (không session_user); client không EXECUTE trực tiếp được", async () => {
    const r = await db.query<{ definer: boolean; anon: boolean; auth: boolean }>(`
      SELECT prosecdef AS definer,
             has_function_privilege('anon', oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', oid, 'EXECUTE') AS auth
        FROM pg_proc WHERE oid = 'app_private.khoa_organization_id_v1()'::regprocedure`);
    expect(r.rows[0]).toEqual({ definer: false, anon: false, auth: false });
    const than = /FUNCTION app_private\.khoa_organization_id_v1\(\)[\s\S]*?\$f\$([\s\S]*?)\$f\$/.exec(sql)![1];
    expect(than.replace(/--.*$/gm, "")).not.toMatch(/session_user/);
    expect(than).toMatch(/current_user IN \('postgres', 'service_role', 'supabase_admin'\)/);
  });
});
