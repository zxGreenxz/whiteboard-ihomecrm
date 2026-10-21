/**
 * Lỗi của trang Cửa vân tay: một lớp chung cho RPC lẫn hàm Edge, để giao diện phân biệt
 * QUYỀN · DỮ LIỆU SAI · MẠNG/CHƯA RÕ KẾT QUẢ thay vì gộp thành "có lỗi".
 *
 * `outcomeUnknown` = lệnh có thể ĐÃ chạy (mạng đứt/hết giờ sau khi gửi). Giao diện không được tự
 * gửi lại; người dùng xem Lịch sử ra vào / Nhật ký thao tác trước.
 */

export type DoorAccessErrorKind =
  | "session"
  | "not_connected"
  | "mode_off"
  | "read_only"
  | "permission"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "state"
  | "tuya_rejected"
  | "unavailable"
  | "not_deployed"
  | "invalid_result"
  | "internal";

export class DoorAccessError extends Error {
  readonly kind: DoorAccessErrorKind;
  readonly code: string | null;
  readonly tuyaCode: string | null;
  readonly outcomeUnknown: boolean;

  constructor(
    kind: DoorAccessErrorKind,
    message: string,
    options: { code?: string | null; tuyaCode?: string | null; outcomeUnknown?: boolean } = {},
  ) {
    super(message);
    this.name = "DoorAccessError";
    this.kind = kind;
    this.code = options.code ?? null;
    this.tuyaCode = options.tuyaCode ?? null;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }

  /** Thử lại (bấm tay) có thể khác kết quả: mạng, máy chủ, dữ liệu trả về lạ. */
  get retryable(): boolean {
    return this.kind === "unavailable" || this.kind === "internal" || this.kind === "invalid_result";
  }
}

export function isDoorAccessError(error: unknown): error is DoorAccessError {
  return error instanceof DoorAccessError;
}

/** Câu hiển thị cho mọi lỗi; lỗi lạ không lộ chữ kỹ thuật. */
export function doorErrorMessage(error: unknown, fallback = "Chưa thực hiện được. Thử lại sau."): string {
  return isDoorAccessError(error) ? error.message : fallback;
}

const NETWORK_TEXT = /Failed to fetch|\bLoad failed|NetworkError|network error|fetch failed|ERR_INTERNET|ERR_NETWORK|timed? ?out|AbortError/i;
const MAX_SERVER_TEXT = 300;

/** Câu máy chủ gửi kèm (đã là tiếng Việt cho người dùng) — cắt ngắn, bỏ khoảng trắng thừa. */
function serverText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT - 1)}…` : text;
}

const unknownOutcome = (operation: string) =>
  `Chưa rõ đã ${operation} chưa — mạng hoặc máy chủ không phản hồi kịp. Xem Nhật ký thao tác trước khi thử lại.`;

// ---------------------------------------------------------------------------------------------
// RPC

export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

/**
 * Lỗi RPC ⇒ DoorAccessError. `operation` là cụm động từ ("tải danh sách máy", "gắn vân tay").
 *
 * Có SQLSTATE ⇒ máy chủ đã trả lời và giao dịch đã quay lui ⇒ kết quả RÕ. Không có mã mà chữ
 * giống lỗi mạng (supabase.rpc không ném — nó trả `{error}` cả khi mất mạng) ⇒ thao tác ghi
 * thành "chưa rõ kết quả".
 */
export function rpcFailure(error: RpcErrorLike, context: { operation: string; mutation: boolean }): DoorAccessError {
  const code = typeof error.code === "string" && error.code ? error.code : null;
  const message = serverText(error.message);
  const { operation, mutation } = context;
  switch (code) {
    case "42501":
      return new DoorAccessError("permission", `Bạn chưa có quyền ${operation} ở tòa này.`, { code });
    case "22023":
      return new DoorAccessError("validation", message ?? "Dữ liệu chưa hợp lệ.", { code });
    case "23505":
      return new DoorAccessError("conflict", message ?? "Dữ liệu bị trùng.", { code });
    case "54000":
      return new DoorAccessError("rate_limited", message ?? "Thao tác quá nhiều lần — đợi một lát rồi thử lại.", { code });
    case "55000":
      return new DoorAccessError("state", message ?? "Trạng thái đã thay đổi — tải lại rồi thử lại.", { code });
    case "PGRST202":
    case "42883":
      return new DoorAccessError("not_deployed", "Máy chủ chưa có chức năng Cửa vân tay (chưa cập nhật cơ sở dữ liệu).", { code });
    case "PGRST301":
    case "PGRST302":
    case "PGRST303":
    case "28000":
      return new DoorAccessError("session", "Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.", { code });
    default:
      break;
  }
  if (code === null && (message === null || NETWORK_TEXT.test(message))) {
    return mutation
      ? new DoorAccessError("unavailable", unknownOutcome(operation), { outcomeUnknown: true })
      : new DoorAccessError("unavailable", `Mất kết nối — chưa ${operation} được. Thử lại sau giây lát.`);
  }
  if (code === null && mutation) {
    // Không có SQLSTATE: lỗi ở cổng/proxy (502/504…) — giao dịch có thể đã ghi.
    return new DoorAccessError("unavailable", unknownOutcome(operation), { outcomeUnknown: true });
  }
  return new DoorAccessError("internal", `Chưa ${operation} được. Thử lại sau.`, { code });
}

// ---------------------------------------------------------------------------------------------
// Edge `door-access`

export type EdgeTransport = "network" | "relay" | "http" | "ok";

export interface EdgeFailureInput {
  transport: EdgeTransport;
  /** HTTP status nếu có (non-2xx). */
  status: number | null;
  /** Thân phản hồi đã đọc JSON (hoặc null nếu không đọc được). */
  body: unknown;
  operation: string;
  mutation: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ok:false, error:{code, message, tuyaCode?, outcomeUnknown?}}` ⇒ phần `error`, không đúng dạng ⇒ null. */
