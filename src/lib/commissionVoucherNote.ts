// =============================================================================
// Ghi chú phiếu hoa hồng — dựng LÚC XEM từ facts hợp đồng (RPC
// get_commission_voucher_facts_v1). Thuần, không gọi mạng, không đọc đồng hồ
// máy: "hôm nay" là `facts.today` do server tính theo múi giờ tổ chức.
//
// Năm dòng chủ chốt (02/09/2026):
//   1. Phòng/Tòa + ngày bắt đầu + (Mã HĐ - STT trong năm)
//   2. Giá phòng · bắt đầu - kết thúc (% hoa hồng - N tháng)
//   3. Đã/Chưa cọc đủ + từng phiếu cọc (mã, phần cọc, tổng phiếu nếu gộp hoá đơn)
//   4. Đã/Chưa đủ 7 ngày tính từ ngày vào ở (= ngày bắt đầu HĐ, khớp luật tự duyệt)
//   5. Khách đại diện · SĐT · trạng thái HĐ hiện tại
// =============================================================================

import { formatVND } from "@/lib/utils";
import {
  CONTRACT_STATUS_CONFIG,
  type ContractDisplayStatus,
} from "@/types/contract";
import { isJsonObject, jsonArray } from "@/lib/jsonValue";
import type { Json } from "@/integrations/supabase/types";

export interface CommissionDepositVoucher {
  id: string;
  code: string | null;
  voucher_date: string | null;
  type: "INCOME" | "EXPENSE";
  /** Phần CỌC trên phiếu (Σ item accounting_class = DEPOSIT). */
  deposit_amount: number;
  /** Tổng phiếu — lớn hơn phần cọc khi phiếu thu gộp cọc với hoá đơn. */
  total_amount: number;
  is_combined: boolean;
}

export interface CommissionVoucherFacts {
  contract_id: string | null;
  contract_number: string | null;
  room_name: string | null;
  building_name: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  expected_move_out_date: string | null;
  seq_in_year: number | null;
  rent_price: number | null;
  months: number | null;
  total_deposit: number | null;
  deposit_paid: number | null;
  deposit_enough: boolean | null;
  deposit_vouchers: CommissionDepositVoucher[];
  today: string | null;
  seven_days_date: string | null;
  seven_days_ok: boolean | null;
  rep_name: string | null;
  rep_phone: string | null;
  commission_kind: "broker" | "sale" | null;
  total_amount: number | null;
  rate_percent: number | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/**
 * Ép jsonb từ RPC về facts có kiểu. Không tin cấu trúc: thiếu trường ⇒ null,
 * dòng cọc méo (thiếu id/số tiền) ⇒ loại — ghi chú là để ĐỌC, không phải để
 * đoán hộ dữ liệu.
 */
export function parseCommissionVoucherFacts(raw: Json | null | undefined): CommissionVoucherFacts | null {
  if (!isJsonObject(raw)) return null;
  const kind = raw.commission_kind;
  const vouchers: CommissionDepositVoucher[] = [];
  for (const x of jsonArray({ v: raw.deposit_vouchers }, "v")) {
    if (!isJsonObject(x)) continue;
    const id = str(x.id);
    const dep = num(x.deposit_amount);
    const total = num(x.total_amount);
    if (!id || dep === null || total === null) continue;
    vouchers.push({
      id,
      code: str(x.code),
      voucher_date: str(x.voucher_date),
      type: x.type === "EXPENSE" ? "EXPENSE" : "INCOME",
      deposit_amount: dep,
      total_amount: total,
      is_combined: x.is_combined === true,
    });
  }
  return {
    contract_id: str(raw.contract_id),
    contract_number: str(raw.contract_number),
    room_name: str(raw.room_name),
    building_name: str(raw.building_name),
    status: str(raw.status),
    start_date: str(raw.start_date),
    end_date: str(raw.end_date),
    expected_move_out_date: str(raw.expected_move_out_date),
    seq_in_year: num(raw.seq_in_year),
    rent_price: num(raw.rent_price),
    months: num(raw.months),
    total_deposit: num(raw.total_deposit),
    deposit_paid: num(raw.deposit_paid),
    deposit_enough: bool(raw.deposit_enough),
    deposit_vouchers: vouchers,
    today: str(raw.today),
    seven_days_date: str(raw.seven_days_date),
    seven_days_ok: bool(raw.seven_days_ok),
    rep_name: str(raw.rep_name),
    rep_phone: str(raw.rep_phone),
    commission_kind: kind === "broker" || kind === "sale" ? kind : null,
    total_amount: num(raw.total_amount),
    rate_percent: num(raw.rate_percent),
  };
}

/** 'YYYY-MM-DD' → 'dd/mm/yyyy' — cắt chuỗi, không qua Date (tránh lệch múi giờ). */
export function fmtNgay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

/** Số ngày giữa hai chuỗi 'YYYY-MM-DD' (b − a), tính theo UTC để không lệch DST. */
function soNgay(a: string, b: string): number | null {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a);
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
  if (!pa || !pb) return null;
  const ua = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]);
  const ub = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((ub - ua) / 86_400_000);
}

