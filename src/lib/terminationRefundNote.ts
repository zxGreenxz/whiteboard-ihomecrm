// =============================================================================
// Ghi chú phiếu "Trả khách thanh lý" — dựng LÚC XEM từ facts (RPC
// get_termination_refund_facts_v1). Thuần, không mạng, không đọc đồng hồ máy.
//
// Chủ chốt 02/09/2026: ghi từng dòng, không gộp thành cụm:
//   [HOÀN KHÁCH THANH LÝ] …
//   QUYẾT TOÁN THANH LÝ dd/mm/yyyy — HĐ …
//   Phòng/Tòa · bắt đầu · kết thúc (Mã HĐ - STT trong năm)
//   Cọc đã thu: từng phiếu (phần cọc / tổng phiếu khi gộp hoá đơn)
//   -
//   rồi KHUNG TỔNG HỢP y như lúc bấm thanh lý (TerminateDialog §4).
//
// Khung tổng hợp tính lại bằng ĐÚNG phép toán server (computeTerminationSettlement)
// từ hồ sơ contract_terminations + hoá đơn SETTLEMENT + item của phiếu. "Tiền
// phòng thừa" (credit) không có cột riêng nên server bóc từ ghi chú quyết toán.
// =============================================================================

import { formatVND } from "@/lib/utils";
import { isJsonObject, jsonArray } from "@/lib/jsonValue";
import type { Json } from "@/integrations/supabase/types";
import {
  computeTerminationSettlement,
  type TerminationSettlement,
} from "@/lib/terminationSettlement";
import {
  dongPhieuCoc,
  fmtNgay,
  parseCommissionVoucherFacts,
  type CommissionVoucherFacts,
} from "@/lib/commissionVoucherNote";

export interface SettlementItem {
  description: string;
  amount: number;
  /** invoice_item_type: PENALTY | RENT | SERVICE | OTHER … */
  type: string | null;
}

export interface RefundItem {
  description: string;
  amount: number;
  type_name: string | null;
  is_deposit: boolean;
}

export interface TerminationRecord {
  termination_date: string | null;
  actual_move_out_date: string | null;
  outstanding_debt: number;
  early_termination_fee: number;
  /** contract_terminations.total_deposit — số cọc đưa vào quyết toán (đã kẹp cọc thực thu). */
  deposit_used: number;
  rent_refund_amount: number;
  total_deductions: number | null;
  refund_amount: number | null;
  status: string | null;
  notes: string | null;
}

