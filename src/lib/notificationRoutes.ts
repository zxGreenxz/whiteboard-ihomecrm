// Allow-list URL điều hướng của THÔNG BÁO (`notifications.metadata.url`).
//
// Vì sao cần: `metadata` là JSONB do trigger/RPC/cron ghi — FE không được
// `navigate()` thẳng vào giá trị đó. Một chuỗi lạ (URL tuyệt đối, `//evil.tld`,
// `javascript:…`) lọt vào `navigate()`/`<a href>` là mở đường đưa người dùng ra
// ngoài app. File này là CỔNG DUY NHẤT: chuỗi nào không nằm trong bảng dưới thì
// trả `null` và UI phải bỏ qua (không điều hướng).
//
// Nguồn sự thật của bảng: `src/App.tsx` (route + `RequirePermission module=…`).
// Sửa route ở App.tsx mà quên file này ⇒ thông báo bấm vào ra NotFound.
//
// KHÔNG có trong allow-list (cố ý):
//   - `/issues/:id`  — route KHÔNG TỒN TẠI, 2 file UI cũ đang trỏ vào (→ NotFound).
//   - `/approvals`   — `list_my_pending_approvals_v1` lọc `state='PENDING_APPROVAL'`,
//                      rỗng ở mốc đo ⇒ bấm vào là trang trắng.
//
// Ánh xạ với §B.7 (metadata.event → url):
//   E1  → /income-expense?approval_status=UNAPPROVED&layer=PENDING
//   E2* → /income-expense/voucher/{ie_id}
//   E3  → /income-expense/voucher/{id} hoặc /income-expense
//   E4  → /tasks?job={job_id}
//   E5  → /thu-tien?handover={handover_id}

import { canUse, type PermsLike } from "@/lib/permissionPages";

/** Đích dự phòng khi biết route nhưng người dùng KHÔNG có quyền vào. */
export const NOTIFICATION_FALLBACK_URL = "/my-day";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v: string) => UUID_RE.test(v);

/**
 * Union `IncomeExpenseFilters.approval_status` (hooks/income-expenses/types.ts).
 * Export để trang Thu chi (desktop + mobile) dùng CHUNG một danh sách hợp lệ —
 * allow-list nhận param mà trang lại không hiểu là deep-link chết câm.
 */
export const IE_APPROVAL_STATUS_PARAM_VALUES: ReadonlySet<string> = new Set([
  "UNAPPROVED",
  "APPROVED",
  "CANCELLED",
  "ALL_ACTIVE",
  "APPROVED_UNPOSTED",
  "POSTED",
  "REVERSED",
]);

/** Union `IncomeExpenseFilters.layer`. */
export const IE_LAYER_PARAM_VALUES: ReadonlySet<string> = new Set([
  "CASH",
  "INTERNAL",
  "PENDING",
]);

export interface NotificationRoute {
  /**
   * Phần path CỐ ĐỊNH. Với `idSegment` = true thì URL hợp lệ là
   * `${path}/<uuid>` (đúng MỘT đoạn UUID, không sâu hơn).
   */
  readonly path: string;
  /** true = còn đúng một đoạn UUID phía sau `path`. */
  readonly idSegment?: boolean;
  /**
   * Module dùng cho `RequirePermission` trong App.tsx (action luôn là `view`).
   * `null` = route KHÔNG bọc `RequirePermission` ⇒ ai đăng nhập cũng vào được.
   */
  readonly module: string | null;
  /**
   * Query param được GIỮ LẠI + validator giá trị. Param ngoài danh sách bị bỏ;
   * param có giá trị không hợp lệ cũng bị bỏ (vẫn tới được trang, chỉ mất lọc).
   * Thứ tự khai báo = thứ tự query string sau khi chuẩn hoá.
   */
  readonly params?: readonly (readonly [string, (v: string) => boolean])[];
}

/**
 * Bảng allow-list. Khớp theo path CHÍNH XÁC (sau khi bỏ query/hash và cắt đúng
 * một dấu `/` thừa ở cuối) — không có khớp tiền tố lỏng lẻo.
 */
