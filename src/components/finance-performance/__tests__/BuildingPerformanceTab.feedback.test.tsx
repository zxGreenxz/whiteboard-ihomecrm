// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildingPerformanceTab } from "../BuildingPerformanceTab";
import { buildBusinessPerformanceFilters } from "@/lib/businessPerformance";
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/hooks/reports/useBusinessPerformance", () => {
 const q = (data: unknown) => ({ data, status: "success", fetchStatus: "idle", isLoading: false, isError: false, error: null, refetch: vi.fn() });
 return { useBusinessPerformancePnl: () => q([]), useBusinessPerformanceBreakEven: () => q([]),
 useBusinessPerformanceReportingRoles: () => q([{ income_expense_type_id: "22222222-2222-4222-8222-222222222222", type_name: "Tiền nhà", side: "EXPENSE", category: "Chi cố định", finance_reporting_role: "LANDLORD_RENT_FIXED", suggested_role: null, can_manage: true, effective_from: "2026-07-01" }]),
 useSetBusinessPerformanceReportingRole: () => ({ mutateAsync: mocks.save, isPending: false }) };
});
afterEach(cleanup);
it("retains selected role and renders a safe inline reason after a denied save", async () => {
 mocks.save.mockRejectedValue({ code: "42501", message: "permission denied table hidden_sql" });
 const filters = buildBusinessPerformanceFilters("2026-07", ["11111111-1111-4111-8111-111111111111"], "ACCRUAL", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
 render(<BuildingPerformanceTab filters={filters} buildings={[{ id: filters.buildingIds[0], name: "DEMO" }]} />);
 fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
 const alert = await screen.findByRole("alert");
 expect(alert.textContent).toContain("không có quyền");
 expect(alert.textContent).not.toContain("hidden_sql");
 expect((screen.getByLabelText("Vai trò tài chính cho Tiền nhà") as HTMLSelectElement).value).toBe("LANDLORD_RENT_FIXED");
 expect(screen.queryByText(/mapping/i)).toBeNull();
});
