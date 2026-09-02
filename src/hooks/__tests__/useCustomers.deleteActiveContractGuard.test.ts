import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// C-03 (audit 02/09/2026): xoá khách đang có hợp đồng hiệu lực phải bị chặn ở
// CẢ HAI đường client (useDeleteCustomer — đường sống; useDeleteTenant — legacy)
// trước khi chạm RPC/UPDATE. Test ghim nguồn: luật "đang hiệu lực" phải lấy từ
// ACTIVE_CONTRACT_STATUSES, không chép cứng chuỗi 'ACTIVE' rải rác.

const customers = readFileSync(new URL("../useCustomers.ts", import.meta.url), "utf8");
const tenants = readFileSync(new URL("../useTenants.ts", import.meta.url), "utf8");

describe("useDeleteCustomer chặn xoá khách còn hợp đồng hiệu lực", () => {
  it("tra contract_customers rồi contracts theo ACTIVE_CONTRACT_STATUSES TRƯỚC khi gọi soft_delete_customer", () => {
    const start = customers.indexOf("export const useDeleteCustomer");
    const body = customers.slice(start);
    const linkPos = body.indexOf('from("contract_customers")');
    const activePos = body.indexOf('.in("status", ACTIVE_CONTRACT_STATUSES)');
    const rpcPos = body.indexOf("supabase.rpc('soft_delete_customer'");
    expect(linkPos).toBeGreaterThan(-1);
    expect(activePos).toBeGreaterThan(linkPos);
    expect(rpcPos).toBeGreaterThan(activePos);
    expect(body.slice(linkPos, rpcPos)).toMatch(/\.is\("deleted_at", null\)/);
    expect(body.slice(linkPos, rpcPos)).toMatch(/throw new Error\(\s*`Không thể xoá khách hàng/);
  });

  it("dịch lỗi CUSTOMER_HAS_ACTIVE_CONTRACT từ RPC thành thông báo tiếng Việt", () => {
    expect(customers).toMatch(/CUSTOMER_HAS_ACTIVE_CONTRACT/);
  });
});

describe("useDeleteTenant (legacy) chặn theo contracts.tenant_id", () => {
  it("không còn TODO và tra contracts ACTIVE trước khi soft delete", () => {
    const start = tenants.indexOf("export const useDeleteTenant");
    const body = tenants.slice(start);
    expect(body).not.toMatch(/TODO: Check if tenant has active contracts/);
    const checkPos = body.indexOf('.eq("tenant_id", id)');
    const updatePos = body.indexOf(".update({ deleted_at:");
    expect(checkPos).toBeGreaterThan(-1);
    expect(updatePos).toBeGreaterThan(checkPos);
    expect(body.slice(checkPos, updatePos)).toMatch(/\.in\("status", ACTIVE_CONTRACT_STATUSES\)/);
  });
});
