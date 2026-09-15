// D1 — `canUse` phải đọc được PHẠM VI, không chỉ "có khoá hay không".
//
// LỖ ĐANG VÁ
//   `get_my_permissions()` trả `{resource: {action: true}}`. Nhân viên được
//   duyệt phiếu ở ĐÚNG MỘT toà nhận `income_expenses.approve = true` trống
//   trơn, nên giao diện bật nút "Duyệt" ở MỌI toà. Máy chủ
//   (`authorize_tenant_action_v3`) vẫn từ chối — nên mỗi lần bấm là một lời hứa
//   bị bội.
//
//   `get_my_permissions_v2(p_org)` (migration 20260915143713) trả
//   `{org_wide, building_ids, cashbook_ids}` cho từng action. `canUse` nhận
//   thêm tham số `buildingId` để hỏi ĐÚNG câu giao diện cần hỏi.
//
// VÌ SAO VẪN PHẢI NHẬN HÌNH DẠNG BOOLEAN CŨ
//   v1 và v2 sống song song một đợt (bản khách đang mở trong trình duyệt người
//   dùng lúc deploy vẫn gọi v1), và 81 chỗ gọi `useMyPermissions` cùng hàng
//   chục test đang truyền map boolean. Siết `buildingId` lên map boolean là
//   tắt nút của người ĐANG CÓ quyền — hỏng nặng hơn lỗi đang vá. Boolean =
//   "không biết phạm vi" ⇒ giữ nguyên câu trả lời cũ.
import { describe, expect, it } from "vitest";
import { canUse } from "@/lib/permissionPages";

const TOA_A = "11111111-1111-4111-8111-111111111111";
const TOA_B = "22222222-2222-4222-8222-222222222222";
const SO_QUY = "33333333-3333-4333-8333-333333333333";

describe("canUse — hình dạng v2 {org_wide, building_ids, cashbook_ids}", () => {
  it("org_wide = true thì mọi toà đều được, kể cả toà không nằm trong danh sách", () => {
    const p = {
      income_expenses: { approve: { org_wide: true, building_ids: [], cashbook_ids: [] } },
    };
    expect(canUse(p, "income_expenses", "approve")).toBe(true);
    expect(canUse(p, "income_expenses", "approve", TOA_A)).toBe(true);
    expect(canUse(p, "income_expenses", "approve", TOA_B)).toBe(true);
  });

  it("CHỈ được một toà: hỏi đúng toà đó thì true, toà khác thì FALSE", () => {
    const p = {
      income_expenses: { approve: { org_wide: false, building_ids: [TOA_A], cashbook_ids: [] } },
    };
    expect(canUse(p, "income_expenses", "approve", TOA_A)).toBe(true);
    expect(canUse(p, "income_expenses", "approve", TOA_B)).toBe(false);
  });

  it("không truyền toà thì hỏi câu 'có quyền này ở đâu đó không'", () => {
    // Bề mặt không gắn với toà nào (vd mục menu, route guard) vẫn phải mở khi
    // người dùng có quyền ở ít nhất một toà — nếu không thì họ không vào nổi
    // trang để chọn toà.
    const p = {
      income_expenses: { approve: { org_wide: false, building_ids: [TOA_A], cashbook_ids: [] } },
    };
    expect(canUse(p, "income_expenses", "approve")).toBe(true);
  });

  it("chỉ có phạm vi SỔ QUỸ: vẫn là có quyền khi không hỏi toà", () => {
    // `cashbooks.post` khai requires_cashbook_possession ⇒ org_wide false và
    // building_ids rỗng theo đúng mô hình. Bỏ cashbook_ids là tắt nút của
    // chính người đang giữ sổ.
    const p = {
      cashbooks: { post: { org_wide: false, building_ids: [], cashbook_ids: [SO_QUY] } },
    };
    expect(canUse(p, "cashbooks", "post")).toBe(true);
  });

  it("không phạm vi nào hiệu lực thì FALSE", () => {
    const p = {
      income_expenses: { approve: { org_wide: false, building_ids: [], cashbook_ids: [] } },
    };
    expect(canUse(p, "income_expenses", "approve")).toBe(false);
    expect(canUse(p, "income_expenses", "approve", TOA_A)).toBe(false);
  });

  it("super admin: sentinel thắng, không cần phạm vi", () => {
    const sa = { __superadmin: true } as unknown as Parameters<typeof canUse>[0];
    expect(canUse(sa, "income_expenses", "approve", TOA_B)).toBe(true);
  });

  it("khoá vắng mặt vẫn là không có quyền dù truyền toà", () => {
    const p = { contracts: { view: { org_wide: true, building_ids: [], cashbook_ids: [] } } };
    expect(canUse(p, "contracts", "terminate", TOA_A)).toBe(false);
  });
});

describe("canUse — hình dạng v1 (boolean) KHÔNG bị siết bởi buildingId", () => {
  it("true trống trơn vẫn true khi hỏi kèm toà", () => {
    const p = { income_expenses: { approve: true } };
    expect(canUse(p, "income_expenses", "approve")).toBe(true);
    expect(canUse(p, "income_expenses", "approve", TOA_A)).toBe(true);
  });

  it("false vẫn là false", () => {
    const p = { income_expenses: { approve: false } };
    expect(canUse(p, "income_expenses", "approve", TOA_A)).toBe(false);
  });
});

describe("canUse — dữ liệu méo không được mở cửa", () => {
  it("building_ids không phải mảng ⇒ coi như rỗng, không ném", () => {
    const p = {
      income_expenses: { approve: { org_wide: false, building_ids: null } },
    } as unknown as Parameters<typeof canUse>[0];
    expect(canUse(p, "income_expenses", "approve")).toBe(false);
    expect(canUse(p, "income_expenses", "approve", TOA_A)).toBe(false);
  });

  it("org_wide không phải boolean true ⇒ không mở", () => {
    const p = {
      income_expenses: { approve: { org_wide: "yes", building_ids: [] } },
    } as unknown as Parameters<typeof canUse>[0];
    expect(canUse(p, "income_expenses", "approve")).toBe(false);
  });

  it("perms rỗng / null", () => {
    expect(canUse(null, "income_expenses", "approve", TOA_A)).toBe(false);
    expect(canUse(undefined, "income_expenses", "approve")).toBe(false);
  });
});
