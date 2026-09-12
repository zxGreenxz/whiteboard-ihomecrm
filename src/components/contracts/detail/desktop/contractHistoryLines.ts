// "Lịch sử hợp đồng" ở màn chi tiết desktop bản mới: mỗi sự kiện là MỘT DÒNG
// CHỮ ĐỌC ĐƯỢC, không phải một cục JSON được nhãn hoá.
//
// Bản cũ in "Loại: ROOM CHANGE" / "Gia hạn 12 tháng" rồi thôi — người xem vẫn
// phải tự đoán phòng nào sang phòng nào, giá có đổi không. Ở đây mỗi dòng tự
// trả lời trọn câu hỏi "hôm đó chuyện gì xảy ra".
//
// Vốn từ transfer_type bám theo src/lib/vacancyReason.ts để cả app nói giống
// nhau: ROOM_CHANGE = chuyển phòng; TENANT_CHANGE / BOTH_CHANGE = sang nhượng.

import type { ContractHistoryItem } from "@/components/contracts/detail/types";
import { formatAmount } from "@/components/contracts/detail/formatCurrency";

export interface DongLichSu {
  id: string;
  /** Đã format dd/MM/yyyy, sẵn sàng in. */
  ngay: string;
  tieuDe: string;
  moTa: string;
  nhan: string;
  /** Class Tailwind cho ô nhãn (chữ + nền + viền). */
  lopNhan: string;
}

export interface HopDongChoLichSu {
  id: string;
  contract_number: string | null;
  created_at?: string | null;
  signed_date?: string | null;
  start_date: string;
  end_date: string;
}

const LOP_NHAN = {
  giaHan: "text-[#12764a] bg-[#eef7f2] border-[#cfe7db]",
  nhuong: "text-[#92400e] bg-[#fffbeb] border-[#fde68a]",
  chuyenPhong: "text-[#1e40af] bg-[#eff6ff] border-[#bfdbfe]",
  thanhLy: "text-[#9f1239] bg-[#fdf3f4] border-[#f6e3e6]",
  taoMoi: "text-[#4a5a52] bg-[#f4f6f7] border-[#e2e5ea]",
} as const;

