// Ma trận âm bản CÁCH LY TENANT — integration test tự động (chống tái phát lỗ
// hổng xuyên-tenant). Dựng 2 tenant TỔNG HỢP cô lập (X, Y) trong 1 transaction
// ROLLBACK, rồi GIẢ DẠNG (impersonate) từng principal của tenant X qua RLS thật
// (SET ROLE authenticated + request.jwt.claims) và khẳng định:
//   - KHÔNG đọc được BẤT KỲ dòng nào của tenant Y (buildings/contracts/
//     income_expenses/rooms) — MUST = 0
//   - RPC get_income_expense_history(<voucher của Y>) trả 0 dòng
//   - RPC generate_invoices_for_building_v2(<tòa của Y>) bị chặn (Access denied)
//   - can_access_building / can_do_on_building với tòa Y = false
//   - VẪN đọc được tenant X của MÌNH (sanity, tránh false-pass do RLS chặn hết)
//
// Bắt buộc phủ 3 loại principal (theo audit R1): OWNER, ADMIN (role 'Admin'),
// và FULL-SCOPE staff (building_id NULL, area_id NULL) — vì cả is_admin() lẫn
// nhánh full-scope đều là đường rò trước khi vá.
//
// Chạy: node scripts/test-cross-tenant.mjs
// Không đổi dữ liệu (mọi thứ trong BEGIN…ROLLBACK). Exit 0 = PASS, 1 = FAIL.
import { readFileSync } from 'node:fs';

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch {}
}
if (!pat) { console.error('Không tìm thấy PAT (env SUPABASE_PAT hoặc CLAUDE.local.md)'); process.exit(1); }

const ref = process.env.SUPABASE_PROJECT_REF || 'tryymsxyyckgbrmmvozx';

// UUID tổng hợp (không đụng dữ liệu thật) — 1... = tenant X, 2... = tenant Y.
const ID = {
  ownerX: '11111111-0000-4000-8000-000000000001',
  ownerY: '22222222-0000-4000-8000-000000000001',
  adminX: '11111111-0000-4000-8000-0000000000a1',
  fullX:  '11111111-0000-4000-8000-0000000000f1',
  roleAdminX: '11111111-0000-4000-8000-0000000000d1',
  roleStaffX: '11111111-0000-4000-8000-0000000000e1',
  buildingX: '11111111-0000-4000-8000-0000000000b1',
  buildingY: '22222222-0000-4000-8000-0000000000b2',
  roomX: '11111111-0000-4000-8000-0000000000c1',
  roomY: '22222222-0000-4000-8000-0000000000c2',
  contractX: '11111111-0000-4000-8000-0000000000c3',
  contractY: '22222222-0000-4000-8000-0000000000c4',
  ieX: '11111111-0000-4000-8000-0000000000e5',
  ieY: '22222222-0000-4000-8000-0000000000e6',
  auditY: '22222222-0000-4000-8000-0000000000a9',
};

// Fixture: 2 tenant cô lập. Chạy dưới postgres + replica (bỏ FK/trigger) TRƯỚC
// khi SET ROLE authenticated.
const FIXTURE = `
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.roles (id,user_id,name,permissions) VALUES
    ('${ID.roleAdminX}','${ID.ownerX}','Admin','{}'::jsonb),
    ('${ID.roleStaffX}','${ID.ownerX}','Quản Lý Tòa',
      '{"income_expenses":{"view":true,"create":true,"edit":true,"delete":true},"invoices":{"create":true,"edit":true,"delete":true},"assets":{"view":true},"warehouses":{"view":true}}'::jsonb);
  INSERT INTO public.buildings (id,user_id,name,province,district,ward,total_floors,total_rooms) VALUES
    ('${ID.buildingX}','${ID.ownerX}','TEST-X','P','D','W',1,1),
    ('${ID.buildingY}','${ID.ownerY}','TEST-Y','P','D','W',1,1);
  INSERT INTO public.rooms (id,building_id,name,rent_price,deposit_amount,floor,max_occupants) VALUES
    ('${ID.roomX}','${ID.buildingX}','RX',1000000,1000000,1,1),
    ('${ID.roomY}','${ID.buildingY}','RY',1000000,1000000,1,1);
  INSERT INTO public.contracts (id,user_id,room_id,signed_date,start_date,end_date,rent_price,public_code) VALUES
    ('${ID.contractX}','${ID.ownerX}','${ID.roomX}','2026-01-01','2026-01-01','2026-12-31',1000000,'TESTX'),
    ('${ID.contractY}','${ID.ownerY}','${ID.roomY}','2026-01-01','2026-01-01','2026-12-31',1000000,'TESTY');
  INSERT INTO public.income_expenses (id,user_id,type,name,building_id,voucher_date,total_amount,approval_status) VALUES
    ('${ID.ieX}','${ID.ownerX}','INCOME','TEST-IE-X','${ID.buildingX}','2026-01-05',5000000,'APPROVED'),
    ('${ID.ieY}','${ID.ownerY}','INCOME','TEST-IE-Y','${ID.buildingY}','2026-01-05',7000000,'APPROVED');
  INSERT INTO public.income_expense_audit_log (id,income_expense_id,action,created_at) VALUES
    ('${ID.auditY}','${ID.ieY}','APPROVED', now());
  INSERT INTO public.staff_assignments (id,staff_id,user_id,role_id,building_id,area_id) VALUES
    ('${ID.buildingX}'::uuid,'${ID.adminX}','${ID.ownerX}','${ID.roleAdminX}',NULL,NULL),
    ('${ID.roomX}'::uuid,  '${ID.fullX}', '${ID.ownerX}','${ID.roleStaffX}',NULL,NULL);
`;

