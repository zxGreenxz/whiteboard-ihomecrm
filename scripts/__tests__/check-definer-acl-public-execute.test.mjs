import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DUONG_THIEU, SCHEMA_UNG_DUNG, docThieuMienTru, phanTichPublicExecute, sqlPublicExecute } from "../check-definer-acl.mjs";

// VÌ SAO CÓ FILE NÀY — đo 01/11/2026 (review PR #371), xác nhận lại 04/11 trên production:
// 119 hàm ứng dụng cấp EXECUTE cho PUBLIC. PUBLIC là MỌI vai, nên login hermes_store_learning
// (đăng nhập thẳng qua pooler, không qua PostgREST) gọi được 67 hàm SECURITY DEFINER rồi tự đặt
// request.jwt.claim.sub là giả danh người dùng. Gate check-definer-acl chỉ hỏi về anon nên im lặng.
// Migration 20261104173640 thu PUBLIC; phần gate dưới đây canh để nó không quay lại. Hành vi trên
// PostgreSQL thật (SQL của gate chạy trên cụm dùng một lần) ở thu-public-execute-sql.test.mjs.
const baseline = JSON.parse(readFileSync(new URL("../definer-acl-baseline.json", import.meta.url), "utf8"));
const blockedRoles = baseline.publicExecute.blockedRoles;
const INGEST = "app_private.hermes_store_learning_ingest_v1(jsonb)";
const KHO = "app_private.hermes_store_read_connection_v1(jsonb)";

