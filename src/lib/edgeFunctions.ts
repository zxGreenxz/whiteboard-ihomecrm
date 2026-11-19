/**
 * Hợp đồng có kiểu cho Edge Function.
 *
 * VÌ SAO EDGE CẦN WRAPPER MÀ RPC THÌ KHÔNG
 *   Đây là điểm khác biệt đáng nhớ, vì lát trước đã đi nhầm đúng chỗ này. Lời gọi
 *   `supabase.rpc("ten_that", { … })` ĐÃ được trình biên dịch canh: tên hàm sai
 *   thì TS2345, tên tham số sai thì TS2353 — kiểu sinh tự động từ DB lo phần đó.
 *   `supabase.functions.invoke("ten", { body })` thì KHÔNG: `body` là `unknown`,
 *   phản hồi là `unknown`, và không có kiểu nào sinh ra từ mã Edge. Đổi hợp đồng
 *   bên Deno thì frontend im lặng cho tới lúc chạy thật.
 *
 *   Nên với Edge, wrapper không phải "cho có kiểu" — nó là NGUỒN KIỂU DUY NHẤT.
 *
 * VÌ SAO NHẬN `invoke` QUA THAM SỐ
 *   Cùng án lệ `paymentRecordRpc.ts`: test bơm được bản giả mà không dựng client.
 *
 * CHỐNG TRÔI
 *   Kiểu ở đây viết tay nên nó trôi được khỏi mã Edge thật.
 *   `src/lib/__tests__/edgeFunctions.test.ts` đọc THẲNG
 *   `supabase/functions/<tên>/index.ts` rồi đối chiếu từng trường — trôi một cái
 *   là đỏ ngay, kèm tên trường.
 *   (Viết `<tên>` chứ không phải dấu sao: chuỗi sao-gạch-chéo giữa block comment
 *   sẽ ĐÓNG comment sớm và làm hỏng cả file. Đã dính đúng lỗi đó ở bản đầu.)
 */

/** Tên Edge Function. Đây là nơi DUY NHẤT viết chúng ra chuỗi ở phía frontend. */
export const EDGE_FN = {
  adminCreateUser: "admin-create-user",
  // Superadmin / chủ công ty đặt lại mật khẩu cho người khác — kiểu ở `datLaiMatKhauNguoiDung` bên dưới.
  adminResetUserPassword: "admin-reset-user-password",
  sendPush: "send-push",
  // Cửa vân tay (SmartLife/Tuya) — hợp đồng ở docs/he-thong/26-cua-van-tay.md, kiểu ở src/lib/door-access/.
  doorAccess: "door-access",
} as const;

export type EdgeFnName = (typeof EDGE_FN)[keyof typeof EDGE_FN];

export interface EdgeInvokeError {
  message?: string | null;
  /**
   * Tên lớp lỗi của supabase-js: `FunctionsHttpError` (máy chủ trả non-2xx, `context` là
   * Response), `FunctionsRelayError`, `FunctionsFetchError` (mạng). Wrapper nào cần phân biệt
   * "máy chủ đã trả lời" với "không biết yêu cầu đã tới chưa" thì đọc trường này.
   */
  name?: string | null;
  context?: unknown;
}

/**
 * Chữ ký của `supabase.functions.invoke`, thu hẹp về đúng phần đang dùng.
 *
 * `body` phải là `Record<string, unknown>` chứ KHÔNG phải `unknown`: bản đầu dùng
 * `unknown` và chỗ gọi đỏ ngay dưới `strict` vì `{ body: unknown }` không gán
 * được vào `FunctionInvokeOptions` của supabase-js. Đảo strict bắt được ngay.
 */
export type EdgeInvoker = (
  fn: EdgeFnName,
  options: { body: Record<string, unknown> },
) => PromiseLike<{ data: unknown; error: EdgeInvokeError | null }>;

