import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Ghim định nghĩa migration 20260902042935: soft_delete_customer phải chặn khách
// còn hợp đồng ACTIVE ở TẦNG DB (client có thể bị vòng qua). Migration là sổ
// đóng băng sau khi apply — test này canh việc ai đó "dọn" guard khỏi bản sau.

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260902042935_soft_delete_customer_chan_khach_con_hop_dong.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("soft_delete_customer guard hợp đồng hiệu lực", () => {
  it("giữ nguyên chữ ký + SECURITY DEFINER + search_path (CREATE OR REPLACE, không overload)", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.soft_delete_customer\(p_customer_id uuid\) RETURNS void/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  it("đếm HĐ ACTIVE chưa xoá qua contract_customers và RAISE trước UPDATE", () => {
    const guard = sql.indexOf("CUSTOMER_HAS_ACTIVE_CONTRACT");
    const update = sql.indexOf("UPDATE customers");
    expect(guard).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(guard);
    expect(sql).toMatch(/JOIN public\.contracts c ON c\.id = cc\.contract_id/);
    expect(sql).toMatch(/c\.status = 'ACTIVE'/);
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
  });

  it("giữ nguyên rào quyền cũ (chủ dữ liệu hoặc super admin) và nghiệm thu cuối file", () => {
    expect(sql).toMatch(/user_id = auth\.uid\(\) OR public\.is_super_admin\(\)/);
    expect(sql).toMatch(/prosrc LIKE '%CUSTOMER_HAS_ACTIVE_CONTRACT%'/);
  });
});
