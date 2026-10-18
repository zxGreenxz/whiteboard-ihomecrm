// Tương đương ngữ nghĩa của 20261018044046_toi_uu_ham_quyen_rls_v1: 22 hàm quyền dùng trong RLS đổi
// LANGUAGE sql → plpgsql (giữ câu truy vấn), buildings_for_v3/current_visible_owner_ids hoist lời gọi
// STABLE thành InitPlan, sandbox_org_ids() IMMUTABLE, income_expenses_restricted_select bọc InitPlan.
//
// TRƯỚC = định nghĩa SỐNG ngay trước migration: baseline + forward lane, CREATE cuối cùng theo thứ tự
// tên file (cùng cách đọc của check-definer-body-authz / liveness). Hàm và policy SELECT/ALL của 8 bảng
// được nạp NGUYÊN VĂN từ nguồn; bảng chỉ dựng đủ cột mà thân hàm/policy đọc.
// SAU = cùng database sau khi chạy migration trong transaction của ca.
// Với từng vai (chủ, quản lý toà, super admin, sandbox/demo, user nhiều công ty, thu hồi/treo/hết hạn,
// cấm khẩn cấp, DENY theo toà/org…): tập id đọc được qua RLS của 8 bảng, phép nối contracts⋈rooms⋈
// buildings và kết quả mọi hàm bị đổi phải TRƯỚC = SAU — cả khi ép generic plan.
// Một PGlite cho cả file, mỗi ca BEGIN…ROLLBACK. Đột biến migration phải làm lệch ít nhất một vai.
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATION = '20261018044046_toi_uu_ham_quyen_rls_v1.sql';
const MIGRATION_SQL = readFileSync(`supabase/migrations/${MIGRATION}`, 'utf8');
const TABLES = ['buildings', 'rooms', 'contracts', 'contract_customers', 'customers', 'invoices', 'invoice_items', 'income_expenses'];
const CHANGED_FUNCTIONS = [
  'public.is_super_admin', 'public.is_admin', 'public.has_full_building_scope', 'public.my_org_ids',
  'public.demo_user_ids', 'public.demo_building_ids', 'app_private.scope_covers_v3', 'app_private.authorized_scope_v3',
  'app_private.authorized_scope_all_v3', 'app_private.can_v3', 'app_private.has_any_scope_v3',
  'app_private.my_possessed_cashbook_ids_v1', 'app_private.buildings_for_v3', 'public.accessible_building_ids',
  'public.accessible_room_ids', 'public.accessible_contract_ids', 'public.accessible_invoice_ids',
  'public.accessible_account_ids', 'public.current_visible_owner_ids', 'public.can_access_building',
  'public.can_access_org_entity', 'public.can_view_restricted_ie',
];
// Policy của 8 bảng còn gọi ba hàm này; migration không đổi thân chúng (sandbox chỉ đổi volatility).
const UNCHANGED_FUNCTIONS = ['public.sandbox_org_ids', 'public.current_profit_manager_id', 'public.current_shareholder_id'];

// ── Đọc định nghĩa sống trước migration ────────────────────────────────────────────────────────────

/** Tách câu lệnh SQL, hiểu chú thích, chuỗi, định danh trích dẫn và dollar-quote. */
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  let start = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'") {
      i++;
      while (i < n) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") { i++; break; } i++; }
      continue;
    }
    if (c === '"') { const e = sql.indexOf('"', i + 1); i = e < 0 ? n : e + 1; continue; }
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80))?.[0];
      if (tag) { const e = sql.indexOf(tag, i + tag.length); i = e < 0 ? n : e + tag.length; continue; }
    }
    if (c === ';') { out.push(sql.slice(start, i + 1)); start = i + 1; }
    i++;
  }
  return out.map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
}

function liveDefinitionsBefore(file: string) {
  const cutoff: string = JSON.parse(readFileSync('supabase/migration-policy.json', 'utf8')).provisionalCutoff.version;
  const forward = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f.slice(0, 14) > cutoff && f < file).sort();
  const sources = ['supabase/baseline/schema.sql', ...forward.map(f => `supabase/migrations/${f}`)];
  const functions = new Map<string, { file: string; sql: string; signatures: Set<string> }>();
  const policies = new Map<string, { table: string; sql: string } | null>();
  const unq = (s: string) => s.replace(/^"|"$/g, '');
  for (const src of sources) {
    for (const st of splitSql(readFileSync(src, 'utf8'))) {
      let m = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?(\w+)"?\."?(\w+)"?\s*\(([^)]*)\)/i.exec(st);
      if (m) {
        const key = `${m[1]}.${m[2]}`;
        const sig = m[3].replace(/\s+/g, ' ').trim();
        const prev = functions.get(key);
        functions.set(key, { file: src, sql: st, signatures: new Set([...(prev?.signatures ?? []), sig]) });
        continue;
      }
      m = /^(CREATE|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)\s+ON\s+(?:public\.)?("?\w+"?)/i.exec(st);
      if (m) {
        const table = unq(m[3]);
        policies.set(`${table}|${unq(m[2])}`, m[1].toUpperCase() === 'CREATE' ? { table, sql: st } : null);
      }
      if (/^ALTER\s+POLICY\s/i.test(st) && TABLES.some(t => new RegExp(`\\sON\\s+(public\\.)?${t}\\b`, 'i').test(st))) {
        throw new Error(`ALTER POLICY trên bảng mục tiêu chưa được mô phỏng: ${st.slice(0, 120)}`);
      }
    }
  }
  return { functions, policies };
}