/**
 * Thân yêu cầu của `admin-create-user`.
 *
 * Chép theo `interface CreateUserRequest` trong
 * `supabase/functions/admin-create-user/index.ts`. Sáu trường sau `phone` là
 * metadata để `handle_new_user()` dựng `profiles` đầy đủ — frontend hiện KHÔNG
 * gửi chúng, nên hồ sơ tạo qua đường này có `username`/`employee_code`/… bằng
 * null. Khai ở đây để chỗ nào cần thì gửi được mà không phải đọc lại mã Deno.
 */
export interface AdminCreateUserRequest {
  email: string;
  password: string;
  full_name?: string;
  phone?: string;
  username?: string;
  contact_email?: string;
  employee_code?: string;
  department?: string;
  job_title?: string;
  is_active?: boolean;
}

/** Phản hồi thành công. Edge trả `{ success: true, user: { id, email } }`. */
export interface AdminCreateUserResult {
  id: string;
  email: string | null;
}

/**
 * Gọi `admin-create-user` và trả về người dùng vừa tạo.
 *
 * Ba đường hỏng, xử cả ba tại đây thay vì để mỗi caller tự nhớ:
 *   1. `error` của supabase-js (mạng, non-2xx)
 *   2. thân phản hồi mang `{ error: "..." }` — Edge trả 400/403 KÈM thân JSON,
 *      và trước đây hai caller đều đọc nó bằng `(data as any)?.error`
 *   3. phản hồi 200 mà thiếu `user.id` — hợp đồng vỡ, và caller cũ ở
 *      `useShareholders` đã phải tự kiểm điều này còn `useAdminUsers` thì không
 */
export async function taoTaiKhoanQuanTri(
  invoke: EdgeInvoker,
  body: AdminCreateUserRequest,
  thongDiepLoiMacDinh = "Tạo tài khoản thất bại",
): Promise<AdminCreateUserResult> {
  // Trải ra object literal chứ không truyền thẳng `body`: interface KHÔNG có chữ
  // ký chỉ mục ngầm nên nó không gán được vào `Record<string, unknown>`, còn
  // object literal thì có. Đây là chỗ duy nhất trong file phải biết chuyện đó.
  const { data, error } = await invoke(EDGE_FN.adminCreateUser, { body: { ...body } });
  if (error) throw new Error(error.message || thongDiepLoiMacDinh);

  const than = (data ?? {}) as { error?: unknown; user?: { id?: unknown; email?: unknown } };
  if (typeof than.error === "string" && than.error.length > 0) throw new Error(than.error);

  const id = than.user?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Không nhận được ID tài khoản mới");
  }
  return { id, email: typeof than.user?.email === "string" ? than.user.email : null };
}

/** Thân yêu cầu của `send-push`. */
export interface SendPushRequest {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/* ───────────────────────── admin-reset-user-password ───────────────────────── */

/**
 * Thân yêu cầu của `admin-reset-user-password`.
 *
 * Luật mật khẩu nằm ở `adminPasswordProblem` (src/lib/accountFeedback.ts); test chống trôi đọc
 * hai hằng `MIN_PASSWORD_CHARS` / `MAX_PASSWORD_BYTES` bên Deno rồi so với bản frontend.
 */
export interface AdminResetUserPasswordRequest {
  userId: string;
  password: string;
}

/** Tư cách mà máy chủ đã dùng để cho phép: superadmin hay chủ công ty. */
export type AdminResetUserPasswordVia = "SUPER_ADMIN" | "COMPANY_OWNER";

/** Phản hồi thành công. Edge trả `{ ok: true, via }`. */
export interface AdminResetUserPasswordResult {
  via: AdminResetUserPasswordVia;
}

/**
 * Mã lỗi theo hợp đồng của hàm (trường `error` của thân lỗi), cộng `not_deployed` cho 404 của
 * cổng Supabase khi hàm chưa triển khai (thân của cổng không mang mã nào trong hợp đồng).
 */
export type ResetUserPasswordErrorKind =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "weak_password"
  | "rate_limited"
  | "service_unavailable"
  | "not_deployed"
  | "outcome_unknown";

/** Câu duy nhất cho mọi trường hợp CHƯA BIẾT mật khẩu đã đổi hay chưa. */
export const RESET_PASSWORD_UNKNOWN_MESSAGE =
  "Chưa xác nhận được mật khẩu đã đổi hay chưa. Thử đăng nhập bằng mật khẩu mới, hoặc đặt lại lần nữa.";

type MaChacChanChuaDoi = Exclude<ResetUserPasswordErrorKind, "not_deployed" | "outcome_unknown">;

/** Mã mà máy chủ gửi khi chắc chắn CHƯA đổi gì. */
const MA_CHAC_CHAN_CHUA_DOI: readonly MaChacChanChuaDoi[] = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "weak_password",
  "rate_limited",
  "service_unavailable",
];

