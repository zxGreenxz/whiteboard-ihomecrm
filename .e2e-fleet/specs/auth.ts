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
  // MÔI TRƯỜNG TEST RIÊNG (project Supabase `ihomecrm-test`, web Preview nhánh
  // `test-env`) — bản sao production, xem scripts/test-env/README.md. Đây là tài
  // khoản THẬT của công ty iHome, đăng nhập bằng MẬT KHẨU TEST (dòng `TEST_PASS`
  // trong CLAUDE.local.md, khác mật khẩu production). credentials() chỉ cấp chúng
  // khi FLEET_BASE_URL là web TEST — spec ghi dữ liệu không bao giờ chạm công ty
  // thật trên production. Thay cho org TEST cũ cccc…0001 và 4 tài khoản `test.*`
  // (gỡ 23/09/2026, migration 20260923163531).
  testchu: 'nguyentam@username.ihomecrm.local', // Chủ công ty [TENANT_OWNER]
  testquanly: 'joey@username.ihomecrm.local', // Quản Lý Tòa
  // Tài khoản hệ thống trên TEST: super admin + TENANT_OWNER, và (tới 24/09/2026) là
  // người GIỮ cả 23 sổ quỹ công ty — `nguyentam` giữ 0 sổ nên không tự lập phiếu thu được.
  testhethong: 'nguyentamca165@gmail.com',
} as const;

const PASS_ENV = {
  chunha: 'FLEET_PASS_CHUNHA',
  ketoan: 'FLEET_PASS_KETOAN',
  quanly: 'FLEET_PASS_QUANLY',
  quanly2: 'FLEET_PASS_QUANLY2',
  sysadmin: 'FLEET_PASS_SYSADMIN',
  testchu: 'FLEET_PASS_TEST_CHU',
  testquanly: 'FLEET_PASS_TEST_QUANLY',
  testhethong: 'FLEET_PASS_TEST_HETHONG',
} as const;

export type UserKey = keyof typeof EMAILS;
/** Giữ tên cũ để spec đang có không phải sửa; chỉ còn email, không có mật khẩu. */
export const USERS = EMAILS;

/** Web Preview của nhánh `test-env` — đích DUY NHẤT nhận tài khoản thật. */
const WEB_TEST = /^https:\/\/ihomecrm-git-test-env-[a-z0-9-]+\.vercel\.app\/?$/;
const CHI_TREN_WEB_TEST: ReadonlySet<UserKey> = new Set(['testchu', 'testquanly', 'testhethong']);

/** FLEET_BASE_URL đang trỏ web TEST — spec riêng của môi trường TEST dùng để `test.skip`. */
export function laWebTest(): boolean {
  return WEB_TEST.test(process.env.FLEET_BASE_URL ?? '');
}

/** Lấy credential từ env; báo lỗi rõ ràng thay vì fail mơ hồ ở bước điền form. */
export function credentials(who: UserKey): { email: string; pass: string } {
  if (CHI_TREN_WEB_TEST.has(who) && !laWebTest()) {
    throw new Error(
      `Tài khoản ${who} là tài khoản THẬT của công ty — chỉ dùng trên web TEST ` +
        `(FLEET_BASE_URL=https://ihomecrm-git-test-env-….vercel.app), đang là ` +
        `"${process.env.FLEET_BASE_URL ?? '(mặc định production)'}".`,
    );
  }
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
