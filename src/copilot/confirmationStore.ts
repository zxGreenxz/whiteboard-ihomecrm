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
  /**
   * `action_id` của hành động đang chờ — khoá tra `ACTION_CATALOG`.
   *
   * BẮT BUỘC, không mặc định. Từ G2-D có nhiều hơn một đường ghi, và thẻ xác
   * nhận phải biết nó đang cầm nonce của hành động NÀO để gọi đúng RPC thực
   * thi. Một giá trị mặc định ở đây sẽ nghĩa là: quên khai `tool` thì thẻ gọi
   * RPC của hành động khác với cùng cái nonce — server từ chối bằng
   * `confirmation_contract_mismatch`, nhưng triệu chứng người dùng thấy là
   * "bấm nút không có gì xảy ra".
   */
  tool: string;
  /** Nonce thô do server phát. KHÔNG được đưa vào tin nhắn, log hay URL. */
  nonce: string;
  /** Payload CHUẨN HOÁ mà server đã chốt — gửi lại nguyên vẹn khi thực thi. */
  canonical: unknown;
  /** Bản xem trước để giao diện vẽ thẻ xác nhận. */
  preview: Record<string, unknown>;
  /** Mốc hết hạn phía server, dùng để giao diện tự ẩn thẻ. */
  hetHanLuc: number;
  /** Stable intent identity used to prevent cross-action confirmation reuse. */
  intentKey: string;
  /** Organization selected when the proposal was created. */
  organizationId: string | null;
  /** Conversation thread selected when the proposal was created. */
  threadId: string | null;
  /** Chat generation selected when the proposal was created. */
  generation?: number;
}

export interface NguCanhXacNhan {
  organizationId: string | null;
  threadId: string | null;
  generation?: number;
}

/**
 * Mỗi intent có một khe riêng, không phải hàng đợi.
 *
 * Truy cập bằng intentKey tạo ranh giới nghiêm ngặt giữa các hành động; giao diện
 * cũ vẫn dùng accessors không đối số để lấy đề xuất mới nhất.
 */
const dangCho = new Map<string, XacNhanDangCho>();
let intentMoiNhat: string | null = null;
let nguCanhHienTai: NguCanhXacNhan | null = null;

function cungNguCanh(a: NguCanhXacNhan | null, b: NguCanhXacNhan | null): boolean {
  return a?.organizationId === b?.organizationId && a?.threadId === b?.threadId && a?.generation === b?.generation;
}

/** Bind the in-memory proposal slot to the active organization/thread generation. */
export function datNguCanhXacNhan(context: NguCanhXacNhan | null): void {
  if (!cungNguCanh(nguCanhHienTai, context)) {
    dangCho.clear();
    intentMoiNhat = null;
  }
  nguCanhHienTai = context;
}

export function layNguCanhXacNhan(): NguCanhXacNhan | null {
  return nguCanhHienTai;
}

/** TTL server là 5 phút; trừ hao 10 giây cho lệch đồng hồ và độ trễ mạng. */
const TRU_HAO_MS = 10_000;

export function datXacNhanDangCho(
  x: Omit<XacNhanDangCho, 'hetHanLuc' | 'intentKey' | 'organizationId' | 'threadId'> & {
    intentKey?: string;
    organizationId?: string | null;
    threadId?: string | null;
    generation?: number;
  },
  ttlMs = 5 * 60_000,
): void {
  // Trừ hao không được nuốt hết TTL. Trừ thẳng 10 giây vào một TTL 1 giây cho ra
  // mốc nằm trong QUÁ KHỨ, tức nonce chết ngay lúc vừa đặt — bộ trừ hao sinh ra
  // để chống lệch đồng hồ lại thành thứ làm hỏng chính nó.
  const song = Math.max(ttlMs - TRU_HAO_MS, Math.floor(ttlMs / 2));
  const intentKey = x.intentKey ?? 'default';
  const organizationId = x.organizationId ?? nguCanhHienTai?.organizationId ?? null;
  const threadId = x.threadId ?? nguCanhHienTai?.threadId ?? null;
  const generation = x.generation ?? nguCanhHienTai?.generation;
  // Keep the UI's legacy no-argument accessors pointed at the newest proposal.
  // Explicit intent keys still provide strict isolation for callers that need it.
  dangCho.delete(intentKey);
  dangCho.set(intentKey, { ...x, organizationId, threadId, ...(generation === undefined ? {} : { generation }), intentKey, hetHanLuc: Date.now() + song });
  intentMoiNhat = intentKey;
}

/**
 * Đề xuất đang chờ, hoặc `null` nếu không có / đã quá hạn.
 *
 * Tự dọn khi quá hạn thay vì trả về rồi để nơi gọi tự kiểm: một nonce hết hạn
 * mà vẫn hiện nút bấm là mời người dùng bấm vào một lỗi.
 */
export function layXacNhanDangCho(
  now: number = Date.now(),
  intentKey?: string,
  expectedContext?: Pick<NguCanhXacNhan, 'organizationId' | 'threadId' | 'generation'>,
): XacNhanDangCho | null {
  const key = intentKey ?? intentMoiNhat;
  if (!key) return null;
  const x = dangCho.get(key);
  if (x && x.hetHanLuc <= now) {
    dangCho.delete(key);
    if (intentMoiNhat === key) intentMoiNhat = null;
    return null;
  }
  const context = expectedContext ?? nguCanhHienTai;
  if (
    x &&
    context &&
    (x.organizationId !== context.organizationId ||
      x.threadId !== context.threadId ||
      (context.generation !== undefined && x.generation !== context.generation))
  ) return null;
  return x ?? null;
}

/**
 * Lấy nonce ra để dùng và XOÁ ngay trong cùng một bước.
 *
 * Gộp hai việc là có chủ ý: tách ra thì tồn tại một khoảng mà nonce đã được đọc
 * nhưng chưa bị xoá, và hai lần bấm nhanh sẽ lấy được cùng một nonce. Server có
 * CAS chặn lần thứ hai, nhưng để client bắn hai lần rồi trông chờ server dọn là
 * đẩy việc sang chỗ khác chứ không phải giải quyết.
 */
export function tieuXacNhan(
  now: number = Date.now(),
  intentKey?: string,
  expectedContext?: Pick<NguCanhXacNhan, 'organizationId' | 'threadId' | 'generation'>,
): XacNhanDangCho | null {
  const key = intentKey ?? intentMoiNhat;
  const x = layXacNhanDangCho(now, key ?? undefined, expectedContext);
  if (!x) return null;
  if (key) dangCho.delete(key);
  if (intentMoiNhat === key) intentMoiNhat = null;
  return x;
}

/** Dọn khe — dùng khi người dùng bấm huỷ hoặc rời cuộc trò chuyện. */
export function xoaXacNhanDangCho(): void {
  dangCho.clear();
  intentMoiNhat = null;
}
