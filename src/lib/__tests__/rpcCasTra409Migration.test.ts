import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261116015253: 30 hàm kiểm phiên bản (CAS) ném PT409 thay cho 40001.
 *
 * PostgREST tự chạy lại SQLSTATE 40001 không dừng — đo TEST 16/11/2026: update_meter_reading_v1 với
 * updated_at cũ treo 125 giây rồi HTTP 504. PT409 ⇒ HTTP 409 ngay. Test này chứng minh:
 *  - thân mới trong file = thân production đã ghim (md5_cu) với ĐÚNG MỘT loại thay đổi: chữ
 *    ERRCODE '40001' thành 'PT409' (đổi ngược ra đúng md5 production; production không có PT409 nào);
 *  - file ghim đúng SECURITY / search_path / tập quyền production và cấp lại quyền theo đúng thứ tự proacl;
 *  - chạy THẬT trên PostgreSQL nhúng: nạp đúng trạng thái production (thân cũ, quyền), chạy migration HAI
 *    lượt ⇒ thân khớp md5_moi, proacl giống từng ký tự; dư quyền (database dựng lại) ⇒ kéo về đúng; một
 *    hàm lệch thân / bị thu quyền / đổi search_path ⇒ dừng 55000 nêu đúng hàm, không hàm nào bị thay;
 *  - hành vi: job_recurrence_update_v1 với version cũ ném 40001 TRƯỚC migration (lỗi có thật) và PT409
 *    SAU migration, cùng câu lỗi.
 */
const FILE = "supabase/migrations/20261116015253_rpc_cas_tra_409_thay_40001.sql";
const SQL = readFileSync(FILE, "utf8").replace(/\r/g, "");
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const RE_PT409 = /(ERRCODE\s*=\s*)'PT409'/gi;
const RE_40001 = /(ERRCODE\s*=\s*)'40001'/gi;

// Nhóm (a) đã phân loại 16/11/2026, kèm proacl production (đọc chỉ đọc 16/11/2026). Đổi danh sách là đổi phạm
// vi sửa — phải sửa có chủ ý ở cả hai nơi.
const ACL_PROD: Record<string, string> = {
  "public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text)": "{postgres=X/postgres,service_role=X/postgres}",
  "public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb)": "{postgres=X/postgres,service_role=X/postgres}",
  "public.confirm_cashbook_closing_v1(uuid,numeric)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.copilot_plan_approve_v1(uuid,text,text,integer,text)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.copilot_plan_cancel_v1(uuid,integer,text)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.copilot_plan_execute_step_v1(uuid,integer,integer,uuid)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.copilot_plan_reconcile_step_v1(uuid,integer,integer)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.decide_financial_voucher(uuid,text,text,bigint)": "{postgres=X/postgres,service_role=X/postgres}",
  "public.delete_contract_draft_v1(uuid,uuid,integer)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.job_recurrence_delete_v1(uuid,integer)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.job_recurrence_set_paused_v1(uuid,integer,boolean)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.job_recurrence_update_v1(uuid,integer,jsonb)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamp with time zone,numeric,text)": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.landlord_portal_confirm_v1(text,text,text,date,integer,text)": "{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.landlord_settlement_close_v1(uuid,date,text,text)": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.landlord_settlement_confirm_v1(text,date,integer,text)": "{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.landlord_settlement_note_update_v1(uuid,date,integer,text)": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.network_center_resume_organization_v1(uuid,bigint,text,uuid)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.network_center_update_settings_v1(uuid,jsonb,bigint,uuid)": "{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}",
  "public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[],uuid[])": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.set_copilot_action_policy_v1(bigint,text,text[],boolean,text,text)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.set_copilot_feature_flag_v2(text,text,text,bigint,uuid,text,text,timestamp with time zone,text)": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.settle_reservation_deposit_v1(jsonb)": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])": "{postgres=X/postgres,authenticated=X/postgres}",
  "public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text)": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.update_meter_reading_v1(uuid,numeric,date,text,text,timestamp with time zone)": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  "app_private.commission_reason_cancel_flex_before_v1(uuid,text,bigint,bigint)": "{postgres=X/postgres}",
};
const DU_KIEN = Object.keys(ACL_PROD);
/** Vai được cấp EXECUTE theo đúng thứ tự trong proacl (bỏ owner postgres). */
const vaiTheoThuTu = (acl: string) =>
  acl.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((x) => x.split("=")[0]).filter((v) => v !== "postgres");

type Ghim = {
  ham: string; md5Cu: string; md5Moi: string; soCho: number; baoMat: boolean; cauHinh: string; quyen: string;
  cau: string; thanMoi: string; thanCu: string;
};

