// Lượt 11 (nghiệm thu 24/10): phân biệt "người dùng THIẾU QUYỀN CRM" với "khoá CHƯA BẬT cho kết nối" khi từ chối thao tác ghi.
// identity của broker chỉ mang tập quyền HIỆU LỰC (quyền CRM ∩ trần công ty ∩ chính sách trợ lý ∩ khoá kết nối), nên runtime không biết
// khoá rơi vì đâu và báo mọi ca là action_disabled ("chưa được bật cho kết nối") — sai khi khoá đã bật mà người dùng chưa được cấp
// quyền CRM. durable-authority (nơi có đủ bốn tập) ghi lại phần thiếu quyền CRM của đúng ảnh chụp quyền đó, khoá theo contextVersion
// (băm của chính ảnh chụp, broker chuyển nguyên cho runtime) ⇒ không bao giờ dùng nhầm ảnh chụp cũ. Chỉ là chỉ dẫn cho câu trả lời:
// quyền vẫn do SQL quyết; không có dòng ghi (đường khác, tiến trình mới) ⇒ runtime giữ action_disabled như trước.
const VERSION = /^[a-f0-9]{64}$/;
const KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export function createCrmPermissionGaps({ maxEntries = 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 16384) throw new TypeError('invalid_crm_permission_gaps');
  const gaps = new Map();
  return Object.freeze({
    /** keys = khoá thao tác có ở trần công ty, chính sách trợ lý và khoá kết nối nhưng KHÔNG có trong quyền CRM của người dùng. */
    observe(contextVersion, keys) {
      if (typeof contextVersion !== 'string' || !VERSION.test(contextVersion) || !Array.isArray(keys) || keys.length > 256 ||
          keys.some(key => typeof key !== 'string' || !KEY.test(key))) return;
      gaps.delete(contextVersion);
      if (gaps.size >= maxEntries) gaps.delete(gaps.keys().next().value);
      gaps.set(contextVersion, new Set(keys));
    },
    lacks: (contextVersion, key) => typeof contextVersion === 'string' && gaps.get(contextVersion)?.has(key) === true,
  });
}