describe("phanTichPublicExecute", () => {
  it("không hàng vi phạm → đạt; vai bị chặn gọi đúng hàm riêng thì không tính", () => {
    const kq = phanTichPublicExecute({
      rows: [{ kind: "reach", role: "hermes_store_learning", sig: INGEST }, { kind: "reach", role: "hermes_store_host", sig: KHO }],
      blockedRoles: { hermes_store_learning: [INGEST], hermes_store_host: [KHO] },
    });
    expect(kq).toMatchObject({ dat: true, hamPublic: [], vuotQuyen: [], macDinh: [], thua: [] });
  });

  it("một hàm còn cấp PUBLIC là đủ để đỏ", () => {
    const kq = phanTichPublicExecute({ rows: [{ kind: "public", role: null, sig: "bulk_create_meter_readings(jsonb)" }], blockedRoles: {} });
    expect(kq.dat).toBe(false);
    expect(kq.hamPublic).toEqual(["bulk_create_meter_readings(jsonb)"]);
  });

  it("vai bị chặn gọi được hàm DEFINER ngoài danh sách → đỏ, kể cả hàm của vai bị chặn khác", () => {
    const kq = phanTichPublicExecute({
      rows: [
        { kind: "reach", role: "hermes_store_learning", sig: "bulk_create_meter_readings(jsonb)" },
        { kind: "reach", role: "hermes_store_host", sig: INGEST },
      ],
      blockedRoles: { hermes_store_learning: [INGEST], hermes_store_host: [KHO] },
    });
    expect(kq.dat).toBe(false);
    expect(kq.vuotQuyen).toEqual(["hermes_store_learning → bulk_create_meter_readings(jsonb)", `hermes_store_host → ${INGEST}`]);
    expect(kq.thua).toEqual([`hermes_store_learning → ${INGEST}`, `hermes_store_host → ${KHO}`]);
  });

  it("vai không có trong cấu hình mà xuất hiện trong kết quả vẫn bị tính (không im lặng cho qua)", () => {
    const kq = phanTichPublicExecute({ rows: [{ kind: "reach", role: "vai_moi", sig: KHO }], blockedRoles: {} });
    expect(kq.vuotQuyen).toEqual([`vai_moi → ${KHO}`]);
  });

  it("mặc định quyền hàm còn cấp PUBLIC → đỏ", () => {
    const kq = phanTichPublicExecute({ rows: [{ kind: "default", role: "postgres", sig: "(toàn cục)" }], blockedRoles: {} });
    expect(kq.dat).toBe(false);
    expect(kq.macDinh).toEqual(["postgres: (toàn cục)"]);
  });

  it("hàm trong policy/view/default mà vai gọi thiếu EXECUTE → đỏ (helper app_private mới quên GRANT), kèm đường", () => {
    const kq = phanTichPublicExecute({
      rows: [{ kind: "thieu", role: "authenticated", sig: "app_private.buildings_i_can_see()", duong: "pg_policy" }], blockedRoles: {},
    });
    expect(kq.dat).toBe(false);
    expect(kq.thieuQuyen).toEqual(["authenticated → app_private.buildings_i_can_see() @ pg_policy"]);
  });

  it("miễn trừ tường minh: mục đã xét cho qua, mục MỚI vẫn đỏ; so khớp bỏ tiền tố public.", () => {
    const thieuMienTru = { anon: ["public.phone_digits(text) @ pg_class"] };
    const chiMuc = { kind: "thieu", role: "anon", sig: "phone_digits(text)", duong: "pg_class" };
    expect(phanTichPublicExecute({ rows: [chiMuc], blockedRoles: {}, thieuMienTru })).toMatchObject({ dat: true, thieuQuyen: [], mienThua: [] });
    const moi = phanTichPublicExecute({
      rows: [chiMuc, { kind: "thieu", role: "anon", sig: "app_private.ma_moi()", duong: "pg_attrdef" }], blockedRoles: {}, thieuMienTru,
    });
    expect(moi.dat).toBe(false);
    expect(moi.thieuQuyen).toEqual(["anon → app_private.ma_moi() @ pg_attrdef"]);
    // Cùng hàm nhưng vai khác không được miễn theo.
    const vaiKhac = phanTichPublicExecute({ rows: [{ ...chiMuc, role: "authenticated" }], blockedRoles: {},
      thieuMienTru: { anon: ["phone_digits(text) @ pg_class"] }, kiemMienThua: false });
    expect(vaiKhac.thieuQuyen).toEqual(["authenticated → phone_digits(text) @ pg_class"]);
  });

  it("miễn khoá theo ĐƯỜNG: cùng vai, cùng hàm nhưng đường mới (view anon đọc được) vẫn đỏ", () => {
    // Re-review #392: miễn khoá theo cặp (vai, hàm) thì thêm một view gọi hàm vốn chỉ miễn ở chỉ mục, gate vẫn xanh.
    const kq = phanTichPublicExecute({
      rows: [{ kind: "thieu", role: "anon", sig: "phone_digits(text)", duong: "pg_class" },
        { kind: "thieu", role: "anon", sig: "phone_digits(text)", duong: "pg_rewrite" }],
      blockedRoles: {}, thieuMienTru: { anon: ["phone_digits(text) @ pg_class"] },
    });
    expect(kq.dat).toBe(false);
    expect(kq.thieuQuyen).toEqual(["anon → phone_digits(text) @ pg_rewrite"]);
    expect(kq.mienThua).toEqual([]);
  });

  it("mục miễn không còn cần → đỏ (danh sách chỉ teo đi); tắt được cho đích không phải production", () => {
    const thieuMienTru = { anon: ["phone_digits(text) @ pg_class"] };
    const kq = phanTichPublicExecute({ rows: [], blockedRoles: {}, thieuMienTru });
    expect(kq.dat).toBe(false);
    expect(kq.mienThua).toEqual(["anon → phone_digits(text) @ pg_class"]);
    // Hàm còn thiếu nhưng ở đường KHÁC thì mục miễn của đường cũ vẫn là thừa.
    const doiDuong = phanTichPublicExecute({ rows: [{ kind: "thieu", role: "anon", sig: "phone_digits(text)", duong: "pg_rewrite" }],
      blockedRoles: {}, thieuMienTru });
    expect(doiDuong.mienThua).toEqual(["anon → phone_digits(text) @ pg_class"]);
    expect(phanTichPublicExecute({ rows: [], blockedRoles: {}, thieuMienTru, kiemMienThua: false })).toMatchObject({ dat: true, mienThua: [] });
  });
});

