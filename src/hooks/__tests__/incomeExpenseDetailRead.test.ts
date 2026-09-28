// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
const mock = vi.hoisted(() => ({
  header: null as unknown,
  rows: [] as unknown[],
  error: null as unknown,
  rpc: vi.fn(),
  labels: {} as Record<string, unknown[]>,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: mock.rpc,
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        in: async (_key: string, ids: string[]) => ({
          data: mock.labels[table] ?? [],
          error: null,
        }),
        maybeSingle: async () => ({ data: mock.header, error: null }),
      };
      return q;
    },
  },
}));
vi.mock("@/hooks/income-expenses/supplements", () => ({
  hydrateIncomeExpenseSupplements: async (rows: unknown[]) => rows,
}));
vi.mock("@/hooks/income-expenses/reservationCreators", () => ({
  hydrateReservationCreators: async (rows: unknown[]) => rows,
}));
import {
  useIncomeExpenseDetail,
  loadIncomeExpenseDetail,
  enrichIncomeExpenseDetails,
  hydrateIncomeExpenseDetailRelations,
} from "../income-expenses/detailRead";
const id = "00000000-0000-4000-8000-000000000001",
  org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = {
  header: {
    posting_mode: null,
    posting_status: null,
    review_state: null,
    tenant_id: null,
    approved_by: null,
    approved_at: null,
    notes: null,
    payer_name: null,
    account_id: null,
    system_source: null,
    shareholder_id: null,
    contract_id: null,
    invoice_id: null,
    commission_kind: null,
    attachments: [],
    business_result_accounting: null,
    counts_in_business_result: true,
    receive_bank_name: null,
    receive_bank_account: null,
    creator_name: null,
    repeat_cycle: null,
    repeat_infinity: false,
    repeat_count: 0,
    repeat_remaining: 0,
    repeat_next_date: null,
    repeat_parent_id: null,
    verified_at: null,
    verified_by: null,
    verified_by_name: null,
    verified_note: null,
    reversal_of_income_expense_id: null,
    id,
    organization_id: org,
    user_id: id,
    building_id: id,
    code: "PT001",
    type: "INCOME",
    name: "Snapshot",
    voucher_date: "2026-09-28",
    total_amount: "100",
    kqkd_amount: "100",
    approval_status: "UNAPPROVED",
    approval_version: 2,
    posting_version: 1,
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
    room_id: id,
  },
  items: [],
  building_name: "Đúng quyền phiếu",
  expected_item_count: 0,
  items_complete: true,
  issues: [],
};
afterEach(cleanup);
function setup() {
  mock.header = {
    organization_id: org,
    room: { id: "other", name: "Stale room" },
    tenant: null,
    account: null,
  };
  mock.rows = [row];
  mock.error = null;
  mock.rpc.mockImplementation(async () => ({
    data: { rows: mock.rows },
    error: mock.error,
  }));
}
describe("detail query boundary", () => {
  it("takes header/items/building from RPC snapshot and drops mismatched old relation labels", async () => {
    setup();
    const v = await loadIncomeExpenseDetail(id);
    expect(v?.name).toBe("Snapshot");
    expect(v?.approval_version).toBe(2);
    expect(v?.building_name).toBe("Đúng quyền phiếu");
    expect(v?.room_name).toBeNull();
  });
  it("invalidating detail refetches and no longer reports success when parent access disappears", async () => {
    setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useIncomeExpenseDetail(id), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data?.id).toBe(id));
    mock.header = null;
    await client.invalidateQueries({ queryKey: ["income-expense"] });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.isSuccess).toBe(true);
  });
  it("returns error state on incomplete RPC instead of an empty successful voucher", async () => {
    setup();
    mock.rows = [{ ...row, expected_item_count: 2 }];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useIncomeExpenseDetail(id), {
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

it("rejects a newer snapshot that could have moved outside the selected list filters", async () => {
  setup();
  const base = await loadIncomeExpenseDetail(id);
  mock.rows = [
    {
      ...row,
      header: {
        ...row.header,
        updated_at: "2026-09-29T00:00:00Z",
        approval_status: "CANCELLED",
      },
    },
  ];
  await expect(enrichIncomeExpenseDetails([base!])).rejects.toThrow();
});

it("hydrates only allowed relation labels for batch children and matches snapshot foreign keys", async () => {
  setup();
  const base = (await loadIncomeExpenseDetail(id))!;
  mock.labels = {
    rooms: [
      { id, name: "Phòng A" },
      { id: "other", name: "Không ghép nhầm" },
    ],
    accounts: [{ id, name: "Sổ đúng", is_virtual: false }],
    tenants: [],
  };
  const [v] = await hydrateIncomeExpenseDetailRelations([
    { ...base, account_id: id },
  ]);
  expect(v.room_name).toBe("Phòng A");
  expect(v.account_name).toBe("Sổ đúng");
  expect(v.account_is_virtual).toBe(false);
  expect(v.tenant_name).toBeNull();
});