// ── Dữ liệu ────────────────────────────────────────────────────────────────────────────────────────

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const SANDBOX = 'cccc0000-0000-4000-8000-000000000001';
const [ORG_A, ORG_B, ORG_C, ORG_X] = [1, 2, 3, 4].map(id);
const ORGS = [ORG_A, ORG_B, ORG_C, ORG_X, SANDBOX];
const U = {
  owner: id(10), manager: id(11), superAdmin: id(12), multi: id(13), revoked: id(14), suspended: id(15),
  roleExpired: id(16), demo: id(17), sandboxOwner: id(18), emergency: id(19), suspendedOrg: id(20),
  fund: id(21), profitManager: id(22), shareholder: id(23), salary: id(24), outsider: id(25),
  superSandbox: id(26), orgDenied: id(27), scopedDeny: id(28), retiredRole: id(29), cashbookKnower: id(30),
};
const ROLES: Array<[string, string | null]> = [...Object.entries(U), ['khong_uid', null]];
const [BA1, BA2, BA3, BA4, BA5, BB1, BB2, BC1, BS1, BX1] = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49].map(id);
const BUILDINGS: Array<[string, string, string, boolean]> = [
  // [id, org, chủ dòng, đã xoá]
  [BA1, ORG_A, U.owner, false], [BA2, ORG_A, U.owner, false], [BA3, ORG_A, U.manager, false],
  [BA4, ORG_A, U.owner, true], [BA5, ORG_A, U.demo, false], [BB1, ORG_B, U.multi, false], [BB2, ORG_B, U.multi, false],
  [BC1, ORG_C, U.emergency, false], [BS1, SANDBOX, U.sandboxOwner, false], [BX1, ORG_X, U.suspendedOrg, false],
];
const AREA_A = id(60);
const [ACC_MANAGER, ACC_POSSESSED, ACC_B] = [70, 71, 72].map(id);
const KEYS = ['buildings.view', 'customers.view', 'income_expenses.restricted_view', 'income_expenses.create', 'cashbooks.post', 'inactive.view', 'unknown.view'];
const lit = (v: unknown) => (v === null ? 'NULL' : typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (...v: unknown[]) => `(${v.map(lit).join(', ')})`;

function seedSql(): string {
  const users = Object.entries(U).map(([k, v]) => row(v, k === 'demo' ? 'demo.1@username.ihomecrm.local' : `${k}@example.test`));
  // [user, org, status, valid_to quá khứ?, revoked?]
  const memberships: Array<[string, string, string, boolean, boolean]> = [
    [U.owner, ORG_A, 'ACTIVE', false, false], [U.manager, ORG_A, 'ACTIVE', false, false], [U.superAdmin, ORG_A, 'ACTIVE', false, false],
    [U.multi, ORG_A, 'ACTIVE', false, false], [U.multi, ORG_B, 'ACTIVE', false, false], [U.multi, ORG_C, 'ACTIVE', true, false],
    [U.revoked, ORG_A, 'ACTIVE', false, true], [U.suspended, ORG_A, 'SUSPENDED', false, false], [U.roleExpired, ORG_A, 'ACTIVE', false, false],
    [U.demo, ORG_A, 'ACTIVE', false, false], [U.sandboxOwner, SANDBOX, 'ACTIVE', false, false], [U.emergency, ORG_C, 'ACTIVE', false, false],
    [U.suspendedOrg, ORG_X, 'ACTIVE', false, false], [U.fund, ORG_A, 'ACTIVE', false, false], [U.profitManager, ORG_A, 'ACTIVE', false, false],
    [U.shareholder, ORG_A, 'ACTIVE', false, false], [U.salary, ORG_A, 'ACTIVE', false, false], [U.superSandbox, SANDBOX, 'ACTIVE', false, false],
    [U.orgDenied, ORG_B, 'ACTIVE', false, false], [U.scopedDeny, ORG_A, 'ACTIVE', false, false], [U.retiredRole, ORG_A, 'ACTIVE', false, false],
    [U.cashbookKnower, ORG_A, 'ACTIVE', false, false],
  ];
  const mid = (u: string, o: string) => `(SELECT m.id FROM public.organization_memberships m WHERE m.user_id = '${u}' AND m.organization_id = '${o}')`;
  const roleId = (o: string, name: string) => `(SELECT r.id FROM public.organization_roles r WHERE r.organization_id = '${o}' AND r.name = '${name}')`;
  const scopeId = (o: string, type: string, target: string | null) =>
    `(SELECT s.id FROM public.authorization_scopes s WHERE s.organization_id = '${o}' AND s.scope_type = '${type}'${
      target ? ` AND coalesce(s.building_id, s.area_id, s.cashbook_id) = '${target}'` : ''})`;
  // [user, org, role, valid_to quá khứ?]
  const bindings: Array<[string, string, string, boolean]> = [
    [U.owner, ORG_A, 'Owner', false], [U.manager, ORG_A, 'Manager', false], [U.superAdmin, ORG_A, 'Owner', false],
    [U.multi, ORG_B, 'Owner', false], [U.multi, ORG_C, 'Owner', false], [U.revoked, ORG_A, 'Owner', false],
    [U.suspended, ORG_A, 'Owner', false], [U.roleExpired, ORG_A, 'Owner', true], [U.demo, ORG_A, 'Owner', false],
    [U.sandboxOwner, SANDBOX, 'Owner', false], [U.emergency, ORG_C, 'Owner', false], [U.suspendedOrg, ORG_X, 'Owner', false],
    [U.superSandbox, SANDBOX, 'Owner', false], [U.orgDenied, ORG_B, 'Owner', false], [U.scopedDeny, ORG_A, 'Owner', false],
    [U.retiredRole, ORG_A, 'Retired', false], [U.cashbookKnower, ORG_A, 'Cashier', false],
  ];
  // [user, org, permission, effect, scope type, target]
  const overrides: Array<[string, string, string, string, string, string | null]> = [
    [U.manager, ORG_A, 'buildings.view', 'DENY', 'BUILDING', BA3],
    [U.multi, ORG_A, 'buildings.view', 'ALLOW', 'BUILDING', BA2],
    [U.orgDenied, ORG_B, 'buildings.view', 'DENY', 'ORGANIZATION', null],
    [U.scopedDeny, ORG_A, 'buildings.view', 'DENY', 'BUILDING', BA2],
    [U.scopedDeny, ORG_A, 'customers.view', 'DENY', 'BUILDING', BA1],
  ];
  const contracts: Array<[number, string | null, string | null, string]> = [];
  const rooms: Array<[number, string, string | null]> = [];
  BUILDINGS.forEach(([b, org], i) => {
    rooms.push([100 + i * 2, b, org], [101 + i * 2, b, i === 0 ? null : org]);
    contracts.push([200 + i * 2, id(100 + i * 2), org, i === 4 ? U.demo : U.owner], [201 + i * 2, id(101 + i * 2), i === 1 ? null : org, U.manager]);
  });
  contracts.push([299, null, ORG_A, U.owner]);
  const custOwners = [U.owner, U.manager, U.suspended, U.demo, U.outsider, U.multi, U.sandboxOwner, U.revoked];
  const customers = custOwners.flatMap((u, i) => [[300 + i * 2, ORG_A, u], [301 + i * 2, i % 2 ? ORG_B : SANDBOX, u]] as Array<[number, string, string]>);
  customers.push([399, null as unknown as string, U.owner]);
  const invoices = BUILDINGS.map(([b, org, owner], i) => [400 + i, b, org, owner] as [number, string, string, string]);
  invoices.push([499, BA1, ORG_A, U.demo]);
  // [n, org, building, chủ dòng, restricted, deleted, account, profit_manager, salary_staff, shareholder]
  const ie: Array<[number, string, string | null, string, boolean, boolean, string | null, string | null, string | null, string | null]> = [
    [500, ORG_A, BA1, U.owner, false, false, null, null, null, null],
    [501, ORG_A, BA1, U.manager, true, false, null, null, null, null],
    [502, ORG_A, BA2, U.owner, true, false, null, null, null, null],
    [503, ORG_A, BA3, U.demo, false, false, null, null, null, null],
    [504, ORG_A, null, U.owner, false, false, ACC_MANAGER, null, null, null],
    [505, ORG_A, null, U.owner, false, false, ACC_POSSESSED, null, null, null],
    [506, ORG_A, BA1, U.owner, false, true, ACC_MANAGER, null, null, null],
    [507, ORG_A, null, U.owner, false, false, null, id(80), null, null],
    [508, ORG_A, null, U.owner, false, false, null, null, U.salary, null],
    [509, ORG_A, null, U.owner, false, false, null, null, null, id(81)],
    [510, ORG_B, BB1, U.multi, true, false, ACC_B, null, null, null],
    [511, SANDBOX, BS1, U.sandboxOwner, false, false, null, null, null, null],
    [512, ORG_A, BA5, U.demo, true, false, null, null, null, null],
    [513, ORG_C, BC1, U.emergency, false, false, null, null, null, null],
  ];
  return `
INSERT INTO auth.users(id, email) VALUES ${users.join(', ')};
INSERT INTO public.super_admins(user_id) VALUES ('${U.superAdmin}'), ('${U.superSandbox}');
INSERT INTO public.organizations(id, status) VALUES ${ORGS.map(o => row(o, o === ORG_X ? 'SUSPENDED' : 'ACTIVE')).join(', ')};
INSERT INTO public.permission_definitions(key, is_active, scope_kinds, required_dimensions, requires_cashbook_possession, accepted_possession_kinds) VALUES
  ('buildings.view', true, '{ORGANIZATION,AREA,BUILDING}', '{}', false, '{}'),
  ('customers.view', true, '{ORGANIZATION,AREA,BUILDING}', '{}', false, '{}'),
  ('income_expenses.restricted_view', true, '{ORGANIZATION}', '{}', false, '{}'),
  ('income_expenses.create', true, '{ORGANIZATION,BUILDING}', '{BUILDING}', false, '{}'),
  ('cashbooks.post', true, '{CASHBOOK}', '{CASHBOOK}', true, '{CUSTODIAN}'),
  ('inactive.view', false, '{ORGANIZATION,BUILDING}', '{}', false, '{}');
INSERT INTO public.organization_memberships(organization_id, user_id, status, valid_from, valid_to, revoked_at) VALUES
  ${memberships.map(([u, o, s, exp, rev]) => `('${o}', '${u}', '${s}', now() - interval '30 days', ${exp ? "now() - interval '1 day'" : 'NULL'}, ${rev ? "now() - interval '2 days'" : 'NULL'})`).join(',\n  ')};
INSERT INTO public.buildings(id, organization_id, user_id, deleted_at) VALUES
  ${BUILDINGS.map(([b, o, u, del]) => `('${b}', '${o}', '${u}', ${del ? 'now()' : 'NULL'})`).join(', ')};
INSERT INTO public.area_buildings(organization_id, area_id, building_id) VALUES ('${ORG_A}', '${AREA_A}', '${BA2}'), ('${ORG_A}', '${AREA_A}', '${BA3}');
INSERT INTO public.accounts(id, organization_id, user_id) VALUES ('${ACC_MANAGER}', '${ORG_A}', '${U.manager}'), ('${ACC_POSSESSED}', '${ORG_A}', '${U.owner}'), ('${ACC_B}', '${ORG_B}', '${U.multi}');
INSERT INTO public.organization_roles(organization_id, name, status)
  SELECT o, 'Owner', 'ACTIVE' FROM unnest(ARRAY[${ORGS.map(lit).join(', ')}]::uuid[]) o
  UNION ALL VALUES ('${ORG_A}'::uuid, 'Manager', 'ACTIVE'), ('${ORG_A}'::uuid, 'Retired', 'RETIRED'), ('${ORG_A}'::uuid, 'Cashier', 'ACTIVE');
INSERT INTO public.role_permissions(organization_id, role_id, permission_key, effect)
  SELECT r.organization_id, r.id, k, 'ALLOW' FROM public.organization_roles r
   CROSS JOIN unnest(ARRAY['buildings.view', 'customers.view', 'income_expenses.restricted_view', 'income_expenses.create', 'inactive.view']) k
   WHERE r.name IN ('Owner', 'Retired');
INSERT INTO public.role_permissions(organization_id, role_id, permission_key, effect) VALUES
  ('${ORG_A}', ${roleId(ORG_A, 'Manager')}, 'buildings.view', 'ALLOW'),
  ('${ORG_A}', ${roleId(ORG_A, 'Manager')}, 'customers.view', 'ALLOW'),
  ('${ORG_A}', ${roleId(ORG_A, 'Manager')}, 'income_expenses.create', 'ALLOW'),
  ('${ORG_A}', ${roleId(ORG_A, 'Cashier')}, 'cashbooks.post', 'ALLOW');
INSERT INTO public.authorization_scopes(organization_id, scope_type, building_id, area_id, cashbook_id)
  SELECT o, 'ORGANIZATION', NULL::uuid, NULL::uuid, NULL::uuid FROM unnest(ARRAY[${ORGS.map(lit).join(', ')}]::uuid[]) o
  UNION ALL SELECT b.organization_id, 'BUILDING', b.id, NULL, NULL FROM public.buildings b
  UNION ALL VALUES ('${ORG_A}'::uuid, 'AREA', NULL::uuid, '${AREA_A}'::uuid, NULL::uuid), ('${ORG_A}'::uuid, 'CASHBOOK', NULL, NULL, '${ACC_POSSESSED}'::uuid);
INSERT INTO public.role_bindings(organization_id, membership_id, role_id, valid_from, valid_to) VALUES
  ${bindings.map(([u, o, r, exp]) => `('${o}', ${mid(u, o)}, ${roleId(o, r)}, now() - interval '30 days', ${exp ? "now() - interval '1 day'" : 'NULL'})`).join(',\n  ')};
INSERT INTO public.role_binding_scopes(organization_id, role_binding_id, scope_id)
  SELECT rb.organization_id, rb.id, s.id FROM public.role_bindings rb
    JOIN public.organization_roles r ON r.id = rb.role_id AND r.name IN ('Owner', 'Retired')
    JOIN public.authorization_scopes s ON s.organization_id = rb.organization_id AND s.scope_type = 'ORGANIZATION';
INSERT INTO public.role_binding_scopes(organization_id, role_binding_id, scope_id)
  SELECT rb.organization_id, rb.id, s.id FROM public.role_bindings rb
    JOIN public.organization_roles r ON r.id = rb.role_id AND r.name = 'Manager'
    JOIN public.authorization_scopes s ON s.organization_id = rb.organization_id
     AND ((s.scope_type = 'BUILDING' AND s.building_id = '${BA1}') OR s.scope_type = 'AREA');
INSERT INTO public.role_binding_scopes(organization_id, role_binding_id, scope_id)
  SELECT rb.organization_id, rb.id, ${scopeId(ORG_A, 'CASHBOOK', ACC_POSSESSED)} FROM public.role_bindings rb
    JOIN public.organization_roles r ON r.id = rb.role_id AND r.name = 'Cashier';
INSERT INTO public.member_permission_overrides(organization_id, membership_id, permission_key, effect) VALUES
  ${overrides.map(([u, o, k, e]) => `('${o}', ${mid(u, o)}, '${k}', '${e}')`).join(',\n  ')};
INSERT INTO public.member_override_scopes(organization_id, override_id, scope_id) VALUES
  ${overrides.map(([u, o, k, e, t, target]) => `('${o}', (SELECT ov.id FROM public.member_permission_overrides ov WHERE ov.membership_id = ${mid(u, o)} AND ov.permission_key = '${k}' AND ov.effect = '${e}'), ${scopeId(o, t, target)})`).join(',\n  ')};
INSERT INTO public.cashbook_possession_bindings(organization_id, membership_id, cashbook_id, possession_kind, valid_from) VALUES
  ('${ORG_A}', ${mid(U.fund, ORG_A)}, '${ACC_POSSESSED}', 'CUSTODIAN', now() - interval '1 day'),
  ('${ORG_A}', ${mid(U.cashbookKnower, ORG_A)}, '${ACC_POSSESSED}', 'CUSTODIAN', now() - interval '1 day');
INSERT INTO app_private.tenant_emergency_denies(organization_id, permission_key, active_from) VALUES ('${ORG_C}', 'buildings.view', now() - interval '1 hour');
INSERT INTO public.profit_managers(id, auth_user_id) VALUES ('${id(80)}', '${U.profitManager}');
INSERT INTO public.shareholders(id, auth_user_id) VALUES ('${id(81)}', '${U.shareholder}');
INSERT INTO public.rooms(id, building_id, organization_id) VALUES ${rooms.map(([n, b, o]) => row(id(n), b, o)).join(', ')};
INSERT INTO public.contracts(id, room_id, organization_id, user_id) VALUES ${contracts.map(([n, r, o, u]) => row(id(n), r, o, u)).join(', ')};
INSERT INTO public.customers(id, organization_id, user_id) VALUES ${customers.map(([n, o, u]) => row(id(n), o, u)).join(', ')};
INSERT INTO public.contract_customers(id, contract_id, customer_id, organization_id)
  SELECT gen_random_uuid(), c.id, cu.id, c.organization_id FROM public.contracts c
    JOIN public.customers cu ON cu.id = ('00000000-0000-4000-8000-' || lpad((300 + (right(c.id::text, 3)::int % 17))::text, 12, '0'))::uuid;
INSERT INTO public.invoices(id, building_id, organization_id, user_id) VALUES ${invoices.map(([n, b, o, u]) => row(id(n), b, o, u)).join(', ')};
INSERT INTO public.invoice_items(id, invoice_id, organization_id) SELECT gen_random_uuid(), i.id, i.organization_id FROM public.invoices i CROSS JOIN generate_series(1, 2);
INSERT INTO public.income_expenses(id, organization_id, building_id, user_id, has_restricted_item, deleted_at, account_id, profit_manager_id, salary_staff_id, shareholder_id) VALUES
  ${ie.map(([n, o, b, u, r, d, a, pm, ss, sh]) => `(${[id(n), o, b, u, r].map(lit).join(', ')}, ${d ? 'now()' : 'NULL'}, ${[a, pm, ss, sh].map(lit).join(', ')})`).join(',\n  ')};
`;
}

const SCHEMA = `
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE ROLE ie_canonical_writer; CREATE ROLE openclaw_function_owner;
CREATE SCHEMA auth; CREATE SCHEMA app_private;
GRANT USAGE ON SCHEMA auth, app_private TO authenticated;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
-- Đúng định nghĩa auth.uid() của Supabase: đọc sub từ claim JWT của request.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text NOT NULL);
CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, user_id uuid NOT NULL,
  status text NOT NULL, valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz, revoked_at timestamptz);
CREATE TABLE public.permission_definitions(key text PRIMARY KEY, permission_domain text NOT NULL DEFAULT 'TENANT', is_active boolean NOT NULL,
  scope_kinds text[] NOT NULL, required_dimensions text[] NOT NULL, requires_cashbook_possession boolean NOT NULL, accepted_possession_kinds text[] NOT NULL);
CREATE TABLE app_private.tenant_emergency_denies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, permission_key text,
  active_from timestamptz NOT NULL, expires_at timestamptz);
CREATE TABLE public.organization_roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, name text NOT NULL, status text);
CREATE TABLE public.role_permissions(organization_id uuid, role_id uuid, permission_key text, effect text NOT NULL, PRIMARY KEY (organization_id, role_id, permission_key));
CREATE TABLE public.role_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, membership_id uuid NOT NULL, role_id uuid NOT NULL,
  valid_from timestamptz, valid_to timestamptz);
CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, scope_type text NOT NULL,
  area_id uuid, building_id uuid, cashbook_id uuid);
CREATE TABLE public.role_binding_scopes(organization_id uuid NOT NULL, role_binding_id uuid NOT NULL, scope_id uuid NOT NULL);
CREATE TABLE public.member_permission_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, membership_id uuid NOT NULL,
  permission_key text NOT NULL, effect text NOT NULL, expires_at timestamptz, revoked_at timestamptz);
CREATE TABLE public.member_override_scopes(organization_id uuid NOT NULL, override_id uuid NOT NULL, scope_id uuid NOT NULL);
CREATE TABLE public.area_buildings(organization_id uuid, area_id uuid, building_id uuid);
CREATE TABLE public.cashbook_possession_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, membership_id uuid NOT NULL,
  cashbook_id uuid NOT NULL, possession_kind text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz);
CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, deleted_at timestamptz);
CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, auth_user_id uuid, deleted_at timestamptz);
CREATE TABLE public.shareholders(id uuid PRIMARY KEY, auth_user_id uuid, deleted_at timestamptz);
CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, deleted_at timestamptz);
CREATE TABLE public.rooms(id uuid PRIMARY KEY, building_id uuid, organization_id uuid);
CREATE TABLE public.contracts(id uuid PRIMARY KEY, room_id uuid, organization_id uuid, user_id uuid);
CREATE TABLE public.customers(id uuid PRIMARY KEY, organization_id uuid, user_id uuid);
CREATE TABLE public.contract_customers(id uuid PRIMARY KEY, contract_id uuid, customer_id uuid, organization_id uuid);
CREATE TABLE public.invoices(id uuid PRIMARY KEY, building_id uuid, organization_id uuid, user_id uuid);
CREATE TABLE public.invoice_items(id uuid PRIMARY KEY, invoice_id uuid, organization_id uuid);
CREATE TABLE public.income_expenses(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, user_id uuid, has_restricted_item boolean NOT NULL DEFAULT false,
  deleted_at timestamptz, account_id uuid, change_account_id uuid, rounding_account_id uuid, profit_manager_id uuid, salary_staff_id uuid, shareholder_id uuid);
`;

// ── Ảnh chụp theo vai ──────────────────────────────────────────────────────────────────────────────

const sortedSet = (expr: string) => `(SELECT coalesce(jsonb_agg(x ORDER BY x), '[]') FROM ${expr} x)`;
const sortedArr = (expr: string) => `(SELECT coalesce(jsonb_agg(x ORDER BY x), '[]') FROM unnest(${expr}) x)`;
const BUILDING_ARGS = `ARRAY[${[...BUILDINGS.map(b => lit(b[0])), lit(id(999))].join(', ')}]::uuid[] || ARRAY[NULL::uuid]`;
const CASHBOOK_ARGS = `ARRAY[${[ACC_MANAGER, ACC_POSSESSED, ACC_B].map(lit).join(', ')}]::uuid[] || ARRAY[NULL::uuid]`;
const KEY_ARGS = `ARRAY[${KEYS.map(lit).join(', ')}]`;
const ORG_ARGS = `ARRAY[${ORGS.map(lit).join(', ')}]::uuid[]`;
const scope = (call: string) => `(SELECT jsonb_build_object('org_wide', s.org_wide, 'b', ${sortedArr('s.building_ids')}, 'c', ${sortedArr('s.cashbook_ids')}) FROM ${call} s)`;

const SNAPSHOT = `SELECT jsonb_build_object(
  ${TABLES.map(t => `'tbl:${t}', (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]') FROM public.${t})`).join(',\n  ')},
  'join:contract_room_building', (SELECT coalesce(jsonb_agg(c.id ORDER BY c.id), '[]') FROM public.contracts c
     JOIN public.rooms r ON r.id = c.room_id JOIN public.buildings b ON b.id = r.building_id),
  'join:ie_restricted_building', (SELECT coalesce(jsonb_agg(ie.id ORDER BY ie.id), '[]') FROM public.income_expenses ie
     JOIN public.buildings b ON b.id = ie.building_id WHERE ie.has_restricted_item),
  'is_super_admin', public.is_super_admin(), 'is_admin', public.is_admin(), 'has_full_building_scope', public.has_full_building_scope(),
  'my_org_ids', ${sortedArr('public.my_org_ids()')}, 'demo_user_ids', ${sortedArr('public.demo_user_ids()')},
  'demo_building_ids', ${sortedArr('public.demo_building_ids()')}, 'sandbox_org_ids', ${sortedArr('public.sandbox_org_ids()')},
  'current_visible_owner_ids', ${sortedArr('public.current_visible_owner_ids()')},
  'accessible_building_ids', ${sortedSet('public.accessible_building_ids()')},
  'accessible_room_ids', ${sortedSet('public.accessible_room_ids()')},
  'accessible_contract_ids', ${sortedSet('public.accessible_contract_ids()')},
  'accessible_invoice_ids', ${sortedSet('public.accessible_invoice_ids()')},
  'accessible_account_ids', ${sortedSet('public.accessible_account_ids()')},
  'my_possessed_cashbook_ids_v1', ${sortedSet('app_private.my_possessed_cashbook_ids_v1()')},
  'can_view_restricted_ie', public.can_view_restricted_ie(),
  'can_access_org_entity', (SELECT jsonb_object_agg(r || '.' || a, public.can_access_org_entity(r, a))
     FROM unnest(ARRAY['customers', 'buildings', 'income_expenses', 'cashbooks']) r CROSS JOIN unnest(ARRAY['view', 'restricted_view', 'post']) a),
  'can_access_building', (SELECT jsonb_agg(public.can_access_building(b) ORDER BY b NULLS LAST) FROM unnest(${BUILDING_ARGS}) b),
  'buildings_for_v3', (SELECT jsonb_object_agg(k, ${sortedArr('app_private.buildings_for_v3(k)')}) FROM unnest(${KEY_ARGS}) k),
  'has_any_scope_v3', (SELECT jsonb_object_agg(k, app_private.has_any_scope_v3(k)) FROM unnest(${KEY_ARGS}) k),
  'authorized_scope_all_v3', (SELECT jsonb_object_agg(k, ${scope('app_private.authorized_scope_all_v3(k)')}) FROM unnest(${KEY_ARGS}) k),
  'authorized_scope_v3', (SELECT jsonb_object_agg(k || '@' || o, ${scope('app_private.authorized_scope_v3(k, o)')})
     FROM unnest(${KEY_ARGS}) k CROSS JOIN unnest(${ORG_ARGS}) o),
  'can_v3', (SELECT jsonb_agg(app_private.can_v3(k, b, c) ORDER BY k, b NULLS LAST, c NULLS LAST)
     FROM unnest(${KEY_ARGS}) k, LATERAL (SELECT b, NULL::uuid AS c FROM unnest(${BUILDING_ARGS}) b
       UNION ALL SELECT NULL, c FROM unnest(${CASHBOOK_ARGS}) c WHERE c IS NOT NULL
       UNION ALL SELECT '${BA1}', '${ACC_POSSESSED}') bc),
  'can_v3_default_args', (SELECT jsonb_object_agg(k, app_private.can_v3(k)) FROM unnest(${KEY_ARGS}) k),
  'scope_covers_v3', (SELECT jsonb_agg(app_private.scope_covers_v3(t, '${BA1}', '${ACC_POSSESSED}', '${AREA_A}', o, tb, tc) ORDER BY t, o, tb NULLS LAST, tc NULLS LAST)
     FROM unnest(ARRAY['ORGANIZATION', 'BUILDING', 'CASHBOOK', 'AREA', 'OTHER']) t CROSS JOIN unnest(ARRAY['${ORG_A}', '${ORG_B}']::uuid[]) o
     CROSS JOIN unnest(ARRAY['${BA1}', '${BA2}', NULL]::uuid[]) tb CROSS JOIN unnest(ARRAY['${ACC_POSSESSED}', NULL]::uuid[]) tc)
) AS snap`;

type Snapshot = Record<string, unknown>;
const db = new PGlite();
const before = new Map<string, Snapshot>();

async function snapshotAs(uid: string | null): Promise<Snapshot> {
  await db.exec('SET LOCAL ROLE authenticated');
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : '']);
  const res = await db.query<{ snap: Snapshot }>(SNAPSHOT);
  await db.exec('RESET ROLE');
  return res.rows[0].snap;
}

/** Thân migration không có BEGIN/COMMIT để chạy trong transaction của ca (DDL Postgres là giao dịch). */
function body(sql: string, { keepPostCheck = true } = {}): string {
  expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
  expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  let out = sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  if (!keepPostCheck) {
    const start = out.indexOf('DO $hau_kiem$');
    const end = out.indexOf('$hau_kiem$;', start);
    expect(start).toBeGreaterThan(0);
    out = out.slice(0, start) + out.slice(end + '$hau_kiem$;'.length);
  }
  return out;
}

async function inTransaction<T>(run: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await run();
  } finally {
    await db.exec('ROLLBACK');
  }
}

beforeAll(async () => {
  const live = liveDefinitionsBefore(MIGRATION);
  const fnSql: string[] = [];
  for (const name of [...UNCHANGED_FUNCTIONS, ...CHANGED_FUNCTIONS]) {
    const def = live.functions.get(name);
    if (!def) throw new Error(`Không tìm thấy định nghĩa sống của ${name}`);
    if (def.signatures.size !== 1) throw new Error(`${name} có overload — test chưa mô phỏng: ${[...def.signatures].join(' | ')}`);
    fnSql.push(def.sql);
  }
  const policySql = [...live.policies.values()]
    .filter((p): p is { table: string; sql: string } => !!p && TABLES.includes(p.table))
    .filter(p => /\bFOR\s+(SELECT|ALL)\b/i.test(p.sql) || !/\bFOR\s+(INSERT|UPDATE|DELETE)\b/i.test(p.sql))
    .map(p => p.sql);
  await db.exec(SCHEMA);
  await db.exec(fnSql.join('\n'));
  await db.exec(TABLES.map(t => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY; GRANT SELECT ON public.${t} TO authenticated;`).join('\n'));
  await db.exec(policySql.join('\n'));
  await db.exec(seedSql());
  for (const [role, uid] of ROLES) before.set(role, await inTransaction(() => snapshotAs(uid)));
}, 120_000);

