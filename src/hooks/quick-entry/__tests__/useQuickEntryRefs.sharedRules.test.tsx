// @vitest-environment jsdom
// Mốc 6 Thu chi: sổ chọn sẵn và gợi ý hạng mục của "Báo chi nhanh" đi qua hai hàm SQL dùng chung với Hermes
// (ie_default_cashbook_v1, ie_category_suggest_v1). Hook thật; các hook dữ liệu và supabase.rpc là ranh giới giả.
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useQuickEntryRefs } from "../useQuickEntryRefs";
import { suggestKey, type SuggestRequest } from "@/lib/quickEntry/sharedRules";

const ORG = "org-1";
const h = vi.hoisted(() => ({ rpc: vi.fn(), restricted: false }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: h.rpc } }));
vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: "org-1" }) }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: {}, error: null, isPending: false }) }));
vi.mock("@/lib/permissionPages", () => ({ canUse: (_p: unknown, _r: string, action: string) => action === "create" || (action === "restricted_create" && h.restricted) }));
vi.mock("@/hooks/personal-finance/usePersonalFinance", () => ({ usePersonalFinance: () => ({ data: { wallets: [], categories: [] }, isLoading: false, error: null }) }));
vi.mock("@/hooks/personal-finance/usePersonalFinancePermissions", () => ({ usePersonalFinancePermissions: () => ({ data: { create: false }, isPending: false, error: null }) }));
vi.mock("@/hooks/company-wallet/useCompanyWallets", () => ({ useCompanyWallets: () => ({ data: { wallets: [] }, isLoading: false, error: null }) }));
vi.mock("@/hooks/useIncomeExpenseFormScope", () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [{ id: "b1", name: "Toà 1", code: "T1" }, { id: "b2", name: "Toà 2", code: "T2" }], isLoading: false, error: null }),
  useIncomeExpenseFormRooms: () => ({ data: [] }),
}));
vi.mock("@/hooks/useIncomeExpenseTypes", () => ({
  useIncomeExpenseTypes: () => ({ isLoading: false, error: null, data: [
    { id: "t-son", name: "Sơn sửa", category: "Bảo trì", type: "expense", organization_id: "org-1", is_restricted: false },
    { id: "t-thue", name: "Tiền thuê", category: "Doanh thu", type: "income", organization_id: "org-1", is_restricted: false },
  ] }),
}));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ isLoading: false, error: null, data: [
  { id: "s1", organization_id: "org-1", is_virtual: false }, { id: "s2", organization_id: "org-1", is_virtual: false },
] }) }));
vi.mock("@/hooks/income-expenses/financeV2Mutations", () => ({ useCustodianCashbooksV2: () => ({ isLoading: false, error: null, data: [{ id: "s1", name: "Quỹ 1" }, { id: "s2", name: "Quỹ 2" }] }) }));
vi.mock("@/hooks/usePeriodFees", () => ({ useFeeAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/useUtilityBills", () => ({ useUtilityAccounts: () => ({ meters: [] }) }));
vi.mock("@/hooks/useBuildingCommonNames", () => ({ useBuildingCommonNames: () => ({ data: new Map() }) }));

beforeEach(() => {
  localStorage.clear();
  h.restricted = false;
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "ie_default_cashbook_v1") return { data: args.p_building_id === "b2" ? "s2" : args.p_building_id === "b1" ? "s-khac" : "s1", error: null };
    if (name === "ie_category_suggest_v1") {
      const items = args.p_items as Array<{ text: string }>;
      return { data: items.map((i) => (i.text.includes("sơn") ? { typeId: "t-son", ruleKey: "son", reason: "rule" } : null)), error: null };
    }
    return { data: null, error: null };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mount = (options?: { entrySource?: "personal_wallet" }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useQuickEntryRefs(options), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
};
const callsOf = (name: string) => h.rpc.mock.calls.filter(([n]) => n === name).map(([, args]) => args as Record<string, unknown>);

it("sổ chọn sẵn = ie_default_cashbook_v1 cho thẻ chưa có toà và từng toà, kèm sổ nhớ ở máy; chờ xong mới hết loading", async () => {
  localStorage.setItem(`ihome:quick-entry:last-account:${ORG}`, "s2");
  const { result } = mount();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(callsOf("ie_default_cashbook_v1")).toEqual([
    { p_organization_id: ORG, p_last_used: "s2" },
    { p_organization_id: ORG, p_building_id: "b1", p_last_used: "s2" },
    { p_organization_id: ORG, p_building_id: "b2", p_last_used: "s2" },
  ]);
  expect(result.current.defaultAccountFor(null)).toBe("s1");
  expect(result.current.defaultAccountFor("b2")).toBe("s2");
  expect(result.current.defaultAccountFor("b1")).toBeNull(); // sổ ngoài danh sách sổ đang giữ ⇒ không chọn sẵn
});

it("ví công ty (personal_wallet) không chọn sẵn sổ và không gọi hàm sổ mặc định", async () => {
  const { result } = mount({ entrySource: "personal_wallet" });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.defaultAccountFor("b1")).toBeNull();
  expect(callsOf("ie_default_cashbook_v1")).toEqual([]);
});

it("gợi ý hạng mục: một lời gọi ie_category_suggest_v1 mỗi chiều thu/chi, ≤ 100 câu mỗi lời gọi, đúng quyền hạng mục hạn chế", async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.loading).toBe(false));
  const requests: SuggestRequest[] = [
    ...Array.from({ length: 101 }, (_, i) => ({ type: "expense" as const, text: i === 0 ? "sơn cửa" : `khoản ${i}`, feeCategory: i === 1 ? "dien" : null })),
    { type: "income", text: "thu sơn", feeCategory: null },
  ];
  const found = await result.current.suggestCategories(requests);
  const calls = callsOf("ie_category_suggest_v1");
  expect(calls.map((c) => [c.p_type, (c.p_items as unknown[]).length, c.p_include_restricted])).toEqual([["expense", 100, false], ["expense", 1, false], ["income", 1, false]]);
  expect((calls[0].p_items as unknown[])[1]).toEqual({ text: "khoản 1", feeCategory: "dien" });
  expect(found.get(suggestKey(requests[0]))).toEqual({ id: "t-son", reason: "rule" });
  expect(found.get(suggestKey(requests[2]))).toBeNull();
  // Hạng mục CHI gợi ý cho câu THU ⇒ ngoài danh sách dùng được của chiều thu ⇒ bỏ.
  expect(found.get(suggestKey(requests[101]))).toBeNull();
});

it("RPC gợi ý lỗi ⇒ ném (nơi ghép thẻ coi như không có gợi ý)", async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.loading).toBe(false));
  h.rpc.mockImplementation(async () => ({ data: null, error: { message: "boom" } }));
  await expect(result.current.suggestCategories([{ type: "expense", text: "sơn", feeCategory: null }])).rejects.toMatchObject({ message: "boom" });
});
