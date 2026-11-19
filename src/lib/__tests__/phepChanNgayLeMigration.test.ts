import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261119035131 — phép trên Chủ nhật / ngày lễ bị chặn ở MỌI đường (request_paid_leave một ngày,
 * approve_leave, approve_leave_batch) + câu thiếu số dư của đơn nhiều ngày nêu ngày bị chặn.
 *
 * Chạy THẬT trên PostgreSQL nhúng theo đúng thứ tự phát hành: request_paid_leave của 20261007082645 và approve_leave của
 * 20260703000004 (đúng thân đang chạy production — tiền kiểm của migration so md5) → 20261119020927 → migration này HAI
 * lượt. Bản giả như xinNghiPhepNhieuNgayMigration.test.ts; ngày lễ là bảng salary_holidays theo tổ chức (vn_workdays giả
 * đọc ngày lễ của tổ chức người gọi). "Hôm nay" đóng đinh 19/11/2026 (thứ Năm); Chủ nhật 22/11, 29/11.
 * Một kết nối: khoá advisory / ORDER BY ... FOR UPDATE không đo được ở đây (đo hai phiên thật trên TEST).
 */
const FILE = "supabase/migrations/20261119035131_chan_phep_ngay_le_va_va_nho.sql";
const FILE_NHIEU_NGAY = "supabase/migrations/20261119020927_xin_nghi_phep_nhieu_ngay.sql";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, CHU, JOEY] = [1, 2, 3, 4].map(id);
const db = new PGlite();

