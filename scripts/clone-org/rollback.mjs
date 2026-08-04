#!/usr/bin/env node
/**
 * Gỡ bản sao công ty TEST.
 *
 *   node scripts/clone-org/rollback.mjs --data          # chỉ xoá dữ liệu đã chép
 *   node scripts/clone-org/rollback.mjs --all           # xoá luôn user + org + policy
 *
 * An toàn: MỌI dòng của bản sao đều mang organization_id = TEST_ORG, nên predicate
 * xoá là hằng số — không có đường nào chạm vào dòng của công ty thật.
 * Vẫn chạy replica mode để trigger guard (khoá sổ, chốt kỳ) không chặn giữa chừng.
 */
import {
  runSql, txWrap, gotrueAdmin, REAL_ORG, TEST_ORG, USERS, testEmail, sqlLit as L,
  cloneTables, log, die,
} from './lib.mjs'

const mode = process.argv.includes('--all') ? 'all' : process.argv.includes('--data') ? 'data' : null
if (!mode) die('Dùng: rollback.mjs --data | --all')

if (TEST_ORG === REAL_ORG) die('TRIPWIRE: TEST_ORG trùng REAL_ORG')

const tables = (await cloneTables()).map((t) => t.tbl)
log(`• xoá dữ liệu org TEST trên ${tables.length} bảng`)

// Xoá theo lô, mỗi lô 1 transaction; replica mode nên không cần thứ tự FK.
const CHUNK = 25
for (let i = 0; i < tables.length; i += CHUNK) {
  const part = tables.slice(i, i + CHUNK)
  await runSql(txWrap(part.map((t) => `DELETE FROM public.${t} WHERE organization_id = '${TEST_ORG}';`)))
  log(`  ✓ ${i + part.length}/${tables.length}`)
}

await runSql('TRUNCATE clone_org.idmap;')
log('✓ dọn clone_org.idmap')

const left = await runSql(`
  SELECT string_agg(x.t || '=' || x.n, ', ') AS s FROM (
    ${tables.map((t) => `SELECT '${t}' t, count(*) n FROM public.${t} WHERE organization_id='${TEST_ORG}'`).join(' UNION ALL ')}
  ) x WHERE x.n > 0;
`)
if (left[0]?.s) die(`Còn sót: ${left[0].s}`)
log('✓ không còn dòng nào mang org TEST')

if (mode === 'data') {
  log('\n✓ Xong (giữ nguyên org + 4 tài khoản test). Chép lại: node scripts/clone-org/clone.mjs')
  process.exit(0)
}

// ===== --all: gỡ nốt user, profile, org, policy =============================
const emails = USERS.map((u) => L(testEmail(u))).join(',')
const users = await runSql(`SELECT id, email FROM auth.users WHERE email IN (${emails});`)

await runSql(txWrap([
  `DELETE FROM public.organization_memberships WHERE organization_id = '${TEST_ORG}';`,
  `DELETE FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email IN (${emails}));`,
]))
log('✓ xoá memberships + profiles')

for (const u of users) {
  const r = await gotrueAdmin(`/admin/users/${u.id}`, { method: 'DELETE' })
  log(`  ${r.status === 200 ? '✓' : '•'} xoá auth user ${u.email} (HTTP ${r.status})`)
}

await runSql(`DELETE FROM public.organizations WHERE id = '${TEST_ORG}';`)
log('✓ xoá dòng organizations')

await runSql(`
  DO $do$
  DECLARE r record; n int := 0;
  BEGIN
    FOR r IN SELECT tablename FROM pg_policies
             WHERE schemaname = 'public' AND policyname LIKE '%\\_hide\\_sandbox\\_admin'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tablename || '_hide_sandbox_admin', r.tablename);
      n := n + 1;
    END LOOP;
    RAISE NOTICE 'dropped % policies', n;
  END $do$;
  DROP FUNCTION IF EXISTS public.sandbox_org_ids();
`)
log('✓ gỡ policy *_hide_sandbox_admin + sandbox_org_ids()')
log('\n✓ Đã gỡ sạch công ty TEST.')
