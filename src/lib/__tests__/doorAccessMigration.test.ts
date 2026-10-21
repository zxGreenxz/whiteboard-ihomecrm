import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Cửa vân tay SmartLife/Tuya (chủ chốt 21/10/2026): bảng + RPC của migration chạy trên khung tối thiểu
// của các bảng/hàm quyền có sẵn ở production. Chạy migration HAI lượt để kiểm idempotent.
const migrationSql = readFileSync('supabase/migrations/20261021072938_cua_van_tay_tuya.sql', 'utf8');

const org = '00000000-0000-4000-8000-0000000000a1';
const otherOrg = '00000000-0000-4000-8000-0000000000b1';
const ownerRole = '00000000-0000-4000-8000-0000000000a0';
const companyOwnerRole = '00000000-0000-4000-8000-0000000000ac';
const owner = '00000000-0000-4000-8000-0000000000a2';
const manager = '00000000-0000-4000-8000-0000000000a3';
const stranger = '00000000-0000-4000-8000-0000000000a4';
const bA = '00000000-0000-4000-8000-0000000000a5';
const bB = '00000000-0000-4000-8000-0000000000a6';
const bX = '00000000-0000-4000-8000-0000000000b5';
const rA1 = '00000000-0000-4000-8000-0000000000a7';
const rA2 = '00000000-0000-4000-8000-0000000000a8';
const rB1 = '00000000-0000-4000-8000-0000000000a9';
const c1 = '00000000-0000-4000-8000-0000000000c1';
const c2 = '00000000-0000-4000-8000-0000000000c2';
const c3 = '00000000-0000-4000-8000-0000000000c3';
const c4 = '00000000-0000-4000-8000-0000000000c4';
const cX = '00000000-0000-4000-8000-0000000000cf';
const db = new PGlite();
type Row = Record<string, unknown>;

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${owner}'),('${manager}'),('${stranger}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(coalesce(nullif(current_setting('test.actor',true),''),'${owner}'),'none')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}'),('${otherOrg}');
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text);INSERT INTO profiles VALUES('${owner}','Chủ A'),('${manager}','Quản lý B');
    CREATE TABLE permission_definitions(key text PRIMARY KEY,resource text,action text,sensitivity text,permission_domain text,scope_kinds text[],
      is_active boolean,scope_match_mode text,requires_cashbook_possession boolean,accepted_possession_kinds text[],required_dimensions text[]);
    CREATE TABLE organization_roles(id uuid PRIMARY KEY,organization_id uuid,name text,system_key text);
    INSERT INTO organization_roles VALUES('${ownerRole}','${org}','Chủ sở hữu tổ chức','TENANT_OWNER'),
      ('00000000-0000-4000-8000-0000000000aa','${org}','Sale',NULL),
      ('${companyOwnerRole}','${org}','Chủ công ty',NULL),
      ('00000000-0000-4000-8000-0000000000ab','${otherOrg}','Chủ công ty','TENANT_OWNER');
    CREATE TABLE role_permissions(organization_id uuid,role_id uuid,permission_key text REFERENCES permission_definitions(key),effect text,
      UNIQUE(organization_id,role_id,permission_key));
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);
    CREATE UNIQUE INDEX buildings_org_id_uidx ON buildings(organization_id,id);
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,fingerprint_code text,deleted_at timestamptz);
    CREATE UNIQUE INDEX customers_org_id_uidx ON customers(organization_id,id);
    CREATE TABLE contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,status text,start_date date,
      end_date date,actual_end_date date,deleted_at timestamptz);
    CREATE TABLE contract_customers(contract_id uuid,customer_id uuid,is_representative boolean NOT NULL DEFAULT false);
    -- Quyền giả lập: người lạ không thuộc công ty nào; test.deny_keys = khoá bị từ chối mọi tòa;
    -- test.deny_pairs = "khoá@tòa" bị từ chối riêng một tòa.
    CREATE FUNCTION my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN auth.uid()='${stranger}' OR auth.uid() IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY['${org}'::uuid] END $$;
    CREATE FUNCTION can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM buildings b WHERE b.id=$1 AND b.organization_id=ANY(my_org_ids())) $$;
    CREATE FUNCTION app_private.can_v3(text,uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT can_access_building($2) AND EXISTS(SELECT 1 FROM permission_definitions WHERE key=$1 AND is_active)
        AND NOT ($1 = ANY(string_to_array(coalesce(current_setting('test.deny_keys',true),''),',')))
        AND NOT (($1||'@'||$2::text) = ANY(string_to_array(coalesce(current_setting('test.deny_pairs',true),''),','))) $$;
    CREATE TABLE lock_calls(org uuid);
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO lock_calls VALUES($1) RETURNING 1::bigint $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
      SELECT $2=ANY(my_org_ids()) AND EXISTS(SELECT 1 FROM lock_calls WHERE org=$2) AND app_private.can_v3($3,$4,$5) $$;
    GRANT USAGE ON SCHEMA public,app_private,auth TO anon,authenticated,service_role;
  `);
  await db.exec(migrationSql);
  await db.exec(migrationSql);
}, 30000);

beforeEach(async () => {
  await db.exec(`RESET ROLE;SELECT set_config('test.actor','',false);SELECT set_config('test.deny_keys','',false);
    SELECT set_config('test.deny_pairs','',false);
    DELETE FROM lock_calls;DELETE FROM door_action_logs;DELETE FROM door_key_links;DELETE FROM door_devices;
    DELETE FROM contract_customers;DELETE FROM contracts;DELETE FROM customers;DELETE FROM rooms;DELETE FROM buildings;
    INSERT INTO buildings VALUES('${bA}','${org}','Tòa A',NULL),('${bB}','${org}','Tòa B',NULL),('${bX}','${otherOrg}','Tòa X',NULL);
    INSERT INTO rooms VALUES('${rA1}','${org}','${bA}','101',NULL),('${rA2}','${org}','${bA}','102',NULL),('${rB1}','${org}','${bB}','201',NULL);
    INSERT INTO customers VALUES('${c1}','${org}','Khách Đang Ở',NULL,NULL),('${c2}','${org}','Khách Đã Đi',NULL,NULL),
      ('${c3}','${org}','Khách Chưa Ký',NULL,NULL),('${c4}','${org}','Khách Tòa B',NULL,NULL),('${cX}','${otherOrg}','Khách Công Ty Khác',NULL,NULL);
    INSERT INTO contracts(id,organization_id,room_id,status,start_date,end_date,actual_end_date) VALUES
      ('00000000-0000-4000-8000-0000000000d1','${org}','${rA1}','ACTIVE','2026-01-01','2027-01-01',NULL),
      ('00000000-0000-4000-8000-0000000000d2','${org}','${rA2}','TERMINATED','2025-06-01','2026-12-01','2026-10-01'),
      ('00000000-0000-4000-8000-0000000000d3','${org}','${rB1}','ACTIVE','2026-02-01','2027-02-01',NULL);
    INSERT INTO contract_customers VALUES('00000000-0000-4000-8000-0000000000d1','${c1}',true),
      ('00000000-0000-4000-8000-0000000000d2','${c2}',true),('00000000-0000-4000-8000-0000000000d3','${c4}',true);
  `);
});
afterAll(async () => { await db.close(); });

async function as(user: string) { await db.query("SELECT set_config('test.actor',$1,false)", [user]); }
async function setting(name: string, value: string) { await db.query('SELECT set_config($1,$2,false)', [name, value]); }
async function deny(fn: () => Promise<unknown>, code: string) {
  await expect(fn()).rejects.toMatchObject({ code });
}
async function one<T = Row>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<{ r: T }>(sql, params)).rows[0].r;
}
async function save(tuyaId = 'dev123abc', building = bA, name = 'Cổng tòa A', extra: { kind?: string; channel?: number; len?: number } = {}) {
  return one(`SELECT door_access_save_device_v1($1,$2,$3,$4,$5,'mk','Access control',$6,$7) r`,
    [org, tuyaId, building, name, extra.kind ?? 'access_control', extra.channel ?? 1, extra.len ?? 7]);
}
async function link(device: unknown, sn: number, customer: string | null, label: string | null = null, type = 'fingerprint', tuyaUser: string | null = 'u1') {
  return one(`SELECT door_access_link_key_v1($1,$2,$3,$4,$5,'Tên trên máy',$6,$7) r`, [org, device, type, sn, tuyaUser, customer, label]);
}
async function code(customer: string) {
  return (await db.query<{ c: string | null }>('SELECT fingerprint_code c FROM customers WHERE id=$1', [customer])).rows[0].c;
}
async function begin(device: unknown, action: string, detail: unknown = {}) {
  return one(`SELECT door_access_begin_action_v1($1,$2,$3,$4::jsonb) r`, [org, device, action, JSON.stringify(detail)]);
}
async function finish(logId: unknown, status: string, passwordId: number | null = null, errorCode: string | null = null) {
  await db.exec('SET ROLE service_role');
  try {
    return await one(`SELECT door_access_finish_action_v1($1,$2,$3,$4,'msg') r`, [logId, status, passwordId, errorCode]);
  } finally { await db.exec('RESET ROLE'); }
}
const nowSec = () => Math.floor(Date.now() / 1000);

describe('quyền và ACL', () => {
  it('thêm bốn khoá theo tòa, chỉ vai chủ công ty (TENANT_OWNER hoặc vai tự tạo "Chủ công ty") có sẵn, chạy lại không nhân đôi', async () => {
    const keys = (await db.query<Row>(`SELECT key,sensitivity,required_dimensions FROM permission_definitions ORDER BY key`)).rows;
    expect(keys).toEqual([
      { key: 'door_access.manage_devices', sensitivity: 'MANAGE', required_dimensions: ['BUILDING'] },
      { key: 'door_access.remote_unlock', sensitivity: 'ELEVATED', required_dimensions: ['BUILDING'] },
      { key: 'door_access.temp_password', sensitivity: 'ELEVATED', required_dimensions: ['BUILDING'] },
      { key: 'door_access.view', sensitivity: 'VIEW', required_dimensions: ['BUILDING'] },
    ]);
    const grants = (await db.query<Row>(`SELECT r.name,r.organization_id,count(*)::int n FROM role_permissions rp
      JOIN organization_roles r ON r.id=rp.role_id GROUP BY 1,2 ORDER BY 1,2`)).rows;
    expect(grants).toEqual([
      { name: 'Chủ công ty', organization_id: org, n: 4 },
      { name: 'Chủ công ty', organization_id: otherOrg, n: 4 },
      { name: 'Chủ sở hữu tổ chức', organization_id: org, n: 4 },
    ]);
  });

  it('trình duyệt không đọc bảng, không chốt nhật ký; chỉ service_role chốt', async () => {
    const acl = (await db.query<Row>(`SELECT
      has_table_privilege('authenticated','door_devices','SELECT') t1,
      has_table_privilege('authenticated','door_action_logs','INSERT') t2,
      has_table_privilege('service_role','door_key_links','SELECT') t3,
      has_function_privilege('anon','door_access_devices_v1(uuid,boolean)','EXECUTE') f1,
      has_function_privilege('authenticated','door_access_begin_action_v1(uuid,uuid,text,jsonb)','EXECUTE') f2,
      has_function_privilege('authenticated','door_access_finish_action_v1(uuid,text,bigint,text,text)','EXECUTE') f3,
      has_function_privilege('service_role','door_access_finish_action_v1(uuid,text,bigint,text,text)','EXECUTE') f4,
      has_function_privilege('authenticated','app_private.door_sync_fingerprint_codes_v1(uuid[])','EXECUTE') f5,
      has_function_privilege('authenticated','app_private.door_access_manage_all_v1(uuid)','EXECUTE') f6,
      has_function_privilege('authenticated','door_access_can_manage_org_v1(uuid)','EXECUTE') f7,
      to_regprocedure('door_access_can_any_v1(uuid,text)') IS NULL g1,
      to_regprocedure('app_private.door_sync_fingerprint_code_v1(uuid)') IS NULL g2`)).rows[0];
    expect(acl).toEqual({ t1: false, t2: false, t3: false, f1: false, f2: true, f3: false, f4: true, f5: false, f6: false, f7: true, g1: true, g2: true });
    const d = await save();
    const { log_id } = await begin(d.id, 'REMOTE_UNLOCK') as { log_id: string };
    await db.exec('SET ROLE authenticated');
    try {
      await deny(() => db.query(`SELECT door_access_finish_action_v1($1,'OK')`, [log_id]), '42501');
      await deny(() => db.query('SELECT * FROM door_action_logs'), '42501');
    } finally { await db.exec('RESET ROLE'); }
  });
});

describe('máy cửa', () => {
  it('lưu máy, trả khuôn có cờ quyền và ghi nhật ký; lưu lại dựng đúng dòng cũ', async () => {
    const d = await save();
    expect(d).toMatchObject({ building_id: bA, building_name: 'Tòa A', display_name: 'Cổng tòa A', device_kind: 'access_control',
      tuya_device_id: 'dev123abc', tuya_category: 'mk', channel_id: 1, password_length: 7, is_active: true,
      can: { view: true, temp_password: true, remote_unlock: true, manage_devices: true } });
    await one('SELECT door_access_disable_device_v1($1,$2) r', [org, d.id]);
    const again = await save('dev123abc', bA, '  Cổng chính  ', { len: 6 });
    expect(again).toMatchObject({ id: d.id, display_name: 'Cổng chính', password_length: 6, is_active: true });
    const actions = (await db.query<Row>('SELECT action,status FROM door_action_logs ORDER BY created_at')).rows;
    expect(actions).toEqual([{ action: 'DEVICE_SAVE', status: 'OK' }, { action: 'DEVICE_DISABLE', status: 'OK' }, { action: 'DEVICE_SAVE', status: 'OK' }]);
  });

  it('kiểm dữ liệu, quyền và ranh giới công ty', async () => {
    await deny(() => save('bad id!'), '22023');
    await deny(() => save('dev1', bA, ''), '22023');
    await deny(() => save('dev1', bA, 'x', { kind: 'camera' }), '22023');
    await deny(() => save('dev1', bA, 'x', { channel: 0 }), '22023');
    await deny(() => save('dev1', bA, 'x', { len: 11 }), '22023');
    await deny(() => save('dev1', bX), '42501');
    await setting('test.deny_keys', 'door_access.manage_devices');
    await deny(() => save('dev1'), '42501');
    await setting('test.deny_keys', '');
    await as(stranger);
    await deny(() => save('dev1'), '42501');
    await as(owner);
    // Máy đã thuộc công ty khác ⇒ 23505, không chiếm được.
    await db.query(`INSERT INTO door_devices(organization_id,building_id,tuya_device_id,display_name,device_kind)
      VALUES($1,$2,'devother','X','access_control')`, [otherOrg, bX]);
    await deny(() => save('devother'), '23505');
    // Người không đủ quyền gắn máy mới KHÔNG được biết máy đó thuộc công ty khác (42501, không phải 23505).
    await setting('test.deny_keys', 'door_access.manage_devices');
    await deny(() => save('devother'), '42501');
  });

  it('gắn máy MỚI cần quyền Quản lý ở MỌI tòa; sửa máy đã có chỉ cần quyền ở tòa của máy', async () => {
    const d = await save('dev1', bA);
    // Quản lý tòa A nhưng không quản lý tòa B: không gắn được máy mới (kể cả vào tòa A) — chặn chiếm máy tòa khác.
    await setting('test.deny_pairs', `door_access.manage_devices@${bB}`);
    await deny(() => save('devNewOfB', bA), '42501');
    expect((await db.query<Row>(`SELECT door_access_can_manage_org_v1($1) r`, [org])).rows[0]).toEqual({ r: false });
    // Máy đã có ở tòa A vẫn sửa được.
    expect(await save('dev1', bA, 'Cổng A mới')).toMatchObject({ id: d.id, display_name: 'Cổng A mới' });
    await setting('test.deny_pairs', '');
    expect((await db.query<Row>(`SELECT door_access_can_manage_org_v1($1) r`, [org])).rows[0]).toEqual({ r: true });
    await as(stranger);
    expect((await db.query<Row>(`SELECT door_access_can_manage_org_v1($1) r`, [org])).rows[0]).toEqual({ r: false });
  });

  it('đổi tòa cần quyền Quản lý ở cả tòa cũ', async () => {
    await save('dev1', bA);
    await setting('test.deny_pairs', `door_access.manage_devices@${bA}`);
    await deny(() => save('dev1', bB), '42501');
    await setting('test.deny_pairs', '');
    expect(await save('dev1', bB)).toMatchObject({ building_id: bB });
  });

  it('danh sách theo quyền từng tòa; máy tắt chỉ hiện với Quản lý khi xin', async () => {
    const a = await save('devA', bA, 'Máy A');
    const b = await save('devB', bB, 'Máy B');
    await one('SELECT door_access_disable_device_v1($1,$2) r', [org, b.id]);
    const list = async (inactive = false) =>
      (await one<{ devices: Row[] }>('SELECT door_access_devices_v1($1,$2) r', [org, inactive])).devices.map((d) => d.id);
    expect(await list()).toEqual([a.id]);
    expect(await list(true)).toEqual([a.id, b.id]);
    // Chỉ còn quyền mật khẩu tạm ở tòa A ⇒ vẫn thấy máy A, cờ đúng.
    await setting('test.deny_keys', 'door_access.view,door_access.remote_unlock,door_access.manage_devices');
    const only = await one<{ devices: Row[] }>('SELECT door_access_devices_v1($1,true) r', [org]);
    expect(only.devices).toMatchObject([{ id: a.id, can: { view: false, temp_password: true, remote_unlock: false, manage_devices: false } }]);
    await setting('test.deny_keys', 'door_access.view,door_access.temp_password,door_access.remote_unlock,door_access.manage_devices');
    expect(await list(true)).toEqual([]);
    await as(stranger);
    await deny(() => list(), '42501');
  });

  it('đọc được trong giao dịch READ ONLY (không khoá dòng)', async () => {
    const d = await save();
    await link(d.id, 12, c1);
    await db.exec('BEGIN READ ONLY');
    try {
      await db.query('SELECT door_access_devices_v1($1,true)', [org]);
      await db.query('SELECT door_access_key_links_v1($1,$2)', [org, d.id]);
      await db.query('SELECT door_access_building_tenants_v1($1,$2)', [org, d.id]);
      await db.query('SELECT door_access_action_logs_v1($1)', [org]);
      await db.query('SELECT door_access_can_manage_org_v1($1)', [org]);
      // Quyết định đọc của hàm Edge không khoá dòng tổ chức.
      await db.query(`SELECT door_access_authorize_v1($1,$2,'door_access.view')`, [org, d.id]);
    } finally { await db.exec('ROLLBACK'); }
  });
});

describe('gắn vân tay với khách', () => {
  it('điền Mã vân tay của khách, gắn lại thì đóng liên kết cũ, bỏ gắn thì xoá mã', async () => {
    const d = await save();
    const l1 = await link(d.id, 12, c1);
    expect(l1).toMatchObject({ unlock_type: 'fingerprint', unlock_sn: 12, customer_id: c1, customer_name: 'Khách Đang Ở',
      tenancy: 'CURRENT', room_name: '101', contract_end_date: null, linked_by_name: 'Chủ A' });
    expect(await code(c1)).toBe('12');
    await link(d.id, 3, c1);
    expect(await code(c1)).toBe('3, 12');
    // Bấm lại đúng nội dung ⇒ cùng liên kết, không thêm dòng.
    expect((await link(d.id, 12, c1)).id).toBe(l1.id);
    // Số 12 chuyển sang khách khác ⇒ liên kết cũ RELINKED, mã hai khách cập nhật.
    const l2 = await link(d.id, 12, c2);
    expect(l2.id).not.toBe(l1.id);
    expect((await db.query<Row>('SELECT unlink_reason FROM door_key_links WHERE id=$1', [l1.id])).rows[0]).toEqual({ unlink_reason: 'RELINKED' });
    expect(await code(c1)).toBe('3');
    expect(await code(c2)).toBe('12');
    // Thẻ không đụng tới mã vân tay.
    await link(d.id, 7, c1, null, 'card');
    expect(await code(c1)).toBe('3');
    const out = await one('SELECT door_access_unlink_key_v1($1,$2) r', [org, l2.id]);
    expect(out).toEqual({ id: l2.id, unlinked: true });
    expect(await code(c2)).toBeNull();
    expect(await one('SELECT door_access_unlink_key_v1($1,$2) r', [org, l2.id])).toEqual({ id: l2.id, unlinked: true });
    const unlinkLogs = (await db.query<Row>(`SELECT count(*)::int n FROM door_action_logs WHERE action='KEY_UNLINK'`)).rows[0];
    expect(unlinkLogs).toEqual({ n: 1 });
  });

  it('chỉ gắn được khách từng/đang có hợp đồng ở tòa của máy', async () => {
    const d = await save();
    await deny(() => link(d.id, 1, c4), '42501'); // khách tòa B
    await deny(() => link(d.id, 1, c3), '42501'); // chưa có hợp đồng nào
    await db.query(`INSERT INTO contracts(id,organization_id,room_id,status,start_date) VALUES('00000000-0000-4000-8000-0000000000d4',$1,$2,'DRAFT','2026-11-01')`, [org, rA2]);
    await db.query(`INSERT INTO contract_customers VALUES('00000000-0000-4000-8000-0000000000d4',$1,true)`, [c3]);
    await deny(() => link(d.id, 1, c3), '42501'); // hợp đồng nháp chưa tính
    expect(await link(d.id, 2, c2)).toMatchObject({ tenancy: 'MOVED_OUT' }); // khách đã đi vẫn gắn được để dọn
    // Hợp đồng đã thanh lý/chuyển nhượng mà quên ngày trả phòng vẫn là ĐÃ ĐI (không giữ vân tay vì thiếu một ngày).
    await db.query(`UPDATE contracts SET status='TRANSFERRED', actual_end_date=NULL WHERE id='00000000-0000-4000-8000-0000000000d2'`);
    expect((await one<{ links: Row[] }>('SELECT door_access_key_links_v1($1,$2) r', [org, d.id])).links)
      .toMatchObject([{ unlock_sn: 2, tenancy: 'MOVED_OUT' }]);
    await db.query(`UPDATE contracts SET status='TERMINATED' WHERE id='00000000-0000-4000-8000-0000000000d2'`);
    expect((await one<{ links: Row[] }>('SELECT door_access_key_links_v1($1,$2) r', [org, d.id])).links)
      .toMatchObject([{ unlock_sn: 2, tenancy: 'MOVED_OUT' }]);
  });

  it('tình trạng thuê: đang ở, đã trả phòng (cần xoá), chưa có HĐ ở tòa, nhân viên', async () => {
    const d = await save();
    await link(d.id, 1, c1);
    await link(d.id, 2, c2);
    // Khách từng có hợp đồng ở tòa A; hợp đồng sau đó bị xoá ⇒ NO_CONTRACT (kiểm lại).
    await db.query(`INSERT INTO contracts(id,organization_id,room_id,status,start_date,actual_end_date) VALUES('00000000-0000-4000-8000-0000000000d5',$1,$2,'TERMINATED','2025-01-01','2025-06-01')`, [org, rA2]);
    await db.query(`INSERT INTO contract_customers VALUES('00000000-0000-4000-8000-0000000000d5',$1,true)`, [c4]);
    await link(d.id, 3, c4);
    await db.query(`UPDATE contracts SET deleted_at=now() WHERE id='00000000-0000-4000-8000-0000000000d5'`);
    await link(d.id, 4, null, 'Bảo vệ');
    const links = (await one<{ links: Row[] }>('SELECT door_access_key_links_v1($1,$2) r', [org, d.id])).links;
    expect(links.map((l) => [l.unlock_sn, l.tenancy, l.room_name, l.contract_end_date])).toEqual([
      [1, 'CURRENT', '101', null],
      [2, 'MOVED_OUT', '102', '2026-10-01'],
      [3, 'NO_CONTRACT', null, null],
      [4, 'STAFF', null, null],
    ]);
  });

  it('kiểm dữ liệu, quyền, khách công ty khác và máy đã tắt', async () => {
    const d = await save();
    await deny(() => link(d.id, 1, c1, 'cả hai'), '22023');
    await deny(() => link(d.id, 1, null, null), '22023');
    await deny(() => link(d.id, -1, c1), '22023');
    await deny(() => link(d.id, 1, c1, null, 'face'), '22023');
    await deny(() => link(d.id, 1, c1, null, 'fingerprint', 'bad id!'), '22023');
    await deny(() => link(d.id, 1, cX), '42501');
    await setting('test.deny_keys', 'door_access.manage_devices');
    await deny(() => link(d.id, 1, c1), '42501');
    await deny(() => db.query('SELECT door_access_building_tenants_v1($1,$2)', [org, d.id]), '42501');
    await setting('test.deny_keys', 'door_access.view');
    await deny(() => db.query('SELECT door_access_key_links_v1($1,$2)', [org, d.id]), '42501');
    await setting('test.deny_keys', '');
    await one('SELECT door_access_disable_device_v1($1,$2) r', [org, d.id]);
    await deny(() => link(d.id, 1, c1), '55000');
  });

  it('danh sách khách đang ở đúng tòa của máy', async () => {
    const d = await save();
    const tenants = (await one<{ tenants: Row[] }>('SELECT door_access_building_tenants_v1($1,$2) r', [org, d.id])).tenants;
    expect(tenants).toEqual([{ customer_id: c1, full_name: 'Khách Đang Ở', room_id: rA1, room_name: '101',
      contract_id: '00000000-0000-4000-8000-0000000000d1', is_representative: true }]);
  });
});

describe('lệnh gửi xuống máy (hàm Edge)', () => {
  const tempDetail = () => ({ name: ' Xem phòng 101 ', purpose: 'XEM_PHONG', effective_sec: nowSec(), invalid_sec: nowSec() + 7200 });

  it('authorize trả ngữ cảnh máy; thiếu quyền, máy tắt, khoá lạ bị chặn', async () => {
    const d = await save('dev1', bA, 'Máy A', { channel: 2, len: 8 });
    const ctx = await one(`SELECT door_access_authorize_v1($1,$2,'door_access.view') r`, [org, d.id]);
    expect(ctx).toEqual({ device_id: d.id, tuya_device_id: 'dev1', device_kind: 'access_control', channel_id: 2,
      password_length: 8, building_id: bA, display_name: 'Máy A' });
    await deny(() => db.query(`SELECT door_access_authorize_v1($1,$2,'buildings.view')`, [org, d.id]), '22023');
    await setting('test.deny_pairs', `door_access.view@${bA}`);
    await deny(() => db.query(`SELECT door_access_authorize_v1($1,$2,'door_access.view')`, [org, d.id]), '42501');
    await setting('test.deny_pairs', '');
    await one('SELECT door_access_disable_device_v1($1,$2) r', [org, d.id]);
    await deny(() => db.query(`SELECT door_access_authorize_v1($1,$2,'door_access.view')`, [org, d.id]), '55000');
    expect((await db.query<Row>(`SELECT door_access_can_manage_org_v1($1) r`, [org])).rows[0]).toEqual({ r: true });
    await setting('test.deny_keys', 'door_access.manage_devices');
    expect((await db.query<Row>(`SELECT door_access_can_manage_org_v1($1) r`, [org])).rows[0]).toEqual({ r: false });
  });

  it('begin: quyền theo thao tác, chi tiết đúng khuôn, không bao giờ nhận mật khẩu', async () => {
    const d = await save();
    await setting('test.deny_keys', 'door_access.remote_unlock');
    await deny(() => begin(d.id, 'REMOTE_UNLOCK'), '42501');
    const ok = await begin(d.id, 'TEMP_PASSWORD_CREATE', tempDetail());
    expect(ok).toMatchObject({ device_id: d.id, tuya_device_id: 'dev123abc', password_length: 7 });
    const row = (await db.query<Row>('SELECT status,detail,actor_id FROM door_action_logs WHERE id=$1', [ok.log_id])).rows[0];
    expect(row).toMatchObject({ status: 'PENDING', actor_id: owner, detail: { name: 'Xem phòng 101', purpose: 'XEM_PHONG' } });
    await deny(() => begin(d.id, 'TEMP_PASSWORD_CREATE', { ...tempDetail(), password: '1234567' }), '22023');
    await deny(() => begin(d.id, 'TEMP_PASSWORD_CREATE', { ...tempDetail(), purpose: 'BAN' }), '22023');
    await deny(() => begin(d.id, 'TEMP_PASSWORD_CREATE', { ...tempDetail(), name: 'x'.repeat(21) }), '22023');
    await deny(() => begin(d.id, 'TEMP_PASSWORD_CREATE', { ...tempDetail(), invalid_sec: nowSec() + 8 * 86400 }), '22023');
    await deny(() => begin(d.id, 'TEMP_PASSWORD_CREATE', { ...tempDetail(), effective_sec: nowSec() - 3600 }), '22023');
    // Dài 6 ngày nhưng bắt đầu sau 2 ngày ⇒ hết hạn quá 7 ngày kể từ bây giờ ⇒ chặn.
    await deny(() => begin(d.id, 'TEMP_PASSWORD_CREATE', { ...tempDetail(), effective_sec: nowSec() + 2 * 86400, invalid_sec: nowSec() + 8 * 86400 }), '22023');
    expect(await begin(d.id, 'TEMP_PASSWORD_CREATE', { ...tempDetail(), effective_sec: nowSec() + 86400, invalid_sec: nowSec() + 7 * 86400 })).toHaveProperty('log_id');
    await deny(() => begin(d.id, 'TEMP_PASSWORD_DELETE', { password_id: 'abc' }), '22023');
    await deny(() => begin(d.id, 'KEY_DELETE', { unlock_type: 'fingerprint', unlock_sn: 3 }), '22023');
    await deny(() => begin(d.id, 'KEY_DELETE', { unlock_type: 'fingerprint', unlock_sn: 9999999999, tuya_user_id: 'u1' }), '22023');
    await deny(() => begin(d.id, 'OPEN_ALL'), '22023');
    await setting('test.deny_keys', '');
    await deny(() => begin(d.id, 'REMOTE_UNLOCK', { channel_id: 9 }), '22023');
    await as(stranger);
    await deny(() => begin(d.id, 'REMOTE_UNLOCK'), '42501');
  });

  it('trần tần suất mở cửa: 10 lần/10 phút mỗi người', async () => {
    const d = await save();
    for (let i = 0; i < 10; i++) await begin(d.id, 'REMOTE_UNLOCK');
    await deny(() => begin(d.id, 'REMOTE_UNLOCK'), '54000');
    // Người khác chưa chạm trần.
    await as(manager);
    expect(await begin(d.id, 'REMOTE_UNLOCK')).toHaveProperty('log_id');
  });

  it('finish chốt một lần: cùng kết quả thì trả lại, khác kết quả thì chặn', async () => {
    const d = await save();
    const { log_id } = await begin(d.id, 'TEMP_PASSWORD_CREATE', tempDetail()) as { log_id: string };
    expect(await finish(log_id, 'OK', 12345)).toEqual({ log_id, status: 'OK' });
    expect(await finish(log_id, 'OK', 12345)).toEqual({ log_id, status: 'OK' });
    await deny(() => finish(log_id, 'FAILED'), '55000');
    const row = (await db.query<Row>('SELECT status,tuya_password_id,error_code,finished_at IS NOT NULL done FROM door_action_logs WHERE id=$1', [log_id])).rows[0];
    expect(row).toEqual({ status: 'OK', tuya_password_id: 12345, error_code: null, done: true });
    const fail = await begin(d.id, 'REMOTE_UNLOCK') as { log_id: string };
    await finish(fail.log_id, 'UNKNOWN', null, 'timeout');
    expect((await db.query<Row>('SELECT status,error_code FROM door_action_logs WHERE id=$1', [fail.log_id])).rows[0])
      .toEqual({ status: 'UNKNOWN', error_code: 'timeout' });
    await deny(() => finish(log_id, 'MAYBE'), '22023');
    const saved = (await db.query<{ id: string }>(`SELECT id FROM door_action_logs WHERE action='DEVICE_SAVE'`)).rows[0];
    await deny(() => finish(saved.id, 'OK'), '22023');
  });

  it('xoá khoá trên máy thành công thì đóng liên kết và xoá mã vân tay', async () => {
    const d = await save();
    const l = await link(d.id, 12, c2);
    expect(await code(c2)).toBe('12');
    const failed = await begin(d.id, 'KEY_DELETE', { unlock_type: 'fingerprint', unlock_sn: 12, tuya_user_id: 'u1', user_type: 1 }) as { log_id: string };
    await finish(failed.log_id, 'FAILED', null, '1106');
    expect(await code(c2)).toBe('12');
    const ok = await begin(d.id, 'KEY_DELETE', { unlock_type: 'fingerprint', unlock_sn: 12, tuya_user_id: 'u1' }) as { log_id: string };
    await finish(ok.log_id, 'OK');
    expect((await db.query<Row>('SELECT unlink_reason,unlinked_by FROM door_key_links WHERE id=$1', [l.id])).rows[0])
      .toEqual({ unlink_reason: 'DELETED_ON_DEVICE', unlinked_by: owner });
    expect(await code(c2)).toBeNull();
  });

  it('nhật ký: lọc theo quyền tòa, theo thao tác, lật trang', async () => {
    const a = await save('devA', bA, 'Máy A');
    const b = await save('devB', bB, 'Máy B');
    for (let i = 0; i < 3; i++) await begin(a.id, 'REMOTE_UNLOCK');
    await begin(b.id, 'REMOTE_UNLOCK');
    const page1 = await one<{ logs: Row[]; has_more: boolean }>(`SELECT door_access_action_logs_v1($1,$2,ARRAY['REMOTE_UNLOCK'],2) r`, [org, a.id]);
    expect(page1.logs).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.logs[0]).toMatchObject({ device_name: 'Máy A', building_name: 'Tòa A', actor_name: 'Chủ A', status: 'PENDING' });
    const page2 = await one<{ logs: Row[]; has_more: boolean }>(`SELECT door_access_action_logs_v1($1,$2,ARRAY['REMOTE_UNLOCK'],2,$3,$4) r`,
      [org, a.id, page1.logs[1].created_at, page1.logs[1].id]);
    expect(page2.logs).toHaveLength(1);
    expect(page2.has_more).toBe(false);
    // Ba dòng cùng một mốc giờ vẫn lật đủ (khoá lật trang là cặp mốc giờ + id).
    await db.query(`UPDATE door_action_logs SET created_at='2026-10-21 10:00:00+07' WHERE door_device_id=$1`, [a.id]);
    const seen: unknown[] = [];
    let cursor: Row | null = null;
    for (let i = 0; i < 10; i++) {
      const page: { logs: Row[]; has_more: boolean } = await one(`SELECT door_access_action_logs_v1($1,$2,NULL,1,$3,$4) r`,
        [org, a.id, cursor?.created_at ?? null, cursor?.id ?? null]);
      seen.push(...page.logs.map((g) => g.id));
      cursor = page.logs[0] ?? null;
      if (!page.has_more) break;
    }
    // Máy A có 4 dòng: DEVICE_SAVE + 3 lần mở cửa — lật từng dòng một, không sót, không trùng.
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    await setting('test.deny_pairs', `door_access.view@${bA}`);
    const all = await one<{ logs: Row[] }>('SELECT door_access_action_logs_v1($1) r', [org]);
    expect(new Set(all.logs.map((g) => g.building_name))).toEqual(new Set(['Tòa B']));
  });
});
