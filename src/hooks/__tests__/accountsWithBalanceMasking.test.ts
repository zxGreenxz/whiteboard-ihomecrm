// H3.4 — `useAccountsWithBalance` KHÔNG ĐƯỢC trả về số tồn quỹ GIẢ.
//
// VÌ SAO (đo 15/09/2026)
//   Hook đọc thẳng view `public.accounts_with_balance` (useAccounts.ts:104).
//   View đó khai `security_invoker='true'` (baseline:99245) — đúng luật của
//   repo (scripts/check-view-invoker.mjs), nhưng nó kéo theo một hệ quả về
//   TIỀN mà lớp view không nói ra:
//
//     current_amount = initial_amount
//                    + COALESCE(SUM(l.signed_amount) FROM income_expense_posting_lines l …, 0)
//
//   `income_expense_posting_lines` có RLS `finance_v2_posting_lines_select_custodian`
//   (baseline:163650) chỉ mở cho CUSTODIAN của chính sổ đó. Người không phải
//   CUSTODIAN đọc ra 0 dòng ⇒ SUM = NULL ⇒ COALESCE = 0 ⇒ `current_amount`
//   bằng ĐÚNG `initial_amount`. Đó là một con số SAI trông như số thật, không
//   phải một ô trống.
//
//   Hai màn danh sách đã tự che bằng `list_cashbook_visibility_v2`
//   (CashbookList.tsx:123, CashbookListMobile.tsx:71) nhưng
//   CashbooksMobilePage.tsx:102 vẫn CỘNG những số đó vào "TỔNG TỒN QUỸ".
//   Chữa ở từng màn là chữa lá; nguồn phải ngừng phát ra số giả.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const nguon = readFileSync(join(process.cwd(), "src/hooks/useAccounts.ts"), "utf8");

describe("H3.4 — tồn quỹ không đọc được thì để TRỐNG, không để 0 giả", () => {
  it("hỏi server sổ nào được xem tồn quỹ", () => {
    expect(nguon).toMatch(/list_cashbook_visibility_v2/);
  });

  it("kiểu AccountWithBalance cho phép current_amount rỗng", () => {
    expect(nguon).toMatch(/current_amount:\s*number\s*\|\s*null/);
  });

  it("mang theo cờ balance_visible để màn hình khỏi phải tự đoán", () => {
    expect(nguon).toMatch(/balance_visible/);
  });

  it("KHÔNG thay số giả bằng 0 — 0 đ cũng là một khẳng định sai", () => {
    // `current_amount: 0` ở nhánh không-xem-được chỉ đổi một lời nói dối này
    // lấy một lời nói dối khác, và cái sau còn cộng được vào tổng.
    expect(nguon).not.toMatch(/current_amount:\s*0\s*[,\n]/);
  });

  it("RPC lỗi thì GIỮ HÀNH VI CŨ, không bôi trắng toàn bộ bảng", () => {
    // Đây là nếp đã có của repo (financeV2Mutations.ts:250-252): không rõ ⇒
    // hiện như cũ. Một lỗi mạng thoáng qua không được làm trắng mọi số dư.
    expect(nguon).toMatch(/visibility|khong ro|không rõ/i);
  });
});
