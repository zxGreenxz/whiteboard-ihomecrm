import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261119020927 — xin nghỉ phép nhiều ngày trong một đơn (request_paid_leave_range) và chủ duyệt / từ chối
 * cả đơn một lần (approve_leave_batch). Chạy THẬT trên PostgreSQL nhúng, migration HAI lượt, gọi bằng vai
 * authenticated với JWT giả qua request.jwt.claim.sub.
 *
 * Bản giả (không phải đối tượng đang kiểm): bảng / cột của salary_attendance_day, notifications, profiles, super_admins
 * dựng đúng phần hai hàm dùng; trigger tự điền tổ chức theo thành viên (thay autofill_org_strict); "hôm nay" của
 * vn_local_date lấy từ test.today (đóng đinh 19/11/2026, thứ Năm — không phụ thuộc đồng hồ thật); is_admin = có trong
 * super_admins; v5_recompute_streak chỉ ghi lại lần gọi. Một kết nối nên không dựng được hai phiên chạy song song.
 *
 * Lịch tháng 11–12/2026: Chủ nhật 22/11, 29/11, 06/12, 13/12, 20/12, 27/12; 01/01/2027 thứ Sáu, 03/01/2027 Chủ nhật.
 */
const FILE = "supabase/migrations/20261119020927_xin_nghi_phep_nhieu_ngay.sql";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, CHU, JOEY, NHAN_VIEN_KHAC] = [1, 2, 3, 4, 5].map(id);
const HOM_NAY = "2026-11-19";
const db = new PGlite();

type KetQuaXin = { from: string; to: string; requested: string[]; existing: string[]; holidays: string[]; batch: string | null };
type KetQuaDuyet = { approved: boolean; user: string; dates: string[] };
type LoiPg = { code?: string; message: string; hint?: string; detail?: string };
type DongNgay = { work_date: string; status: string; evidence: Array<Record<string, unknown>>; audit: Array<Record<string, unknown>>; organization_id: string | null };
type DongThongBao = { user_id: string; organization_id: string | null; subject: string; content: string; metadata: Record<string, unknown> };