describe("docThieuMienTru", () => {
  it("thiếu mục → rỗng; sai dạng → ném (cấu hình đi vào phép so, không được im lặng hỏng)", () => {
    expect(docThieuMienTru({})).toEqual({});
    expect(docThieuMienTru(undefined)).toEqual({});
    expect(docThieuMienTru({ thieuMienTru: { anon: ["f() @ pg_class"] } })).toEqual({ anon: ["f() @ pg_class"] });
    expect(() => docThieuMienTru({ thieuMienTru: ["anon → f() @ pg_class"] })).toThrow(/vai → mảng/);
    expect(() => docThieuMienTru({ thieuMienTru: { anon: "f() @ pg_class" } })).toThrow(/vai → mảng/);
    expect(() => docThieuMienTru({ thieuMienTru: { "x'; --": ["f() @ pg_class"] } })).toThrow(/vai → mảng/);
  });

  it("mục kiểu cũ không ghi đường, hoặc đường lạ → ném (miễn phải khoá theo đường)", () => {
    expect(() => docThieuMienTru({ thieuMienTru: { anon: ["phone_digits(text)"] } })).toThrow(/chữ ký @ đường/);
    expect(() => docThieuMienTru({ thieuMienTru: { anon: ["phone_digits(text) @ chi_muc"] } })).toThrow(/chữ ký @ đường/);
    expect(() => docThieuMienTru({ thieuMienTru: { anon: [" @ pg_class"] } })).toThrow(/chữ ký @ đường/);
    expect(DUONG_THIEU).toEqual(["pg_policy", "pg_rewrite", "pg_attrdef", "pg_constraint", "pg_class", "pg_trigger", "pg_proc", "pg_type"]);
  });
});

describe("sqlPublicExecute", () => {
  it("từ chối cấu hình rỗng hoặc tên vai lạ (chuỗi đi thẳng vào SQL)", () => {
    expect(() => sqlPublicExecute({})).toThrow(/rỗng/);
    expect(() => sqlPublicExecute({ "x'); DROP TABLE t; --": [] })).toThrow(/không hợp lệ/);
  });

  it("quét đủ schema ứng dụng, mọi vai trong cấu hình, theo MỌI nhóm thành viên (MEMBER, không chỉ thừa hưởng)", () => {
    const sql = sqlPublicExecute(blockedRoles);
    expect(SCHEMA_UNG_DUNG).toEqual(["public", "app_private", "api"]);
    for (const role of Object.keys(blockedRoles)) expect(sql).toContain(`'${role}'`);
    expect(sql).toContain("pg_has_role(r.oid, g.oid, 'MEMBER')");
    expect(sql).toContain("acldefault('f', a.proowner)");
    expect(sql).toContain("d.deptype = 'e'");
  });

  it("kiểm thiếu quyền theo pg_depend: policy, MỌI view (trừ materialized), default/CHECK/chỉ mục/WHEN, domain, hàm khác", () => {
    const sql = sqlPublicExecute(blockedRoles);
    const thieu = sql.slice(sql.indexOf("'thieu'"), sql.indexOf("SELECT 'default'"));
    for (const nguon of DUONG_THIEU) expect(thieu).toContain(`d.classid = 'pg_catalog.${nguon}'::regclass`);
    // PostgreSQL kiểm EXECUTE của hàm trong view theo vai đang truy vấn, kể cả view không security_invoker.
    expect(thieu).not.toContain("security_invoker");
    expect(thieu).toContain("c.relkind <> 'm'");
    // DEFAULT của tham số luôn tính theo người gọi; thân BEGIN ATOMIC chỉ tính khi hàm là INVOKER.
    expect(thieu).toContain("NOT x.prosecdef OR x.proargdefaults::text ~ (':funcid ' || a.oid::text");
    // Aggregate không tính: PostgreSQL kiểm EXECUTE của sfunc/finalfunc theo chủ aggregate.
    expect(thieu).toContain("x.prokind <> 'a'");
    // DEFAULT của domain chạy cả ở UPDATE … SET col = DEFAULT.
    const nhanDomain = thieu.slice(thieu.indexOf("d.classid = 'pg_catalog.pg_type'"));
    expect(nhanDomain).toContain("has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE')");
  });

  it("mỗi dòng 'thieu' mang đường phụ thuộc (một dòng cho mỗi vai, hàm, đường)", () => {
    const sql = sqlPublicExecute(blockedRoles);
    expect(sql).toContain("SELECT DISTINCT 'thieu', r.rolname::text, a.sig,");
    expect(sql).toContain("(SELECT k.relname::text FROM pg_catalog.pg_class k WHERE k.oid = d.classid)");
    expect(sql).toContain("JOIN pg_catalog.pg_depend d ON d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = a.oid");
    expect(sql).toContain("NULL::text AS duong");
  });

  it("miễn anon trên cửa đã cố ý đóng CHỈ nằm trong nhánh policy", () => {
    const sql = sqlPublicExecute(blockedRoles);
    const thieu = sql.slice(sql.indexOf("'thieu'"), sql.indexOf("SELECT 'default'"));
    const nhanPolicy = thieu.slice(thieu.indexOf("d.classid = 'pg_catalog.pg_policy'"), thieu.indexOf("d.classid = 'pg_catalog.pg_rewrite'"));
    expect(nhanPolicy).toContain("r.rolname = 'anon'");
    expect(nhanPolicy).toContain("x.grantee = 'authenticated'::regrole");
    expect(nhanPolicy).toContain("x.grantee = 'anon'::regrole");
    expect(thieu.split("r.rolname = 'anon'")).toHaveLength(2);
  });
});