/** Nguyên văn câu tạo hàm `public.<ten>` trong một file migration (tới hết dấu đóng thân + ";"). */
function cauTao(file: string, ten: string): string {
  const sql = readFileSync(file, "utf8");
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${ten}(`);
  const m = /AS\s+(\$[a-z_]*\$)/i.exec(sql.slice(i));
  if (i < 0 || !m) throw new Error(`Không thấy câu tạo ${ten} trong ${file}`);
  const batDau = i + m.index + m[0].length;
  return sql.slice(i, sql.indexOf(`${m[1]};`, batDau) + m[1].length + 1);
}

type LoiPg = { code?: string; message: string; hint?: string };
async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
async function goi<T>(user: string, sql: string, params: unknown[]): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
  await db.exec("SET LOCAL ROLE authenticated");
  const r = await db.query<{ r: T }>(sql, params);
  await db.exec("RESET ROLE");
  return r.rows[0].r;
}
async function loi(fn: () => Promise<unknown>): Promise<LoiPg> {
  await db.exec("SAVEPOINT truoc_loi");
  try { await fn(); } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT truoc_loi");
    await db.exec("RESET ROLE");
    return e as LoiPg;
  }
  throw new Error("Lệnh không ném lỗi");
}
const xinMotNgay = (date: string) => goi(JOEY, "SELECT public.request_paid_leave($1::date, 'thử') AS r", [date]);
const xinKhoang = (from: string, to: string) => goi(JOEY, "SELECT public.request_paid_leave_range($1::date, $2::date) AS r", [from, to]);
const duyetMotNgay = (date: string, ok: boolean) => goi(CHU, "SELECT public.approve_leave($1::uuid, $2::date, $3) AS r", [JOEY, date, ok]);
const duyetDon = (dates: string[], ok: boolean) =>
  goi(CHU, "SELECT public.approve_leave_batch($1::uuid, $2::date[], $3) AS r", [JOEY, `{${dates.join(",")}}`, ok]);
async function trangThai(date: string): Promise<string | undefined> {
  return (await db.query<{ status: string }>("SELECT status FROM public.salary_attendance_day WHERE user_id = $1 AND work_date = $2::date", [JOEY, date])).rows[0]?.status;
}
async function choDuyet(...dates: string[]) {
  for (const d of dates) await db.query("INSERT INTO public.salary_attendance_day (user_id, work_date, status) VALUES ($1, $2::date, 'pending_leave')", [JOEY, d]);
}
async function ngayLe(date: string, org = ORG_A) {
  await db.query("INSERT INTO public.salary_holidays (organization_id, holiday_date) VALUES ($1, $2::date)", [org, date]);
}
async function daDung(n: number) {
  for (let i = 0; i < n; i++) {
    await db.query("INSERT INTO public.salary_attendance_day (user_id, work_date, status) VALUES ($1, $2::date, 'leave_approved')",
      [JOEY, `2026-${String((i % 10) + 1).padStart(2, "0")}-${String(5 + Math.floor(i / 10)).padStart(2, "0")}`]);
  }
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    SET test.today = '2026-11-19';
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.organizations (id uuid PRIMARY KEY);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.super_admins (user_id uuid PRIMARY KEY, created_at timestamptz NOT NULL);
    CREATE TABLE public.memberships (user_id uuid, organization_id uuid);
    CREATE TABLE public.salary_holidays (organization_id uuid NOT NULL, holiday_date date NOT NULL);
    CREATE TABLE public.salary_award_errors (staff_id uuid, fn_name text, error_text text, payload jsonb);
    CREATE TABLE public.salary_attendance_day (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users(id),
      work_date date NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','pending_check','pending_leave','ticked','leave_approved','neutral','expired','flagged','voided')),
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      audit jsonb NOT NULL DEFAULT '[]'::jsonb,
      organization_id uuid REFERENCES public.organizations(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, work_date)
    );
    CREATE FUNCTION public.tu_dien_to_chuc() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS NULL THEN
        SELECT m.organization_id INTO NEW.organization_id FROM public.memberships m WHERE m.user_id = NEW.user_id ORDER BY m.organization_id LIMIT 1;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a90_autofill_org BEFORE INSERT ON public.salary_attendance_day FOR EACH ROW EXECUTE FUNCTION public.tu_dien_to_chuc();
    CREATE TABLE public.notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid NOT NULL,
      type text NOT NULL, channel text NOT NULL, status text NOT NULL, subject text, content text, metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE FUNCTION public.get_salary_v5_config(p_org uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
      RETURN '{"system_v5":{"shield_bank_from":"2026-09-01"},"attendance_v5":{"paid_leave_days_per_month":1}}'::jsonb;
    END $$;
    -- Ngày làm của tổ chức NGƯỜI GỌI: T2–T7 trừ salary_holidays của tổ chức đó (người gọi một tổ chức trong các ca).
    CREATE FUNCTION public.vn_workdays(p_month date) RETURNS SETOF date LANGUAGE plpgsql STABLE AS $$
    DECLARE v_dau date := date_trunc('month', p_month)::date;
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
      RETURN QUERY SELECT v_dau + k FROM generate_series(0, 30) AS k
        WHERE v_dau + k < (v_dau + interval '1 month')::date AND extract(dow FROM v_dau + k) <> 0
          AND v_dau + k NOT IN (SELECT h.holiday_date FROM public.salary_holidays h
                                 JOIN public.memberships m ON m.organization_id = h.organization_id WHERE m.user_id = auth.uid());
    END $$;
    CREATE FUNCTION public.vn_local_date(ts timestamptz) RETURNS date LANGUAGE sql STABLE AS $$ SELECT current_setting('test.today')::date $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = auth.uid()) $$;
    CREATE FUNCTION public.v5_recompute_streak(p_user uuid, p_month date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN RETURN '{}'::jsonb; END $$;

    INSERT INTO public.organizations VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO auth.users VALUES ('${CHU}'), ('${JOEY}');
    INSERT INTO public.profiles VALUES ('${CHU}', 'Chủ'), ('${JOEY}', 'JOEY');
    INSERT INTO public.super_admins VALUES ('${CHU}', '2026-01-01');
    INSERT INTO public.memberships VALUES ('${JOEY}', '${ORG_A}'), ('${CHU}', '${ORG_A}');
  `);
  // Đúng thân production của hai hàm cũ (tiền kiểm của migration so md5), ACL như production.
  await db.exec(cauTao("supabase/migrations/20261007082645_request_paid_leave_notification_org.sql", "request_paid_leave"));
  await db.exec(cauTao("supabase/migrations/20260703000004_v5_myday.sql", "approve_leave"));
  await db.exec(`
    REVOKE ALL ON FUNCTION public.request_paid_leave(date, text) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.request_paid_leave(date, text) TO authenticated, service_role;
    REVOKE ALL ON FUNCTION public.approve_leave(uuid, date, boolean) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.approve_leave(uuid, date, boolean) TO authenticated, service_role;
  `);
  await db.exec(readFileSync(FILE_NHIEU_NGAY, "utf8"));
  const sql = readFileSync(FILE, "utf8");
  await db.exec(sql);
  await db.exec(sql);
}, 30000);
afterAll(() => db.close());

