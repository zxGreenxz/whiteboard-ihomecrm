// Kho nonce xác nhận GHI — sống trong BỘ NHỚ, không bao giờ vào ngữ cảnh mô hình.
//
// VÌ SAO TỒN TẠI
//   `tao_phieu_thu_chi_nhap` trả về một chuỗi, và chuỗi đó đi thẳng vào ngữ cảnh
//   mô hình. Nếu nonce nằm trong chuỗi trả về thì mô hình đọc được nó, nghĩa là
//   nó lại có thể tự "xác nhận" — đúng cái ranh giới mà nonce sinh ra để dựng.
//
//   Nên tool làm hai việc tách rời: chuỗi trả về CHỈ có bản xem trước cho mô
//   hình đọc, còn nonce đi qua module này cho giao diện lấy. Hai đường, hai
//   người đọc, và người đọc nonce không phải mô hình.
//
// VÌ SAO KHÔNG LƯU XUỐNG ĐĨA
//   Nonce sống 5 phút và chỉ có nghĩa trong đúng lượt chat đang mở. Ghi vào
//   localStorage/sessionStorage là kéo dài vòng đời của một thứ cố ý ngắn, và
//   thêm một chỗ nữa để nó rò ra. Tải lại trang thì mất — đúng, người dùng xem
//   lại bản xem trước là chuyện rẻ, còn một nonce sống sót qua reload thì không.

export interface XacNhanDangCho {
  /** Nonce thô do server phát. KHÔNG được đưa vào tin nhắn, log hay URL. */
  nonce: string;
  /** Payload CHUẨN HOÁ mà server đã chốt — gửi lại nguyên vẹn khi thực thi. */
  canonical: unknown;
  /** Bản xem trước để giao diện vẽ thẻ xác nhận. */
  preview: Record<string, unknown>;
  /** Mốc hết hạn phía server, dùng để giao diện tự ẩn thẻ. */
  hetHanLuc: number;
}

/**
 * Một khe duy nhất, không phải hàng đợi.
 *
 * Có chủ ý: hai đề xuất ghi cùng chờ một lúc thì người dùng không biết mình đang
 * bấm cho cái nào. Đề xuất mới đè đề xuất cũ, và cái cũ chết cùng nonce của nó.
 */
let dangCho: XacNhanDangCho | null = null;

/** TTL server là 5 phút; trừ hao 10 giây cho lệch đồng hồ và độ trễ mạng. */
const TRU_HAO_MS = 10_000;

export function datXacNhanDangCho(x: Omit<XacNhanDangCho, 'hetHanLuc'>, ttlMs = 5 * 60_000): void {
  // Trừ hao không được nuốt hết TTL. Trừ thẳng 10 giây vào một TTL 1 giây cho ra
  // mốc nằm trong QUÁ KHỨ, tức nonce chết ngay lúc vừa đặt — bộ trừ hao sinh ra
  // để chống lệch đồng hồ lại thành thứ làm hỏng chính nó.
  const song = Math.max(ttlMs - TRU_HAO_MS, Math.floor(ttlMs / 2));
  dangCho = { ...x, hetHanLuc: Date.now() + song };
}

/**
 * Đề xuất đang chờ, hoặc `null` nếu không có / đã quá hạn.
 *
 * Tự dọn khi quá hạn thay vì trả về rồi để nơi gọi tự kiểm: một nonce hết hạn
 * mà vẫn hiện nút bấm là mời người dùng bấm vào một lỗi.
 */
export function layXacNhanDangCho(now: number = Date.now()): XacNhanDangCho | null {
  if (dangCho && dangCho.hetHanLuc <= now) dangCho = null;
  return dangCho;
}

/**
 * Lấy nonce ra để dùng và XOÁ ngay trong cùng một bước.
 *
 * Gộp hai việc là có chủ ý: tách ra thì tồn tại một khoảng mà nonce đã được đọc
 * nhưng chưa bị xoá, và hai lần bấm nhanh sẽ lấy được cùng một nonce. Server có
 * CAS chặn lần thứ hai, nhưng để client bắn hai lần rồi trông chờ server dọn là
 * đẩy việc sang chỗ khác chứ không phải giải quyết.
 */
export function tieuXacNhan(now: number = Date.now()): XacNhanDangCho | null {
  const x = layXacNhanDangCho(now);
  dangCho = null;
  return x;
}

/** Dọn khe — dùng khi người dùng bấm huỷ hoặc rời cuộc trò chuyện. */
export function xoaXacNhanDangCho(): void {
  dangCho = null;
}