/** "2026-09-05" hoặc ISO đầy đủ → "05/09/2026". Không đọc được thì trả "". */
function ngayVn(gt: unknown): string {
  if (typeof gt !== "string") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(gt);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function so(gt: unknown): number | null {
  const n = Number(gt);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function chu(gt: unknown): string | null {
  return typeof gt === "string" && gt.trim() !== "" ? gt.trim() : null;
}

function dongGiaHan(item: ContractHistoryItem): DongLichSu {
  const d = item.details;
  const tu = ngayVn(d.old_end_date);
  const den = ngayVn(d.new_end_date);
  const thang = so(d.extension_months);
  const gia = so(d.new_rent_price);

  const manh: string[] = [];
  if (tu && den) manh.push(`${tu} → ${den}`);
  if (thang) manh.push(`${thang} tháng`);
  if (gia) {
    // `rent_price_changed` là cờ do writer đặt; nó mới là nguồn sự thật chuyện
    // "có đổi giá không". `new_rent_price` luôn có giá trị kể cả khi giữ nguyên.
    manh.push(
      d.rent_price_changed
        ? `giá ${formatAmount(gia)}`
        : `giá giữ nguyên ${formatAmount(gia)}`,
    );
  }

  return {
    id: item.id,
    ngay: ngayVn(item.created_at),
    tieuDe: "Gia hạn hợp đồng",
    moTa: manh.join(", "),
    nhan: "GIA HẠN",
    lopNhan: LOP_NHAN.giaHan,
  };
}

function dongChuyenNhuong(item: ContractHistoryItem): DongLichSu {
  const d = item.details;
  const loai = chu(d.transfer_type) ?? "ROOM_CHANGE";
  const doiPhong = loai === "ROOM_CHANGE";

  if (doiPhong) {
    // Thiếu một vế thì nói "phòng khác" chứ không in mũi tên cụt — mũi tên cụt
    // trông như lỗi render, còn "phòng khác" là câu đúng: ta biết có chuyển,
    // chỉ không tra được tên.
    const cu = chu(d.old_room_label) ?? "phòng khác";
    const moi = chu(d.new_room_label) ?? "phòng khác";
    const gia = so(d.new_rent_price);
    const manh = [`${cu} → ${moi}`];
    if (gia) manh.push(`giá ${formatAmount(gia)}`);
    return {
      id: item.id,
      ngay: ngayVn(item.created_at),
      tieuDe: "Chuyển phòng",
      moTa: manh.join(", "),
      nhan: "CHUYỂN PHÒNG",
      lopNhan: LOP_NHAN.chuyenPhong,
    };
  }

  const cu = chu(d.old_tenant_name) ?? "khách cũ";
  const moi = chu(d.new_tenant_name) ?? "khách mới";
  return {
    id: item.id,
    ngay: ngayVn(item.created_at),
    tieuDe: "Nhượng hợp đồng",
    moTa: `${cu} → ${moi}`,
    nhan: "NHƯỢNG HĐ",
    lopNhan: LOP_NHAN.nhuong,
  };
}

function dongThanhLy(item: ContractHistoryItem): DongLichSu {
  const d = item.details;
  const boCoc = chu(d.termination_type) === "FORFEIT";
  const manh: string[] = [boCoc ? "khách bỏ cọc" : "khách rời phòng"];

  const ngayTra = ngayVn(d.actual_move_out_date);
  if (ngayTra) manh.push(`trả phòng ${ngayTra}`);

  // Hai con số khác nghĩa nhau — bỏ cọc thì cọc thành doanh thu, rời phòng thì
  // net quyết toán là số hồ sơ. Không gộp chung một nhãn.
  if (boCoc) {
    const giu = so(d.early_termination_fee);
    if (giu) manh.push(`cọc giữ lại ${formatAmount(giu)}`);
  } else {
    const net = so(d.refund_amount);
    if (net) manh.push(`net quyết toán ${formatAmount(net)}`);
  }

  return {
    id: item.id,
    ngay: ngayVn(item.created_at),
    tieuDe: "Thanh lý hợp đồng",
    moTa: manh.join(", "),
    nhan: "THANH LÝ",
    lopNhan: LOP_NHAN.thanhLy,
  };
}

function dongTaoMoi(contract: HopDongChoLichSu): DongLichSu {
  const manh: string[] = [];
  const so_ = chu(contract.contract_number);
  if (so_) manh.push(so_);
  const tu = ngayVn(contract.start_date);
  const den = ngayVn(contract.end_date);
  if (tu && den) manh.push(`hiệu lực ${tu} – ${den}`);

  return {
    id: `${contract.id}-tao-moi`,
    // created_at là mốc đúng nhất; HĐ nhập từ sổ giấy có thể thiếu nên lùi về
    // ngày ký, rồi tới ngày bắt đầu.
    ngay:
      ngayVn(contract.created_at) ||
      ngayVn(contract.signed_date) ||
      ngayVn(contract.start_date),
    tieuDe: "Tạo hợp đồng",
    moTa: manh.join(", "),
    nhan: "TẠO MỚI",
    lopNhan: LOP_NHAN.taoMoi,
  };
}

export function dungDongLichSu(args: {
  contract: HopDongChoLichSu;
  history: ContractHistoryItem[];
}): DongLichSu[] {
  const { contract, history } = args;

  const dong = history
    .slice()
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .map((item) => {
      if (item.type === "extension") return dongGiaHan(item);
      if (item.type === "transfer") return dongChuyenNhuong(item);
      return dongThanhLy(item);
    });

  // "Tạo hợp đồng" luôn chốt đáy: nó là sự kiện cũ nhất về bản chất, và neo nó
  // cứng tránh chuyện HĐ nhập liệu ngược ngày làm nó nhảy lên giữa danh sách.
  dong.push(dongTaoMoi(contract));
  return dong;
}
