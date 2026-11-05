import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SCHEMA_UNG_DUNG, phanTichPublicExecute, sqlPublicExecute } from "../check-definer-acl.mjs";

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

  it("hàm trong policy/view/default mà vai gọi thiếu EXECUTE → đỏ (helper app_private mới quên GRANT)", () => {
    const kq = phanTichPublicExecute({ rows: [{ kind: "thieu", role: "authenticated", sig: "app_private.buildings_i_can_see()" }], blockedRoles: {} });
    expect(kq.dat).toBe(false);
    expect(kq.thieuQuyen).toEqual(["authenticated → app_private.buildings_i_can_see()"]);
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

  it("kiểm thiếu quyền theo pg_depend (policy/view/default/CHECK/chỉ mục/WHEN), miễn anon trên cửa đã cố ý đóng", () => {
    const sql = sqlPublicExecute(blockedRoles);
    expect(sql).toContain("SELECT 'thieu'");
    for (const nguon of ["pg_policy", "pg_rewrite", "pg_attrdef", "pg_constraint", "pg_index", "pg_trigger"]) expect(sql).toContain(nguon);
    expect(sql).toContain("x.grantee = 'authenticated'::regrole");
    expect(sql).toContain("x.grantee = 'anon'::regrole");
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
    expect(blockedRoles.hermes_store_executor).toHaveLength(22);
    expect(blockedRoles.hermes_store_executor).not.toContain(INGEST);
    for (const sig of blockedRoles.hermes_store_executor) {
      expect(sig).toMatch(/^app_private\.hermes_(store|zalo_provisioning)[a-z_]*_v1\(jsonb\)$/);
    }
    for (const role of ["pgbouncer", "supabase_auth_admin", "supabase_etl_admin", "supabase_functions_admin",
      "supabase_read_only_user", "supabase_replication_admin"]) expect(blockedRoles[role]).toEqual([]);
  });
});
