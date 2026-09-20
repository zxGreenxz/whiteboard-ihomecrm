// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  fireEvent,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps, ReactNode } from "react";
import type List from "@/components/income-expenses/IncomeExpenseList";
import type Detail from "@/components/income-expenses/IncomeExpenseDetailDialog";
import type MobileDetail from "@/components/income-expenses/IncomeExpenseDetailMobile";
import type { IncomeExpenseActionsController } from "@/hooks/income-expenses/useIncomeExpenseActions";
const m = vi.hoisted(() => ({
  input: null as unknown,
  list: null as unknown,
  detail: null as unknown,
  mobile: null as unknown,
  host: null as unknown,
  controller: { contexts: { v: {} }, open: vi.fn(), openApproval: vi.fn() },
  row: {
    id: "v",
    organization_id: "org",
    code: "PC-test",
    name: "Phiếu cần rà soát",
    type: "EXPENSE",
    voucher_date: "2026-09-21",
    total_amount: 100,
    approval_status: "UNAPPROVED",
    review_state: "CHANGES_REQUESTED",
    posting_status: "UNPOSTED",
    account_id: null,
    items: [],
    attachments: [],
    repeat_cycle: "NONE",
  },
}));
vi.mock("@/hooks/income-expenses/useIncomeExpenseActions", () => ({
  useIncomeExpenseActions: (input: unknown) => {
    m.input = input;
    return m.controller;
  },
}));
vi.mock("@/components/income-expenses/IncomeExpenseActionDialogs", () => ({
  IncomeExpenseActionDialogs: ({ controller }: { controller: unknown }) => {
    m.host = controller;
    return null;
  },
}));
vi.mock("@/components/income-expenses/IncomeExpenseList", () => ({
  default: (props: unknown) => {
    m.list = props;
    return null;
  },
}));
vi.mock("@/components/income-expenses/IncomeExpenseDetailDialog", () => ({
  default: (props: unknown) => {
    m.detail = props;
    return null;
  },
}));
vi.mock("@/components/income-expenses/IncomeExpenseDetailMobile", () => ({
  default: (props: unknown) => {
    m.mobile = props;
    return null;
  },
}));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org" }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "actor" } }),
}));
vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({ data: {} }),
}));
vi.mock("@/hooks/use-mobile", () => ({ usePhoneViewport: () => false }));
vi.mock("@/hooks/useCopilotPageContext", () => ({
  useCopilotPageContext: () => {},
}));
vi.mock("@/hooks/useRoomIdsByCode", () => ({
  useRoomIdsByCode: () => ({ data: [] }),
}));
vi.mock("@/hooks/income-expenses/supplements", () => ({
  useIncomeExpenseSupplements: () => ({ data: [] }),
}));
vi.mock("@/hooks/useIncomeExpenses", () => ({
  EMPTY_INCOME_EXPENSE_FILTERS: {
    dateRange: { from: "", to: "" },
    building_ids: [],
    type: "ALL",
    layer: "CASH",
    approval_status: "ALL",
  },
  useIncomeExpenses: () => ({
    data: { data: [m.row], totalCount: 1 },
    isLoading: false,
  }),
  useIncomeExpenseBatches: () => ({
    data: { data: [], totalCount: 0 },
    isLoading: false,
  }),
  useIncomeExpenseStats: () => ({ data: undefined }),
  useRestoreIncomeExpense: () => ({}),
  useGenerateRecurringVouchers: () => ({}),
  useStopRecurring: () => ({}),
  useCancelIncomeExpenseBatch: () => ({}),
}));
vi.mock("@/lib/financeV2Route", () => ({
  useFinanceV2Routes: () => ({
    getOrg: () => ({ readSemantics: "CANONICAL" }),
  }),
  isCanonicalRead: () => true,
}));
vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/income-expenses/IncomeExpenseStats", () => ({
  IncomeExpenseStats: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseFilters", () => ({
  IncomeExpenseFiltersBar: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseFilterPanel", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseFilterChips", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseForm", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseVerifyDialog", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseImportDialog", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseBatchForm", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseBatchList", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseBatchDetailDialog", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseQuickCreateDialog", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseBatchListMobile", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/IncomeExpenseBatchDetailMobile", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/PayViaBankAppSheet", () => ({
  default: () => null,
}));
vi.mock("@/components/income-expenses/VoucherHistoryDialog", () => ({
  default: () => null,
}));
import IncomeExpensePage from "./IncomeExpensePage";
import IncomeExpenseMobilePage from "./IncomeExpenseMobilePage";
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  m.list = null;
  m.detail = null;
  m.mobile = null;
  m.host = null;
});
afterEach(cleanup);
it("desktop supplies the real current scope, shared contexts, commands and single host", () => {
  render(
    <MemoryRouter>
      <IncomeExpensePage />
    </MemoryRouter>,
  );
  expect(m.input).toMatchObject({
    scope: { actorId: "actor", organizationId: "org" },
    voucherIds: ["v"],
  });
  const list = m.list as ComponentProps<typeof List>;
  expect(list.actionContexts).toBe(m.controller.contexts);
  expect((m.detail as ComponentProps<typeof Detail>).actions).toBe(
    m.controller,
  );
  expect(m.host).toBe(m.controller);
  const row = list.vouchers[0];
  act(() => {
    list.onApprove!(row);
    list.onResubmitReview!(row);
    list.onRequestChanges!(row);
    list.onPostApproved!(row);
    list.onReversePosting!(row);
    list.onQuickEdit!(row);
  });
  expect(m.controller.openApproval).toHaveBeenCalledExactlyOnceWith("v");
  for (const action of [
    "resubmitReview",
    "requestChanges",
    "post",
    "reverse",
    "supplement",
  ])
    expect(m.controller.open).toHaveBeenCalledWith(action, "v");
});
it("mobile passes the same shared controller to its detail and host, keeping existing voucher identity", () => {
  render(
    <MemoryRouter>
      <IncomeExpenseMobilePage />
    </MemoryRouter>,
  );
  expect(m.input).toMatchObject({
    scope: { actorId: "actor", organizationId: "org" },
    voucherIds: ["v"],
  });
  fireEvent.click(screen.getByText("Phiếu cần rà soát"));
  const detail = m.mobile as ComponentProps<typeof MobileDetail>;
  expect(detail.actions).toBe(m.controller);
  expect(m.host).toBe(m.controller);
  const controller = detail.actions as IncomeExpenseActionsController;
  act(() => {
    controller.open("resubmitReview", "v");
    controller.open("supplement", "v");
  });
  expect(m.controller.open).toHaveBeenCalledWith("resubmitReview", "v");
  expect(m.controller.open).toHaveBeenCalledWith("supplement", "v");
});
