import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Ghim 3 migration bảo mật 02/09/2026 (re-anchor: PMETER-C01 ×2, FR009-C04 bước 1,
// FR002-C01, PCOMPAT-C01). Migration là sổ đóng băng sau apply — test canh ai đó
// "dọn" guard ở bản sau, và canh ba bất biến: không DROP (chữ ký giữ nguyên),
// anon bị cắt, quyết định không còn dựa vào helper STABLE.

const mig = (name: string) =>
  readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");

describe("20260902082002 — meter RPC: REVOKE anon + _v1 vào migration", () => {
  const sql = mig("20260902082002_meter_rpc_revoke_anon_va_v1_vao_migration.sql");

  it("REVOKE anon/PUBLIC đúng 3 chữ ký legacy đang hở", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.approve_meter_reading\(uuid\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.bulk_approve_meter_readings\(uuid\[\]\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.salary_work_ledger\(date, uuid\) FROM PUBLIC, anon;/);
  });

  it("_v1 có authz thật (can_do_on_building) và không cấp cho anon", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.approve_meter_reading_v1\(p_id uuid\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.bulk_approve_meter_readings_v1\(p_ids uuid\[\]\)/);
    expect(sql).toMatch(/can_do_on_building\('meter_readings','edit',v_building\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.approve_meter_reading_v1\(uuid\) TO authenticated, service_role;/);
    expect(sql).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  it("nghiệm thu bắt has_function_privilege('anon') trên cả 5 hàm", () => {
    expect(sql).toMatch(/has_function_privilege\('anon', r\.sig, 'EXECUTE'\)/);
    expect(sql).toMatch(/'public\.salary_work_ledger\(date,uuid\)'/);
  });
});

describe("20260902082003 — transfer_contract_impl chặn khách khác org", () => {
  const sql = mig("20260902082003_transfer_contract_chan_khach_khac_org.sql");

  it("giữ chữ ký 6 đối số, khoá org rồi đọc lại FOR UPDATE", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.transfer_contract_impl\(p_contract_id uuid, p_new_customer_id uuid, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_transfer_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text\) RETURNS uuid/);
    const lock = sql.indexOf("lock_org_for_decision_v1(v_org)");
    const forUpdate = sql.indexOf("FOR UPDATE;");
    expect(lock).toBeGreaterThan(-1);
    expect(forUpdate).toBeGreaterThan(lock);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  it("khách mới phải cùng organization_id với hợp đồng, lệch → 42501, trước mọi UPDATE", () => {
    const guard = sql.indexOf("v_customer_org IS DISTINCT FROM v_contract.organization_id");
    const firstUpdate = sql.indexOf("UPDATE contract_customers");
    expect(guard).toBeGreaterThan(-1);
    expect(firstUpdate).toBeGreaterThan(guard);
    expect(sql).toMatch(/USING ERRCODE = '42501'/);
  });
});

describe("20260902082004 — ie_compat_update_pending_v2 kiểm scope MỚI", () => {
  const sql = mig("20260902082004_ie_compat_update_pending_kiem_scope_moi.sql");

  it("khoá org trước FOR UPDATE, tính scope cuối cho mọi quan hệ", () => {
    const lock = sql.indexOf("lock_org_for_decision_v1(v_org)");
    const forUpdate = sql.indexOf("FOR UPDATE;");
    expect(lock).toBeGreaterThan(-1);
    expect(forUpdate).toBeGreaterThan(lock);
    for (const rel of ["buildings", "rooms", "tenants", "contracts", "invoices", "shareholders", "accounts"]) {
      expect(sql).toMatch(new RegExp(`FROM public\\.${rel} x WHERE x\\.id = v_t_\\w+ AND x\\.organization_id = v_row\\.organization_id`));
    }
  });

  it("trục tiền authorize HAI lần (toà cũ + toà mới) bằng authorize_tenant_action_v3, hết helper STABLE", () => {
    expect(sql).toMatch(/'income_expenses\.edit', v_row\.building_id, NULL\)/);
    expect(sql).toMatch(/'income_expenses\.edit', v_t_building, NULL\)/);
    expect(sql).toMatch(/COALESCE\(v_ok_old, false\) AND COALESCE\(v_ok_new, false\)/);
    // helper STABLE chỉ được nhắc trong comment/nghiệm thu, không còn trong đường quyết định
    const body = sql.slice(sql.indexOf("AS $$"), sql.indexOf("-- Nghiệm thu"));
    expect(body).not.toMatch(/ie_can_edit_money_axis_v1\(/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });
});
