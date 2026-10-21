// @vitest-environment jsdom
// Câu 25 (chủ chốt 21/10/2026): người lập không có quyền duyệt KHÔNG tự duyệt phiếu chi vượt
// ngưỡng. Trước vá, hộp chi tiết phiếu (máy tính + điện thoại) hiện nút Duyệt cho mọi phiếu chờ
// duyệt — kể cả với người lập không có quyền duyệt. Nay máy chủ (ie_self_approve_gate_v1) báo
// chặn ⇒ nút khoá + câu giải thích; máy chủ không chặn ⇒ nút như cũ.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const detail = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
  isFetching: false,
  isFetchedAfterMount: true,
  isSuccess: true,
  isPlaceholderData: false,
  isPaused: false,
  refetch: vi.fn(),
}));
const gate = vi.hoisted(() => ({
  state: { blocked: false, message: null as string | null },
  calls: [] as Array<{ voucherId: unknown; enabled: boolean }>,
}));
// Không để bài thử bắn request thật.
vi.mock("@/integrations/supabase/client", () => {
  const ketQua = Promise.resolve({ data: null, error: null });
  const chuoi: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? ketQua.then.bind(ketQua) : chuoi),
    apply: () => chuoi,
  });
  return { supabase: chuoi };
});
vi.mock("@/hooks/income-expenses/selfApproveGate", () => ({
  useSelfApproveGate: (voucherId: unknown, enabled: boolean) => {
    gate.calls.push({ voucherId, enabled });
    return enabled ? gate.state : { blocked: false, message: null };
  },
}));
vi.mock("@/hooks/income-expenses/detailRead", () => ({ useIncomeExpenseDetail: () => detail }));
vi.mock("@/hooks/useVoucherDetail", () => ({ useVoucherWithBatch: () => detail }));
vi.mock("@/hooks/useIncomeExpenses", () => ({
  useIncomeExpenseHistory: () => ({ data: [] }),
  useUpdateBatchAccount: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => ({ data: false }), useIsSuperAdmin: () => ({ data: false }) }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "nguoi-lap" } }) }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: [] }) }));
const manHinh = vi.hoisted(() => ({ dienThoai: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => manHinh.dienThoai }));
vi.mock("@/hooks/useIsCompanyOwner", () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock("@/hooks/useReservationSettlement", () => ({
  useReservationSettlementForVoucher: () => ({ data: null, error: null, isSuccess: true, isLoading: false }),
}));
vi.mock("@/lib/financeV2Route", () => ({ useFinanceV2Routes: () => ({ getOrg: () => null }), isCanonicalRead: () => false }));
vi.mock("@/components/income-expenses/PayViaBankAppSheet", () => {
  const Tam = ({ open }: { open: boolean }) => (open ? <div>tam-chi-qua-app</div> : null);
  return { default: Tam, PayViaBankAppSheet: Tam };
});
vi.mock("@/components/ui/storage-image", () => ({ StorageImage: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock("@/components/deposits/ReservationSettlementDialog", () => ({ ReservationSettlementDialog: () => null }));
vi.mock("@/components/income-expenses/QlManagerSelect", () => ({ QlManagerSelect: () => null }));

import IncomeExpenseDetailMobile from "../IncomeExpenseDetailMobile";
import { IncomeExpenseDetailDialog } from "../IncomeExpenseDetailDialog";

const GIAI_THICH = "Phiếu chi từ 600.000 đ trở lên cần người có quyền duyệt thu chi duyệt. Bạn là người lập phiếu nên không tự duyệt được.";
const phieu = {
  id: "v", type: "EXPENSE", code: "PC-Q25", name: "Phiếu thử câu 25", total_amount: 1200000, user_id: "nguoi-lap",
  approval_status: "UNAPPROVED", attachments: [], items: [], contract_id: null, invoice_id: null,
  system_source: null, detail_read: { complete: true, expected_item_count: 0 },
};

function wrap(node: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}
function datPhieu(next: Record<string, unknown> = {}) {
  Object.assign(detail, { data: { ...phieu, ...next }, error: null, isFetching: false, isFetchedAfterMount: true, isSuccess: true, isPlaceholderData: false });
}
function datCong(blocked: boolean) {
  gate.state = blocked ? { blocked: true, message: GIAI_THICH } : { blocked: false, message: null };
}

afterEach(() => {
  cleanup();
  gate.calls = [];
  manHinh.dienThoai = false;
});

describe("hộp chi tiết phiếu trên máy tính", () => {
  const moHop = (onApprove = vi.fn()) =>
    wrap(<IncomeExpenseDetailDialog open voucherId="v" voucher={null} onOpenChange={() => {}} onApprove={onApprove} />);

  it("máy chủ báo chặn: nút Duyệt khoá, có câu giải thích, bấm không gọi duyệt", () => {
    datPhieu();
    datCong(true);
    const onApprove = vi.fn();
    render(moHop(onApprove));
    const nut = screen.getByRole("button", { name: "Duyệt phiếu" });
    expect(nut.matches(":disabled")).toBe(true);
    expect(nut.getAttribute("title")).toBe(GIAI_THICH);
    const note = screen.getByRole("note");
    expect(note.textContent).toBe(GIAI_THICH);
    expect(nut.getAttribute("aria-describedby")).toBe(note.id);
    fireEvent.click(nut);
    expect(onApprove).not.toHaveBeenCalled();
    expect(gate.calls.at(-1)).toEqual({ voucherId: "v", enabled: true });
  });

  it("máy chủ không chặn (người khác có quyền duyệt, phiếu dưới ngưỡng…): nút như cũ", () => {
    datPhieu();
    datCong(false);
    const onApprove = vi.fn();
    render(moHop(onApprove));
    const nut = screen.getByRole("button", { name: "Duyệt phiếu" });
    expect(nut.matches(":disabled")).toBe(false);
    expect(nut.getAttribute("title")).toBe("Duyệt phiếu");
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(nut);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("phiếu đã duyệt hoặc không có nút Duyệt: không hỏi cổng", () => {
    datPhieu({ approval_status: "APPROVED" });
    datCong(true);
    render(moHop());
    expect(screen.queryByRole("button", { name: "Duyệt phiếu" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(gate.calls.every((c) => c.enabled === false)).toBe(true);
  });
});

describe("tấm chi tiết phiếu trên điện thoại", () => {
  const moTam = (onApprove = vi.fn()) =>
    wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} onApprove={onApprove} />);

  it("máy chủ báo chặn: nút Duyệt khoá + câu giải thích", () => {
    datPhieu();
    datCong(true);
    const onApprove = vi.fn();
    render(moTam(onApprove));
    const nut = screen.getByRole("button", { name: "Duyệt" });
    expect(nut.matches(":disabled")).toBe(true);
    expect(screen.getByRole("note").textContent).toBe(GIAI_THICH);
    fireEvent.click(nut);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("máy chủ không chặn: nút Duyệt bấm được, không có câu giải thích", () => {
    datPhieu();
    datCong(false);
    const onApprove = vi.fn();
    render(moTam(onApprove));
    const nut = screen.getByRole("button", { name: "Duyệt" });
    expect(nut.matches(":disabled")).toBe(false);
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(nut);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("không truyền onApprove (màn không cho duyệt): không hỏi cổng", () => {
    datPhieu();
    datCong(true);
    render(wrap(<IncomeExpenseDetailMobile voucherId="v" onClose={() => {}} />));
    expect(screen.queryByRole("button", { name: "Duyệt" })).toBeNull();
    expect(gate.calls.every((c) => c.enabled === false)).toBe(true);
  });
});