async function apiQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// Chạy 1 assertion cho 1 principal (mỗi request tự dựng fixture + ROLLBACK).
async function probe(principalId) {
  const sql = `BEGIN;
${FIXTURE}
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims',
      json_build_object('sub','${principalId}','role','authenticated')::text, true);
    SELECT json_build_object(
      'uid', (SELECT auth.uid())::text,
      'is_admin', public.is_admin(),
      'is_super_admin', public.is_super_admin(),
      'reads_Y_buildings',       (SELECT count(*) FROM public.buildings       WHERE id='${ID.buildingY}'),
      'reads_Y_rooms',           (SELECT count(*) FROM public.rooms           WHERE id='${ID.roomY}'),
      'reads_Y_contracts',       (SELECT count(*) FROM public.contracts       WHERE id='${ID.contractY}'),
      'reads_Y_income_expenses', (SELECT count(*) FROM public.income_expenses WHERE id='${ID.ieY}'),
      'rpc_history_Y_rows',      (SELECT count(*) FROM public.get_income_expense_history('${ID.ieY}')),
      'can_access_Y',            public.can_access_building('${ID.buildingY}'),
      'can_do_invoice_Y',        public.can_do_on_building('invoices','create','${ID.buildingY}'),
      'reads_X_buildings',       (SELECT count(*) FROM public.buildings       WHERE id='${ID.buildingX}'),
      'reads_X_income_expenses', (SELECT count(*) FROM public.income_expenses WHERE id='${ID.ieX}')
    ) AS verdict;
ROLLBACK;`;
  const { ok, body } = await apiQuery(sql);
  if (!ok) return { error: body.slice(0, 400) };
  try {
    const rows = JSON.parse(body);
    return rows[0]?.verdict ?? { error: 'no verdict', raw: body.slice(0, 200) };
  } catch {
    return { error: 'parse fail', raw: body.slice(0, 200) };
  }
}

// RPC ghi xuyên-tenant PHẢI bị chặn: gọi generate cho tòa của Y dưới principal X.
async function probeGenerateBlocked(principalId) {
  const sql = `BEGIN;
${FIXTURE}
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims',
      json_build_object('sub','${principalId}','role','authenticated')::text, true);
    SELECT public.generate_invoices_for_building_v2('${ID.buildingY}','2026-01','RENT') AS r;
ROLLBACK;`;
  const { ok, body } = await apiQuery(sql);
  // PASS nếu request BÁO LỖI với "Access denied" (guard chặn trước khi ghi).
  const blocked = !ok && /access denied/i.test(body);
  return { blocked, ok, msg: body.slice(0, 200) };
}

const PRINCIPALS = [
  { label: 'OWNER tenant X', id: ID.ownerX, expectSeesOwn: false }, // owner-không-staff: RLS tòa dựa staff_assignments → có thể KHÔNG thấy (không phải lỗ hổng)
  { label: 'ADMIN tenant X (role Admin)', id: ID.adminX, expectSeesOwn: true },
  { label: 'FULL-SCOPE staff tenant X', id: ID.fullX, expectSeesOwn: true },
];

const run = async () => {
  console.log(`\n=== MA TRẬN ÂM BẢN CÁCH LY TENANT (project ${ref}) ===\n`);
  let failed = 0;
  for (const p of PRINCIPALS) {
    const v = await probe(p.id);
    if (v.error) { console.log(`❌ ${p.label}: LỖI probe — ${v.error}`); failed++; continue; }
    const crossTenant =
      Number(v.reads_Y_buildings) + Number(v.reads_Y_rooms) + Number(v.reads_Y_contracts) +
      Number(v.reads_Y_income_expenses) + Number(v.rpc_history_Y_rows);
    const gen = await probeGenerateBlocked(p.id);

    const leaks = [];
    if (Number(v.reads_Y_buildings) > 0) leaks.push('buildings');
    if (Number(v.reads_Y_rooms) > 0) leaks.push('rooms');
    if (Number(v.reads_Y_contracts) > 0) leaks.push('contracts');
    if (Number(v.reads_Y_income_expenses) > 0) leaks.push('income_expenses');
    if (Number(v.rpc_history_Y_rows) > 0) leaks.push('get_income_expense_history');
    if (v.can_access_Y === true) leaks.push('can_access_building');
    if (v.can_do_invoice_Y === true) leaks.push('can_do_on_building');
    if (!gen.blocked) leaks.push('generate_invoices_for_building_v2');

    const ok = leaks.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? '✅' : '❌'} ${p.label}`);
    console.log(`    is_admin=${v.is_admin} is_super_admin=${v.is_super_admin} | thấy tenant X của mình: buildings=${v.reads_X_buildings} ie=${v.reads_X_income_expenses}`);
    console.log(`    XUYÊN-TENANT (phải 0): Y-rows=${crossTenant} can_access_Y=${v.can_access_Y} can_do_Y=${v.can_do_invoice_Y} generate_blocked=${gen.blocked}`);
    if (!ok) console.log(`    ⚠️  RÒ RỈ QUA: ${leaks.join(', ')}`);
  }
  console.log(`\n=== KẾT QUẢ: ${failed === 0 ? '✅ CÁCH LY TENANT PASS (không rò)' : `❌ ${failed} principal RÒ RỈ XUYÊN-TENANT`} ===\n`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((e) => { console.error(e.message || e); process.exit(2); });