function khoi(tag: string): string {
  const m = new RegExp(`DO \\$${tag}\\$[\\s\\S]*?\\$${tag}\\$;`).exec(SQL);
  if (!m) throw new Error(`Không thấy khối ${tag}`);
  return m[0];
}

/** Câu CREATE OR REPLACE của đúng một hàm: từ tiêu đề tới `$function$;`. */
function cauTao(ham: string): string {
  const ten = ham.slice(0, ham.indexOf("("));
  const dau = SQL.indexOf(`CREATE OR REPLACE FUNCTION ${ten}(`);
  if (dau < 0) throw new Error(`Không thấy câu tạo ${ten}`);
  if (SQL.indexOf(`CREATE OR REPLACE FUNCTION ${ten}(`, dau + 1) >= 0) throw new Error(`${ten} có hơn một câu tạo`);
  const mo = SQL.indexOf("AS $function$", dau);
  const dong = SQL.indexOf("$function$;", mo + "AS $function$".length);
  return SQL.slice(dau, dong + "$function$;".length);
}
const thanCua = (cau: string) => cau.slice(cau.indexOf("AS $function$") + "AS $function$".length, cau.lastIndexOf("$function$;"));

const GHIM: Ghim[] = (() => {
  const truoc = [...khoi("kiem_truoc").matchAll(/\('([^']+)', '([0-9a-f]{32})', '([0-9a-f]{32})', (true|false), '([^']*)', '([^']*)'\)/g)];
  const sau = new Map(
    [...khoi("kiem_sau").matchAll(/\('([^']+)', '([0-9a-f]{32})', (\d+), (true|false), '([^']*)', '([^']*)'\)/g)]
      .map((m) => [m[1], { md5Moi: m[2], soCho: Number(m[3]), khoa: `${m[4]}|${m[5]}|${m[6]}` }]),
  );
  return truoc.map((m) => {
    const cau = cauTao(m[1]);
    const thanMoi = thanCua(cau);
    const s = sau.get(m[1]);
    if (!s || s.md5Moi !== m[3] || s.khoa !== `${m[4]}|${m[5]}|${m[6]}`) throw new Error(`${m[1]}: hai khối kiểm ghim lệch nhau`);
    return {
      ham: m[1], md5Cu: m[2], md5Moi: m[3], soCho: s.soCho, baoMat: m[4] === "true", cauHinh: m[5], quyen: m[6],
      cau, thanMoi, thanCu: thanMoi.replace(RE_PT409, "$1'40001'"),
    };
  });
})();

/** Câu tạo bản production (thân cũ) — dựng ngược từ file; test dưới chứng minh khớp md5 production. */
const cauCu = (g: Ghim) => g.cau.replace(g.thanMoi, () => g.thanCu);

const NEN = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA extensions;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  -- Kiểu trả về của ba hàm job_recurrence_* và update_meter_reading_v1; thân hàm không kiểm lúc tạo.
  CREATE TABLE public.job_recurrence_rules(
    id uuid PRIMARY KEY, title text, description text, assignee_id uuid, priority text, frequency text,
    every smallint, weekdays smallint[], month_day smallint, start_date date, end_date date, due_days smallint,
    version integer NOT NULL DEFAULT 1, paused_at timestamptz, deleted_at timestamptz);
  CREATE TABLE public.meter_readings(id uuid PRIMARY KEY);
`;

/** Dựng đúng trạng thái production: thân cũ + quyền đúng thứ tự proacl production. `sua` làm lệch một hàm. */
async function napProduction(db: PGlite, sua?: (g: Ghim, cau: string) => string) {
  await db.exec(NEN);
  await db.exec("SET check_function_bodies = off;");
  for (const g of GHIM) {
    await db.exec((sua ?? ((_, c) => c))(g, cauCu(g)));
    const vai = vaiTheoThuTu(ACL_PROD[g.ham]);
    await db.exec(`REVOKE ALL ON FUNCTION ${g.ham} FROM PUBLIC;`);
    if (vai.length) await db.exec(`GRANT EXECUTE ON FUNCTION ${g.ham} TO ${vai.join(", ")};`);
  }
}

/** md5 thân, proacl dạng chữ, SECURITY và proconfig của 30 hàm. */
async function trangThai(db: PGlite) {
  const r = await db.query<{ ham: string; md5: string; acl: string; bao_mat: boolean; cau_hinh: string }>(
    `SELECT t.ham, md5(p.prosrc) AS md5, p.proacl::text AS acl, p.prosecdef AS bao_mat, p.proconfig::text AS cau_hinh
       FROM unnest($1::text[]) AS t(ham) JOIN pg_proc p ON p.oid = to_regprocedure(t.ham)`,
    [GHIM.map((g) => g.ham)],
  );
  return new Map(r.rows.map((x) => [x.ham, x]));
}

async function loiCua(p: Promise<unknown>) {
  return p.then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }));
}

describe("20261116015253 — CAS trả PT409 thay 40001", () => {
  it("ghim đúng 30 hàm nhóm (a), mỗi hàm một câu CREATE", () => {
    expect(GHIM.map((g) => g.ham).sort()).toEqual([...DU_KIEN].sort());
    expect(GHIM.reduce((s, g) => s + g.soCho, 0)).toBe(44);
  });

  it("thân mới khớp md5_moi, không còn ERRCODE 40001, số chỗ PT409 đúng khối kiểm sau", () => {
    for (const g of GHIM) {
      expect(md5(g.thanMoi), g.ham).toBe(g.md5Moi);
      expect(g.thanMoi.match(RE_40001), g.ham).toBeNull();
      expect((g.thanMoi.match(RE_PT409) ?? []).length, g.ham).toBe(g.soCho);
    }
  });

  it("đổi ngược PT409 → 40001 ra đúng thân production đã ghim: chỉ mã lỗi đổi, câu lỗi giữ nguyên", () => {
    for (const g of GHIM) {
      expect(md5(g.thanCu), g.ham).toBe(g.md5Cu);
      expect(g.thanCu.match(/PT409/g), g.ham).toBeNull();
    }
  });

  it("ghim SECURITY khớp chính câu tạo; tập quyền ghim = tập vai trong proacl production", () => {
    for (const g of GHIM) {
      expect(/\n SECURITY DEFINER\n/.test(g.cau), g.ham).toBe(g.baoMat);
      expect(g.quyen, g.ham).toBe([...vaiTheoThuTu(ACL_PROD[g.ham])].sort().join(","));
    }
  });

  it("file định nghĩa sống cấp lại quyền theo đúng thứ tự proacl production: REVOKE PUBLIC + vai API, GRANT", () => {
    for (const g of GHIM) {
      const sau = SQL.slice(SQL.indexOf(g.cau) + g.cau.length).split("\n").slice(1, 4).filter((l) => /^(REVOKE|GRANT) /.test(l));
      const vai = vaiTheoThuTu(ACL_PROD[g.ham]);
      expect(sau, g.ham).toEqual([
        `REVOKE ALL ON FUNCTION ${g.ham} FROM PUBLIC;`,
        `REVOKE ALL ON FUNCTION ${g.ham} FROM anon, authenticated, service_role;`,
        ...(vai.length ? [`GRANT EXECUTE ON FUNCTION ${g.ham} TO ${vai.join(", ")};`] : []),
      ]);
    }
  });
});

describe("20261116015253 — chạy thật trên PostgreSQL nhúng", () => {
  const db = new PGlite();
  beforeAll(async () => {
    await napProduction(db);
    await db.exec(`INSERT INTO public.job_recurrence_rules(id, title, version)
                   VALUES ('00000000-0000-4000-8000-000000000001', 'Việc mẫu', 2);
                   SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false);`);
  }, 60000);
  afterAll(() => db.close());

  const goiLechVersion = () =>
    loiCua(db.query(`SELECT public.job_recurrence_update_v1('00000000-0000-4000-8000-000000000001', 1, '{"title":"Mới"}'::jsonb)`));

  it("trước migration: đúng trạng thái production (md5, proacl, SECURITY, search_path); version cũ ném 40001", async () => {
    const tt = await trangThai(db);
    for (const g of GHIM) {
      expect(tt.get(g.ham)?.md5, g.ham).toBe(g.md5Cu);
      expect(tt.get(g.ham)?.acl, g.ham).toBe(ACL_PROD[g.ham]);
      expect(tt.get(g.ham)?.bao_mat, g.ham).toBe(g.baoMat);
      expect(tt.get(g.ham)?.cau_hinh, g.ham).toBe(g.cauHinh);
    }
    expect(await goiLechVersion()).toEqual({ code: "40001", message: "job_recurrence_conflict" });
  });

  it("migration chạy hai lượt: thân khớp md5_moi, proacl giống từng ký tự; version cũ ném PT409 cùng câu lỗi", async () => {
    await db.exec(SQL);
    await db.exec(SQL);
    const sau = await trangThai(db);
    for (const g of GHIM) {
      expect(sau.get(g.ham)?.md5, g.ham).toBe(g.md5Moi);
      expect(sau.get(g.ham)?.acl, g.ham).toBe(ACL_PROD[g.ham]);
      expect(sau.get(g.ham)?.bao_mat, g.ham).toBe(g.baoMat);
      expect(sau.get(g.ham)?.cau_hinh, g.ham).toBe(g.cauHinh);
    }
    expect(await goiLechVersion()).toEqual({ code: "PT409", message: "job_recurrence_conflict" });
    const conLai = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'app_private') AND p.prosrc ~* $re$errcode\\s*=\\s*'40001'$re$`,
    );
    expect(conLai.rows[0].n).toBe(0);
  });
});

