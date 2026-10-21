// @vitest-environment jsdom
// RT-HUB-13 (21/10/2026): lượt prefetch do hub realtime kích hoạt phải qua cửa
// quyền xem domain. Trước đây người không có quyền xem hoá đơn/thu chi/HĐ/công
// việc vẫn bị nạp danh sách + thống kê của các trang đó mỗi khi có event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

vi.mock("@/hooks/useJobs", () => ({
  jobsQuery: () => ({ queryKey: ["jobs", "prefetch"], queryFn: () => [] }),
}));
vi.mock("@/hooks/useInvoices", () => ({
  invoicesListQuery: () => ({ queryKey: ["invoices", "prefetch"], queryFn: () => [] }),
  invoiceStatisticsQuery: () => ({ queryKey: ["invoice-statistics", "prefetch"], queryFn: () => [] }),
}));
vi.mock("@/hooks/useIncomeExpenses", () => ({
  incomeExpensesListQuery: () => ({ queryKey: ["income-expenses", "prefetch"], queryFn: () => [] }),
  incomeExpenseStatsQuery: () => ({ queryKey: ["income-expenses", "stats"], queryFn: () => [] }),
  EMPTY_INCOME_EXPENSE_FILTERS: {},
}));
vi.mock("@/hooks/useContracts", () => ({
  contractsPagedQuery: () => ({ queryKey: ["contracts", "prefetch"], queryFn: () => [] }),
  contractStatsQuery: () => ({ queryKey: ["contracts", "stats"], queryFn: () => [] }),
}));
// warmRouteChunk nạp chunk trang — thay bằng module rỗng để test không kéo cả trang.
vi.mock("@/pages/TaskManagementPage", () => ({ default: null }));
vi.mock("@/pages/TasksMobilePage", () => ({ default: null }));
vi.mock("@/pages/invoices/InvoicesPage", () => ({ default: null }));
vi.mock("@/pages/invoices/InvoicesMobilePage", () => ({ default: null }));

import { duocXemDomain, prefetchDomainTuHub, quyenTrongCache } from "@/lib/prefetchPages";

describe("prefetchDomainTuHub — cửa quyền cho lượt prefetch của hub", () => {
  let qc: QueryClient;
  let prefetch: ReturnType<typeof vi.spyOn>;
  const observers: Array<() => void> = [];

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    qc = new QueryClient();
    prefetch = vi.spyOn(qc, "prefetchQuery").mockResolvedValue(undefined);
  });

  afterEach(() => {
    observers.splice(0).forEach((stop) => stop());
    qc.clear();
    vi.unstubAllGlobals();
  });

  function quyen(org: string, perms: Record<string, unknown>, active: boolean) {
    qc.setQueryData(["my-permissions", org], perms);
    if (active) {
      const observer = new QueryObserver(qc, { queryKey: ["my-permissions", org], enabled: false });
      observers.push(observer.subscribe(() => {}));
    }
  }

  it("FAIL-CLOSED: chưa có bảng quyền trong cache thì không prefetch", () => {
    prefetchDomainTuHub(qc, "jobs");
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("có quyền xem module ⇒ prefetch; không có ⇒ bỏ", () => {
    quyen("org-a", { tasks: { view: true }, invoices: { view: false } }, true);
    prefetchDomainTuHub(qc, "invoices");
    expect(prefetch).not.toHaveBeenCalled();
    prefetchDomainTuHub(qc, "jobs");
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("super admin xem được mọi domain", () => {
    quyen("org-a", { __superadmin: true }, true);
    expect(duocXemDomain(quyenTrongCache(qc), "contracts")).toBe(true);
    expect(duocXemDomain(quyenTrongCache(qc), "income-expenses")).toBe(true);
  });

  it("công ty đang chọn (query có observer) thắng bản cache của công ty khác", () => {
    quyen("org-cu", { tasks: { view: true } }, false);
    quyen("org-dang-chon", { tasks: { view: false } }, true);
    prefetchDomainTuHub(qc, "jobs");
    expect(prefetch).not.toHaveBeenCalled();
  });
});
