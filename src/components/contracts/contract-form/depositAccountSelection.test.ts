import { describe, expect, it } from "vitest";

import type { Account } from "@/hooks/useAccounts";
import {
  pickDefaultDepositAccountId,
  selectDepositAccounts,
} from "./useContractFormState";

const JOEY = "d45a7506-5250-4d99-ac94-9f73cbd4df17";
const OWNER = "90450d5f-29b6-4897-bdef-cdb5fb53f339";

const account = (over: Partial<Account> & Pick<Account, "id" | "name">): Account =>
  ({
    user_id: OWNER,
    code: "",
    bank_name: null,
    account_number: null,
    bank_account_holder: null,
    branch: null,
    description: null,
    is_default: false,
    quick_default_building_id: null,
    initial_amount: 0,
    initial_date: "2026-01-01",
    lock_date: null,
    is_virtual: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  }) as Account;

/**
 * Ảnh chụp thật danh sách sổ quỹ mà tk joey (Quản Lý Tòa, 8 toà gồm 158PVC)
 * nhìn thấy ngày 27/07/2026, đã sort theo name ASC đúng như `useAccounts`.
 * Sổ ĐẦU TIÊN của joey là sổ ảo — chính là cái bẫy.
 */
const JOEY_CASHBOOKS: Account[] = [
  account({ id: "a1", name: "ATam" }),
  account({ id: "a2", name: "Cấn trừ thanh lý (nội bộ)", user_id: JOEY, is_virtual: true }),
  account({ id: "a3", name: "Chung" }),
  account({ id: "a4", name: "Hiển Chi", user_id: JOEY }),
  account({ id: "a5", name: "Hiển Thối", user_id: JOEY, is_virtual: true }),
  account({ id: "a6", name: "Hiển Thu", user_id: JOEY }),
  account({ id: "a7", name: "HKDHUY" }),
  account({ id: "a8", name: "Làm tròn tiền thiếu", is_virtual: true }),
  account({ id: "a9", name: "TK939" }),
];

describe("selectDepositAccounts", () => {
  it("loại mọi sổ ảo khỏi danh sách chọn sổ nhận cọc", () => {
    const options = selectDepositAccounts(JOEY_CASHBOOKS);

    expect(options.map((a) => a.name)).toEqual([
      "ATam",
      "Chung",
      "Hiển Chi",
      "Hiển Thu",
      "HKDHUY",
      "TK939",
    ]);
    expect(options.some((a) => a.is_virtual)).toBe(false);
  });

  it("giữ nguyên thứ tự và không đụng gì khi toàn sổ thật", () => {
    const real = JOEY_CASHBOOKS.filter((a) => !a.is_virtual);
    expect(selectDepositAccounts(real)).toEqual(real);
  });
});

describe("pickDefaultDepositAccountId", () => {
  it("KHÔNG auto-chọn sổ ảo cho staff — án lệ joey/503/158PVC", () => {
    const picked = pickDefaultDepositAccountId(
      selectDepositAccounts(JOEY_CASHBOOKS),
      JOEY,
    );

    // Trước khi vá: "a2" (Cấn trừ thanh lý — sổ ảo) → create_contract_v2 ném
    // 42501 "Sổ quỹ cọc không thuộc tổ chức" mỗi lần lưu HĐ.
    expect(picked).toBe("a4");
    expect(JOEY_CASHBOOKS.find((a) => a.id === picked)?.is_virtual).toBe(false);
  });

  it("ưu tiên sổ is_default của chính user trước sổ đầu danh sách", () => {
    const accounts = selectDepositAccounts([
      ...JOEY_CASHBOOKS,
      account({ id: "a10", name: "Zulu", user_id: JOEY, is_default: true }),
    ]);

    expect(pickDefaultDepositAccountId(accounts, JOEY)).toBe("a10");
  });

  it("fallback sổ chung khi user chưa có sổ riêng nào", () => {
    const noOwn = selectDepositAccounts(
      JOEY_CASHBOOKS.filter((a) => a.user_id !== JOEY),
    );

    expect(pickDefaultDepositAccountId(noOwn, JOEY)).toBe("a1");
  });

  it("trả chuỗi rỗng khi lọc xong không còn sổ thật nào", () => {
    const allVirtual = selectDepositAccounts(
      JOEY_CASHBOOKS.filter((a) => a.is_virtual),
    );

    expect(allVirtual).toEqual([]);
    expect(pickDefaultDepositAccountId(allVirtual, JOEY)).toBe("");
  });
});
