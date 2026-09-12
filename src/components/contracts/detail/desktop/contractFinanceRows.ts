// Bảng "Tài chính" của màn chi tiết hợp đồng (desktop bản mới): gom TIỀN CỌC +
// HOÁ ĐƠN + QUYẾT TOÁN THANH LÝ vào MỘT bảng, thay cho 3 thẻ rời và 2 tab
// (Hoá đơn / Thanh toán) của bản cũ.
//
// LUẬT ĐẾM — chỗ duy nhất dễ sai ở file này:
//   Dòng CHÍNH cộng vào tổng; dòng CON thì không. Dòng con là chi tiết của dòng
//   cha (phiếu thu cọc của dòng cọc, từng lần trả tiền của dòng hoá đơn, ba dòng
//   bóc tách của dòng net quyết toán) — cộng vào là đếm hai lần đúng số tiền đó.
//
// Ba con số tổng trong file thiết kế (8.050.000 / 12.200.000 / 10.878.500) khớp
// đúng luật này, kể cả cột "Đã thu" 9.500.000 của ca thanh lý. Chúng là fixture
// trong __tests__/contractFinanceRows.test.ts.
//
// LƯU Ý NGHĨA CỦA CỘT "ĐÃ THU" Ở DÒNG NET QUYẾT TOÁN: đó là tiền ĐI RA (phiếu
// hoàn đã vào sổ), không phải tiền thu vào. Thiết kế cố ý xếp chung cột để bảng
// chỉ có một trục số; dòng cảnh báo dưới nhóm là chỗ nói rõ chuyện đó.

import { formatAmount } from "@/components/contracts/detail/formatCurrency";
import { nhanKyHoaDon } from "./invoicePeriodLabel";

export interface DongTien {
  id: string;
  ten: string;
  /** Cột "Kỳ / ngày". */
  ky: string;
  soTien: number | null;
  daThu: number | null;
  conNo: number | null;
  laDongCon: boolean;
  /** Hoá đơn đã huỷ — vẫn cộng vào tổng, chỉ nhuộm nhạt. */
  daHuy?: boolean;
  /** Chú thích nhỏ in sau tên (vd "cọc đầu kỳ (không vào sổ quỹ)"). */
  ghiChu?: string | null;
  /** Mã phiếu/hoá đơn in font mono trước tên. */
  ma?: string | null;
  /** Nút 👁 mở gì: id hoá đơn để điều hướng, null thì không có nút. */
  moHoaDonId?: string | null;
}

export type KhoaNhom = "TIEN_COC" | "HOA_DON" | "QUYET_TOAN";

export interface NhomTien {
  khoa: KhoaNhom;
  tieuDe: string;
  /** Nhóm thanh lý tô đỏ, hai nhóm kia tô xanh. */
  toDo: boolean;
  dong: DongTien[];
  /** Câu cảnh báo dưới nhóm; null là không có gì phải cảnh báo. */
  canhBao: string | null;
}

export interface TongTien {
  soHoaDon: number;
  soTien: number;
  daThu: number;
  conNo: number;
}

export interface PhieuCocChoBang {
  id: string;
  code: string | null;
  total_amount: number | string | null;
  voucher_date: string;
  approval_status?: string | null;
  posting_status?: string | null;
  account?: { name?: string | null } | null;
}

export interface LanThanhToanChoBang {
  id: string;
  amount: number | string | null;
  payment_date: string;
  payment_method?: string | null;
  notes?: string | null;
  reversed_at?: string | null;
}

export interface HoaDonChoBang {
  id: string;
  invoice_number?: string | null;
  billing_month?: string | null;
  status?: string | null;
  total_amount?: number | string | null;
  paid_amount?: number | string | null;
  invoice_items?: Array<{ from_date?: string | null; to_date?: string | null }> | null;
  payments?: LanThanhToanChoBang[] | null;
}

export interface QuyetToanChoBang {
  termination_type: string | null;
  actual_move_out_date: string | null;
  total_deposit: number | null;
  outstanding_debt: number | null;
  early_termination_fee: number | null;
  refund_amount: number | null;
  posted_refund: number;
  posted_refund_count: number;
  posted_refund_codes: string[];
}

