// Phép tính cho header đen của màn chi tiết hợp đồng (desktop bản mới).
// Tách khỏi JSX để test được — mấy chỗ dễ sai ở đây đều là số học, không phải
// bố cục: chia cho 0 khi HĐ có ngày bắt đầu = ngày kết thúc, và dấu âm khi HĐ
// đã quá hạn.

export interface ChipTrangThai {
  nhan: string;
  /** Chấm tròn xanh (đang chạy) hay xám (mọi trạng thái còn lại). */
  xanh: boolean;
}

const NHAN_TRANG_THAI: Record<string, string> = {
  DRAFT: "Nháp",
  ACTIVE: "Đang hoạt động",
  TRANSFERRED: "Đã chuyển nhượng",
  TERMINATED: "Đã thanh lý",
  EXPIRED: "Hết hạn",
};

/**
 * Chip trạng thái HĐ. Trạng thái lạ (enum DB được nới sau này) hiện NGUYÊN mã
 * thay vì rơi về rỗng — ô trống ở đây đọc như "HĐ không có trạng thái", còn mã
 * lạ thì có người sẽ hỏi và ta sửa được.
 */
export function chipTrangThai(status: string): ChipTrangThai {
  return {
    nhan: NHAN_TRANG_THAI[status] ?? status,
    xanh: status === "ACTIVE",
  };
}

/** Phần trăm thời hạn đã trôi qua, làm tròn, luôn nằm trong [0, 100]. */
export function tienDoHopDong(totalDays: number, daysElapsed: number): number {
  // HĐ một ngày (start = end) cho totalDays = 0. Không chặn ở đây thì ra Infinity
  // rồi thanh tiến độ nhận width: "Infinity%".
  if (!Number.isFinite(totalDays) || totalDays <= 0) return 0;
  const pct = (daysElapsed / totalDays) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.round(Math.min(Math.max(pct, 0), 100));
}

export interface NhanThoiHan {
  tienTo: "còn" | "quá hạn";
  so: number;
  donVi: "ngày";
}

/**
 * "còn 351 ngày" / "quá hạn 4 ngày". Trả về từng mảnh thay vì chuỗi ghép sẵn vì
 * header in ba mảnh ở ba cỡ chữ khác nhau.
 */
export function nhanThoiHan(daysRemaining: number): NhanThoiHan {
  if (daysRemaining < 0) {
    return { tienTo: "quá hạn", so: Math.abs(daysRemaining), donVi: "ngày" };
  }
  return { tienTo: "còn", so: daysRemaining, donVi: "ngày" };
}
