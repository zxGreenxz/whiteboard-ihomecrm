// Lớp an toàn cho UI-control (F8/F13 PLAN.md v2.1). npm page-agent@1.11.0 CHƯA có
// cơ chế [data-page-agent-not-interactive] (đó là main chưa release) — bản này
// dùng interactiveBlacklist SỐNG (getFlatTree đọc lại mỗi updateTree) repopulate
// qua event `beforeUpdate`. Verified spike (docs/ai-copilot/SPIKE-RESULTS.md).
import type { PageAgent } from 'page-agent';
import { PILOT_UI_CONTROL_ROUTES } from './pageScope';

// Nút/hành động NGUY HIỂM: agent không được click. Regex text/aria + container
// cảnh báo + attribute chủ động [data-ai-risk] (gắn dần vào component dùng chung).
// LƯU Ý: \b của JS regex không hoạt động sau ký tự có dấu (ỷ không phải \w) —
// "huỷ/hủy" match theo cả 2 cách bỏ dấu, KHÔNG dùng 'huy' trần (tên người Huy).
// `nh[ưu][ơợ]ng` thay cho `chuy[ểe]n nh[ưượ]` cũ: nút thật trên bảng hợp đồng
// ghi "Nhượng HĐ" / "Nhượng hợp đồng", KHÔNG có chữ "chuyển" phía trước, nên
// luật cũ đi ngang qua nó (khảo sát 14/08/2026). Hai ký tự "ượ" phải khớp RỜI
// để không nuốt "nhưng" — từ nối thông thường, khớp nó là chặn nhầm nút lành.
export const DANGER_RE = /xo[áa]|delete|huỷ|hủy|remove|thanh l[ýy]|b[ỏo] c[ọo]c|x[óo]a|duy[ệe]t|approve|nh[ưu][ơợ]ng/i;

// Form-fill 3b: agent ĐƯỢC điền form nhưng KHÔNG BAO GIỜ tự submit — nút
// Lưu/Xác nhận/type=submit bị loại khỏi index, agent dừng ở "bạn kiểm tra và bấm Lưu".
export const SUBMIT_RE = /^\s*(l[ưu]u\b|c[ậa]p nh[ậa]t|x[áa]c nh[ậa]n|ho[àa]n t[ấa]t|t[ạa]o(\s|$)|th[êe]m m[ớơ]i|g[ửư]i\b|submit|save)/i;

/**
 * Mọi chỗ một nút có thể mang nhãn, trả về dạng danh sách RỜI.
 *
 * Phải đọc cả `title`: khảo sát 14/08/2026 cho thấy nút icon trên bảng toà nhà
 * đặt nhãn ở `title` ("Sửa", "Xoá", "In"), toolbar hợp đồng cũng vậy ("Nhập",
 * "Xuất"). Không đọc `title` thì nút "Xoá" chỉ là một icon trần không chữ, và
 * hàng rào theo nhãn đi thẳng qua nó.
 *
 * Trả rời từng nhãn thay vì nối chuỗi vì `SUBMIT_RE` NEO ĐẦU (`^`): nối
 * `textContent` + `title` lại thì một nút có chữ "Xem" phía trước sẽ che mất
 * `title="Lưu"` phía sau. Nối chuỗi ở đây là tự tạo điểm mù.
 *
 * CHƯA VỚI TỚI (ghi rõ để không đọc nhầm là đã phủ): nhãn nằm trong
 * `<TooltipContent>` — nó chỉ render vào portal khi hover, nên "Thanh lý",
 * "Nhượng HĐ", "Xóa" trên bảng hợp đồng KHÔNG có chữ nào trong DOM lúc quét.
 * Và control autosave không nhãn (`<Switch>` trạng thái toà nhà, multiselect
 * gán khu vực) thì không nhãn nào bắt được. Cả hai lớp đó là việc của
 * safe-control theo khai báo (Phase C), không phải của regex.
 */
export function nhanCuaPhanTu(el: Element): string[] {
  return [
    el.textContent ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
  ].filter((s) => s.trim().length > 0);
}

/** Một nhãn bất kỳ khớp luật nguy hiểm hoặc luật submit ⇒ phần tử bị loại. */
export function nhanNguyHiem(nhan: string[]): boolean {
  return nhan.some((s) => DANGER_RE.test(s) || SUBMIT_RE.test(s.trim()));
}

function findDangerousElements(): Element[] {
  const out: Element[] = [];
  document
    .querySelectorAll<HTMLElement>('button, a, [role="button"], [role="menuitem"], [data-ai-risk], [type="submit"]')
    .forEach((el) => {
      if (el.hasAttribute('data-ai-risk')) { out.push(el); return; }
      if (el.closest('[role="alertdialog"], [data-ai-risk]')) { out.push(el); return; }
      if (el.getAttribute('type') === 'submit') { out.push(el); return; }
      if (nhanNguyHiem(nhanCuaPhanTu(el))) out.push(el);
    });
  return out;
}

/**
 * Gắn listener `beforeUpdate` để repopulate mảng blacklist IN-PLACE ngay trước
 * mỗi lần dựng DOM tree → nút nguy hiểm mất index tương tác ở mọi step (kể cả
 * sau SPA re-render). Trả về hàm cleanup.
 */
export function attachDangerStamping(agent: PageAgent, liveBlacklist: Element[]): () => void {
  const handler = () => {
    liveBlacklist.length = 0;
    liveBlacklist.push(...findDangerousElements());
  };
  agent.pageController.addEventListener('beforeUpdate', handler);
  handler(); // stamp ngay lần đầu
  return () => agent.pageController.removeEventListener('beforeUpdate', handler);
}

/**
 * onBeforeStep guard: nếu SPA đã rời route allowlist giữa task → throw → task
 * dừng THẬT (page-agent không try-catch quanh hook — verified). Ẩn launcher
 * KHÔNG dừng instance đang chạy nên đây là chốt chặn.
 */
export function makeRouteGuard(allowlist: readonly string[]) {
  return () => {
    const path = window.location.pathname;
    const ok = allowlist.some((a) => path === a || path.startsWith(a + '/'));
    if (!ok) {
      throw new Error(`Đã rời khỏi phạm vi cho phép (${path}). Dừng thao tác để đảm bảo an toàn.`);
    }
  };
}

// Route allowlist khởi điểm cho pilot (chỉ nav + filter). Tắt trên Chat Zalo (F13).
//
// SINH TỪ CONTRACT, không còn viết tay: một trang chỉ vào được danh sách này khi
// contract của nó khai `safeControlIds` — tức có control đã duyệt từng cái, gắn
// `data-ai-safe`. Nới phạm vi bằng cách sửa dòng này là nới đúng vào chỗ chưa có
// control nào được duyệt; nới đúng chỗ là khai thêm ở
// `src/app/capabilities/registry.ts`. Gate: scripts/check-copilot-routes.mjs.
export const PILOT_ROUTE_ALLOWLIST: readonly string[] = PILOT_UI_CONTROL_ROUTES;
