// =============================================================
// Tín hiệu realtime của hộp thư — PHÉP TÍNH THUẦN, không React, không Supabase.
// (21/10/2026, plan realtime + thông báo, mục C1.)
//
// VÌ SAO KÊNH notif PHẢI NGHE '*' VÀ VÌ SAO PHẢI GOM
//   Bản cũ chỉ nghe INSERT. Đọc trên điện thoại thì máy tính vẫn đỏ; server sửa
//   dòng gộp E1 "N phiếu chờ bạn duyệt" (upsert ⇒ UPDATE, không INSERT) thì chuông
//   người duyệt đứng số cũ. Nghe '*' sửa được, nhưng "Đánh dấu đã đọc tất cả" sinh
//   MỘT sự kiện UPDATE cho TỪNG dòng (đo prod: một người có 1.979 dòng chưa đọc),
//   bắn tới mọi thiết bị kể cả chính máy vừa bấm. Không gom thì đó là ~2.000 lần
//   refetch. Nên hai việc đi cùng nhau: lọc sự kiện vô nghĩa + gom có trần chờ.
//
// HẰNG RIÊNG, KHÔNG DÙNG hubDebounce
//   Hub gom 800 ms / trần 2,4 s cho bảng nghiệp vụ. Chuông là thứ người dùng nhìn
//   chờ ("có thông báo mới chưa?"), 800 ms là trễ vô ích; nhưng trailing thuần thì
//   một cơn bão kéo dài đẩy lùi lần làm mới VÔ HẠN. 300 ms đủ gộp một lệnh
//   markAll (các UPDATE cùng giao dịch tới sát nhau), trần 1 s bảo đảm cơn bão dài
//   vẫn nhả số mới về màn hình mỗi giây.
// =============================================================

/** Chờ thêm sau sự kiện cuối của cụm (trailing). */
export const GOM_THONG_BAO_MS = 300;
/** Mốc muộn nhất tính từ sự kiện ĐẦU cụm — chống đẩy lùi vô hạn. */
export const TRAN_CHO_THONG_BAO_MS = 1_000;

/** Phần payload postgres_changes mà kênh notif đọc (không tin hình dạng). */
export interface NotificationChangePayload {
  eventType?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

/** Cột mà chuông/hộp thư hiển thị; UPDATE chỉ đáng làm mới khi một trong số này đổi. */
const COT_HIEN_THI = ["status", "subject", "content"] as const;

/**
 * Sự kiện có đáng làm mới hộp thư không.
 *
 * - INSERT / DELETE: luôn có (thêm hoặc mất một dòng).
 * - UPDATE: chỉ khi trạng thái hoặc nội dung đổi. Hàng đợi push ghi push_state,
 *   push_attempts, push_leased_at… mỗi lượt drain — những UPDATE đó không đổi gì
 *   người dùng nhìn thấy nên bỏ qua.
 *   Bảng để REPLICA IDENTITY FULL (gói B2) nên `old` có đủ cột. Nếu `old` THIẾU
 *   một cột (replica identity DEFAULT, hoặc server chưa áp B2) thì không chứng
 *   minh được "không đổi" ⇒ coi như ĐỔI. Bỏ lỡ một lần làm mới tệ hơn thừa một lần.
 * - Loại lạ: coi như có (an toàn hơn bỏ qua).
 */
export function suKienCanLamMoi(payload: NotificationChangePayload | null | undefined): boolean {
  const loai = payload?.eventType;
  if (loai !== "UPDATE") return true;
  const cu = payload?.old;
  const moi = payload?.new;
  if (!cu || !moi) return true;
  return COT_HIEN_THI.some((cot) => !(cot in cu) || !(cot in moi) || cu[cot] !== moi[cot]);
}

/**
 * Thời gian còn được chờ: trọn GOM_THONG_BAO_MS, nhưng không vượt trần tính từ
 * sự kiện đầu cụm. 0 khi đã quá hạn (timer 0 ms vẫn bất đồng bộ nên thứ tự đúng).
 */
export function choConLaiThongBao(mocDauCum: number, bayGio: number): number {
  return Math.max(0, Math.min(GOM_THONG_BAO_MS, mocDauCum + TRAN_CHO_THONG_BAO_MS - bayGio));
}

export interface BoGomThongBao {
  /** Ghi nhận một sự kiện; lần làm mới sẽ chạy sau khi cụm lặng (có trần). */
  day(): void;
  /** Huỷ lần làm mới đang chờ (dọn hook). */
  huy(): void;
}

/** Gom nhiều sự kiện liền nhau về MỘT lần gọi `lamMoi`, theo luật ở đầu file. */
export function taoBoGomThongBao(lamMoi: () => void, now: () => number = Date.now): BoGomThongBao {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let mocDauCum = 0;
  return {
    day() {
      const bayGio = now();
      if (timer !== null) clearTimeout(timer);
      else mocDauCum = bayGio;
      timer = setTimeout(() => {
        timer = null;
        lamMoi();
      }, choConLaiThongBao(mocDauCum, bayGio));
    },
    huy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
