#!/usr/bin/env node
/**
 * BƯỚC 2 — dựng org TEST + 4 tài khoản test.* (ánh xạ 1-1 với 4 tài khoản org thật).
 *
 *   TEST_PW='<mật khẩu>' node scripts/clone-org/create-users.mjs
 *
 * KHÔNG tạo membership ở đây: organization_memberships được clone.mjs chép như mọi
 * bảng khác (id vào idmap) để role_bindings / approval_step_approvers / income_expenses
 * .maker_membership_id … trỏ đúng membership mới. Ở đây chỉ dựng auth.users + profiles
 * + dòng organizations, vì id của chúng KHÔNG sinh ngẫu nhiên được.
 *
 * AN TOÀN: tuyệt đối không INSERT user test vào super_admins (án lệ seed-p0 — role
 * admin/super admin bypass XUYÊN tenant, coi như phá bỏ toàn bộ cách ly).
 */
import {
  runSql, gotrueAdmin, sqlLit as L,
  REAL_ORG, TEST_ORG, TEST_ORG_SLUG, TEST_ORG_NAME, USERS, testEmail, log, die,
} from './lib.mjs'

const PW = process.env.TEST_PW
if (!PW) die('Thiếu env TEST_PW')

// ===== 0. Guard idempotent ==================================================
const existed = await runSql(`SELECT id FROM public.organizations WHERE id = '${TEST_ORG}';`)
if (existed?.length) die('Org TEST đã tồn tại — chạy scripts/clone-org/rollback.mjs trước.')

// ===== 1. Dòng organizations ================================================
// is_demo = true: chỉ dùng cho badge "Bản demo" ở màn Cấu hình > Tổ chức và thứ tự
// sắp xếp của current_admin_org_v1(). Cách ly thật nằm ở sandbox_org_ids().
await runSql(`
  INSERT INTO public.organizations (id, slug, name, status, is_demo, created_by)
  SELECT '${TEST_ORG}', ${L(TEST_ORG_SLUG)}, ${L(TEST_ORG_NAME)}, 'ACTIVE', true, created_by
  FROM public.organizations WHERE id = '${REAL_ORG}';
`)
log(`✓ organizations: ${TEST_ORG_NAME}`)

// ===== 2. 4 tài khoản GoTrue ================================================
for (const u of USERS) {
  const email = testEmail(u)
  const r = await gotrueAdmin('/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: PW,
      email_confirm: true,
      user_metadata: { username: u.username, full_name: u.fullName },
    }),
  })
  if (r.status === 200 || r.status === 201) log(`✓ user ${u.username}`)
  else if (r.status === 422 && /already/i.test(JSON.stringify(r.body))) log(`• user ${u.username} đã có`)
  else die(`tạo ${u.username} fail: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
}

// ===== 3. profiles — sao chép hồ sơ của user gốc ============================
const pairs = USERS.map((u) => `(${L(u.realEmail)}, ${L(testEmail(u))}, ${L(u.fullName)})`).join(',')
await runSql(`
  WITH m(real_email, test_email, full_name) AS (VALUES ${pairs}),
  j AS (
    SELECT tu.id AS new_id, ru.id AS old_id, m.full_name
    FROM m
    JOIN auth.users ru ON ru.email = m.real_email
    JOIN auth.users tu ON tu.email = m.test_email
  )
  INSERT INTO public.profiles (
    id, full_name, phone, email, avatar_url, company_name, address,
    default_payment_due_days, timezone, language, department, job_title,
    employee_code, is_active, organization_id
  )
  SELECT j.new_id, j.full_name, NULL, NULL, p.avatar_url, p.company_name, p.address,
         p.default_payment_due_days, p.timezone, p.language, p.department, p.job_title,
         p.employee_code, true, '${TEST_ORG}'
  FROM j JOIN public.profiles p ON p.id = j.old_id
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name, organization_id = EXCLUDED.organization_id, is_active = true;
`)

const check = await runSql(`
  SELECT u.email, p.full_name, p.job_title
  FROM auth.users u JOIN public.profiles p ON p.id = u.id
  WHERE u.email IN (${USERS.map((u) => L(testEmail(u))).join(',')})
  ORDER BY u.email;
`)
if (check.length !== USERS.length) die(`Chỉ dựng được ${check.length}/${USERS.length} profile`)
for (const r of check) log(`  ${r.email} — ${r.full_name} (${r.job_title ?? 'không job_title'})`)

// ===== 3b. Nạp clone_org.user_map ==========================================
// Bảng này là đầu vào bắt buộc của public.clone_org_sync_v1() (nút Đồng bộ).
await runSql(`
  INSERT INTO clone_org.user_map (old_user_id, new_user_id)
  SELECT ru.id, tu.id
  FROM (VALUES ${pairs}) m(real_email, test_email, full_name)
  JOIN auth.users ru ON ru.email = m.real_email
  JOIN auth.users tu ON tu.email = m.test_email
  ON CONFLICT (old_user_id) DO UPDATE SET new_user_id = EXCLUDED.new_user_id;
`)
const um = await runSql(`SELECT count(*) AS n FROM clone_org.user_map;`)
log(`✓ clone_org.user_map: ${um[0].n} cặp tài khoản`)

// ===== 4. Tripwire an toàn ==================================================
const bad = await runSql(`
  SELECT count(*) AS n FROM public.super_admins s
  JOIN auth.users u ON u.id = s.user_id
  WHERE u.email IN (${USERS.map((u) => L(testEmail(u))).join(',')});
`)
if (Number(bad[0].n) > 0) die('TRIPWIRE: user test lọt vào super_admins — dừng ngay.')

log('\n✓ Xong bước 2. Tiếp: node scripts/clone-org/clone.mjs')
