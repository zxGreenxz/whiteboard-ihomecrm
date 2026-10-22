// Lỗ 1 (18/10/2026): network_center_list_clients_v1 trả tên/ID khách và ID hợp đồng cho người chỉ
// có network_center.view. Một PGlite cho cả file; mỗi ca BEGIN…ROLLBACK. Ca trước chạy thân sống
// 20260729145000 (lộ), ca sau chạy migration vá (chặn), đột biến chứng minh các phép kiểm cắn.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const read = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const FIX = read('20261018052307_an_khach_network_center_clients_khi_thieu_quyen.sql');
const OLD = read('20260729145000_network_center_connection_host_fix.sql');
const GUARD = read('20260729040000_network_center_rls_rpcs_realtime.sql');

function fn(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const open = sql.indexOf('$fn$', start);
  const close = sql.indexOf('$fn$;', open + 4);
  if (start < 0 || open < 0 || close < 0) throw new Error(`không thấy ${name}`);
  return sql.slice(start, close + 5);
}
const LIST = 'public.network_center_list_clients_v1';

const org = 'a0000000-0000-4000-8000-000000000001';
const building = 'b0000000-0000-4000-8000-000000000001';
const otherBuilding = 'b0000000-0000-4000-8000-000000000002';
const viewer = 'c0000000-0000-4000-8000-000000000001';
const owner = 'c0000000-0000-4000-8000-000000000002';
const outsider = 'c0000000-0000-4000-8000-000000000003';
const customer = 'd0000000-0000-4000-8000-000000000001';
const strayCustomer = 'd0000000-0000-4000-8000-000000000002';
// Hai hồ sơ dưới đây không liên kết được trên production: khoá ngoại network_client_links_customer_fk
// (organization_id, customer_id) → customers(organization_id, id) ép khách cùng công ty với liên kết.
// Fixture cố ý bỏ khoá ngoại đó để kiểm riêng lớp lọc trong hàm (phòng thủ thứ hai, như RLS web).
const legacyCustomer = 'd0000000-0000-4000-8000-000000000003'; // organization_id NULL — web vẫn cho đọc
const foreignCustomer = 'd0000000-0000-4000-8000-000000000004'; // gắn công ty khác
const otherOrg = 'a0000000-0000-4000-8000-000000000002';
const contract = 'e0000000-0000-4000-8000-000000000001';
const strayContract = 'e0000000-0000-4000-8000-000000000002';
const room = 'f0000000-0000-4000-8000-000000000001';

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text, deleted_at timestamptz, is_virtual boolean NOT NULL DEFAULT false);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY, name text);
    CREATE TABLE public.customers(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, full_name text);
    CREATE TABLE public.network_client_current(id uuid PRIMARY KEY, organization_id uuid, building_id uuid,
      client_fingerprint text, observed_at timestamptz, last_seen_at timestamptz, expires_at timestamptz,
      hostname text, observed_ip inet, observed_mac macaddr, session_type text, connection_type text,
      room_hint text, rx_bps numeric, tx_bps numeric, randomized_mac boolean, session_key text);
    CREATE TABLE public.network_client_links(id uuid PRIMARY KEY, organization_id uuid, building_id uuid,
      client_fingerprint text, valid_from timestamptz, valid_to timestamptz, confidence numeric,
      room_id uuid, contract_id uuid, customer_id uuid);
    -- Quyền giả: 'khoá@toà' trong test.grants; chủ hồ sơ hợp lệ trong test.owners.
    CREATE FUNCTION public.can_do_on_building(text, text, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT ($1 || '.' || $2 || '@' || $3::text) = ANY (string_to_array(coalesce(current_setting('test.grants', true), ''), ',')) $$;
    CREATE FUNCTION public.current_visible_owner_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT coalesce(string_to_array(nullif(current_setting('test.owners', true), ''), ',')::uuid[], '{}') $$;
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated;
    INSERT INTO buildings VALUES ('${building}', '${org}', 'Toà A', null, false), ('${otherBuilding}', '${org}', 'Toà B', null, false);
    INSERT INTO rooms VALUES ('${room}', 'P101');
    INSERT INTO customers VALUES ('${customer}', '${org}', '${owner}', 'Khách Một'), ('${strayCustomer}', '${org}', '${outsider}', 'Khách Lạc'),
      ('${legacyCustomer}', null, '${owner}', 'Khách Cũ'), ('${foreignCustomer}', '${otherOrg}', '${owner}', 'Khách Công Ty Khác');
    INSERT INTO network_client_current VALUES
      ('10000000-0000-4000-8000-000000000003', '${org}', '${building}', 'fp-3', now() - interval '3 minute', now() - interval '3 minute', now() + interval '1 day',
       'phone-3', '10.0.0.13', '02:00:00:00:00:03', 'DHCP', 'WIFI', null, 1, 2, false, 's-3'),
      ('10000000-0000-4000-8000-000000000004', '${org}', '${building}', 'fp-4', now() - interval '4 minute', now() - interval '4 minute', now() + interval '1 day',
       'phone-4', '10.0.0.14', '02:00:00:00:00:04', 'DHCP', 'WIFI', null, 1, 2, false, 's-4'),
      ('10000000-0000-4000-8000-000000000001', '${org}', '${building}', 'fp-1', now() - interval '1 minute', now() - interval '1 minute', now() + interval '1 day',
       'phone-1', '10.0.0.11', '02:00:00:00:00:01', 'DHCP', 'WIFI', null, 1, 2, false, 's-1'),
      ('10000000-0000-4000-8000-000000000002', '${org}', '${building}', 'fp-2', now() - interval '2 minute', now() - interval '2 minute', now() + interval '1 day',
       'phone-2', '10.0.0.12', '02:00:00:00:00:02', 'DHCP', 'WIFI', null, 1, 2, false, 's-2');
    INSERT INTO network_client_links VALUES
      ('20000000-0000-4000-8000-000000000001', '${org}', '${building}', 'fp-1', now() - interval '1 day', null, 1, '${room}', '${contract}', '${customer}'),
      ('20000000-0000-4000-8000-000000000002', '${org}', '${building}', 'fp-2', now() - interval '1 day', null, 1, '${room}', '${strayContract}', '${strayCustomer}'),
      ('20000000-0000-4000-8000-000000000003', '${org}', '${building}', 'fp-3', now() - interval '1 day', null, 1, '${room}', null, '${legacyCustomer}'),
      ('20000000-0000-4000-8000-000000000004', '${org}', '${building}', 'fp-4', now() - interval '1 day', null, 1, '${room}', null, '${foreignCustomer}');`);
  await db.exec(fn(GUARD, 'app_private.network_center_require_view_v1'));
  await db.exec(fn(OLD, LIST));
  await db.exec(`GRANT EXECUTE ON FUNCTION ${LIST}(uuid, timestamptz, uuid, integer) TO authenticated, service_role`);
});
afterAll(async () => { await db?.close(); });

// Một ca = một giao dịch: đặt danh tính/quyền, (tuỳ) thay thân hàm, gọi như authenticated, ROLLBACK.
async function probe({ grants, owners = owner, body = null }) {
  await db.exec('BEGIN');
  try {
    if (body) await db.exec(body);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('test.grants', $2, true), set_config('test.owners', $3, true)`,
      [viewer, grants.join(','), owners]);
    await db.exec('SET LOCAL ROLE authenticated');
    const { rows } = await db.query(`SELECT ${LIST}($1) AS page`, [building]);
    return Object.fromEntries(rows[0].page.items.map((i) => [i.hostname, i]));
  } finally { await db.exec('ROLLBACK'); }
}
const NC = `network_center.view@${building}`;
const CUST = `customers.view@${building}`;

