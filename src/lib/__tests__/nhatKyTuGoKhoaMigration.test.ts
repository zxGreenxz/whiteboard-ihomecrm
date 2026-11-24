import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 20261124131052 — nhật ký tự gỡ khoá «chờ đối chiếu» trên máy chủ (đợt 1b). Chạy THẬT trên PostgreSQL
 * nhúng, migration HAI lượt, gọi bằng vai authenticated với JWT giả qua request.jwt.claim.sub.
 *
 * Bản giả (không phải đối tượng đang kiểm): các bảng tư cách / vai / binding / superadmin / hồ sơ dựng đúng những cột
 * hai hàm dùng, cùng kiểu với production (đo 24/11/2026). auth.uid() đọc request.jwt.claim.sub như Supabase.
 *
 * Người trong bản giả:
 *   CHU        chủ công ty A theo nghĩa chặt (OWNER + binding tới vai TENANT_OWNER còn hạn)
 *   JOEY       quản lý toà ở công ty A (thành viên thường)
 *   CHU_TEN    thành viên A giữ vai TỰ ĐẶT TÊN «Chủ công ty» (system_key NULL) — không được đọc
 *   CHU_HET    chủ A nhưng binding tới TENANT_OWNER đã hết hạn — không được đọc
 *   KHAC       thành viên công ty B
 *   HAI_CTY    thành viên cả A và B
 *   SIEU       superadmin, chỉ là thành viên A
 *   NGHI       từng ở công ty A, tư cách REVOKED
 */
const FILE = "supabase/migrations/20261124131052_nhat_ky_tu_go_khoa_cho_doi_chieu.sql";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, ORG_KHONG_CO] = [1, 2, 3].map(id);
const [CHU, JOEY, CHU_TEN, CHU_HET, KHAC, HAI_CTY, SIEU, NGHI] = [11, 12, 13, 14, 15, 16, 17, 18].map(id);
const [VAI_CHU_A, VAI_TEN_A, VAI_QL_A] = [21, 22, 23].map(id);
const db = new PGlite();

type KetQua = { id: string | null; status: "inserted" | "duplicate" | "rejected"; reason?: string };
type Dong = {
  id: string; entryId: string; actorUserId: string; actorName: string | null; organizationSource: string; namespace: string;
  businessKey: string; operation: string | null; attemptId: string; recordIds: string[]; recordCount: number;
  stuckAt: string; releasedAt: string; receivedAt: string; device: string | null;
};
type Trang = { organizationId: string; allowed: boolean; rows: Dong[]; hasMore: boolean };
type LoiPg = { code?: string; message: string };

let soMa = 1000;
/** Một dòng hàng đợi đúng hình dạng `PendingValveLogEntry` mà trình duyệt gửi. */
function dong(user: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  soMa += 1;
  return {
    id: id(soMa), userId: user, organizationId: ORG_A, contextOrganizationId: null, namespace: "voucher-form-create",
    businessKey: "INCOME:b1:", operation: "lập phiếu thu", attemptId: `a-${soMa}`, recordIds: ["pt-01"], recordCount: 1,
    stuckAt: "2026-11-24T02:00:00.000Z", releasedAt: "2026-11-24T02:05:00.000Z", ...extra,
  };
}