export interface HopDongChoBang {
  status: string;
  total_deposit?: number | null;
  deposit_paid?: number | null;
  deposit_remaining?: number | null;
}

const n = (gt: unknown): number => {
  const v = Number(gt);
  return Number.isFinite(v) ? v : 0;
};

const ngayVn = (gt: string | null | undefined): string => {
  if (!gt) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(gt);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : gt;
};

const PHUONG_THUC: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  CARD: "Thẻ",
  OTHER: "Khác",
};

function nhomTienCoc(
  contract: HopDongChoBang,
  phieu: PhieuCocChoBang[],
): NhomTien {
  const phaiThu = n(contract.total_deposit);
  const daThu = n(contract.deposit_paid);

  const dong: DongTien[] = [
    {
      id: "coc-chinh",
      ten: "Tiền cọc theo hợp đồng",
      ky: "Theo HĐ",
      soTien: phaiThu,
      daThu,
      // `deposit_remaining` là cột của DB; dùng nó thay vì tự trừ để không đẻ ra
      // số thứ hai cãi nhau với phần còn lại của app.
      conNo: Math.max(n(contract.deposit_remaining), 0),
      laDongCon: false,
    },
  ];

  for (const p of phieu) {
    const chuThich: string[] = [];
    if (p.approval_status && p.approval_status !== "APPROVED") {
      chuThich.push(p.approval_status);
    }
    // Phiếu cọc đầu kỳ lên sổ ảo: tiền khách đóng TRƯỚC khi dùng phần mềm nên
    // không hề chạy qua sổ quỹ. Nói rõ để không ai đi tìm dòng tiền trong két.
    if (p.posting_status === "NOT_APPLICABLE") {
      chuThich.push("cọc đầu kỳ (không vào sổ quỹ)");
    }
    dong.push({
      id: `coc-${p.id}`,
      ma: p.code,
      ten: p.account?.name ?? "",
      ky: ngayVn(p.voucher_date),
      soTien: null,
      daThu: n(p.total_amount),
      conNo: null,
      laDongCon: true,
      ghiChu: chuThich.length > 0 ? chuThich.join(" · ") : null,
    });
  }

  return { khoa: "TIEN_COC", tieuDe: "Tiền cọc", toDo: false, dong, canhBao: null };
}

function nhomHoaDon(
  hoaDon: HoaDonChoBang[],
  tenHoaDon: (hd: HoaDonChoBang) => string,
): NhomTien {
  const dong: DongTien[] = [];

  for (const hd of hoaDon) {
    const tong = n(hd.total_amount);
    const daThu = n(hd.paid_amount);
    dong.push({
      id: hd.id,
      ten: tenHoaDon(hd),
      ky: nhanKyHoaDon(hd),
      soTien: tong,
      daThu,
      conNo: Math.max(tong - daThu, 0),
      laDongCon: false,
      daHuy: hd.status === "CANCELLED",
      moHoaDonId: hd.id,
    });

    for (const tt of hd.payments ?? []) {
      // Lần trả tiền đã bị đảo (reversed_at) không còn là tiền đã thu — bỏ khỏi
      // danh sách thay vì hiện rồi để người đọc tự trừ.
      if (tt.reversed_at) continue;
      const chuThich = [
        tt.payment_method
          ? PHUONG_THUC[tt.payment_method] ?? tt.payment_method
          : null,
        tt.notes,
      ]
        .filter(Boolean)
        .join(" · ");
      dong.push({
        id: `tt-${tt.id}`,
        ten: chuThich || "Thanh toán",
        ky: ngayVn(tt.payment_date),
        soTien: null,
        daThu: n(tt.amount),
        conNo: null,
        laDongCon: true,
      });
    }
  }

  return { khoa: "HOA_DON", tieuDe: "Hoá đơn", toDo: false, dong, canhBao: null };
}