describe("20261116015253 — database dựng lại (baseline --no-acl + shim cấp EXECUTE cho mọi vai API)", () => {
  it("dư quyền PUBLIC / anon / authenticated / service_role ⇒ vẫn chạy, quyền về đúng proacl production", async () => {
    const la = new PGlite();
    try {
      await napProduction(la);
      for (const g of GHIM) await la.exec(`GRANT EXECUTE ON FUNCTION ${g.ham} TO PUBLIC, anon, authenticated, service_role;`);
      await la.exec(SQL);
      const tt = await trangThai(la);
      for (const g of GHIM) {
        expect(tt.get(g.ham)?.md5, g.ham).toBe(g.md5Moi);
        expect(tt.get(g.ham)?.acl, g.ham).toBe(ACL_PROD[g.ham]);
      }
    } finally {
      await la.close();
    }
  }, 60000);
});

describe("20261116015253 — kiểm sau bắt file sai, cả giao dịch lùi", () => {
  it("file cấp thừa anon cho một hàm ⇒ kiểm sau ném 55000 nêu đúng hàm; ROLLBACK trả lại thân cũ cho cả 30 hàm", async () => {
    const la = new PGlite();
    try {
      await napProduction(la);
      const sai = "public.landlord_settlement_close_v1(uuid,date,text,text)";
      const sqlSai = SQL.replace(`GRANT EXECUTE ON FUNCTION ${sai} TO authenticated, service_role;`,
        `GRANT EXECUTE ON FUNCTION ${sai} TO anon, authenticated, service_role;`);
      expect(sqlSai).not.toBe(SQL);
      const loi = await loiCua(la.exec(sqlSai));
      expect(loi?.code).toBe("55000");
      expect(loi?.message).toContain(sai);
      expect(loi?.message).toMatch(/lệch SECURITY \/ proconfig \/ quyền/);
      await la.exec("ROLLBACK");
      const tt = await trangThai(la);
      for (const g of GHIM) {
        expect(tt.get(g.ham)?.md5, g.ham).toBe(g.md5Cu);
        expect(tt.get(g.ham)?.acl, g.ham).toBe(ACL_PROD[g.ham]);
      }
    } finally {
      await la.close();
    }
  }, 60000);
});

