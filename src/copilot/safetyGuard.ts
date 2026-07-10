// Lớp an toàn cho UI-control (F8/F13 PLAN.md v2.1). npm page-agent@1.11.0 CHƯA có
// cơ chế [data-page-agent-not-interactive] (đó là main chưa release) — bản này
// dùng interactiveBlacklist SỐNG (getFlatTree đọc lại mỗi updateTree) repopulate
// qua event `beforeUpdate`. Verified spike (docs/ai-copilot/SPIKE-RESULTS.md).
import type { PageAgent } from 'page-agent';

// Nút/hành động NGUY HIỂM: agent không được click. Regex text/aria + container
// cảnh báo + attribute chủ động [data-ai-risk] (gắn dần vào component dùng chung).
const DANGER_RE = /xo[áa]|delete|hu[ỷy]\b|remove|thanh l[ýy]|b[ỏo] c[ọo]c|x[óo]a|duy[ệe]t|approve|chuy[ểe]n nh[ưượ]/i;

function findDangerousElements(): Element[] {
  const out: Element[] = [];
  document
    .querySelectorAll<HTMLElement>('button, a, [role="button"], [role="menuitem"], [data-ai-risk]')
    .forEach((el) => {
      if (el.hasAttribute('data-ai-risk')) { out.push(el); return; }
      if (el.closest('[role="alertdialog"], [data-ai-risk]')) { out.push(el); return; }
      const label = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
      if (DANGER_RE.test(label)) out.push(el);
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
export function makeRouteGuard(allowlist: string[]) {
  return () => {
    const path = window.location.pathname;
    const ok = allowlist.some((a) => path === a || path.startsWith(a + '/'));
    if (!ok) {
      throw new Error(`Đã rời khỏi phạm vi cho phép (${path}). Dừng thao tác để đảm bảo an toàn.`);
    }
  };
}

// Route allowlist khởi điểm cho pilot (chỉ nav + filter). Tắt trên Chat Zalo (F13).
export const PILOT_ROUTE_ALLOWLIST = ['/apartments', '/invoices', '/customers'];