async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
async function vai(user: string | null) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
  await db.exec("SET LOCAL ROLE authenticated");
}
// Lỗi giữa giao dịch làm giao dịch hỏng: không RESET ROLE trong finally (câu đó sẽ ném 25P02 đè lỗi thật) — loi()
// cuộn về savepoint, cuộn luôn SET LOCAL ROLE / JWT của vai().
async function xin(user: string | null, from: string | null, to: string | null, reason: string | null = null): Promise<KetQuaXin> {
  await vai(user);
  const r = await db.query<{ r: KetQuaXin }>("SELECT public.request_paid_leave_range($1::date, $2::date, $3) AS r", [from, to, reason]);
  await db.exec("RESET ROLE");
  return r.rows[0].r;
}
async function duyet(user: string, staff: string | null, dates: string[] | null, approve: boolean | null): Promise<KetQuaDuyet> {
  await vai(user);
  const r = await db.query<{ r: KetQuaDuyet }>("SELECT public.approve_leave_batch($1::uuid, $2::date[], $3) AS r",
    [staff, dates === null ? null : `{${dates.join(",")}}`, approve]);
  await db.exec("RESET ROLE");
  return r.rows[0].r;
}
/** Lệnh phải ném lỗi; mọi thứ nó ghi được cuộn về (savepoint) để ca kiểm tiếp được dữ liệu sau lỗi. */
async function loi(fn: () => Promise<unknown>): Promise<LoiPg> {
  await db.exec("SAVEPOINT truoc_loi");
  try {
    await fn();
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT truoc_loi");
    await db.exec("RESET ROLE");
    return e as LoiPg;
  }
  throw new Error("Lệnh không ném lỗi");
}
async function ngay(user = JOEY): Promise<DongNgay[]> {
  return (await db.query<DongNgay>(
    "SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, status, evidence, audit, organization_id FROM public.salary_attendance_day WHERE user_id = $1 ORDER BY work_date",
    [user])).rows;
}
async function thongBao(): Promise<DongThongBao[]> {
  return (await db.query<DongThongBao>("SELECT user_id, organization_id, subject, content, metadata FROM public.notifications ORDER BY created_at, id")).rows;
}
async function datNgay(user: string, workDate: string, status: string, evidence: unknown[] = []) {
  await db.query("INSERT INTO public.salary_attendance_day (user_id, work_date, status, evidence) VALUES ($1, $2::date, $3, $4::jsonb)",
    [user, workDate, status, JSON.stringify(evidence)]);
}
/** n ngày phép rải trong tháng 01–10/2026 — làm "đã dùng" của năm. batDau để hai lần gọi không trùng ngày. */
async function daDungTrongNam(n: number, status = "leave_approved", batDau = 0) {
  for (let i = batDau; i < batDau + n; i++) {
    await datNgay(JOEY, `2026-${String((i % 10) + 1).padStart(2, "0")}-${String(5 + Math.floor(i / 10)).padStart(2, "0")}`, status);
  }
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    SET test.today = '${HOM_NAY}';
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.organizations (id uuid PRIMARY KEY);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.super_admins (user_id uuid PRIMARY KEY, created_at timestamptz NOT NULL);
    CREATE TABLE public.memberships (user_id uuid, organization_id uuid);
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
    -- Như production từ 20260915074852: (p_org uuid DEFAULT NULL), chưa đăng nhập ⇒ 42501 not_permitted.
    -- Hệ số phép/tháng mặc định 1; ca nào cần khác thì SET LOCAL test.rate.
    CREATE FUNCTION public.get_salary_v5_config(p_org uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
      RETURN jsonb_build_object('system_v5', jsonb_build_object('shield_bank_from', '2026-09-01'),
        'attendance_v5', jsonb_build_object('paid_leave_days_per_month', COALESCE(NULLIF(current_setting('test.rate', true), ''), '1')::int));
    END $$;
    -- Lịch ngày làm của công ty người gọi (như vn_workdays_for_org_v1): T2–T7 của tháng trừ ngày lễ (bảng ngay_le).
    CREATE TABLE public.ngay_le (d date PRIMARY KEY);
    CREATE FUNCTION public.vn_workdays(p_month date) RETURNS SETOF date LANGUAGE plpgsql STABLE AS $$
    DECLARE v_dau date := date_trunc('month', p_month)::date;
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
      RETURN QUERY SELECT v_dau + k FROM generate_series(0, 30) AS k
        WHERE v_dau + k < (v_dau + interval '1 month')::date AND extract(dow FROM v_dau + k) <> 0
          AND v_dau + k NOT IN (SELECT l.d FROM public.ngay_le l);
    END $$;
    CREATE FUNCTION public.vn_local_date(ts timestamptz) RETURNS date LANGUAGE sql STABLE AS $$ SELECT current_setting('test.today')::date $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = auth.uid()) $$;
    CREATE TABLE public.lan_tinh_chuoi (user_id uuid, thang date);
    CREATE FUNCTION public.v5_recompute_streak(p_user uuid, p_month date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN INSERT INTO public.lan_tinh_chuoi VALUES (p_user, p_month); RETURN '{}'::jsonb; END $$;

    INSERT INTO public.organizations VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO auth.users VALUES ('${CHU}'), ('${JOEY}'), ('${NHAN_VIEN_KHAC}');
    INSERT INTO public.profiles VALUES ('${CHU}', 'Chủ'), ('${JOEY}', 'JOEY'), ('${NHAN_VIEN_KHAC}', 'Nhân viên khác');
    INSERT INTO public.super_admins VALUES ('${CHU}', '2026-01-01');
    INSERT INTO public.memberships VALUES ('${JOEY}', '${ORG_A}'), ('${NHAN_VIEN_KHAC}', '${ORG_B}'), ('${CHU}', '${ORG_A}'), ('${CHU}', '${ORG_B}');
  `);
  const sql = readFileSync(FILE, "utf8");
  await db.exec(sql);
  await db.exec(sql);
}, 30000);
afterAll(() => db.close());

describe("20261119020927 — migration", () => {
  it("chạy hai lượt vẫn đúng một bản mỗi hàm: jsonb, VOLATILE, SECURITY DEFINER, search_path cố định; anon / PUBLIC không gọi được", async () => {
    const r = await db.query<{ ten: string; definer: boolean; vol: string; cfg: string[]; anon: boolean; auth: boolean; pub: boolean }>(`
      SELECT p.proname AS ten, p.prosecdef AS definer, p.provolatile AS vol, p.proconfig AS cfg,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) g WHERE g.grantee = 0) AS pub
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('request_paid_leave_range', 'approve_leave_batch') ORDER BY 1`);
    expect(r.rows).toEqual([
      { ten: "approve_leave_batch", definer: true, vol: "v", cfg: ["search_path=pg_catalog, public"], anon: false, auth: true, pub: false },
      { ten: "request_paid_leave_range", definer: true, vol: "v", cfg: ["search_path=pg_catalog, public"], anon: false, auth: true, pub: false },
    ]);
  });

  it("tiền kiểm dừng khi đã có approve_leave_batch khác chữ ký (không để lại overload)", async () => {
    await db.exec("CREATE FUNCTION public.approve_leave_batch(p_user uuid, p_dates date[]) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$");
    try {
      const e = await db.exec(readFileSync(FILE, "utf8")).then(() => null, (err: LoiPg) => err);
      await db.exec("ROLLBACK");
      expect(e).toMatchObject({ code: "55000" });
      expect(e?.message).toContain("khác chữ ký");
    } finally {
      await db.exec("DROP FUNCTION public.approve_leave_batch(uuid, date[])");
    }
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM pg_proc WHERE proname = 'approve_leave_batch'")).rows[0].n).toBe(1);
  });
});

describe("request_paid_leave_range — nhân viên xin nghỉ nhiều ngày", () => {
  it("ghi 20→23/11 thành 3 ngày chờ duyệt (bỏ Chủ nhật 22/11), chung mã đơn, một thông báo cho chủ đúng tổ chức", async () => {
    await trongGiaoDich(async () => {
      const r = await xin(JOEY, "2026-11-20", "2026-11-23", "  Về quê  ");
      expect(r).toMatchObject({ from: "2026-11-20", to: "2026-11-23", requested: ["2026-11-20", "2026-11-21", "2026-11-23"], existing: [], holidays: [] });
      expect(r.batch).toMatch(/^[0-9a-f-]{36}$/);
      const rows = await ngay();
      expect(rows.map((d) => [d.work_date, d.status, d.organization_id])).toEqual([
        ["2026-11-20", "pending_leave", ORG_A], ["2026-11-21", "pending_leave", ORG_A], ["2026-11-23", "pending_leave", ORG_A],
      ]);
      for (const d of rows) {
        expect(d.evidence).toHaveLength(1);
        expect(d.evidence[0]).toMatchObject({ kind: "leave_request", reason: "Về quê", batch: r.batch, from: "2026-11-20", to: "2026-11-23" });
        expect(d.audit).toEqual([expect.objectContaining({ by: JOEY, action: "request_leave", batch: r.batch })]);
      }
      const tb = await thongBao();
      expect(tb).toHaveLength(1);
      expect(tb[0]).toMatchObject({ user_id: CHU, organization_id: ORG_A, subject: "Xin phép nghỉ có lương", content: "JOEY xin phép 3 ngày từ 20/11 đến 23/11 — Về quê" });
      expect(tb[0].metadata).toEqual({
        v5: "leave_request", staff_id: JOEY, date: "2026-11-20", date_to: "2026-11-23",
        dates: ["2026-11-20", "2026-11-21", "2026-11-23"], batch: r.batch, url: "/my-day",
      });
    });
  });

  it("một ngày, lý do toàn khoảng trắng: nhãn «ngày dd/mm», không ghi lý do", async () => {
    await trongGiaoDich(async () => {
      const r = await xin(JOEY, HOM_NAY, HOM_NAY, "   ");
      expect(r.requested).toEqual([HOM_NAY]);
      expect((await ngay())[0].evidence[0]).toMatchObject({ reason: null });
      expect((await thongBao())[0].content).toBe("JOEY xin phép ngày 19/11");
    });
  });

  it("các ngày không liền nhau (đã có đơn ở giữa) thì liệt kê từng ngày", async () => {
    await trongGiaoDich(async () => {
      await datNgay(JOEY, "2026-11-24", "leave_approved");
      const r = await xin(JOEY, "2026-11-23", "2026-11-25");
      expect(r).toMatchObject({ requested: ["2026-11-23", "2026-11-25"], existing: ["2026-11-24"] });
      expect((await thongBao())[0].content).toBe("JOEY xin phép 2 ngày 23/11, 25/11");
    });
  });

  it("gửi lại đúng đơn: không ghi thêm, không báo thêm, batch null", async () => {
    await trongGiaoDich(async () => {
      await xin(JOEY, "2026-11-20", "2026-11-23");
      const lan2 = await xin(JOEY, "2026-11-20", "2026-11-23");
      expect(lan2).toEqual({ from: "2026-11-20", to: "2026-11-23", requested: [], existing: ["2026-11-20", "2026-11-21", "2026-11-23"], holidays: [], batch: null });
      expect(await thongBao()).toHaveLength(1);
      for (const d of await ngay()) expect(d.audit).toHaveLength(1);
    });
  });

  it("ngày đã có đơn (chờ duyệt) trong khoảng giữ nguyên; chỉ ghi ngày mới", async () => {
    await trongGiaoDich(async () => {
      await datNgay(JOEY, "2026-11-21", "pending_leave", [{ kind: "leave_request", reason: "cũ" }]);
      const r = await xin(JOEY, "2026-11-20", "2026-11-23", "mới");
      expect(r).toMatchObject({ requested: ["2026-11-20", "2026-11-23"], existing: ["2026-11-21"] });
      const cu = (await ngay()).find((d) => d.work_date === "2026-11-21");
      expect(cu?.evidence).toEqual([{ kind: "leave_request", reason: "cũ" }]);
    });
  });

  it("ngày từng bị từ chối (pending) chuyển lại chờ duyệt, evidence nối thêm", async () => {
    await trongGiaoDich(async () => {
      await datNgay(JOEY, "2026-11-20", "pending", [{ kind: "leave_request", reason: "lần trước" }]);
      await xin(JOEY, "2026-11-20", "2026-11-20", "lần này");
      const [d] = await ngay();
      expect(d.status).toBe("pending_leave");
      expect(d.evidence.map((e) => e.reason)).toEqual(["lần trước", "lần này"]);
    });
  });

  it.each([
    ["chưa đăng nhập", null, "2026-11-20", "2026-11-21", null, "leave_not_signed_in", "Chưa đăng nhập"],
    ["thiếu ngày", JOEY, "2026-11-20", null, null, "leave_range_invalid", "Chọn ngày bắt đầu và ngày kết thúc nghỉ"],
    ["ngày kết thúc trước ngày bắt đầu", JOEY, "2026-11-23", "2026-11-20", null, "leave_range_invalid", "Ngày kết thúc phải bằng hoặc sau ngày bắt đầu"],
    ["bắt đầu từ hôm qua", JOEY, "2026-11-18", "2026-11-20", null, "leave_past_date", "Chỉ xin phép cho hôm nay hoặc ngày tới"],
    ["dài 32 ngày lịch", JOEY, "2026-11-20", "2026-12-21", null, "leave_range_too_long", "Mỗi đơn xin tối đa 31 ngày — chia thành nhiều đơn"],
    ["chỉ có Chủ nhật", JOEY, "2026-11-22", "2026-11-22", null, "leave_no_workday", "Các ngày đã chọn đều là Chủ nhật hoặc ngày lễ — không cần xin phép"],
    ["lý do quá 500 ký tự", JOEY, "2026-11-20", "2026-11-20", "x".repeat(501), "leave_reason_too_long", "Lý do nghỉ tối đa 500 ký tự"],
  ])("%s ⇒ từ chối (HINT đúng), không ghi gì", async (_ten, user, from, to, reason, hint, message) => {
    await trongGiaoDich(async () => {
      const e = await loi(() => xin(user, from, to, reason));
      expect(e).toMatchObject({ code: "P0001", hint, message });
      expect(await ngay()).toEqual([]);
      expect(await thongBao()).toEqual([]);
    });
  });

  it("đúng 31 ngày lịch không bị chặn vì độ dài (bị chặn vì số dư)", async () => {
    await trongGiaoDich(async () => {
      const e = await loi(() => xin(JOEY, "2026-11-20", "2026-12-20"));
      expect(e.hint).toBe("leave_quota_exceeded");
    });
  });

  it("một ngày trong khoảng đã có ngày công ⇒ từ chối CẢ đơn, nêu ngày đó", async () => {
    await trongGiaoDich(async () => {
      await datNgay(JOEY, "2026-11-21", "ticked");
      const e = await loi(() => xin(JOEY, "2026-11-20", "2026-11-23"));
      expect(e).toMatchObject({ code: "P0001", hint: "leave_day_ticked", message: "Ngày 21/11/2026 đã có ngày công — bỏ ngày đó ra khỏi đơn" });
      expect((await ngay()).map((d) => [d.work_date, d.status])).toEqual([["2026-11-21", "ticked"]]);
      expect(await thongBao()).toEqual([]);
    });
  });
});

describe("request_paid_leave_range — chỉ xin cho ngày làm của công ty (bỏ ngày lễ như Chủ nhật)", () => {
  it("ngày lễ trong khoảng không thành ngày phép, trả về ở holidays và không trừ số dư", async () => {
    await trongGiaoDich(async () => {
      await db.exec("INSERT INTO public.ngay_le VALUES ('2026-11-24')");
      await daDungTrongNam(9); // tháng 11 tích luỹ 11 ⇒ còn đúng 2 ngày: tính cả ngày lễ thì thiếu
      const r = await xin(JOEY, "2026-11-23", "2026-11-25");
      expect(r).toMatchObject({ requested: ["2026-11-23", "2026-11-25"], existing: [], holidays: ["2026-11-24"] });
      expect((await ngay()).filter((d) => d.work_date >= HOM_NAY).map((d) => d.work_date)).toEqual(["2026-11-23", "2026-11-25"]);
      expect((await thongBao())[0].content).toBe("JOEY xin phép 2 ngày 23/11, 25/11");
    });
  });

  it("khoảng chỉ gồm ngày lễ và Chủ nhật ⇒ leave_no_workday, không ghi gì", async () => {
    await trongGiaoDich(async () => {
      await db.exec("INSERT INTO public.ngay_le VALUES ('2026-11-21')");
      const e = await loi(() => xin(JOEY, "2026-11-21", "2026-11-22"));
      expect(e).toMatchObject({ code: "P0001", hint: "leave_no_workday" });
      expect(await ngay()).toEqual([]);
    });
  });

  it("đơn 31 ngày chạm ba tháng (30/01 → 01/03/2027): lịch của tháng giữa cũng được đọc", async () => {
    await trongGiaoDich(async () => {
      await db.exec("SET LOCAL test.rate = '12'");
      // 01/02/2027 là thứ Hai. Lễ 01–20/02 (trừ Chủ nhật 07, 14) ⇒ 18 ngày lễ; 22–27/02 vẫn là ngày làm.
      await db.exec(`INSERT INTO public.ngay_le SELECT date '2027-02-01' + k FROM generate_series(0, 19) AS k
                      WHERE extract(dow FROM date '2027-02-01' + k) <> 0`);
      const r = await xin(JOEY, "2027-01-30", "2027-03-01");
      expect(r.requested).toEqual(["2027-01-30", "2027-02-22", "2027-02-23", "2027-02-24", "2027-02-25", "2027-02-26", "2027-02-27", "2027-03-01"]);
      expect(r.holidays).toHaveLength(18);
      expect(r.holidays[0]).toBe("2027-02-01");
    });
  });
});

describe("request_paid_leave_range — số dư phép năm phải đủ cho mọi ngày mới", () => {
  it("đủ đúng: đã dùng 8 (cả chờ duyệt), tháng 11 tích luỹ 11 ⇒ xin được 3 ngày", async () => {
    await trongGiaoDich(async () => {
      await daDungTrongNam(6);
      await daDungTrongNam(2, "pending_leave", 6);
      expect((await xin(JOEY, "2026-11-20", "2026-11-23")).requested).toHaveLength(3);
    });
  });

  it("thiếu một ngày ⇒ từ chối cả đơn, nói còn đủ bao nhiêu ngày; ngày chờ duyệt cũng tính là đã dùng", async () => {
    await trongGiaoDich(async () => {
      await daDungTrongNam(7);
      await daDungTrongNam(2, "pending_leave", 7);
      const e = await loi(() => xin(JOEY, "2026-11-20", "2026-11-23"));
      expect(e).toMatchObject({ code: "P0001", hint: "leave_quota_exceeded", message: "Số dư phép chỉ còn đủ 2 ngày, đơn này cần 3 ngày — bớt ngày rồi gửi lại" });
      expect((await ngay()).filter((d) => d.work_date >= HOM_NAY)).toEqual([]);
      expect(await thongBao()).toEqual([]);
    });
  });

  it("hết hẳn ⇒ câu «Số dư phép đã hết» như đơn một ngày", async () => {
    await trongGiaoDich(async () => {
      await daDungTrongNam(11);
      const e = await loi(() => xin(JOEY, "2026-11-20", "2026-11-21"));
      expect(e).toMatchObject({ hint: "leave_quota_exceeded", message: "Số dư phép đã hết (tích lũy 11 — đã dùng 11)" });
    });
  });

  it("ngày sang tháng sau được tích luỹ thêm: đã dùng 10 ⇒ 30/11 (11) và 01/12 (12) đều được", async () => {
    await trongGiaoDich(async () => {
      await daDungTrongNam(10);
      expect((await xin(JOEY, "2026-11-30", "2026-12-01")).requested).toEqual(["2026-11-30", "2026-12-01"]);
    });
  });

  it("sang năm mới tính lại từ đầu năm: 31/12 dùng phép 2026, 01/01/2027 dùng phép tháng 1 (1 ngày) ⇒ 02/01 thiếu", async () => {
    await trongGiaoDich(async () => {
      await daDungTrongNam(11);
      const e = await loi(() => xin(JOEY, "2026-12-31", "2027-01-02"));
      expect(e.message).toBe("Số dư phép chỉ còn đủ 2 ngày, đơn này cần 3 ngày — bớt ngày rồi gửi lại");
      expect((await xin(JOEY, "2026-12-31", "2027-01-01")).requested).toEqual(["2026-12-31", "2027-01-01"]);
    });
  });

  it("phép của người khác không tính vào số dư của mình", async () => {
    await trongGiaoDich(async () => {
      for (let m = 1; m <= 11; m++) await datNgay(NHAN_VIEN_KHAC, `2026-${String(m).padStart(2, "0")}-10`, "leave_approved");
      expect((await xin(JOEY, "2026-11-20", "2026-11-21")).requested).toHaveLength(2);
    });
  });
});

describe("approve_leave_batch — chủ duyệt / từ chối cả đơn", () => {
  async function donChoDuyet(dates: string[]) {
    for (const d of dates) await datNgay(JOEY, d, "pending_leave");
  }

  it("người không phải chủ bị từ chối bằng đúng câu của approve_leave", async () => {
    await trongGiaoDich(async () => {
      await donChoDuyet(["2026-11-20"]);
      const e = await loi(() => duyet(JOEY, JOEY, ["2026-11-20"], true));
      expect(e).toMatchObject({ code: "P0001", message: "Chỉ chủ được duyệt phép" });
      expect((await ngay())[0].status).toBe("pending_leave");
    });
  });

  it("duyệt 28/11, 30/11, 01/12 (gửi lộn xộn, trùng): mọi ngày leave_approved, chuỗi tính lại một lần mỗi tháng, một thông báo", async () => {
    await trongGiaoDich(async () => {
      await donChoDuyet(["2026-11-28", "2026-11-30", "2026-12-01"]);
      const r = await duyet(CHU, JOEY, ["2026-12-01", "2026-11-28", "2026-11-30", "2026-11-28"], true);
      expect(r).toEqual({ approved: true, user: JOEY, dates: ["2026-11-28", "2026-11-30", "2026-12-01"] });
      const rows = await ngay();
      expect(rows.map((d) => d.status)).toEqual(["leave_approved", "leave_approved", "leave_approved"]);
      for (const d of rows) expect(d.audit.at(-1)).toMatchObject({ by: CHU, action: "approve_leave", batch_days: 3 });
      expect((await db.query("SELECT user_id, to_char(thang, 'YYYY-MM-DD') AS thang FROM public.lan_tinh_chuoi ORDER BY thang")).rows)
        .toEqual([{ user_id: JOEY, thang: "2026-11-01" }, { user_id: JOEY, thang: "2026-12-01" }]);
      const tb = await thongBao();
      expect(tb).toHaveLength(1);
      expect(tb[0]).toMatchObject({
        user_id: JOEY, organization_id: ORG_A, subject: "Phép đã duyệt ✅",
        content: "Phép 3 ngày từ 28/11 đến 01/12 đã duyệt ✅ — ngày trung tính, chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh",
      });
      expect(tb[0].metadata).toEqual({
        v5: "leave_result", date: "2026-11-28", date_to: "2026-12-01", dates: ["2026-11-28", "2026-11-30", "2026-12-01"], approved: true, url: "/my-day",
      });
    });
  });

  it("từ chối hai ngày không liền: về pending, thông báo liệt kê ngày", async () => {
    await trongGiaoDich(async () => {
      await donChoDuyet(["2026-11-20", "2026-11-24"]);
      const r = await duyet(CHU, JOEY, ["2026-11-20", "2026-11-24"], false);
      expect(r.approved).toBe(false);
      expect((await ngay()).map((d) => [d.status, d.audit.at(-1)?.action])).toEqual([["pending", "decline_leave"], ["pending", "decline_leave"]]);
      expect((await thongBao())[0]).toMatchObject({ subject: "Phép chưa được duyệt", content: "Phép 2 ngày 20/11, 24/11 chưa được duyệt — trao đổi thêm với chủ nhé" });
    });
  });

  it("một ngày: câu thông báo giống approve_leave", async () => {
    await trongGiaoDich(async () => {
      await donChoDuyet(["2026-11-20"]);
      await duyet(CHU, JOEY, ["2026-11-20"], true);
      expect((await thongBao())[0].content).toBe("Phép ngày 20/11 đã duyệt ✅ — ngày trung tính, chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh");
    });
  });

  it("một ngày đã được duyệt / không có dòng ⇒ không đổi ngày nào, không báo, không tính chuỗi", async () => {
    await trongGiaoDich(async () => {
      await donChoDuyet(["2026-11-20"]);
      await datNgay(JOEY, "2026-11-21", "leave_approved");
      for (const dates of [["2026-11-20", "2026-11-21"], ["2026-11-20", "2026-11-25"]]) {
        const e = await loi(() => duyet(CHU, JOEY, dates, true));
        expect(e).toMatchObject({ code: "P0001", message: "Ngày này không ở trạng thái chờ duyệt phép" });
      }
      expect((await ngay()).map((d) => [d.work_date, d.status])).toEqual([["2026-11-20", "pending_leave"], ["2026-11-21", "leave_approved"]]);
      expect(await thongBao()).toEqual([]);
      expect((await db.query("SELECT 1 FROM public.lan_tinh_chuoi")).rows).toEqual([]);
    });
  });

  it("không chọn ngày / thiếu người / thiếu quyết định ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      for (const [staff, dates, approve] of [[JOEY, [], true], [JOEY, null, true], [null, ["2026-11-20"], true], [JOEY, ["2026-11-20"], null]] as const) {
        expect(await loi(() => duyet(CHU, staff, dates as string[] | null, approve))).toMatchObject({ code: "22023" });
      }
    });
  });

  it("chỉ duyệt đơn của đúng người được chỉ định", async () => {
    await trongGiaoDich(async () => {
      await datNgay(NHAN_VIEN_KHAC, "2026-11-20", "pending_leave");
      await donChoDuyet(["2026-11-20"]);
      await duyet(CHU, JOEY, ["2026-11-20"], true);
      expect((await ngay(NHAN_VIEN_KHAC))[0].status).toBe("pending_leave");
    });
  });

  it("anon không gọi được cả hai hàm", async () => {
    await trongGiaoDich(async () => {
      await db.exec("SET LOCAL ROLE anon");
      const e = await loi(() => db.query("SELECT public.approve_leave_batch($1::uuid, ARRAY['2026-11-20']::date[], true)", [JOEY]));
      expect(e.code).toBe("42501");
      await db.exec("SET LOCAL ROLE anon");
      const e2 = await loi(() => db.query("SELECT public.request_paid_leave_range('2026-11-20', '2026-11-20')"));
      expect(e2.code).toBe("42501");
    });
  });
});
