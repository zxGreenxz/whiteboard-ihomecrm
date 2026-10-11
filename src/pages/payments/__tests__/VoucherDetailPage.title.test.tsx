// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

// K11-58 (C-07): /income-expense/voucher/:id luôn đề "Chi tiết phiếu thu" kể cả phiếu CHI.
const h = vi.hoisted(() => ({ type: "EXPENSE" as "INCOME" | "EXPENSE" }));
const voucher = () => ({
  id: "v1", code: "PC0001", type: h.type, name: "Mua vật tư", total_amount: 100000, voucher_date: "2026-10-08",
  approval_status: "APPROVED", items: [], created_at: "2026-10-08T00:00:00Z", user_id: "u", organization_id: "org",
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/hooks/useVoucherDetail", () => ({
  useVoucherWithBatch: () => ({ data: { voucher: voucher(), batch: null }, isLoading: false, isFetching: false, isError: false, isFetchedAfterMount: true, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useReservationSettlement", () => ({ useReservationSettlementForVoucher: () => ({ data: null, isLoading: false }) }));
vi.mock("@/components/deposits/ReservationSettlementDetails", () => ({ ReservationSettlementDetails: () => null }));
vi.mock("@/components/ui/storage-image", () => ({ StorageImage: () => null }));
vi.mock("@/components/ui/attachment-lightbox", () => ({ AttachmentLightbox: () => null }));
vi.mock("@/lib/financeV2Route", () => ({ useFinanceV2Routes: () => ({ getOrg: () => null }), isCanonicalRead: () => false }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u" } }) }));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock("@/components/income-expenses/IncomeExpenseQuickEditDialog", () => ({ default: () => null }));
import VoucherDetailPage from "../VoucherDetailPage";

afterEach(cleanup);
const mo = () => render(<MemoryRouter initialEntries={["/income-expense/voucher/v1"]}><Routes><Route path="/income-expense/voucher/:id" element={<VoucherDetailPage />} /></Routes></MemoryRouter>);

it("phiếu CHI đề 'Chi tiết phiếu chi'", () => {
  h.type = "EXPENSE"; mo();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Chi tiết phiếu chi — PC0001");
});
it("phiếu THU vẫn đề 'Chi tiết phiếu thu'", () => {
  h.type = "INCOME"; mo();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Chi tiết phiếu thu — PC0001");
});