test('TRƯỚC vá: chỉ network_center.view vẫn thấy tên, customerId, contractId', async () => {
  const items = await probe({ grants: [NC] });
  expect(items['phone-1']).toMatchObject({ customerName: 'Khách Một', customerId: customer, contractId: contract });
  expect(items['phone-2']).toMatchObject({ customerName: 'Khách Lạc', customerId: strayCustomer });
});

test('migration vá chạy hai lượt (idempotent) và giữ chữ ký/ACL chỉ authenticated', async () => {
  await db.exec(FIX);
  await db.exec(FIX);
  const { rows } = await db.query(`SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, p.prosecdef, p.provolatile
    FROM pg_proc p WHERE p.oid = to_regprocedure('${LIST}(uuid,timestamp with time zone,uuid,integer)')`);
  expect(rows[0]).toEqual({ anon: false, service: false, auth: true, prosecdef: true, provolatile: 's' });
});

const blocked = async (body) => {
  const items = await probe({ grants: [NC], body });
  return items['phone-1'].customerName === null && items['phone-1'].customerId === null && items['phone-1'].contractId === null
    && items['phone-2'].customerName === null && items['phone-2'].customerId === null && items['phone-2'].contractId === null
    && items['phone-3'].customerName === null && items['phone-3'].customerId === null
    && items['phone-1'].roomHint === 'P101' && items['phone-1'].roomId === room;
};
const scoped = async (body) => {
  const items = await probe({ grants: [NC, CUST], body });
  const other = await probe({ grants: [NC, `customers.view@${otherBuilding}`], body });
  return items['phone-1'].customerName === 'Khách Một' && items['phone-1'].customerId === customer && items['phone-1'].contractId === contract
    // Chủ hồ sơ không thuộc công ty người gọi: ẩn tên/ID khách, vẫn thấy hợp đồng ở toà mình có quyền.
    && items['phone-2'].customerName === null && items['phone-2'].customerId === null && items['phone-2'].contractId === strayContract
    // Hồ sơ chưa gắn công ty (NULL) vẫn đọc được như customers_org_boundary của web; hồ sơ gắn công ty khác thì không.
    && items['phone-3'].customerName === 'Khách Cũ' && items['phone-3'].customerId === legacyCustomer
    && items['phone-4'].customerName === null && items['phone-4'].customerId === null
    // customers.view ở toà KHÁC không mở toà này.
    && other['phone-1'].customerName === null && other['phone-1'].contractId === null;
};

