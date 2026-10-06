// =============================================================================
// Ranh giới tài khoản trên trình duyệt: tài khoản rời tab (đăng xuất, hết phiên,
// đổi tài khoản ở tab khác) thì không để lại gì cho tài khoản kế tiếp.
//
// Báo lỗi 06/10/2026: NATHAN mở /contracts thấy 0 hợp đồng. Tab còn giữ bộ lọc toà
// của tài khoản đăng nhập trước, NATHAN không thấy toà đó nên mọi số về 0, còn ô
// lọc lại ghi "Tất cả toà nhà" vì không tìm được tên toà. Trước đây chỉ bộ lọc báo
// cáo Hiệu quả kinh doanh được dọn khi đổi tài khoản.
//
// - sessionStorage: xoá HẾT. Nó chỉ chứa trạng thái giao diện của tab (bộ lọc
//   `flt:*`, cờ đã vào trang chủ, mốc kiểm hoá đơn quá hạn, khoá chống tải lại
//   lặp…), không có gì phải mang sang tài khoản khác.
// - localStorage: chỉ xoá lựa chọn giao diện KHÔNG gắn theo người dùng (hai danh
//   sách bên dưới). Giữ lại phiên đăng nhập (supabase-js tự quản), lựa chọn đã gắn
//   userId, và nhật ký chống ghi trùng tiền: chúng gắn theo userId hoặc mã yêu cầu
//   nên không lẫn sang người khác, còn xoá đi thì chính người đó đăng nhập lại có
//   thể gửi trùng một khoản thu. Phân loại từng file đọc/ghi localStorage nằm ở
//   src/lib/__tests__/accountBrowserState.test.ts — file mới chưa phân loại là đỏ.
// =============================================================================

/** Lựa chọn giao diện lưu chung cho mọi tài khoản trên máy — dọn khi tài khoản rời tab. */
export const ACCOUNT_UI_LOCAL_KEYS: readonly string[] = [
  "invoice-list-column-visibility-v1",
  "ie-batch-list-column-visibility-v1",
];

/** Như trên nhưng khoá có hậu tố (sổ chi chọn gần nhất lưu theo công ty, không theo người). */
export const ACCOUNT_UI_LOCAL_PREFIXES: readonly string[] = [
  "ihome:quick-entry:last-account:",
];

function isAccountUiLocalKey(key: string): boolean {
  return (
    ACCOUNT_UI_LOCAL_KEYS.includes(key) ||
    ACCOUNT_UI_LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function browserSessionStorage(): Storage | null {
  let storage: Storage | null = null;
  try {
    if (typeof window !== "undefined") storage = window.sessionStorage;
  } catch {
    // Trình duyệt chặn bộ nhớ ⇒ tab không giữ được trạng thái nào để dọn.
  }
  return storage;
}

export function browserLocalStorage(): Storage | null {
  let storage: Storage | null = null;
  try {
    if (typeof window !== "undefined") storage = window.localStorage;
  } catch {
    // Trình duyệt chặn bộ nhớ ⇒ máy không giữ được lựa chọn nào để dọn.
  }
  return storage;
}

export function clearAccountBrowserState(
  session: Storage | null = browserSessionStorage(),
  local: Storage | null = browserLocalStorage(),
): void {
  try {
    session?.clear();
  } catch {
    // Trình duyệt chặn bộ nhớ (chế độ riêng tư…): không có gì để dọn.
  }
  if (!local) return;

  const accountKeys: string[] = [];
  try {
    for (let index = 0; index < local.length; index += 1) {
      const key = local.key(index);
      if (key !== null && isAccountUiLocalKey(key)) accountKeys.push(key);
    }
  } catch {
    // Bộ nhớ bị chặn khi đang duyệt ⇒ không đọc được thì cũng không xoá được.
    return;
  }
  for (const key of accountKeys) {
    try {
      local.removeItem(key);
    } catch {
      // Bộ nhớ có thể bị chặn giữa lúc duyệt và lúc xoá.
    }
  }
}

/**
 * Đăng xuất chủ động: dọn rồi nạp lại HẲN trang đăng nhập. Trang cũ bị bỏ cùng toàn
 * bộ bộ nhớ JS của tài khoản vừa thoát (state React, cache dữ liệu), nên tài khoản
 * đăng nhập kế tiếp luôn bắt đầu từ trạng thái sạch.
 */
export function restartAtLogin(
  navigateDocument: (path: string) => void = (path) => window.location.replace(path),
): void {
  clearAccountBrowserState();
  navigateDocument("/login");
}
