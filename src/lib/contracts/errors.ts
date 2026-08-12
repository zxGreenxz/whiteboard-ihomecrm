/**
 * Phân loại lỗi ở biên RPC/Edge — plan §9.
 *
 * KHÁC GÌ src/lib/friendlyError.ts
 *   friendlyError trả lời "nói gì với NGƯỜI DÙNG". File này trả lời "MÁY phải làm
 *   gì tiếp": có được thử lại không, có phải đăng nhập lại không, có phải nạp lại
 *   trạng thái không, hay đây là chốt chặn nội bộ vỡ và phải kêu to.
 *
 *   Hai câu hỏi đó khác nhau, và gộp chúng là nguồn của cả hai lỗi tệ nhất ở biên
 *   này: thử lại thứ không được phép thử lại, và nuốt thứ phải kêu.
 *
 * BẢNG MÃ DƯỚI ĐÂY LÀ ĐO ĐƯỢC, KHÔNG PHẢI CHÉP TỪ TÀI LIỆU POSTGRES.
 *   Đếm trên 629 file migration ngày 07/08/2026 (`grep -o "ERRCODE = '…'"`):
 *     42501 × 798 · 22023 × 544 · 55000 × 503 · P0002 × 138 · P0001 × 91
 *     23505 × 52 · 23514 × 44 · 40001 × 24 · 54000 × 23 · 0A000 × 9
 *     42P01 × 7 · 42883 × 6 · 23503 × 5 · 23502 × 5 · 28000 × 2
 *   Nghĩa là `55000` — "object không ở trạng thái tiên quyết" — là mã bận thứ ba
 *   của hệ: phiếu đã duyệt rồi, sổ quỹ đã chốt rồi, hợp đồng đã thanh lý rồi.
 *   Nó KHÔNG phải lỗi kỹ thuật, và cũng KHÔNG được thử lại.
 */

/** Việc phải làm tiếp, không phải câu nói với người dùng. */
export type ErrorCategory =
  /** Thiếu quyền, hoặc phiên đăng nhập không còn hợp lệ. Không thử lại. */
  | "permission"
  /** Đầu vào sai. Không thử lại cho tới khi người dùng sửa. */
  | "validation"
  /**
   * Đụng độ ĐỒNG THỜI ở tầng lưu trữ — deadlock, serialization failure, không
   * lấy được khoá. ĐÂY LÀ NHÓM DUY NHẤT ĐƯỢC THỬ LẠI: cùng một lời gọi, lát sau,
   * sẽ thành công.
   */
  | "concurrency"
  /**
   * Trạng thái đã đổi: phiếu đã duyệt, sổ đã chốt, bản ghi đã tồn tại. Thử lại là
   * SAI — nó sẽ hỏng theo đúng cách cũ, hoặc tệ hơn là ghi trùng.
   */
  | "conflict"
  /** Không tìm thấy đối tượng. */
  | "not_found"
  /**
   * Bị chặn vì GỌI QUÁ NHIỀU (giới hạn tốc độ phía máy chủ).
   *
   * VÌ SAO KHÔNG NHÉT VÀO `concurrency`
   *   Nhìn qua thì giống: "lát sau gọi lại sẽ được". Nhưng `concurrency` là nhóm
   *   DUY NHẤT được thử lại TỰ ĐỘNG, mà tự động thử lại một lỗi giới hạn tốc độ
   *   là đổ thêm đúng thứ đã làm nó kích hoạt — limiter sẽ không bao giờ hạ
   *   xuống. Đây là nhóm "chậm lại", không phải nhóm "thử lại ngay".
   *
   *   Hệ này ném `PT429` (xem migration 20260808140000): PostgREST quy ước
   *   SQLSTATE dạng `PTxxx` trả về HTTP xxx, nên `PT429` ra đúng 429 Too Many
   *   Requests — thứ mà Cloudflare và mọi lớp trung gian hiểu là "lùi lại", khác
   *   hẳn 5xx vốn bị đọc là "origin đang hỏng".
   */
  | "rate_limit"
  /**
   * Chốt chặn NỘI BỘ vỡ (P0001 = RAISE EXCEPTION trần của chính hệ này), hoặc
   * schema đã đổi dưới chân client. Phải kêu to, không được nuốt.
   */
  | "internal_invariant"
  /** Chưa phân loại được — mặc định KHÔNG thử lại. */
  | "unknown";

/**
 * SQLSTATE → nhóm. Chỉ ghi mã hệ này THẬT SỰ gặp, cộng ba mã đồng thời mà
 * PostgreSQL sinh ra chứ không do ta ném.
 */