describe("20261119035131 — migration", () => {
  it("hai lượt vẫn đúng một bản mỗi hàm; authenticated gọi được, anon / PUBLIC không; ACL hai hàm cũ giữ nguyên", async () => {
    const r = await db.query<{ ten: string; acl: string; anon: boolean; auth: boolean }>(`
      SELECT p.proname AS ten, p.proacl::text AS acl,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('request_paid_leave', 'approve_leave', 'request_paid_leave_range', 'approve_leave_batch') ORDER BY 1`);
    expect(r.rows.map((x) => [x.ten, x.auth, x.anon])).toEqual([
      ["approve_leave", true, false], ["approve_leave_batch", true, false],
      ["request_paid_leave", true, false], ["request_paid_leave_range", true, false],
    ]);
    expect(r.rows.find((x) => x.ten === "approve_leave")?.acl).toContain("service_role=X");
  });

  it("bản dựng lại để anon gọi được hai hàm cũ (như Restore Drill: baseline --no-acl + shim) ⇒ chạy file kéo về đúng production", async () => {
    await db.exec(`GRANT EXECUTE ON FUNCTION public.approve_leave(uuid, date, boolean) TO anon, PUBLIC;
                   GRANT EXECUTE ON FUNCTION public.request_paid_leave(date, text) TO anon`);
    await db.exec(readFileSync(FILE, "utf8"));
    const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon,
             bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth,
             bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) AS svc
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('request_paid_leave', 'approve_leave')`);
    expect(r.rows[0]).toEqual({ anon: false, auth: true, svc: true });
  });

  it("tiền kiểm dừng khi thân approve_leave đang chạy khác thân đã rà", async () => {
    await db.exec("BEGIN");
    try {
      await db.exec("CREATE OR REPLACE FUNCTION public.approve_leave(p_user uuid, p_date date, p_approve boolean) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN '{}'; END $$");
      const e = await db.exec(readFileSync(FILE, "utf8")).then(() => null, (err: LoiPg) => err);
      expect(e).toMatchObject({ code: "55000" });
      expect(e?.message).toContain("KHÁC thân đã rà");
    } finally {
      await db.exec("ROLLBACK");
    }
  });
});

describe("Chủ nhật / ngày lễ không thành ngày phép ở mọi đường", () => {
  it("đơn một ngày (request_paid_leave) từ chối ngày lễ của công ty người xin; ngày làm vẫn xin được", async () => {
    await trongGiaoDich(async () => {
      await ngayLe("2026-11-24");
      expect(await loi(() => xinMotNgay("2026-11-24"))).toMatchObject({ hint: "leave_no_workday", message: "Ngày 24/11/2026 là ngày lễ của công ty — không cần xin phép" });
      expect(await trangThai("2026-11-24")).toBeUndefined();
      expect(await xinMotNgay("2026-11-25")).toMatchObject({ status: "pending_leave", date: "2026-11-25" });
    });
  });

  it("ngày lễ của tổ chức khác không chặn", async () => {
    await trongGiaoDich(async () => {
      await ngayLe("2026-11-24", ORG_B);
      expect(await xinMotNgay("2026-11-24")).toMatchObject({ status: "pending_leave" });
    });
  });

  it("approve_leave: không duyệt được ngày lễ / Chủ nhật đang chờ, nhưng TỪ CHỐI được", async () => {
    await trongGiaoDich(async () => {
      await ngayLe("2026-11-24");
      await choDuyet("2026-11-24", "2026-11-22", "2026-11-25");
      for (const d of ["2026-11-24", "2026-11-22"]) {
        const e = await loi(() => duyetMotNgay(d, true));
        expect(e).toMatchObject({ hint: "leave_not_workday" });
        expect(e.message).toContain("chỉ từ chối được, không duyệt");
        expect(await trangThai(d)).toBe("pending_leave");
      }
      expect(await duyetMotNgay("2026-11-24", false)).toMatchObject({ approved: false });
      expect(await trangThai("2026-11-24")).toBe("pending");
      expect(await duyetMotNgay("2026-11-25", true)).toMatchObject({ approved: true });
      expect(await trangThai("2026-11-25")).toBe("leave_approved");
    });
  });

  it("approve_leave_batch: đơn có ngày lễ ⇒ không duyệt ngày nào, nêu đúng ngày; từ chối cả đơn được", async () => {
    await trongGiaoDich(async () => {
      await ngayLe("2026-11-24");
      await choDuyet("2026-11-23", "2026-11-24", "2026-11-25");
      const e = await loi(() => duyetDon(["2026-11-23", "2026-11-24", "2026-11-25"], true));
      expect(e).toMatchObject({ hint: "leave_not_workday", message: "Ngày 24/11/2026 là Chủ nhật hoặc ngày lễ của công ty — từ chối riêng ngày đó ở Bảng lương → Đơn xin nghỉ rồi duyệt các ngày còn lại" });
      expect(await trangThai("2026-11-23")).toBe("pending_leave");
      expect(await duyetDon(["2026-11-23", "2026-11-24", "2026-11-25"], false)).toMatchObject({ approved: false });
      expect(await trangThai("2026-11-24")).toBe("pending");
    });
  });

  it("approve_leave / approve_leave_batch: ngày lễ của TỔ CHỨC KHÁC không chặn duyệt", async () => {
    await trongGiaoDich(async () => {
      await ngayLe("2026-11-24", ORG_B);
      await ngayLe("2026-11-25", ORG_B);
      await choDuyet("2026-11-24", "2026-11-25");
      expect(await duyetMotNgay("2026-11-24", true)).toMatchObject({ approved: true });
      expect(await duyetDon(["2026-11-25"], true)).toMatchObject({ approved: true });
      expect(await trangThai("2026-11-25")).toBe("leave_approved");
    });
  });

  it("đơn nhiều ngày không có ngày lễ vẫn duyệt cả đơn như trước", async () => {
    await trongGiaoDich(async () => {
      await choDuyet("2026-11-27", "2026-11-28", "2026-11-30");
      expect(await duyetDon(["2026-11-27", "2026-11-28", "2026-11-30"], true)).toMatchObject({ approved: true });
      expect(await trangThai("2026-11-30")).toBe("leave_approved");
    });
  });
});

describe("request_paid_leave_range — câu thiếu số dư nêu ngày bị chặn", () => {
  it("hết ngay từ ngày đầu", async () => {
    await trongGiaoDich(async () => {
      await daDung(11);
      expect(await loi(() => xinKhoang("2026-11-20", "2026-11-21"))).toMatchObject({
        hint: "leave_quota_exceeded", message: "Số dư phép đã hết cho ngày 20/11/2026 (tích lũy 11 — đã dùng 11)",
      });
    });
  });

  it("đủ cho mấy ngày đầu rồi hết: nêu số ngày được và ngày hết", async () => {
    await trongGiaoDich(async () => {
      await daDung(10);
      expect(await loi(() => xinKhoang("2026-11-27", "2026-12-01"))).toMatchObject({
        hint: "leave_quota_exceeded",
        message: "Số dư phép chỉ đủ cho 1 ngày đầu của đơn, hết từ ngày 28/11/2026 (tích lũy 11 — đã dùng 11) — bớt ngày rồi gửi lại",
      });
    });
  });
});