function nhomQuyetToan(qt: QuyetToanChoBang): NhomTien {
  const boCoc = qt.termination_type === "FORFEIT";
  const net = boCoc ? n(qt.early_termination_fee) : n(qt.refund_amount);
  const daHoan = n(qt.posted_refund);
  const lech = net - daHoan;

  const dong: DongTien[] = [
    {
      id: "qt-coc",
      ten: "Cọc tính quyết toán",
      ky: "",
      soTien: n(qt.total_deposit),
      daThu: null,
      conNo: null,
      laDongCon: true,
    },
    {
      id: "qt-no",
      ten: "Công nợ cấn trừ",
      ky: "",
      soTien: -n(qt.outstanding_debt),
      daThu: null,
      conNo: null,
      laDongCon: true,
    },
    {
      id: "qt-phi",
      ten: "Phí phạt + thu thêm",
      ky: "",
      soTien: -n(qt.early_termination_fee),
      daThu: null,
      conNo: null,
      laDongCon: true,
    },
    {
      id: "qt-net",
      ten: boCoc ? "Cọc giữ làm doanh thu" : "Net quyết toán (hồ sơ)",
      ky: ngayVn(qt.actual_move_out_date),
      soTien: net,
      daThu: daHoan,
      conNo: Math.max(lech, 0),
      laDongCon: false,
    },
  ];

  // Hồ sơ và tiền thật là HAI nguồn và trên prod chúng lệch nhau theo cả hai
  // chiều. Nói thẳng con số lệch, và nói rõ là phải rà tay — tuyệt đối không
  // tự sửa số cho khớp.
  let canhBao: string | null = null;
  if (!boCoc && net !== 0 && lech !== 0) {
    canhBao =
      qt.posted_refund_count > 0
        ? `Phiếu hoàn đã vào sổ: ${qt.posted_refund_codes.join(", ")} — lệch ${formatAmount(Math.abs(lech))} so với hồ sơ, cần rà tay.`
        : `Chưa có phiếu hoàn nào vào sổ — hồ sơ ghi ${formatAmount(net)}, cần rà tay.`;
  }

  const ngay = ngayVn(qt.actual_move_out_date);
  return {
    khoa: "QUYET_TOAN",
    tieuDe: `Quyết toán thanh lý · ${boCoc ? "khách bỏ cọc" : "khách rời phòng"}${ngay ? ` · ${ngay}` : ""}`,
    toDo: true,
    dong,
    canhBao,
  };
}

export function dungBangTaiChinh(args: {
  contract: HopDongChoBang;
  depositVouchers: PhieuCocChoBang[];
  invoices: HoaDonChoBang[];
  terminationInfo: QuyetToanChoBang | null | undefined;
  /** Cách đặt tên hoá đơn; mặc định dùng số hoá đơn. */
  tenHoaDon?: (hd: HoaDonChoBang) => string;
}): { nhom: NhomTien[]; tong: TongTien } {
  const { contract, depositVouchers, invoices, terminationInfo } = args;
  const tenHoaDon =
    args.tenHoaDon ?? ((hd: HoaDonChoBang) => hd.invoice_number || hd.id.slice(0, 8));

  const nhom: NhomTien[] = [
    nhomTienCoc(contract, depositVouchers),
    nhomHoaDon(invoices, tenHoaDon),
  ];

  // Chỉ hiện quyết toán khi HĐ THỰC SỰ đã thanh lý. Hồ sơ thanh lý có thể tồn
  // tại ở trạng thái nháp/chờ duyệt trên một HĐ vẫn đang chạy — hiện ra là nói
  // sai chuyện đã xảy ra.
  if (contract.status === "TERMINATED" && terminationInfo) {
    nhom.push(nhomQuyetToan(terminationInfo));
  }

  const dongChinh = nhom.flatMap((g) => g.dong).filter((d) => !d.laDongCon);
  const soTien = dongChinh.reduce((s, d) => s + n(d.soTien), 0);
  const daThu = dongChinh.reduce((s, d) => s + n(d.daThu), 0);

  return {
    nhom,
    tong: {
      soHoaDon: invoices.length,
      soTien,
      daThu,
      conNo: Math.max(soTien - daThu, 0),
    },
  };
}
