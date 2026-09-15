// =============================================================
// Nhịp gom sự kiện của hub realtime — DỮ LIỆU + PHÉP TÍNH THUẦN.
//
// Tách khỏi useRealtimeDataSync.ts (15/09, plan con B) vì hub có một trần độ dài
// được ghim bằng test (realtimeOrchestratorThin.test.ts: < 260 dòng). Trần đó
// không phải luật thẩm mỹ — nó là phép đo "hub biết cách CHẠY, không biết CHẠY
// GÌ". Phần dưới đây là cách chạy thuần tuý, không nhắc tên bảng hay query key
// nào, nên nó ra khỏi hub mà không làm loãng ranh giới ấy.
// =============================================================

export const DEBOUNCE_MS = 800;

// TRẦN CHỜ — thứ mà debounce 800ms KHÔNG có, và thiếu nó thì lời hứa "gộp cơn
// bão về 1 lần invalidate" chỉ đúng SAU KHI bão tan.
//
// DEBOUNCE_MS là trailing-edge thuần: mỗi event clearTimeout rồi đặt lại. Một
// đợt bulk bắn event dày hơn 1 lần/800ms (sinh hoá đơn hàng loạt, import thu
// chi) đẩy lùi flush VÔ HẠN. Trong suốt đợt đó giao diện đứng số mà không có tín
// hiệu nào: không lỗi, không cảnh báo, người dùng chỉ thấy màn hình không đổi.
//
// MAX_WAIT_MS là mốc muộn nhất tính từ event ĐẦU TIÊN của cụm. Chọn 3×: đủ xa để
// vẫn gộp được một cụm bình thường (một thao tác người dùng hiếm khi kéo quá 2,4
// giây), đủ gần để một đợt bulk vẫn nhả tin về màn hình vài lần thay vì im bặt
// tới lúc xong.
export const MAX_WAIT_MS = DEBOUNCE_MS * 3;

/**
 * Thời gian còn được phép chờ: bình thường là trọn DEBOUNCE_MS, nhưng không bao
 * giờ vượt quá mốc trần tính từ event đầu cụm. Trả về 0 khi đã quá hạn — timer
 * 0ms vẫn chạy bất đồng bộ nên thứ tự vẫn đúng.
 */
export function delayConTrongTran(mocDauCum: number, bayGio: number): number {
  return Math.max(0, Math.min(DEBOUNCE_MS, mocDauCum + MAX_WAIT_MS - bayGio));
}