export function edgeErrorEnvelope(body: unknown): { code: string; message: string | null; tuyaCode: string | null; outcomeUnknown: boolean | null } | null {
  if (!isRecord(body) || body.ok !== false || !isRecord(body.error)) return null;
  const { code, message, tuyaCode, outcomeUnknown } = body.error;
  if (typeof code !== "string" || !code) return null;
  return {
    code,
    message: serverText(message),
    tuyaCode: typeof tuyaCode === "string" || typeof tuyaCode === "number" ? String(tuyaCode) : null,
    outcomeUnknown: typeof outcomeUnknown === "boolean" ? outcomeUnknown : null,
  };
}

/** Lỗi của hàm Edge ⇒ DoorAccessError, theo bảng mã trong docs/he-thong/26-cua-van-tay.md. */
export function edgeFailure(input: EdgeFailureInput): DoorAccessError {
  const { operation, mutation } = input;
  const envelope = edgeErrorEnvelope(input.body);
  if (envelope) {
    const { code, message, tuyaCode } = envelope;
    // Máy chủ nói rõ thì theo máy chủ; lỗi nội bộ của thao tác ghi mà máy chủ không nói ⇒ coi như chưa rõ.
    const isUnknown = envelope.outcomeUnknown ?? (mutation && (code === "internal" || code === "tuya_unavailable"));
    const options = { code, tuyaCode, outcomeUnknown: isUnknown };
    switch (code) {
      case "unauthorized":
        return new DoorAccessError("session", "Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.", options);
      case "organization_required":
        return new DoorAccessError("validation", "Chưa chọn công ty. Chọn công ty rồi thử lại.", options);
      case "invalid_request":
        return new DoorAccessError("validation", message ?? "Yêu cầu chưa hợp lệ.", options);
      case "not_configured":
      case "org_not_connected":
        return new DoorAccessError("not_connected", "Chưa kết nối SmartLife.", options);
      case "mode_off":
        return new DoorAccessError("mode_off", "Cửa vân tay đang tắt.", options);
      case "writes_disabled":
        return new DoorAccessError("read_only", "Đang ở chế độ chỉ đọc — chưa thao tác được trên máy.", options);
      case "not_permitted":
        return new DoorAccessError("permission", `Bạn chưa có quyền ${operation} ở máy này.`, options);
      case "device_not_found":
        return new DoorAccessError("not_found", "Không tìm thấy máy này trong CRM (có thể vừa bị tắt). Tải lại danh sách máy.", options);
      case "conflict":
        return new DoorAccessError("conflict", message ?? "Thao tác bị trùng — tải lại rồi thử lại.", options);
      case "rate_limited":
        return new DoorAccessError("rate_limited", message ?? "Thao tác quá nhiều lần — đợi một lát rồi thử lại.", options);
      case "tuya_rejected":
        return new DoorAccessError(
          "tuya_rejected",
          `SmartLife từ chối (mã ${tuyaCode ?? "?"})${message ? `: ${message}` : ""}.`,
          options,
        );
      case "tuya_unavailable":
        return new DoorAccessError(
          "unavailable",
          isUnknown ? unknownOutcome(operation) : "Không kết nối được SmartLife. Thử lại sau giây lát.",
          options,
        );
      default:
        return new DoorAccessError(
          "internal",
          isUnknown ? unknownOutcome(operation) : `Máy chủ gặp lỗi khi ${operation}. Thử lại sau.`,
          options,
        );
    }
  }

  // Không có phong bì của door-access: lỗi mạng, cổng Supabase, hoặc hàm chưa triển khai.
  if (input.transport === "network" || input.transport === "relay") {
    return mutation
      ? new DoorAccessError("unavailable", unknownOutcome(operation), { outcomeUnknown: true })
      : new DoorAccessError("unavailable", `Mất kết nối — chưa ${operation} được. Thử lại sau giây lát.`);
  }
  const status = input.status;
  if (status === 401) {
    return new DoorAccessError("session", "Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.", { code: "http_401" });
  }
  if (status === 404) {
    return new DoorAccessError("not_deployed", "Máy chủ chưa có chức năng Cửa vân tay (hàm door-access chưa triển khai).", { code: "http_404" });
  }
  if (input.transport === "http" && status !== null && status >= 400 && status < 500) {
    // Cổng từ chối trước khi hàm chạy — chắc chắn chưa làm gì.
    return new DoorAccessError("internal", `Máy chủ từ chối yêu cầu ${operation} (HTTP ${status}). Thử lại sau.`, { code: `http_${status}` });
  }
  if (mutation) {
    return new DoorAccessError(input.transport === "ok" ? "invalid_result" : "unavailable", unknownOutcome(operation), {
      code: status === null ? null : `http_${status}`,
      outcomeUnknown: true,
    });
  }
  return input.transport === "ok"
    ? new DoorAccessError("invalid_result", `Máy chủ trả dữ liệu chưa hợp lệ khi ${operation}. Thử lại sau.`)
    : new DoorAccessError("unavailable", `Máy chủ chưa phản hồi khi ${operation}. Thử lại sau giây lát.`, {
        code: status === null ? null : `http_${status}`,
      });
}
