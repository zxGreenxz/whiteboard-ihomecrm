// @vitest-environment jsdom
// Phiếu con mở từ Phiếu tổng không nằm trong trang danh sách ⇒ hộp chi tiết của nó phải tự có
// câu trả lời "huỷ được không" của máy chủ. Thiếu, luật nút rơi về quyền income_expenses.cancel
// và ẩn Huỷ với người lập phiếu/người đã thu — dù máy chủ vẫn cho họ huỷ (review chéo 30/10/2026).
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IncomeExpenseBatchSummary } from "@/hooks/useIncomeExpenses";

const h = vi.hoisted(() => ({
  state: { data: null as unknown, isFetching: false, isFetchedAfterMount: true, isSuccess: true, refetch: () => {} },
  eligibilityCalls: [] as string[][],
  detailProps: [] as Array<Record<string, unknown>>,
  ghiProps(p: Record<string, unknown>) { if (p.voucher) h.detailProps.push(p); return null; },
}));
const ELIGIBLE = { id: "c1", eligible: true, reason_code: null, mode: "MANUAL", blocking_voucher_code: null };

vi.mock("@/hooks/useVoucherDetail", () => ({ useVoucherWithBatch: () => h.state }));
vi.mock("@/hooks/useIncomeExpenses", () => ({ useUpdateBatchAccount: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/ui/attachment-lightbox", () => ({ AttachmentLightbox: () => null }));
vi.mock("@/components/ui/storage-image", () => ({ StorageImage: () => null }));
vi.mock("../BatchAccountReasonDialog", () => ({ default: () => null }));
vi.mock("@/hooks/income-expenses/useVoucherActions", () => ({
  useVoucherCancelEligibility: (vouchers: Array<{ id: string }>) => {
    const ids = vouchers.map((v) => v.id);
    h.eligibilityCalls.push(ids);
    return ids.includes("c1")
      ? { cancelEligibility: { c1: ELIGIBLE }, incomeCancelEligibility: undefined }
      : { cancelEligibility: undefined, incomeCancelEligibility: undefined };
  },
}));
vi.mock("../IncomeExpenseDetailMobile", () => ({ default: h.ghiProps }));
vi.mock("../IncomeExpenseDetailDialog", () => ({ default: h.ghiProps }));

import { IncomeExpenseBatchDetailMobile } from "../IncomeExpenseBatchDetailMobile";
import { IncomeExpenseBatchDetailDialog } from "../IncomeExpenseBatchDetailDialog";

const child = {
  id: "c1", code: "PC-THU-1", type: "EXPENSE", items: [], total_amount: 100, approval_status: "UNAPPROVED",
  account_id: "a", user_id: "nguoi-lap", building_name: null, voucher_date: "2026-10-01",
};
const batch = {
  id: "b1", name: "Đợt thử", type: "EXPENSE", total_amount: 100, voucher_count: 1, building_names: [],
  attachments: [], vouchers: [child], has_approved: false, all_cancelled: false,
} as unknown as IncomeExpenseBatchSummary;
h.state.data = { batch };

afterEach(() => { cleanup(); h.eligibilityCalls.length = 0; h.detailProps.length = 0; });

it("điện thoại: mở phiếu con ⇒ hỏi máy chủ đúng phiếu đó và đưa câu trả lời vào tấm chi tiết", () => {
  const { container } = render(<IncomeExpenseBatchDetailMobile batch={batch} onClose={() => {}} onCancelVoucher={() => {}} />);
  fireEvent.click(container.querySelector(".bchild-main")!);
  expect(h.eligibilityCalls.at(-1)).toEqual(["c1"]);
  const last = h.detailProps.at(-1)!;
  expect((last.cancelEligibility as Record<string, typeof ELIGIBLE>)?.c1?.eligible).toBe(true);
});

it("máy tính: mở phiếu con ⇒ hộp chi tiết nhận câu trả lời huỷ của máy chủ", () => {
  const { getByTitle } = render(
    <IncomeExpenseBatchDetailDialog open onOpenChange={() => {}} batch={batch} onCancelVoucher={() => {}} />,
  );
  fireEvent.click(getByTitle("Xem chi tiết phiếu"));
  expect(h.eligibilityCalls.at(-1)).toEqual(["c1"]);
  const last = h.detailProps.at(-1)!;
  expect((last.cancelEligibility as Record<string, typeof ELIGIBLE>)?.c1?.eligible).toBe(true);
});