const laMaChacChanChuaDoi = (ma: string): ma is MaChacChanChuaDoi =>
  (MA_CHAC_CHAN_CHUA_DOI as readonly string[]).includes(ma);

/** Câu mặc định khi máy chủ không gửi kèm `message` (hoặc thân không phải của chính hàm). */
const CAU_LOI_DAT_LAI: Record<Exclude<ResetUserPasswordErrorKind, "outcome_unknown">, string> = {
  invalid_request: "Yêu cầu chưa hợp lệ. Mật khẩu chưa được đổi.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Đăng nhập lại rồi thử lại.",
  forbidden: "Bạn không có quyền đặt lại mật khẩu cho người này.",
  weak_password: "Mật khẩu quá yếu. Chọn mật khẩu khác hoặc bấm Tạo ngẫu nhiên.",
  rate_limited: "Đặt lại quá nhiều lần. Đợi một lát rồi thử lại.",
  service_unavailable: "Máy chủ tạm thời chưa xử lý được. Mật khẩu chưa được đổi, thử lại sau giây lát.",
  not_deployed: "Máy chủ chưa có chức năng đặt lại mật khẩu. Mật khẩu chưa được đổi.",
};

/**
 * Lỗi của luồng đặt lại mật khẩu.
 *
 * `outcomeUnknown` = CHƯA BIẾT mật khẩu đã đổi hay chưa (502/5xx khác 503, mạng hay relay đứt,
 * 200 mà thân sai dạng). `false` = chắc chắn chưa đổi (400/401/403/422/429/503).
 *
 * Status HTTP đặt tên `httpStatus` chứ KHÔNG phải `status`: bộ đoán lỗi chung
 * (`hasUnconfirmedResponse` trong src/lib/operationOutcome.ts) đọc mọi `status` 5xx là "chưa rõ",
 * mà 503 ở đây là chắc chắn chưa đổi theo hợp đồng.
 */
export class ResetUserPasswordError extends Error {
  readonly kind: ResetUserPasswordErrorKind;
  readonly httpStatus: number | null;
  readonly outcomeUnknown: boolean;

  constructor(kind: ResetUserPasswordErrorKind, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ResetUserPasswordError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.outcomeUnknown = kind === "outcome_unknown";
  }
}

const loiChuaRoKetQua = (httpStatus: number | null = null) =>
  new ResetUserPasswordError("outcome_unknown", RESET_PASSWORD_UNKNOWN_MESSAGE, httpStatus);

/** Mọi lỗi của luồng đặt lại ⇒ ResetUserPasswordError; lỗi lạ coi như chưa rõ kết quả. */
export function chuanHoaLoiDatLaiMatKhau(error: unknown): ResetUserPasswordError {
  return error instanceof ResetUserPasswordError ? error : loiChuaRoKetQua();
}

const laBanGhi = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_CAU_MAY_CHU = 300;

/** Câu máy chủ gửi kèm (đã là tiếng Việt cho người dùng): bỏ khoảng trắng thừa, cắt ngắn. */
function cauMayChu(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_CAU_MAY_CHU ? `${text.slice(0, MAX_CAU_MAY_CHU - 1)}…` : text;
}

/** Đọc status + JSON từ `error.context` (Response) của FunctionsHttpError — cùng cách door-access. */
async function docPhanHoiLoi(context: unknown): Promise<{ status: number | null; body: unknown }> {
  if (!laBanGhi(context)) return { status: null, body: null };
  const status = typeof context.status === "number" ? context.status : null;
  const json = context.json;
  if (typeof json !== "function") return { status, body: null };
  try {
    return { status, body: await (json as () => Promise<unknown>).call(context) };
  } catch {
    return { status, body: null };
  }
}