afterAll(() => db.close());

const visible = (snap: Snapshot | undefined, key: string) => snap?.[key] as string[];

describe('dữ liệu TRƯỚC không rỗng và phân biệt được vai (chống xanh rỗng)', () => {
  it('nạp đúng định nghĩa sống: hàm còn LANGUAGE sql, policy restricted chưa bọc InitPlan', async () => {
    const res = await db.query<{ lang: string; n: number }>(`
      SELECT l.lanname AS lang, count(*)::int AS n FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = ANY (ARRAY[${CHANGED_FUNCTIONS.map(f => `'${f}'::regproc`).join(', ')}]::oid[]) GROUP BY 1`);
    expect(res.rows).toEqual([{ lang: 'sql', n: CHANGED_FUNCTIONS.length }]);
    const pol = await db.query<{ q: string }>(`SELECT pg_get_expr(polqual, polrelid) AS q FROM pg_policy WHERE polname = 'income_expenses_restricted_select'`);
    expect(pol.rows[0].q).toContain('can_view_restricted_ie()');
    expect(pol.rows[0].q).not.toContain('SELECT');
  });

  it('các vai nhìn thấy tập toà khác nhau đúng luật', () => {
    expect(visible(before.get('owner'), 'tbl:buildings')).toEqual([BA1, BA2, BA3, BA5]);
    expect(visible(before.get('manager'), 'accessible_building_ids')).toEqual([BA1, BA2]);
    expect(visible(before.get('scopedDeny'), 'accessible_building_ids')).toEqual([BA1, BA3, BA5]);
    expect(visible(before.get('superAdmin'), 'accessible_building_ids')).toEqual([BA1, BA2, BA3]);
    expect(visible(before.get('superSandbox'), 'accessible_building_ids')).toEqual([]);
    expect(visible(before.get('superAdmin'), 'tbl:buildings')).toEqual([BA1, BA2, BA3, BA4, BB1, BB2, BC1, BX1]);
    // Hành vi HIỆN HÀNH (giữ nguyên): org_wide ở MỘT công ty ⇒ buildings_for_v3 trả mọi toà của MỌI công ty trong
    // my_org_ids(), kể cả công ty chỉ có quyền một toà (A: BA2) và công ty membership đã hết hạn/bị cấm khẩn cấp (C).
    expect(visible(before.get('multi'), 'accessible_building_ids')).toEqual([BA1, BA2, BA3, BA5, BB1, BB2, BC1]);
    for (const r of ['revoked', 'suspended', 'roleExpired', 'emergency', 'suspendedOrg', 'orgDenied', 'retiredRole', 'outsider', 'khong_uid']) {
      expect(visible(before.get(r), 'accessible_building_ids'), r).toEqual([]);
    }
    expect(visible(before.get('sandboxOwner'), 'tbl:buildings')).toEqual([BS1]);
    expect((before.get('revoked')?.can_access_building as boolean[]).filter(Boolean).length).toBeGreaterThan(0);
  });

  it('phiếu hạn chế, quỹ, quản lý lợi nhuận, cổ đông và khách hàng đều có dòng', () => {
    expect(visible(before.get('owner'), 'tbl:income_expenses')).toContain(id(501));
    expect(visible(before.get('manager'), 'tbl:income_expenses')).toContain(id(501));
    expect(visible(before.get('manager'), 'tbl:income_expenses')).not.toContain(id(502));
    expect(visible(before.get('fund'), 'tbl:income_expenses')).toEqual([id(505)]);
    expect(visible(before.get('profitManager'), 'tbl:income_expenses')).toEqual([id(507)]);
    expect(visible(before.get('shareholder'), 'tbl:income_expenses')).toEqual([id(509)]);
    expect(visible(before.get('salary'), 'tbl:income_expenses')).toEqual([id(508)]);
    expect(visible(before.get('owner'), 'tbl:customers').length).toBeGreaterThan(3);
    expect(visible(before.get('owner'), 'tbl:customers')).not.toContain(id(304));
    for (const t of TABLES) expect(visible(before.get('owner'), `tbl:${t}`).length, t).toBeGreaterThan(0);
  });
});

