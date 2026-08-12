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
  sendPush: "send-push",
} as const;

export type EdgeFnName = (typeof EDGE_FN)[keyof typeof EDGE_FN];

export interface EdgeInvokeError {
  message?: string | null;
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