export interface TerminationRefundFacts {
  voucher: {
    id: string;
    code: string | null;
    total_amount: number;
    voucher_date: string | null;
    approval_status: string | null;
    account_id: string | null;
    notes: string | null;
  };
  contract: CommissionVoucherFacts | null;
  end_date: string | null;
  termination: TerminationRecord | null;
  excess_rent: number;
  shortfall_mode: "PAID" | "DEBT" | null;
  settlement_items: SettlementItem[];
  refund_items: RefundItem[];
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;
const num = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseTerminationRefundFacts(raw: Json | null | undefined): TerminationRefundFacts | null {
  if (!isJsonObject(raw) || !isJsonObject(raw.voucher)) return null;
  const v = raw.voucher;
  const id = str(v.id);
  if (!id) return null;

  const t = isJsonObject(raw.termination) ? raw.termination : null;
  const settlement: SettlementItem[] = [];
  for (const x of jsonArray({ a: raw.settlement_items }, "a")) {
    if (!isJsonObject(x)) continue;
    settlement.push({ description: str(x.description) ?? "Khoản thu thêm", amount: num(x.amount), type: str(x.type) });
  }
  const refunds: RefundItem[] = [];
  for (const x of jsonArray({ a: raw.refund_items }, "a")) {
    if (!isJsonObject(x)) continue;
    refunds.push({
      description: str(x.description) ?? "",
      amount: num(x.amount),
      type_name: str(x.type_name),
      is_deposit: x.is_deposit === true,
    });
  }
  const mode = raw.shortfall_mode;
  return {
    voucher: {
      id,
      code: str(v.code),
      total_amount: num(v.total_amount),
      voucher_date: str(v.voucher_date),
      approval_status: str(v.approval_status),
      account_id: str(v.account_id),
      notes: str(v.notes),
    },
    contract: parseCommissionVoucherFacts(raw.contract),
    end_date: str(raw.end_date),
    termination: t
      ? {
          termination_date: str(t.termination_date),
          actual_move_out_date: str(t.actual_move_out_date),
          outstanding_debt: num(t.outstanding_debt),
          early_termination_fee: num(t.early_termination_fee),
          deposit_used: num(t.deposit_used),
          rent_refund_amount: num(t.rent_refund_amount),
          total_deductions: numOrNull(t.total_deductions),
          refund_amount: numOrNull(t.refund_amount),
          status: str(t.status),
          notes: str(t.notes),
        }
      : null,
    excess_rent: num(raw.excess_rent),
    shortfall_mode: mode === "PAID" || mode === "DEBT" ? mode : null,
    settlement_items: settlement,
    refund_items: refunds,
  };
}

/** Dòng đầu: nhắc chọn sổ quỹ CHỈ khi phiếu còn chờ duyệt và chưa gán sổ. */
export function dongDauHoanKhach(f: TerminationRefundFacts): string {
  const canChonSo = f.voucher.approval_status === "UNAPPROVED" && !f.voucher.account_id;
  return (
    "[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật)." +
    (canChonSo ? " CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được." : "")
  );
}

/** Các dòng phía trên khung tổng hợp (mỗi phần tử một dòng). */
export function buildTerminationHeaderLines(f: TerminationRefundFacts): string[] {
  const c = f.contract;
  const maHD = c?.contract_number ?? "—";
  const ngayTL = fmtNgay(f.termination?.actual_move_out_date ?? f.end_date);
  const lines: string[] = [];
  lines.push(dongDauHoanKhach(f));
  lines.push(`QUYẾT TOÁN THANH LÝ ${ngayTL} — HĐ ${maHD}`);
  const stt = c?.seq_in_year != null ? String(c.seq_in_year) : "?";
  lines.push(
    `${c?.room_name ?? "—"}/${c?.building_name ?? "—"} · bắt đầu ${fmtNgay(c?.start_date)} · kết thúc ${fmtNgay(f.end_date)} (${maHD} - ${stt})`,
  );
  // Cọc ĐÃ THU = số cọc đưa vào quyết toán (contract_terminations.total_deposit).
  // Sau thanh lý, contracts.deposit_paid đã bị trừ bởi chính phiếu "Cấn cọc →
  // doanh thu" (chi nội bộ, is_deposit) nên KHÔNG dùng; và chỉ liệt kê phiếu THU —
  // phiếu CHI trong danh sách là kết quả của quyết toán này, không phải nguồn cọc.
  const daThu = f.termination?.deposit_used ?? c?.deposit_paid ?? 0;
  const vouchers = (c?.deposit_vouchers ?? []).filter((v) => v.type === "INCOME");
  if (vouchers.length === 0) {
    lines.push(`Cọc đã thu: ${formatVND(daThu)} (chưa có phiếu thu cọc)`);
  } else {
    lines.push(`Cọc đã thu: ${formatVND(daThu)}`);
    for (const v of vouchers) lines.push(dongPhieuCoc(v));
  }
  lines.push("-");
  return lines;
}

export interface CardRow {
  label: string;
  amount: number;
  tone: "red" | "green" | "muted";
  /** Dòng con thụt vào (liệt kê từng khoản). */
  sub?: { label: string; amount: number }[];
}

export interface TerminationCard {
  rows: CardRow[];
  totalDeductions: number;
  /** Dương = chủ trả khách, âm = khách phải trả thêm. */
  net: number;
  netLabel: string;
  settlement: TerminationSettlement;
  /** Phiếu chi ≠ số tính lại ⇒ cảnh báo, không im lặng. */
  warning: string | null;
}

/** Khung TỔNG HỢP y như TerminateDialog §4, tính lại từ hồ sơ đã lưu. */
export function buildTerminationCard(f: TerminationRefundFacts): TerminationCard | null {
  const t = f.termination;
  if (!t) return null;

  const penalty = f.settlement_items
    .filter((it) => it.type === "PENALTY")
    .reduce((s, it) => s + it.amount, 0);
  const extraItems = f.settlement_items.filter((it) => it.type !== "PENALTY");
  const extraFromItems = extraItems.reduce((s, it) => s + it.amount, 0);
  // early_termination_fee = phạt + thu thêm (writer ghi gộp). Ưu tiên hồ sơ; item
  // chỉ để liệt kê. Hồ sơ = 0 mà item có tiền ⇒ tin item (hồ sơ cũ thiếu cột).
  const extra = Math.max(t.early_termination_fee - penalty, 0) || extraFromItems;

  const s = computeTerminationSettlement({
    depositPaid: t.deposit_used,
    depositRefundRequested: t.deposit_used,
    excessRent: f.excess_rent,
    outstandingDebt: t.outstanding_debt,
    penaltyFee: penalty,
    extraChargesTotal: extra,
    customerRefundTotal: t.rent_refund_amount,
  });

  const refundSubs = f.refund_items
    .filter((it) => !it.is_deposit && it.type_name !== "Hoàn tiền thừa thanh lý" && it.amount > 0)
    .map((it) => ({ label: it.description || it.type_name || "Hoàn lại khách", amount: it.amount }));

  const rows: CardRow[] = [
    { label: "Tổng công nợ", amount: t.outstanding_debt, tone: "red" },
    { label: "Tiền cọc hoàn trả", amount: s.deposit, tone: "green" },
    { label: "Tiền phòng thừa", amount: f.excess_rent, tone: "green" },
    { label: "Hoàn lại khách", amount: s.owed, tone: "green", sub: refundSubs },
  ];
  if (penalty > 0) rows.push({ label: "Phí phạt thanh lý", amount: penalty, tone: "red" });
  rows.push({
    label: "Tổng thu thêm",
    amount: extra,
    tone: "red",
    sub: extraItems.filter((it) => it.amount > 0).map((it) => ({ label: it.description, amount: it.amount })),
  });
  if (s.appliedDeposit > 0) {
    rows.push({ label: "Cọc cấn vào khấu trừ (bút toán nội bộ)", amount: s.appliedDeposit, tone: "muted" });
  }

  let warning: string | null = null;
  if (Math.abs(s.totalRefund - f.voucher.total_amount) > 1) {
    warning = `Số phiếu chi ${formatVND(f.voucher.total_amount)} khác số tính lại ${formatVND(s.totalRefund)} — hồ sơ quyết toán có thể đã chỉnh tay, đối chiếu ghi chú gốc.`;
  }

  const netLabel =
    s.net >= 0
      ? "Chủ nhà trả lại khách"
      : `Khách còn phải trả${f.shortfall_mode === "DEBT" ? " (ghi nợ — chờ thu)" : f.shortfall_mode === "PAID" ? " (đã thu khi thanh lý)" : ""}`;

  return { rows, totalDeductions: s.charges, net: s.net, netLabel, settlement: s, warning };
}