async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
async function vai(user: string | null, role = "authenticated") {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
  await db.exec(`SET LOCAL ROLE ${role}`);
}
async function ghi(user: string | null, entries: unknown, device: string | null = "Mozilla/5.0 (iPhone) Safari"): Promise<KetQua[]> {
  await vai(user);
  const r = await db.query<{ r: { results: KetQua[] } }>("SELECT public.pending_valve_release_log_append_v1($1::jsonb, $2) AS r",
    [JSON.stringify(entries), device]);
  await db.exec("RESET ROLE");
  return r.rows[0].r.results;
}
async function doc(user: string, org: string, limit = 50, before: { releasedAt: string; id: string } | null = null): Promise<Trang> {
  await vai(user);
  const r = await db.query<{ r: Trang }>("SELECT public.pending_valve_release_log_list_v1($1::uuid, $2, $3::timestamptz, $4::uuid) AS r",
    [org, limit, before?.releasedAt ?? null, before?.id ?? null]);
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
async function bang(): Promise<Array<Record<string, unknown>>> {
  return (await db.query<Record<string, unknown>>(
    "SELECT client_entry_id::text, actor_user_id::text, organization_id::text, organization_source, pending_scope, operation, device, record_ids, record_count FROM app_private.pending_valve_release_log ORDER BY received_at, client_entry_id",
  )).rows;
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text NOT NULL, is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text NOT NULL);
    CREATE TABLE public.super_admins (user_id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.organization_memberships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, user_id uuid NOT NULL,
      member_type text NOT NULL, status text NOT NULL, valid_from timestamptz NOT NULL DEFAULT now() - interval '1 day',
      valid_to timestamptz
    );
    CREATE TABLE public.organization_roles (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL, system_key text, status text NOT NULL DEFAULT 'ACTIVE'
    );
    CREATE TABLE public.role_bindings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, membership_id uuid NOT NULL, role_id uuid NOT NULL,
      valid_from timestamptz, valid_to timestamptz
    );
    INSERT INTO public.organizations (id, name) VALUES ('${ORG_A}', 'A'), ('${ORG_B}', 'B');
    INSERT INTO public.profiles VALUES ('${CHU}', 'Chủ A'), ('${JOEY}', 'JOEY'), ('${KHAC}', 'Người B'), ('${SIEU}', '  ');
    INSERT INTO public.super_admins (user_id) VALUES ('${SIEU}');
    INSERT INTO public.organization_roles VALUES
      ('${VAI_CHU_A}', '${ORG_A}', 'Chủ sở hữu tổ chức', 'TENANT_OWNER', 'ACTIVE'),
      ('${VAI_TEN_A}', '${ORG_A}', 'Chủ công ty', NULL, 'ACTIVE'),
      ('${VAI_QL_A}', '${ORG_A}', 'Quản Lý Tòa', NULL, 'ACTIVE');
    INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status, valid_to) VALUES
      ('${ORG_A}', '${CHU}', 'OWNER', 'ACTIVE', NULL),
      ('${ORG_A}', '${JOEY}', 'STAFF', 'ACTIVE', NULL),
      ('${ORG_A}', '${CHU_TEN}', 'OWNER', 'ACTIVE', NULL),
      ('${ORG_A}', '${CHU_HET}', 'OWNER', 'ACTIVE', NULL),
      ('${ORG_B}', '${KHAC}', 'STAFF', 'ACTIVE', NULL),
      ('${ORG_A}', '${HAI_CTY}', 'STAFF', 'ACTIVE', NULL),
      ('${ORG_B}', '${HAI_CTY}', 'STAFF', 'ACTIVE', NULL),
      ('${ORG_A}', '${SIEU}', 'STAFF', 'ACTIVE', NULL),
      ('${ORG_A}', '${NGHI}', 'STAFF', 'REVOKED', NULL);
    INSERT INTO public.role_bindings (organization_id, membership_id, role_id, valid_from, valid_to)
      SELECT m.organization_id, m.id, v.role_id, NULL, v.valid_to
        FROM public.organization_memberships m
        JOIN (VALUES ('${CHU}'::uuid, '${VAI_CHU_A}'::uuid, NULL::timestamptz),
                     ('${CHU_TEN}'::uuid, '${VAI_TEN_A}'::uuid, NULL::timestamptz),
                     ('${CHU_HET}'::uuid, '${VAI_CHU_A}'::uuid, now() - interval '1 hour'),
                     ('${JOEY}'::uuid, '${VAI_QL_A}'::uuid, NULL::timestamptz)) AS v(user_id, role_id, valid_to)
          ON v.user_id = m.user_id AND m.organization_id = '${ORG_A}';
  `);
  const sql = readFileSync(FILE, "utf8");
  // Hai lượt liền nhau: file phải chạy lại được (lane forward chạy hai lượt trong ROLLBACK trước khi áp).
  await db.exec(sql);
  await db.exec(sql);
}, 60_000);
afterAll(async () => { await db.close(); });

describe("ACL và bảng chỉ thêm", () => {
  it("authenticated gọi được hai hàm; anon và service_role không; không vai nào chạm thẳng bảng", async () => {
    const r = await db.query<Record<string, boolean>>(`SELECT
      has_function_privilege('authenticated', 'public.pending_valve_release_log_append_v1(jsonb,text)', 'EXECUTE') AS auth_ghi,
      has_function_privilege('authenticated', 'public.pending_valve_release_log_list_v1(uuid,integer,timestamptz,uuid)', 'EXECUTE') AS auth_doc,
      has_function_privilege('anon', 'public.pending_valve_release_log_append_v1(jsonb,text)', 'EXECUTE') AS anon_ghi,
      has_function_privilege('anon', 'public.pending_valve_release_log_list_v1(uuid,integer,timestamptz,uuid)', 'EXECUTE') AS anon_doc,
      has_function_privilege('service_role', 'public.pending_valve_release_log_append_v1(jsonb,text)', 'EXECUTE') AS svc_ghi,
      has_table_privilege('authenticated', 'app_private.pending_valve_release_log', 'SELECT') AS auth_select,
      has_table_privilege('authenticated', 'app_private.pending_valve_release_log', 'INSERT') AS auth_insert,
      has_table_privilege('service_role', 'app_private.pending_valve_release_log', 'UPDATE') AS svc_update`);
    expect(r.rows[0]).toEqual({ auth_ghi: true, auth_doc: true, anon_ghi: false, anon_doc: false, svc_ghi: false, auth_select: false, auth_insert: false, svc_update: false });
    await trongGiaoDich(async () => {
      await vai(JOEY);
      const e = await loi(() => db.query("SELECT count(*) FROM app_private.pending_valve_release_log"));
      expect(e.code).toBe("42501");
    });
  });

  it("hàm DEFINER ghim search_path", async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>(
      "SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN ('pending_valve_release_log_append_v1','pending_valve_release_log_list_v1') ORDER BY proname");
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toContain("search_path=pg_catalog, public, app_private");
    }
  });

  it("không sửa, không xoá, không TRUNCATE được dòng nào — kể cả chủ bảng", async () => {
    await trongGiaoDich(async () => {
      expect(await ghi(JOEY, [dong(JOEY)])).toMatchObject([{ status: "inserted" }]);
      for (const cau of [
        "UPDATE app_private.pending_valve_release_log SET operation = 'sửa'",
        "DELETE FROM app_private.pending_valve_release_log",
        "TRUNCATE app_private.pending_valve_release_log",
      ]) {
        const e = await loi(() => db.exec(cau));
        expect(e.code, cau).toBe("0A000");
      }
      expect(await bang()).toHaveLength(1);
    });
  });
});

describe("hàm ghi", () => {
  it("ghi dòng của chính mình; người gỡ lấy từ phiên, thiết bị cắt 300 ký tự, mã bản ghi giữ thứ tự", async () => {
    await trongGiaoDich(async () => {
      const row = dong(JOEY, { recordIds: ["pt-02", "pt-01"], recordCount: 7 });
      expect(await ghi(JOEY, [row], "x".repeat(400))).toEqual([{ id: row.id, status: "inserted" }]);
      expect(await bang()).toEqual([{
        client_entry_id: row.id, actor_user_id: JOEY, organization_id: ORG_A, organization_source: "pending", pending_scope: ORG_A,
        operation: "lập phiếu thu", device: "x".repeat(300), record_ids: ["pt-02", "pt-01"], record_count: 7,
      }]);
    });
  });

  it("dòng mang người dùng khác bị từ chối not_self, không ghi gì", async () => {
    await trongGiaoDich(async () => {
      const row = dong(CHU);
      expect(await ghi(JOEY, [row])).toEqual([{ id: row.id, status: "rejected", reason: "not_self" }]);
      expect(await bang()).toEqual([]);
    });
  });

  it("sai công ty bị từ chối not_member: công ty mình không thuộc, tư cách đã thu hồi, công ty không tồn tại", async () => {
    await trongGiaoDich(async () => {
      const b = dong(JOEY, { organizationId: ORG_B });
      expect(await ghi(JOEY, [b])).toEqual([{ id: b.id, status: "rejected", reason: "not_member" }]);
      const nghi = dong(NGHI);
      expect(await ghi(NGHI, [nghi])).toEqual([{ id: nghi.id, status: "rejected", reason: "not_member" }]);
      const ngucanh = dong(JOEY, { organizationId: "actor-scope", contextOrganizationId: ORG_B });
      expect(await ghi(JOEY, [ngucanh])).toEqual([{ id: ngucanh.id, status: "rejected", reason: "not_member" }]);
      const khongCo = dong(SIEU, { organizationId: ORG_KHONG_CO });
      expect(await ghi(SIEU, [khongCo])).toEqual([{ id: khongCo.id, status: "rejected", reason: "not_member" }]);
      expect(await bang()).toEqual([]);
    });
  });

  it("superadmin ghi được cho công ty có thật dù không là thành viên", async () => {
    await trongGiaoDich(async () => {
      const row = dong(SIEU, { organizationId: ORG_B });
      expect(await ghi(SIEU, [row])).toEqual([{ id: row.id, status: "inserted" }]);
      expect((await bang())[0]).toMatchObject({ actor_user_id: SIEU, organization_id: ORG_B });
    });
  });

  it("gửi lại cùng mã dòng không nhân đôi: lần sau trả duplicate; cùng mã khác nội dung trả conflict", async () => {
    await trongGiaoDich(async () => {
      const row = dong(JOEY);
      expect(await ghi(JOEY, [row])).toEqual([{ id: row.id, status: "inserted" }]);
      expect(await ghi(JOEY, [row])).toEqual([{ id: row.id, status: "duplicate" }]);
      expect(await ghi(JOEY, [row, row])).toEqual([{ id: row.id, status: "duplicate" }, { id: row.id, status: "duplicate" }]);
      expect(await ghi(JOEY, [{ ...row, attemptId: "khac" }])).toEqual([{ id: row.id, status: "rejected", reason: "conflict" }]);
      expect(await bang()).toHaveLength(1);
      // Cùng mã dòng của NGƯỜI KHÁC là dòng khác (khoá chống trùng gồm người gỡ).
      expect(await ghi(KHAC, [{ ...row, userId: KHAC, organizationId: ORG_B }])).toEqual([{ id: row.id, status: "inserted" }]);
      expect(await bang()).toHaveLength(2);
    });
  });

  it("một dòng hỏng không chặn các dòng khác trong cùng lô", async () => {
    await trongGiaoDich(async () => {
      const tot1 = dong(JOEY), tot2 = dong(JOEY);
      const hong = [
        dong(JOEY, { stuckAt: "2026-13-40T02:00:00.000Z" }),
        dong(JOEY, { releasedAt: "hôm qua" }),
        dong(JOEY, { businessKey: "x".repeat(1001) }),
        dong(JOEY, { recordIds: [1, 2] }),
        dong(JOEY, { recordIds: Array.from({ length: 101 }, (_, i) => `m${i}`) }),
        dong(JOEY, { namespace: "" }),
        dong(JOEY, { operation: "x".repeat(201) }),
        dong(JOEY, { contextOrganizationId: "khong-phai-uuid", organizationId: "actor-scope" }),
        dong(JOEY, { recordCount: 1.5 }),
        dong(JOEY, { userId: undefined }),
        { ...dong(JOEY), id: "khong-phai-uuid" },
        "khong-phai-object",
      ];
      const kq = await ghi(JOEY, [tot1, ...hong, tot2]);
      expect(kq[0]).toEqual({ id: tot1.id, status: "inserted" });
      expect(kq.at(-1)).toEqual({ id: tot2.id, status: "inserted" });
      expect(kq.slice(1, -1).map(r => r.reason)).toEqual(Array(hong.length).fill("invalid"));
      expect(kq.slice(1, -3).map(r => r.id)).toEqual(hong.slice(0, -2).map(r => (r as { id: string }).id));
      expect(kq.at(-2)?.id ?? null).toBeNull();
      expect(await bang()).toHaveLength(2);
    });
  });

  it("dấu phạm vi người dùng: dùng công ty đang mở lúc gỡ; không có thì công ty duy nhất; nhiều công ty thì no_org", async () => {
    await trongGiaoDich(async () => {
      const ngucanh = dong(HAI_CTY, { organizationId: "actor-scope", contextOrganizationId: ORG_B });
      const duyNhat = dong(JOEY, { organizationId: "actor-scope" });
      const khongRo = dong(HAI_CTY, { organizationId: "actor-scope" });
      expect(await ghi(HAI_CTY, [ngucanh, khongRo])).toEqual([
        { id: ngucanh.id, status: "inserted" }, { id: khongRo.id, status: "rejected", reason: "no_org" },
      ]);
      expect(await ghi(JOEY, [duyNhat])).toEqual([{ id: duyNhat.id, status: "inserted" }]);
      expect((await bang()).map(r => [r.organization_id, r.organization_source, r.pending_scope])).toEqual([
        [ORG_B, "context", "actor-scope"], [ORG_A, "sole_membership", "actor-scope"],
      ]);
    });
  });

  it("dấu mang uuid công ty thì công ty đang mở không thay được nó", async () => {
    await trongGiaoDich(async () => {
      const row = dong(HAI_CTY, { organizationId: ORG_A, contextOrganizationId: ORG_B });
      expect(await ghi(HAI_CTY, [row])).toEqual([{ id: row.id, status: "inserted" }]);
      expect((await bang())[0]).toMatchObject({ organization_id: ORG_A, organization_source: "pending" });
    });
  });

  it("chưa đăng nhập 42501; không phải mảng hoặc quá 50 dòng 22023; mảng rỗng trả rỗng", async () => {
    await trongGiaoDich(async () => {
      expect((await loi(() => ghi(null, [dong(JOEY)]))).code).toBe("42501");
      expect((await loi(() => ghi(JOEY, { id: 1 }))).code).toBe("22023");
      expect((await loi(() => ghi(JOEY, null))).code).toBe("22023");
      expect((await loi(() => ghi(JOEY, Array.from({ length: 51 }, () => dong(JOEY))))).code).toBe("22023");
      expect(await ghi(JOEY, [])).toEqual([]);
      expect(await ghi(JOEY, Array.from({ length: 50 }, () => dong(JOEY)))).toHaveLength(50);
    });
  });

  it("giới hạn 500 dòng mới mỗi người trong 24 giờ (54000); người khác không bị ảnh hưởng", async () => {
    await trongGiaoDich(async () => {
      await db.query(`INSERT INTO app_private.pending_valve_release_log
        (client_entry_id, actor_user_id, organization_id, organization_source, pending_scope, namespace, business_key, attempt_id, stuck_at, released_at)
        SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'pending', $3, 'ns', 'k', 'a', now(), now() FROM generate_series(1, 500)`, [JOEY, ORG_A, ORG_A]);
      expect((await loi(() => ghi(JOEY, [dong(JOEY)]))).code).toBe("54000");
      expect(await ghi(CHU, [dong(CHU)])).toMatchObject([{ status: "inserted" }]);
    });
  });
});

describe("hàm đọc", () => {
  async function gieo() {
    const rows = [
      dong(JOEY, { releasedAt: "2026-11-24T02:05:00.000Z" }),
      dong(CHU, { releasedAt: "2026-11-24T03:05:00.000Z", operation: null }),
      dong(JOEY, { releasedAt: "2026-11-24T04:05:00.000Z" }),
    ];
    await ghi(JOEY, [rows[0], rows[2]]);
    await ghi(CHU, [rows[1]]);
    await ghi(KHAC, [dong(KHAC, { organizationId: ORG_B })]);
    return rows;
  }

  it("người thường, vai tự đặt tên «Chủ công ty», chủ hết hạn binding: allowed=false, không thấy dòng nào", async () => {
    await trongGiaoDich(async () => {
      await gieo();
      for (const nguoi of [JOEY, CHU_TEN, CHU_HET, KHAC, HAI_CTY]) {
        expect(await doc(nguoi, ORG_A), nguoi).toEqual({ organizationId: ORG_A, allowed: false, rows: [], hasMore: false });
      }
      expect(await doc(KHAC, ORG_B)).toMatchObject({ allowed: false, rows: [] });
    });
  });

  it("chủ công ty đọc đúng công ty mình, mới nhất trước, có tên người gỡ; công ty khác thì không", async () => {
    await trongGiaoDich(async () => {
      const rows = await gieo();
      const trang = await doc(CHU, ORG_A);
      expect(trang.allowed).toBe(true);
      expect(trang.hasMore).toBe(false);
      expect(trang.rows.map(r => r.entryId)).toEqual([rows[2].id, rows[1].id, rows[0].id]);
      expect(trang.rows[0]).toMatchObject({
        actorUserId: JOEY, actorName: "JOEY", organizationSource: "pending", namespace: "voucher-form-create",
        businessKey: "INCOME:b1:", operation: "lập phiếu thu", recordIds: ["pt-01"], recordCount: 1,
        device: "Mozilla/5.0 (iPhone) Safari",
      });
      expect(Date.parse(trang.rows[0].releasedAt)).toBe(Date.parse("2026-11-24T04:05:00.000Z"));
      expect(Date.parse(trang.rows[0].stuckAt)).toBe(Date.parse("2026-11-24T02:00:00.000Z"));
      expect(trang.rows[1]).toMatchObject({ actorUserId: CHU, operation: null });
      expect(await doc(CHU, ORG_B)).toMatchObject({ allowed: false, rows: [] });
    });
  });

  it("superadmin đọc theo công ty được hỏi; tên trống thì actorName null", async () => {
    await trongGiaoDich(async () => {
      await gieo();
      await ghi(SIEU, [dong(SIEU)]);
      const a = await doc(SIEU, ORG_A);
      expect(a.rows).toHaveLength(4);
      expect(a.rows.find(r => r.actorUserId === SIEU)?.actorName).toBeNull();
      const b = await doc(SIEU, ORG_B);
      expect(b.rows.map(r => r.actorUserId)).toEqual([KHAC]);
    });
  });

  it("phân trang theo con trỏ (giờ gỡ, id), không trùng không sót", async () => {
    await trongGiaoDich(async () => {
      const rows = await gieo();
      const p1 = await doc(CHU, ORG_A, 2);
      expect(p1.hasMore).toBe(true);
      expect(p1.rows.map(r => r.entryId)).toEqual([rows[2].id, rows[1].id]);
      const cuoi = p1.rows.at(-1)!;
      const p2 = await doc(CHU, ORG_A, 2, { releasedAt: cuoi.releasedAt, id: cuoi.id });
      expect(p2.rows.map(r => r.entryId)).toEqual([rows[0].id]);
      expect(p2.hasMore).toBe(false);
    });
  });

  it("tham số sai: 42501 khi chưa đăng nhập, 22023 khi thiếu công ty / giới hạn ngoài 1–200 / con trỏ thiếu một nửa", async () => {
    await trongGiaoDich(async () => {
      await vai(null);
      expect((await loi(() => db.query("SELECT public.pending_valve_release_log_list_v1($1::uuid)", [ORG_A]))).code).toBe("42501");
      await vai(CHU);
      expect((await loi(() => db.query("SELECT public.pending_valve_release_log_list_v1(NULL::uuid)"))).code).toBe("22023");
      await vai(CHU);
      expect((await loi(() => doc(CHU, ORG_A, 0))).code).toBe("22023");
      expect((await loi(() => doc(CHU, ORG_A, 201))).code).toBe("22023");
      await vai(CHU);
      expect((await loi(() => db.query("SELECT public.pending_valve_release_log_list_v1($1::uuid, 10, now(), NULL)", [ORG_A]))).code).toBe("22023");
    });
  });
});