describe('SAU migration = TRƯỚC, từng vai', () => {
  it.each(ROLES)('%s', { timeout: 60_000 }, async (role) => {
    const uid = ROLES.find(r => r[0] === role)?.[1] ?? null;
    await inTransaction(async () => {
      await db.exec(body(MIGRATION_SQL));
      const first = await snapshotAs(uid);
      const warm = await snapshotAs(uid);
      await db.exec('SET LOCAL plan_cache_mode = force_generic_plan');
      const generic = await snapshotAs(uid);
      expect(first).toEqual(before.get(role));
      expect(warm).toEqual(before.get(role));
      expect(generic).toEqual(before.get(role));
    });
  });

  it('migration chạy hai lượt trong một transaction vẫn đạt và giữ nguyên kết quả', { timeout: 60_000 }, async () => {
    await inTransaction(async () => {
      await db.exec(body(MIGRATION_SQL));
      await db.exec(body(MIGRATION_SQL));
      const lang = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
         WHERE l.lanname = 'plpgsql' AND p.oid = ANY (ARRAY[${CHANGED_FUNCTIONS.map(f => `'${f}'::regproc`).join(', ')}]::oid[])`);
      expect(lang.rows[0].n).toBe(CHANGED_FUNCTIONS.length);
      for (const r of ['owner', 'superAdmin', 'revoked'] as const) expect(await snapshotAs(U[r])).toEqual(before.get(r));
    });
  });

  it('sandbox_org_ids() IMMUTABLE được planner gập thành literal trong policy', async () => {
    await inTransaction(async () => {
      await db.exec(body(MIGRATION_SQL));
      const plan = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) SELECT id FROM public.contracts WHERE organization_id = ANY (public.sandbox_org_ids())`);
      expect(plan.rows.map(r => r['QUERY PLAN']).join('\n')).toContain(`'{${SANDBOX}}'::uuid[]`);
    });
  });

  it('chốt kiểm dừng migration khi policy hiện hành lệch bản đã review', async () => {
    await inTransaction(async () => {
      await db.exec(`ALTER POLICY income_expenses_restricted_select ON public.income_expenses USING (has_restricted_item = false)`);
      await expect(db.exec(body(MIGRATION_SQL))).rejects.toThrow(/lệch bản đã review/);
    });
  });
});

