import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { request, type FullConfig } from '@playwright/test';

/**
 * Nơi cất cookie mở khoá preview. Sinh ra bởi globalSetup, KHÔNG commit
 * (.gitignore) — nội dung là một chứng chỉ mở được mọi deployment preview.
 */
export const DUONG_DAN_COOKIE_BYPASS = fileURLToPath(
  new URL('./.auth/vercel-bypass.json', import.meta.url),
);

/**
 * Mở khoá bản preview của Vercel bằng COOKIE, không bằng header toàn cục.
 *
 * VÌ SAO KHÔNG DÙNG `use.extraHTTPHeaders` NỮA (sự cố đo 02/09/2026)
 *   Playwright gắn `extraHTTPHeaders` vào **MỌI** request của browser context —
 *   không riêng request tới origin của app. Trang Copilot gọi thẳng
 *   `https://<ref>.supabase.co/functions/v1/llm-proxy/chat/completions`, nên hai
 *   header bypass đi kèm sang origin đó và trình duyệt phải preflight. Supabase
 *   không liệt kê `x-vercel-set-bypass-cookie` trong `Access-Control-Allow-Headers`
 *   ⇒ preflight hỏng:
 *     "Request header field x-vercel-set-bypass-cookie is not allowed by
 *      Access-Control-Allow-Headers"
 *   Kết quả: 3/7 test Copilot đỏ trên preview vì một lý do chẳng liên quan gì tới
 *   Copilot. Chìa mở cửa nhà mình không được đem gõ cửa nhà hàng xóm.
 *
 * CÁCH ĐÚNG
 *   Gửi header bypass ĐÚNG MỘT LẦN, tới đúng origin preview, kèm
 *   `x-vercel-set-bypass-cookie: true`. Vercel trả về cookie `_vercel_jwt` **gắn
 *   với host preview đó**. Lưu cookie vào storageState; từ đó browser tự đính kèm
 *   cookie cho các request cùng host và KHÔNG gửi gì lạ sang Supabase — cookie
 *   theo luật same-origin, header thì không.
 *
 * KHÔNG CÓ BIẾN MÔI TRƯỜNG ⇒ KHÔNG LÀM GÌ
 *   Chạy tay trên production/local giữ NGUYÊN hành vi cũ: không sinh file, không
 *   thêm cookie, không thêm header. Một bước setup "luôn chạy" là một bước sẽ hỏng
 *   ở nơi nó chẳng có việc gì để làm.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  void config;

  const bimat = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const baseURL = process.env.FLEET_BASE_URL;
  if (!bimat || !baseURL) return;

  const ctx = await request.newContext({
    baseURL,
    extraHTTPHeaders: {
      'x-vercel-protection-bypass': bimat,
      'x-vercel-set-bypass-cookie': 'true',
    },
  });

  try {
    const res = await ctx.get('/');
    if (!res.ok()) {
      throw new Error(
        `Mở khoá preview thất bại: GET ${baseURL}/ trả HTTP ${res.status()}. ` +
          'Khả năng cao là VERCEL_AUTOMATION_BYPASS_SECRET sai hoặc đã hết hạn ' +
          '(Vercel → Project → Settings → Deployment Protection → Protection Bypass for Automation).',
      );
    }
    const html = await res.text();
    if (!html.includes('name="build-sha"')) {
      throw new Error(
        `Mở khoá preview thất bại: GET ${baseURL}/ trả HTTP 200 nhưng KHÔNG có thẻ ` +
          '<meta name="build-sha"> — tức đây là trang đăng nhập SSO của Vercel chứ không phải app. ' +
          'Khả năng cao là VERCEL_AUTOMATION_BYPASS_SECRET sai hoặc đã hết hạn.',
      );
    }

    await mkdir(dirname(DUONG_DAN_COOKIE_BYPASS), { recursive: true });
    await ctx.storageState({ path: DUONG_DAN_COOKIE_BYPASS });
  } finally {
    await ctx.dispose();
  }
}