test('SAU vá: thiếu customers.view ở toà ⇒ ba trường khách null, phòng vẫn hiện', async () => {
  expect(await blocked()).toBe(true);
});

test('SAU vá: customers.view đúng toà + chủ hồ sơ hợp lệ mới thấy khách', async () => {
  expect(await scoped()).toBe(true);
});

test('chưa đăng nhập hoặc thiếu network_center.view vẫn bị chặn 42501', async () => {
  await db.exec('BEGIN');
  try {
    await db.exec(`SELECT set_config('test.grants', '${CUST}', true); SET LOCAL ROLE authenticated`);
    await expect(db.query(`SELECT ${LIST}($1)`, [building])).rejects.toThrow(/Network Center view permission/);
  } finally { await db.exec('ROLLBACK'); }
  await expect(probe({ grants: [CUST] })).rejects.toThrow(/Network Center view permission/);
});

test('đột biến: bỏ từng vế của cửa thì phép kiểm phải đỏ', async () => {
  const body = fn(FIX, LIST);
  const mutants = {
    'bỏ customers.view': body.replace("COALESCE(public.can_do_on_building('customers', 'view', p_building_id), false)", 'true'),
    'bỏ chủ hồ sơ': body.replace('AND customer.user_id = ANY (v_owners)', ''),
    'bỏ neo công ty': body.replace('AND (customer.organization_id IS NULL OR customer.organization_id = v_scope.organization_id)', ''),
    'bỏ nhận hồ sơ NULL công ty': body.replace('customer.organization_id IS NULL OR ', ''),
    'bỏ cửa hợp đồng': body.replace('CASE WHEN v_show_customer THEN link.contract_id END', 'link.contract_id'),
    'khoá sai toà': body.replace("'customers', 'view', p_building_id", `'customers', 'view', '${otherBuilding}'::uuid`),
  };
  for (const [label, mutant] of Object.entries(mutants)) {
    expect(mutant, label).not.toBe(body);
    expect((await blocked(mutant)) && (await scoped(mutant)), label).toBe(false);
  }
});