const MA_SQLSTATE: Readonly<Record<string, ErrorCategory>> = {
  // Quyền
  "42501": "permission", // insufficient_privilege — RLS/GRANT từ chối
  "28000": "permission", // invalid_authorization_specification

  // Đầu vào
  "22023": "validation", // invalid_parameter_value — mã kiểm đầu vào bận nhất
  "23514": "validation", // check_violation
  "23502": "validation", // not_null_violation
  "22P02": "validation", // invalid_text_representation
  "22001": "validation", // string_data_right_truncation
  "22003": "validation", // numeric_value_out_of_range

  // ĐỒNG THỜI — nhóm DUY NHẤT được thử lại
  "40001": "concurrency", // serialization_failure
  "40P01": "concurrency", // deadlock_detected
  "55P03": "concurrency", // lock_not_available

  // Trạng thái đã đổi
  "55000": "conflict", // object_not_in_prerequisite_state — phiếu đã duyệt / sổ đã chốt
  "23505": "conflict", // unique_violation
  "23503": "conflict", // foreign_key_violation — bản ghi tham chiếu đã biến mất
  "23P01": "conflict", // exclusion_violation — khoảng thời gian chồng lấn (kỳ hợp đồng, kỳ khoá sổ)

  // Không tìm thấy
  P0002: "not_found", // no_data_found
  PGRST116: "not_found", // PostgREST: .single() trả 0 dòng

  // Chốt chặn nội bộ / schema trôi
  P0001: "internal_invariant", // RAISE EXCEPTION trần — chốt chặn của CHÍNH hệ này
  // too_many_rows: `SELECT INTO STRICT` nhận nhiều hơn một dòng. Đây LUÔN là lỗi
  // giả định của ta về tính duy nhất, không phải lỗi người dùng.
  P0003: "internal_invariant",
  "42703": "internal_invariant", // undefined_column — client cũ hơn schema
  "42P01": "internal_invariant", // undefined_table
  "42883": "internal_invariant", // undefined_function — RPC gõ sai hoặc chưa deploy
  "0A000": "internal_invariant", // feature_not_supported
  "54000": "internal_invariant", // program_limit_exceeded
  "42723": "internal_invariant", // duplicate_function — migration dựng chồng
  "42601": "internal_invariant", // syntax_error — SQL động ghép sai
};

/** Mã của PostgREST (không phải SQLSTATE) — nằm cùng trường `code`. */
const MA_POSTGREST: Readonly<Record<string, ErrorCategory>> = {
  PGRST301: "permission", // JWT hết hạn / không hợp lệ
  PGRST202: "internal_invariant", // không tìm thấy hàm — slug RPC sai
  PGRST204: "internal_invariant", // không tìm thấy cột
  // Hệ này tự ném, không phải PostgREST sinh ra: quy ước `PTxxx` → HTTP xxx.
  // Nguồn: 20260808140000_gdr_tra_ve_429_thay_vi_500.sql (chặn dò mã theo IP).
  PT429: "rate_limit",
};

export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** Lấy `code` ra khỏi mọi hình dạng lỗi mà hai client hay ném. */
export function extractCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;
  if (typeof e.code === "string" && e.code.length > 0) return e.code;
  // supabase-js đôi khi bọc lỗi PostgREST một lớp.
  const inner = e.error;
  if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).code === "string") {
    return (inner as Record<string, string>).code;
  }
  return null;
}

/**
 * Phân loại một lỗi từ RPC/Edge.
 *
 * Mặc định là `unknown` chứ KHÔNG phải một nhóm "an toàn" nào đó. Chọn mặc định
 * lạc quan ở đây nghĩa là mọi mã chưa từng gặp sẽ được xử theo cách rẻ nhất, và
 * mã chưa từng gặp thường xuất hiện đúng lúc có sự cố.
 */
export function classifyDbError(error: unknown): ErrorCategory {
  const code = extractCode(error);
  if (!code) return "unknown";
  return MA_SQLSTATE[code] ?? MA_POSTGREST[code] ?? "unknown";
}

/**
 * Lời gọi này có được thử lại NGUYÊN VĂN không?
 *
 * CHỈ nhóm `concurrency`. Mọi nhóm khác trả false, kể cả `unknown`.
 *
 * Vì sao nghiêm ngặt đến vậy trên code tiền: thử lại một lời gọi ghi mà lần đầu
 * ĐÃ ghi thành công (rồi hỏng ở đường về) sẽ ghi hai lần. Ba mã đồng thời ở trên
 * là ba trường hợp PostgreSQL bảo đảm giao dịch KHÔNG có tác dụng phụ nào —
 * ngoài chúng ra, ta không biết.
 */
export function isRetryable(category: ErrorCategory): boolean {
  return category === "concurrency";
}

/**
 * Lỗi này có phải chuyện của NGƯỜI DÙNG không (họ sửa được), hay của HỆ THỐNG?
 * Dùng để quyết định hiện toast êm hay bắn cảnh báo.
 */
export function isUserActionable(category: ErrorCategory): boolean {
  return (
    category === "validation" ||
    category === "conflict" ||
    category === "not_found" ||
    // Người dùng xử được: chờ một lát rồi thử lại. Bắn cảnh báo cho người trực vì
    // một người gõ sai mã nhiều lần là đúng thứ báo động giả làm người ta tắt
    // bảng theo dõi — chính lý do migration 20260808140000 đổi 5xx thành 429.
    category === "rate_limit"
  );
}