describe("20261116015253 — production lệch bản đã rà thì dừng, không ghi gì", () => {
  const LECH = "public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)";
  const CA: [string, (la: PGlite) => Promise<void>, RegExp][] = [
    ["PR khác vừa sửa thân",
      (la) => napProduction(la, (g, cau) => (g.ham === LECH ? cau.replace("AS $function$", "AS $function$\n-- PR khác vừa sửa") : cau)),
      /Thân .* đã khác/],
    ["PR khác vừa thu quyền (file không được âm thầm cấp lại)",
      async (la) => { await napProduction(la); await la.exec(`REVOKE EXECUTE ON FUNCTION ${LECH} FROM authenticated;`); },
      /Thuộc tính .* đã khác/],
    ["PR khác vừa đổi search_path",
      async (la) => { await napProduction(la); await la.exec(`ALTER FUNCTION ${LECH} SET search_path = public;`); },
      /Thuộc tính .* đã khác/],
  ];
  it.each(CA)("%s ⇒ 55000 nêu đúng hàm, không hàm nào bị thay", async (_ten, dung, cau) => {
    const la = new PGlite();
    try {
      await dung(la);
      const loi = await loiCua(la.exec(SQL));
      expect(loi?.code).toBe("55000");
      expect(loi?.message).toContain(LECH);
      expect(loi?.message).toMatch(cau);
      await la.exec("ROLLBACK");
      const tt = await trangThai(la);
      for (const g of GHIM) {
        if (g.ham !== LECH) expect(tt.get(g.ham)?.md5, g.ham).toBe(g.md5Cu);
      }
    } finally {
      await la.close();
    }
  }, 60000);
});