export const NOTIFICATION_URL_ALLOWLIST: readonly NotificationRoute[] = [
  // Ngày của tôi — App.tsx:380, KHÔNG bọc RequirePermission ⇒ đích dự phòng an toàn.
  { path: "/my-day", module: null },
  // App.tsx:316
  { path: "/notifications", module: "notifications" },
  // App.tsx:367. E1 cần CẢ HAI param: chỉ `approval_status=UNAPPROVED` mà thiếu
  // `layer=PENDING` thì lớp CASH mặc định ép thêm `.eq(approval_status,APPROVED)`
  // và postgrest-js dùng append (AND) ⇒ danh sách RA 0 DÒNG. Nếu `layer` bị loại
  // vì giá trị rác, trang Thu chi tự gỡ lớp về "Tất cả" (xem effect deep-link ở
  // IncomeExpensePage/IncomeExpenseMobilePage) nên không bao giờ rơi vào bẫy đó.
  {
    path: "/income-expense",
    module: "income_expenses",
    params: [
      ["approval_status", (v) => IE_APPROVAL_STATUS_PARAM_VALUES.has(v)],
      ["layer", (v) => IE_LAYER_PARAM_VALUES.has(v)],
      ["account_id", isUuid],
    ],
  },
  // App.tsx:369 — VoucherDetailPage nhận đúng `income_expenses.id`.
  { path: "/income-expense/voucher", idSegment: true, module: "income_expenses" },
  // App.tsx:379 — resolver `?job=` ở TaskManagementPage.tsx + TasksMobilePage.tsx.
  { path: "/tasks", module: "tasks", params: [["job", isUuid]] },
  // App.tsx:358 — resolver `?handover=` ở ThuTien.tsx.
  { path: "/thu-tien", module: "thu_tien", params: [["handover", isUuid]] },
  // App.tsx:434 — chỉ ProtectedRoute, trang tự rẽ admin ↔ self-view theo quyền.
  { path: "/finance/salary", module: null },
  // App.tsx:365 / :345 — fallback cho các dòng thông báo cũ mang invoice_id/contract_id.
  { path: "/invoices", idSegment: true, module: "invoices" },
  { path: "/contracts", idSegment: true, module: "contracts" },
];

/** Cắt hash + query, chuẩn hoá `/` thừa ở cuối. Trả null nếu chuỗi đáng ngờ. */
function splitPath(raw: string): { path: string; query: string } | null {
  // Ký tự điều khiển / khoảng trắng bên trong: không route nào của ta có.
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) <= 0x20 || raw.charCodeAt(i) === 0x7f) return null;
  }
  // `\` bị nhiều trình duyệt coi như `/` khi phân giải URL ⇒ `/\evil.tld` là
  // protocol-relative trá hình. Không route nào cần backslash.
  if (raw.includes("\\")) return null;
  // Scheme (`javascript:`, `https:`, `mailto:`) — dấu `:` đứng trước `/` đầu tiên.
  const colon = raw.indexOf(":");
  if (colon >= 0) {
    const slash = raw.indexOf("/");
    if (slash === -1 || colon < slash) return null;
  }
  // Phải là đường dẫn tuyệt đối NỘI BỘ.
  if (!raw.startsWith("/")) return null;
  // `//host` = protocol-relative ⇒ ra ngoài app.
  if (raw.startsWith("//")) return null;

  const noHash = raw.split("#", 1)[0];
  const qIdx = noHash.indexOf("?");
  let path = qIdx === -1 ? noHash : noHash.slice(0, qIdx);
  const query = qIdx === -1 ? "" : noHash.slice(qIdx + 1);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { path, query };
}

function matchRoute(path: string): NotificationRoute | null {
  for (const route of NOTIFICATION_URL_ALLOWLIST) {
    if (!route.idSegment) {
      if (path === route.path) return route;
      continue;
    }
    const prefix = `${route.path}/`;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    // ĐÚNG một đoạn UUID — chặn `/invoices/<uuid>/../../x`.
    if (isUuid(rest)) return route;
  }
  return null;
}

function buildQuery(route: NotificationRoute, query: string): string {
  if (!route.params?.length || !query) return "";
  const src = new URLSearchParams(query);
  const out = new URLSearchParams();
  for (const [key, isValid] of route.params) {
    const value = src.get(key);
    if (value !== null && isValid(value)) out.set(key, value);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/**
 * Chuẩn hoá + kiểm duyệt URL lấy từ `notification.metadata.url`.
 *
 * @param raw  giá trị thô trong metadata (kiểu bất kỳ — JSONB không hứa gì).
 * @param perms bản đồ quyền của người đang đăng nhập (`useMyPermissions`).
 * @returns
 *   - đường dẫn nội bộ ĐÃ chuẩn hoá (chỉ giữ query param hợp lệ), hoặc
 *   - `'/my-day'` khi route hợp lệ nhưng người dùng thiếu quyền module
 *     (điều hướng vào sẽ bị `RequirePermission` đá về `/` — thà đưa thẳng tới
 *     trang ai cũng vào được còn hơn nháy một cú redirect khó hiểu), hoặc
 *   - `null` khi chuỗi không nằm trong allow-list ⇒ UI KHÔNG được điều hướng.
 */
export function resolveNotificationUrl(
  raw: unknown,
  perms: PermsLike,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = splitPath(trimmed);
  if (!parts) return null;

  const route = matchRoute(parts.path);
  if (!route) return null;

  if (route.module && !canUse(perms, route.module, "view")) {
    return NOTIFICATION_FALLBACK_URL;
  }

  return `${parts.path}${buildQuery(route, parts.query)}`;
}

export default resolveNotificationUrl;