// Mỗi đột biến mô phỏng một lỗi có thật khi viết lại hàm quyền; bỏ hậu kiểm để chính phép so tập dòng bắt.
const MUTANTS: Array<[string, string, string]> = [
  ['chép thân authorized_scope_v3 từ baseline (mất revoked_at)', '         and m.revoked_at is null\n', ''],
  ['đảo điều kiện ẩn org sandbox khỏi super admin', 'and not ((select public.is_super_admin())\n', 'and ((select public.is_super_admin())\n'],
  ['so chủ toà với nhầm mảng demo', 'b.user_id = any((select public.demo_user_ids())::uuid[])', 'b.user_id = any((select public.demo_building_ids())::uuid[])'],
  ['hoist nhầm hàm trong nhánh org-wide', 'b.organization_id = any((select public.my_org_ids())::uuid[])', 'b.organization_id = any((select public.demo_user_ids())::uuid[])'],
  ['bỏ lọc thành viên ACTIVE khi hoist current_visible_owner_ids', "    where m.status = 'ACTIVE'\n      and m.organization_id = any ((select public.my_org_ids())::uuid[])",
    "    where m.organization_id = any ((select public.my_org_ids())::uuid[])"],
  ['bọc InitPlan nhưng làm rơi nhánh can_view_restricted_ie', '    OR (SELECT public.can_view_restricted_ie())\n', ''],
  ['can_access_building hỏi nhầm quyền', "app_private.can_v3('buildings.view', _building_id)", "app_private.can_v3('customers.view', _building_id)"],
  ['gộp org_wide bằng bool_and', 'bool_or(p.org_wide)', 'bool_and(p.org_wide)'],
  ['RETURN QUERY của accessible_room_ids trả nhầm cột', 'SELECT r.id FROM public.rooms r\n', 'SELECT r.building_id FROM public.rooms r\n'],
];

describe('đột biến migration phải bị bắt', () => {
  it.each(MUTANTS)('%s', { timeout: 120_000 }, async (_name, find, replace) => {
    expect(MIGRATION_SQL.split(find)).toHaveLength(2);
    const mutated = MIGRATION_SQL.replace(find, replace);
    const diffs = await inTransaction(async () => {
      await db.exec(body(mutated, { keepPostCheck: false }));
      // Dừng ở vai đầu tiên bị lệch: đủ chứng minh đột biến chết, không cần chụp cả 22 vai.
      for (const [role, uid] of ROLES) {
        const snap = await snapshotAs(uid);
        const prev = before.get(role) ?? {};
        const lech = Object.keys(prev).filter(k => JSON.stringify(prev[k]) !== JSON.stringify(snap[k]));
        if (lech.length) return lech.map(k => `${role}:${k}`);
      }
      return [];
    });
    expect(diffs.length, 'đột biến sống sót').toBeGreaterThan(0);
  });
});
