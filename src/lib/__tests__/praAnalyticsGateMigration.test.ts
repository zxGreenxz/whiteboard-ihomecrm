import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// PANALYTICS-C01 ×7 (re-anchor bảo mật 02/09/2026): 7 RPC báo cáo `pra_*` từng
// gate bằng owner heuristic (`current_visible_owner_ids() OR is_super_admin() OR
// is_admin()`) — admin per-tenant bất kỳ đọc được analytics của chủ khác.
// Migration 20260902090518 thay bằng quyền `sale_phong.view_analytics` theo đúng
// tổ chức của chủ dữ liệu. Test ghim ba bất biến dễ mất nhất khi ai đó sửa sau.

const sql = readFileSync(
  new URL("../../../supabase/migrations/20260902090518_pra_gate_view_analytics_theo_org.sql", import.meta.url),
  "utf8",
);

const PRA_FUNCTIONS = [
  "pra_summary",
  "pra_timeseries",
  "pra_top_rooms",
  "pra_funnel",
  "pra_errors",
  "pra_error_groups",
  "pra_by_token",
];

describe("20260902090518 — gate view_analytics cho 7 RPC pra_*", () => {
  it("định nghĩa lại đủ 7 hàm, mỗi hàm dùng helper mới, không hàm nào còn owner heuristic", () => {
    for (const fn of PRA_FUNCTIONS) {
      expect(sql, `thiếu ${fn}`).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    }
    // 7 lời gọi trong thân hàm + 1 định nghĩa helper + nhắc trong nghiệm thu
    const calls = sql.match(/AND app_private\.pra_can_view_analytics_v1\(e\.owner_id\)/g) ?? [];
    expect(calls.length).toBe(7);
    // owner heuristic chỉ được phép xuất hiện trong comment header và câu nghiệm thu
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.pra_summary("), sql.indexOf("-- Nghiệm thu"));
    expect(body).not.toMatch(/current_visible_owner_ids/);
    expect(body).not.toMatch(/public\.is_admin\(\)/);
  });

  it("helper phải STABLE và KHÔNG lấy khoá — nếu không PostgREST ném 25006 ở hàm cha STABLE", () => {
    const helper = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION app_private.pra_can_view_analytics_v1"),
      sql.indexOf("COMMENT ON FUNCTION app_private.pra_can_view_analytics_v1"),
    );
    expect(helper).toMatch(/LANGUAGE sql STABLE SECURITY DEFINER/);
    expect(helper).toMatch(/authorized_scope_v3\('sale_phong\.view_analytics', b\.organization_id\)/);
    expect(helper).not.toMatch(/authorize_tenant_action_v3/);
    expect(helper).not.toMatch(/lock_org_for_decision_v1/);
    expect(helper).not.toMatch(/FOR (UPDATE|SHARE)/);
  });

  it("giữ nhánh chủ dữ liệu + super admin (không cắt người đang dùng), anon bị cắt khỏi helper", () => {
    expect(sql).toMatch(/p_owner = \(SELECT auth\.uid\(\)\)/);
    expect(sql).toMatch(/OR public\.is_super_admin\(\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app_private\.pra_can_view_analytics_v1\(uuid\) FROM PUBLIC, anon;/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });
});