/**
 * Trạng thái hiển thị của HĐ — cùng luật với getContractDisplayStatus ở
 * src/types/contract.ts nhưng lấy "hôm nay" từ server (facts.today) thay vì
 * đồng hồ máy khách, để bản in/ghi chú ổn định và test được.
 */
export function trangThaiHopDong(f: Pick<CommissionVoucherFacts,
  "status" | "end_date" | "expected_move_out_date" | "today">): ContractDisplayStatus {
  if (f.status === "TERMINATED") return "TERMINATED";
  if (f.status === "TRANSFERRED") return "TRANSFERRED";
  if (f.status === "DRAFT") return "DRAFT";
  if (f.expected_move_out_date) return "MOVING_OUT";
  if (f.status === "EXPIRED") return "EXPIRED";
  if (!f.end_date || !f.today) return "ACTIVE";
  const d = soNgay(f.today, f.end_date);
  if (d === null) return "ACTIVE";
  if (d < 0) return "EXPIRED";
  if (d <= 30) return "EXPIRING";
  return "ACTIVE";
}

const fmtPhanTram = (p: number): string =>
  `${(Math.round(p * 10) / 10).toLocaleString("vi-VN")}%`;

/** Dòng con cho một phiếu cọc. */
export function dongPhieuCoc(v: CommissionDepositVoucher): string {
  const ma = v.code ?? "(không mã)";
  const ngay = v.voucher_date ? ` (${fmtNgay(v.voucher_date)})` : "";
  if (v.type === "EXPENSE") {
    return `  · ${ma}${ngay}: hoàn cọc −${formatVND(v.deposit_amount)}`;
  }
  if (v.is_combined) {
    return `  · ${ma}${ngay}: cọc ${formatVND(v.deposit_amount)} / tổng phiếu ${formatVND(v.total_amount)} (gộp hoá đơn)`;
  }
  return `  · ${ma}${ngay}: ${formatVND(v.deposit_amount)}`;
}

/** Năm dòng ghi chú (dòng 3 kèm các dòng con phiếu cọc). */
export function buildCommissionNoteLines(f: CommissionVoucherFacts): string[] {
  const lines: string[] = [];
  const phongToa = `${f.room_name ?? "—"}/${f.building_name ?? "—"}`;
  const stt = f.seq_in_year != null ? String(f.seq_in_year) : "?";

  // 1. Phòng/Tòa + ngày bắt đầu + (Mã HĐ - STT)
  lines.push(`${phongToa} ${fmtNgay(f.start_date)} (${f.contract_number ?? "—"} - ${stt})`);

  // 2. Giá phòng · bắt đầu - kết thúc (% - N tháng)
  const thang = f.months != null ? `${f.months} tháng` : "? tháng";
  const ngoac = f.rate_percent != null ? `${fmtPhanTram(f.rate_percent)} - ${thang}` : thang;
  lines.push(
    `Giá phòng ${formatVND(f.rent_price)} · ${fmtNgay(f.start_date)} - ${fmtNgay(f.end_date)} (${ngoac})`,
  );

  // 3. Cọc
  const phai = f.total_deposit ?? 0;
  const da = f.deposit_paid ?? 0;
  if (f.deposit_vouchers.length === 0) {
    lines.push(`Chưa cọc: ${formatVND(0)} / ${formatVND(phai)} (chưa có phiếu thu cọc)`);
  } else if (f.deposit_enough ?? da >= phai) {
    lines.push(`Đã cọc đủ: ${formatVND(da)}`);
  } else {
    lines.push(`Chưa cọc đủ: ${formatVND(da)} / ${formatVND(phai)}`);
  }
  for (const v of f.deposit_vouchers) lines.push(dongPhieuCoc(v));

  // 4. 7 ngày từ ngày vào ở (= ngày bắt đầu HĐ)
  if (f.seven_days_ok) {
    lines.push(`Đã đủ 7 ngày tính từ ngày vào ở ${fmtNgay(f.start_date)}`);
  } else {
    lines.push(
      `Chưa đủ 7 ngày tính từ ngày vào ở ${fmtNgay(f.start_date)} (đủ ngày ${fmtNgay(f.seven_days_date)})`,
    );
  }

  // 5. Khách · SĐT · trạng thái
  const trangThai = CONTRACT_STATUS_CONFIG[trangThaiHopDong(f)].label;
  const khach = f.rep_name ? `${f.rep_name} · ${f.rep_phone ?? "—"}` : "— (chưa có khách đại diện)";
  lines.push(`${khach} · ${trangThai}`);

  return lines;
}