function loaiTheoStatus(status: number): Exclude<ResetUserPasswordErrorKind, "outcome_unknown"> {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_deployed";
    case 422:
      return "weak_password";
    case 429:
      return "rate_limited";
    case 503:
      return "service_unavailable";
    default:
      // 400 và mọi 4xx khác: máy chủ từ chối yêu cầu trước khi đổi gì.
      return "invalid_request";
  }
}

function loiTheoPhanHoi(status: number | null, body: unknown): ResetUserPasswordError {
  // Phong bì của chính hàm là `{ error: "<mã>", message }`. Thân của cổng Supabase (404
  // `{ code, message: "Requested function was not found" }`, 401 `{ msg: "Invalid JWT" }`, trang
  // HTML…) không có `error` ⇒ không hiện chữ kỹ thuật tiếng Anh của nó.
  const ma = laBanGhi(body) && typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;
  const cauCuaHam = ma !== null && laBanGhi(body) ? cauMayChu(body.message) : null;
  // 4xx: bị từ chối trước khi đổi. 503 chỉ "chắc chắn chưa đổi" khi đúng phong bì của hàm
  // (`service_unavailable` — hàm hỏng TRƯỚC bước đổi); 503 của proxy/cổng có thể tới SAU khi hàm đã
  // đổi xong. Mọi status khác (502, 500, 504, 546…) hay thiếu status: chưa rõ.
  const hamBao503 = status === 503 && ma === "service_unavailable";
  if (status === null || !((status >= 400 && status < 500) || hamBao503) || ma === "outcome_unknown") {
    return loiChuaRoKetQua(status);
  }
  // Mã ngoài danh sách (405 method_not_allowed, 413, 415…) thì loại theo status, câu vẫn của máy chủ.
  const kind = ma !== null && laMaChacChanChuaDoi(ma) ? ma : loaiTheoStatus(status);
  return new ResetUserPasswordError(kind, cauCuaHam ?? CAU_LOI_DAT_LAI[kind], status);
}

/**
 * Gọi `admin-reset-user-password` và trả về tư cách máy chủ đã dùng.
 *
 * Không bao giờ trả về khi chưa chắc đã đổi: mọi đường hỏng ném `ResetUserPasswordError`, với
 * `outcomeUnknown` nói rõ người dùng có cần kiểm lại hay không. Không tự gửi lại.
 */
export async function datLaiMatKhauNguoiDung(
  invoke: EdgeInvoker,
  body: AdminResetUserPasswordRequest,
): Promise<AdminResetUserPasswordResult> {
  let phanHoi: { data: unknown; error: EdgeInvokeError | null };
  try {
    phanHoi = await invoke(EDGE_FN.adminResetUserPassword, {
      body: { userId: body.userId, password: body.password },
    });
  } catch {
    // supabase-js gói mọi lỗi vào `error` chứ không ném. Bản bơm vào mà ném thì không biết yêu
    // cầu đã đi hay chưa.
    throw loiChuaRoKetQua();
  }

  if (phanHoi.error) {
    // FunctionsFetchError (mạng), FunctionsRelayError (relay), lỗi đọc thân của phản hồi 2xx
    // (SyntaxError…) hay lỗi lạ: yêu cầu có thể đã tới Auth.
    if (phanHoi.error.name !== "FunctionsHttpError") throw loiChuaRoKetQua();
    const { status, body: than } = await docPhanHoiLoi(phanHoi.error.context);
    throw loiTheoPhanHoi(status, than);
  }

  const via = laBanGhi(phanHoi.data) && phanHoi.data.ok === true ? phanHoi.data.via : undefined;
  if (via === "SUPER_ADMIN" || via === "COMPANY_OWNER") return { via };
  // 200 mà thân sai dạng: hàm đã chạy nhưng không xác nhận được gì.
  throw loiChuaRoKetQua(200);
}