describe("allowlist anon trong definer-acl-baseline.json", () => {
  it("không còn hai hàm báo cáo tiền mà 20260621000001 đã cố ý thu khỏi anon", () => {
    for (const sig of ["get_change_breakdown_v2(uuid,uuid,invoice_status,date,date,text,text,uuid[])",
      "get_deposit_breakdown_v2(uuid,uuid,date,date,text,uuid[])"]) expect(baseline.signatures).not.toContain(sig);
    expect(baseline.count).toBe(baseline.signatures.length);
  });
});

describe("cấu hình publicExecute trong definer-acl-baseline.json", () => {
  it("miễn trừ câu 'thieu' đúng 2 mục anon đã xét 05/11, khoá ở đường chỉ mục biểu thức (pg_class), có ghi lý do", () => {
    expect(docThieuMienTru(baseline.publicExecute)).toEqual({
      anon: ["normalize_income_expense_type_name(text) @ pg_class", "phone_digits(text) @ pg_class"],
    });
    expect(baseline.publicExecute.thieuMienTruNote).toMatch(/chỉ mục biểu thức/);
    expect(baseline.publicExecute.thieuMienTruNote).toMatch(/WITH CHECK/);
    expect(baseline.publicExecute.thieuMienTruNote).toMatch(/ĐƯỜNG/);
  });

  it("đủ các vai đã chứng minh không cần hàm ứng dụng, mỗi vai một mảng", () => {
    expect(Object.keys(blockedRoles).sort()).toEqual([
      "hermes_learning_ingest", "hermes_store_executor", "hermes_store_host", "hermes_store_learning", "pgbouncer",
      "supabase_auth_admin", "supabase_etl_admin", "supabase_functions_admin", "supabase_read_only_user", "supabase_replication_admin",
    ]);
    for (const sigs of Object.values(blockedRoles)) expect(Array.isArray(sigs)).toBe(true);
  });

  it("login học chỉ được đúng hàm nạp; kho bền không được hàm nạp; login nền tảng không được hàm nào", () => {
    expect(blockedRoles.hermes_store_learning).toEqual([INGEST]);
    expect(blockedRoles.hermes_learning_ingest).toEqual([INGEST]);
    expect(blockedRoles.hermes_store_host).toEqual(blockedRoles.hermes_store_executor);
    expect(blockedRoles.hermes_store_executor).toHaveLength(23);
    expect(blockedRoles.hermes_store_executor).not.toContain(INGEST);
    for (const sig of blockedRoles.hermes_store_executor) {
      expect(sig).toMatch(/^app_private\.hermes_(store|zalo_provisioning)[a-z_]*_v1\(jsonb\)$/);
    }
    for (const role of ["pgbouncer", "supabase_auth_admin", "supabase_etl_admin", "supabase_functions_admin",
      "supabase_read_only_user", "supabase_replication_admin"]) expect(blockedRoles[role]).toEqual([]);
  });
});
