// Cấu hình project TEST cho giống production ở những chỗ KHÔNG nằm trong database:
// Data API (PostgREST) và Auth. Idempotent — sync.mjs gọi mỗi lần đồng bộ.
//
// Project mới tạo mặc định MỞ ĐĂNG KÝ tự do (disable_signup=false): ai có URL +
// publishable key đều tự tạo được tài khoản. Production đã tắt từ lâu (đường đăng ký
// công khai đã gỡ khỏi app). Để nguyên thì TEST — mang dữ liệu thật — kém an toàn hơn
// production. Bước này tắt nó.
//
// Chỉ chép các trường KHÔNG bí mật (không đụng jwt_secret, SMTP, key nhà cung cấp).

import { PROD_REF, ghiLog, mgmt } from "./lib.mjs";

const TRUONG_AUTH = [
  "disable_signup", "jwt_exp", "mailer_autoconfirm", "external_email_enabled", "external_phone_enabled",
  "external_anonymous_users_enabled", "password_min_length", "password_required_characters",
  "security_update_password_require_reauthentication", "sessions_timebox", "sessions_inactivity_timeout",
  "refresh_token_rotation_enabled", "security_refresh_token_reuse_interval", "mfa_totp_enroll_enabled",
];
const TRUONG_POSTGREST = ["db_schema", "max_rows", "db_extra_search_path", "db_pool"];

/** URL web của môi trường TEST (alias Vercel của nhánh test-env). */
export const WEB_TEST = "https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app";

export async function cauHinhProjectTest(cred) {
  if (!cred.testPat) {
    ghiLog("cau-hinh", "⚠ thiếu TEST_SUPABASE_PAT — bỏ qua cấu hình Data API/Auth");
    return false;
  }
  // Đọc production bằng PAT nào thấy được prod (PAT của TEST thường là tài khoản chủ).
  const patProd = cred.testPat;
  const [authProd, restProd] = await Promise.all([
    mgmt(patProd, "GET", `/v1/projects/${PROD_REF}/config/auth`).catch(() => mgmt(cred.pat, "GET", `/v1/projects/${PROD_REF}/config/auth`)),
    mgmt(patProd, "GET", `/v1/projects/${PROD_REF}/postgrest`).catch(() => mgmt(cred.pat, "GET", `/v1/projects/${PROD_REF}/postgrest`)),
  ]);
  const auth = Object.fromEntries(TRUONG_AUTH.map((k) => [k, authProd[k]]));
  auth.disable_signup = true; // chốt cứng, kể cả nếu production có ngày mở lại
  auth.site_url = WEB_TEST;
  auth.uri_allow_list = `${WEB_TEST}/**,http://localhost:8080/**`;
  // API từ chối null (vd db_pool chưa đặt) — chỉ gửi trường production có giá trị.
  const rest = Object.fromEntries(TRUONG_POSTGREST.filter((k) => restProd[k] != null).map((k) => [k, restProd[k]]));

  await mgmt(cred.testPat, "PATCH", `/v1/projects/${cred.testRef}/config/auth`, auth);
  await mgmt(cred.testPat, "PATCH", `/v1/projects/${cred.testRef}/postgrest`, rest);

  const [a2, r2] = await Promise.all([
    mgmt(cred.testPat, "GET", `/v1/projects/${cred.testRef}/config/auth`),
    mgmt(cred.testPat, "GET", `/v1/projects/${cred.testRef}/postgrest`),
  ]);
  if (a2.disable_signup !== true) throw new Error("Không tắt được đăng ký tự do trên TEST.");
  if (r2.db_schema !== restProd.db_schema) throw new Error(`Data API TEST "${r2.db_schema}" ≠ production "${restProd.db_schema}".`);
  ghiLog("cau-hinh", `Auth: tắt đăng ký, site ${WEB_TEST} · Data API: ${r2.db_schema}`);
  return true;
}
