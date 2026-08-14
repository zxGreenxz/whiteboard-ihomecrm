import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const maintenanceSource = readFileSync(
  new URL("../useMaintenanceBatch.ts", import.meta.url),
  "utf8",
);
const copilotSource = readFileSync(
  new URL("../../copilot/tools/writeTools.ts", import.meta.url),
  "utf8",
);
const previewSql = readFileSync(
  new URL(
    "../../../supabase/migrations/20260814034500_copilot_confirmation_intent_v1.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("income/expense type writers keep organization scope", () => {
  it("resolves maintenance types from the one organization owning every batch building", () => {
    expect(maintenanceSource).toMatch(/const organizationId\s*=/);
    expect(maintenanceSource).toMatch(/\.eq\(['"]organization_id['"], organizationId\)/);
    expect(maintenanceSource).toMatch(/organization_id:\s*organizationId/);
    expect(maintenanceSource).toMatch(/resolveOwnType\(s, organizationId, uid\)/);
  });

  it("resolves the Copilot category inside the selected organization — now server-side", () => {
    // Bất biến KHÔNG đổi: hạng mục thu/chi phải được giải TRONG đúng công ty,
    // không bao giờ lấy hạng mục của công ty khác. Chỗ THỰC THI thì đã đổi.
    //
    // Trước 14/08/2026 client tự giải: `resolveBuilding` rồi `resolveType(...,
    // building.organization_id)`. Nay cả hai nằm trong
    // `copilot_preview_income_expense_v1` — vì bản xem trước phải do server chốt
    // thì hash payload mới có nghĩa, và nonce mới gắn được vào một tài nguyên cụ
    // thể. Giải ở client rồi gửi id lên là mời client gửi id nó tự chọn.
    //
    // Test này đi theo bất biến, không đi theo dòng mã cũ.
    expect(copilotSource).toMatch(/copilot_preview_income_expense_v1/);
    expect(
      copilotSource,
      "client KHÔNG được tự giải hạng mục nữa — server chốt thì hash mới có nghĩa",
    ).not.toMatch(/from\(['"]income_expense_types['"]\)/);
    expect(copilotSource).toMatch(/chotToChuc\(ctx, ['"]tao_phieu_thu_chi_nhap['"]\)/);

    expect(previewSql).toMatch(
      /FROM public\.income_expense_types t\s*\n\s*WHERE t\.organization_id = p_organization_id/,
    );
    expect(previewSql).toMatch(
      /FROM public\.buildings b\s*\n\s*WHERE b\.organization_id = p_organization_id/,
    );
    // Và công ty đó phải là công ty NGƯỜI GỌI có quyền tạo, không phải tham số suông.
    expect(previewSql).toMatch(
      /authorized_scope_v3\(['"]income_expenses\.create['"], p_organization_id\)/,
    );
  });
});
