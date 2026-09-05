import { Page } from '@playwright/test';

/**
 * Tài khoản test DEMO (org dddd…0001). MẬT KHẨU KHÔNG hard-code trong repo —
 * đọc từ biến môi trường; giá trị thật nằm ở `CLAUDE.local.md` (đã gitignore).
 *
 * Cách chạy:
 *   FLEET_PASS_CHUNHA=... FLEET_PASS_KETOAN=... FLEET_PASS_QUANLY=... \
 *     npx playwright test specs/<file>.spec.ts
 *
 * Hoặc export sẵn trong shell để khỏi gõ lại mỗi lần.
 */
const EMAILS = {
  chunha: 'demo.chunha@username.ihomecrm.local',
  ketoan: 'demo.ketoan@username.ihomecrm.local',
  quanly: 'demo.quanly@username.ihomecrm.local',
  // Quản lý THỨ HAI của org DEMO. Secret `FLEET_PASS_QUANLY2` đã có trong
  // .github/workflows/copilot-e2e.yml từ 02/09/2026 nhưng khoá này thì chưa —
  // ma trận hành động Copilot cần một danh tính DEMO thứ hai để chứng minh
  // "nonce của người này người kia không dùng được".
  quanly2: 'demo.quanly2@username.ihomecrm.local',
  // Tài khoản HỆ THỐNG (super admin). Dùng cho việc mà không vai nào khác làm
  // được: lật cờ rollout bằng `set_copilot_feature_flag_v2` (RPC đó đòi
  // `is_super_admin()`) và xoay PIN step-up.
  //
  // ⚠ TỪ 03/09/2026 NÓ CŨNG LÀ THÀNH VIÊN ACTIVE CỦA DEMO, CÓ QUYỀN GHI THẬT.
  // `supabase/migrations/20260903220254_demo_l5_e2e_accounts_seed_v1.sql` gán cho
  // nó ĐÚNG vai "Chủ công ty" của `demo.chunha` để một kế hoạch L5 thật chạy
  // được bằng một actor vừa là super admin vừa có role_binding thật. Chú thích
  // cũ ở đây từng ghi "KHÔNG có `income_expenses.edit` trên org DEMO" — điều đó
  // ĐÚNG trước hàng seed kia và SAI sau nó; niềm tin đó đã làm ca 3 của
  // `copilot-action-matrix.spec.ts` đỏ (xem chú thích ca 3/ca 3b ở đó). ĐỪNG
  // dùng tài khoản này làm vai "thiếu quyền" nữa.
  sysadmin: 'nguyentamca165@gmail.com',
  // Công ty TEST (org cccc…0001) — bản sao dữ liệu công ty thật, xem
  // scripts/clone-org/README.md. Dùng để thử tính năng mới trên dữ liệu thật.
  testchu: 'test.nguyentamca165@username.ihomecrm.local',
  testketoan: 'test.joey@username.ihomecrm.local',
} as const;

const PASS_ENV = {
  chunha: 'FLEET_PASS_CHUNHA',
  ketoan: 'FLEET_PASS_KETOAN',
  quanly: 'FLEET_PASS_QUANLY',
  quanly2: 'FLEET_PASS_QUANLY2',
  sysadmin: 'FLEET_PASS_SYSADMIN',
  testchu: 'FLEET_PASS_TEST',
  testketoan: 'FLEET_PASS_TEST',
} as const;

export type UserKey = keyof typeof EMAILS;
/** Giữ tên cũ để spec đang có không phải sửa; chỉ còn email, không có mật khẩu. */
export const USERS = EMAILS;

/** Lấy credential từ env; báo lỗi rõ ràng thay vì fail mơ hồ ở bước điền form. */
export function credentials(who: UserKey): { email: string; pass: string } {
  const pass = process.env[PASS_ENV[who]];
  if (!pass) {
    throw new Error(
      `Thiếu biến môi trường ${PASS_ENV[who]} cho tài khoản ${who}. ` +
        `Mật khẩu tài khoản test nằm ở CLAUDE.local.md — KHÔNG commit vào repo.`,
    );
  }
  return { email: EMAILS[who], pass };
}

/** Đăng nhập 1 tài khoản demo (mỗi worker 1 context riêng → phiên độc lập). */
export async function login(page: Page, who: UserKey) {
  const u = credentials(who);
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Tài Khoản' }).fill(u.email);
  await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(u.pass);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
}

/** Bắt các lỗi console app-level (loại bỏ noise mạng 4xx/5xx là network log). */
export function trackConsoleErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return;   // network 4xx/5xx = không phải app exception
    if (/Failed to fetch/i.test(t)) return;           // fetch transient (blip mạng khi chạy parallel/headed)
    if (/useBuildings error/i.test(t)) return;        // hệ quả của fetch-transient trên
    errs.push(t);
  });
  return errs;
}
