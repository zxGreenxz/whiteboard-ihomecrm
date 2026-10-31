import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

// 31/10/2026: vai tự tạo "Chủ công ty" (system_key NULL) là nguồn quyền hằng ngày của chủ thật nhưng thiếu sale_phong.lock_room
// (20261010114500 chỉ cấp cho TENANT_OWNER / "Chủ sở hữu tổ chức") ⇒ Hermes báo forbidden cho contract.room_lock / room_unlock.
// Migration cấp đúng khoá đó cho đúng vai đó; mọi dòng/vai khác giữ nguyên, chạy lại không đổi gì.
const sql = readFileSync('supabase/migrations/20261031041018_chu_cong_ty_quyen_lock_tam_phong.sql', 'utf8');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IHOME = 'aaaa0000-0000-4000-8000-000000000001', DEMO = id(2), OTHER = id(3), RETIRED_ORG = id(4);
const ROLE = { chu: id(11), owner: id(12), manager: id(13), demo: id(21), deny: id(31), retired: id(41) };
type Row = { organization_id: string; role_id: string; permission_key: string; effect: string };
// Dựng PGlite mất vài giây trên máy bận / CI đầy tải: trần riêng cho từng bài, như các test PGlite khác.
const PGLITE_TIMEOUT_MS = 30_000;
const open: PGlite[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(db => db.close())); });

async function database({ withLockKey = true, roles = true, ihomeRoleName = 'Chủ công ty' } = {}) {
  const db = new PGlite();
  open.push(db);
  // Cột, khoá chính, khoá ngoại, CHECK, hai unique index và trigger a10_bump_authz_version theo supabase/baseline/schema.sql.
  await db.exec(`
    CREATE TABLE organizations(id uuid PRIMARY KEY, authorization_version bigint NOT NULL DEFAULT 1);
    CREATE TABLE permission_definitions(key text PRIMARY KEY, permission_domain text NOT NULL, is_active boolean NOT NULL);
    CREATE TABLE organization_roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
      name text NOT NULL, is_system boolean NOT NULL DEFAULT false, system_key text,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
      CHECK (system_key IS NULL OR (is_system AND system_key ~ '^[A-Z][A-Z0-9_]{2,63}$')), UNIQUE (organization_id, id));
    CREATE UNIQUE INDEX org_roles_org_name_lower_uidx ON organization_roles(organization_id, lower(name));
    CREATE UNIQUE INDEX organization_roles_system_key_uidx ON organization_roles(organization_id, system_key) WHERE system_key IS NOT NULL;
    CREATE TABLE role_permissions(organization_id uuid NOT NULL, role_id uuid NOT NULL,
      permission_key text NOT NULL REFERENCES permission_definitions(key), effect text NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW','DENY')),
      PRIMARY KEY (organization_id, role_id, permission_key),
      FOREIGN KEY (organization_id, role_id) REFERENCES organization_roles(organization_id, id) ON DELETE CASCADE);
    CREATE FUNCTION bump_org_authorization_version() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v_org uuid;
    BEGIN
      IF tg_op = 'DELETE' THEN v_org := (to_jsonb(old)->>'organization_id')::uuid; ELSE v_org := (to_jsonb(new)->>'organization_id')::uuid; END IF;
      IF v_org IS NOT NULL THEN UPDATE organizations SET authorization_version = authorization_version + 1 WHERE id = v_org; END IF;
      RETURN coalesce(new, old);
    END $$;
    CREATE TRIGGER a10_bump_authz_version AFTER INSERT OR DELETE OR UPDATE ON role_permissions FOR EACH ROW EXECUTE FUNCTION bump_org_authorization_version();
    INSERT INTO permission_definitions VALUES ('deposits.create','TENANT',true),('rooms.edit','TENANT',true);
  `);
  if (withLockKey) await db.exec(`INSERT INTO permission_definitions VALUES ('sale_phong.lock_room','TENANT',true);`);
  if (!roles) return db;
  await db.exec(`
    INSERT INTO organizations(id) VALUES ('${IHOME}'),('${DEMO}'),('${OTHER}'),('${RETIRED_ORG}');
    INSERT INTO organization_roles(id, organization_id, name, is_system, system_key, status) VALUES
      ('${ROLE.chu}','${IHOME}','${ihomeRoleName}',false,NULL,'ACTIVE'),
      ('${ROLE.owner}','${IHOME}','Chủ sở hữu tổ chức',true,'TENANT_OWNER','ACTIVE'),
      ('${ROLE.manager}','${IHOME}','Quản Lý Tòa',false,NULL,'ACTIVE'),
      ('${ROLE.demo}','${DEMO}','Chủ công ty',true,'TENANT_OWNER','ACTIVE'),
      ('${ROLE.deny}','${OTHER}','Chủ công ty',false,NULL,'ACTIVE'),
      ('${ROLE.retired}','${RETIRED_ORG}','Chủ công ty',false,NULL,'RETIRED');
    INSERT INTO role_permissions VALUES
      ('${IHOME}','${ROLE.chu}','deposits.create','ALLOW'),('${IHOME}','${ROLE.chu}','rooms.edit','ALLOW'),
      ('${IHOME}','${ROLE.manager}','deposits.create','ALLOW'),('${DEMO}','${ROLE.demo}','deposits.create','ALLOW');
  `);
  // Vai DEMO cố ý KHÔNG có sẵn khoá: nếu migration bỏ điều kiện system_key IS NULL, vai này sẽ nhận thêm dòng và test đỏ.
  if (withLockKey) await db.exec(`
    INSERT INTO role_permissions VALUES ('${IHOME}','${ROLE.owner}','sale_phong.lock_room','ALLOW'),
      ('${OTHER}','${ROLE.deny}','sale_phong.lock_room','DENY');
  `);
  return db;
}
const rows = async (db: PGlite) => (await db.query<Row>(
  'SELECT organization_id, role_id, permission_key, effect FROM role_permissions ORDER BY organization_id, role_id, permission_key')).rows;
const versions = async (db: PGlite) => (await db.query<{ id: string; authorization_version: number }>(
  'SELECT id, authorization_version::int AS authorization_version FROM organizations ORDER BY id')).rows;
const key = (row: Row) => `${row.organization_id}|${row.role_id}|${row.permission_key}|${row.effect}`;

describe('20261031041018 — vai "Chủ công ty" nhận quyền Lock tạm phòng', () => {
  it('thêm đúng một dòng ALLOW cho vai "Chủ công ty" (system_key NULL, ACTIVE), tăng authorization_version đúng org đó; chạy lại không đổi gì', async () => {
    const db = await database();
    const before = await rows(db), versionsBefore = await versions(db);
    await db.exec(sql);
    const once = await rows(db);
    const added = once.filter(row => !before.some(old => key(old) === key(row)));
    expect(added).toEqual([{ organization_id: IHOME, role_id: ROLE.chu, permission_key: 'sale_phong.lock_room', effect: 'ALLOW' }]);
    // Không dòng cũ nào bị đổi hay mất.
    expect(before.every(old => once.some(row => key(row) === key(old)))).toBe(true);
    const versionsOnce = await versions(db);
    expect(versionsOnce).toEqual(versionsBefore.map(org => ({ ...org, authorization_version: org.authorization_version + (org.id === IHOME ? 1 : 0) })));
    await db.exec(sql);
    expect(await rows(db)).toEqual(once);
    expect(await versions(db)).toEqual(versionsOnce);
  }, PGLITE_TIMEOUT_MS);

  it('không cấp cho vai mang system_key (DEMO), vai RETIRED, Quản Lý Tòa; giữ DENY chủ tự đặt', async () => {
    const db = await database();
    await db.exec(sql);
    const after = await rows(db);
    const lock = (role: string) => after.filter(row => row.role_id === role && row.permission_key === 'sale_phong.lock_room').map(row => row.effect);
    expect(lock(ROLE.demo)).toEqual([]);
    expect(lock(ROLE.retired)).toEqual([]);
    expect(lock(ROLE.manager)).toEqual([]);
    expect(lock(ROLE.deny)).toEqual(['DENY']);
    expect(lock(ROLE.chu)).toEqual(['ALLOW']);
  }, PGLITE_TIMEOUT_MS);

  it('vai đích của org iHome đã đổi tên từ lần đo ⇒ dừng, cả lượt lùi (kể cả dòng vừa chèn ở org khác)', async () => {
    const db = await database({ ihomeRoleName: 'Chủ công ty (cũ)' });
    // Một org khác có vai khớp neo mà chưa có dòng ⇒ lệnh chèn THẬT SỰ ghi một dòng trước khi chốt dừng; dòng đó phải lùi theo.
    const LATE_ORG = id(5), LATE_ROLE = id(51);
    await db.exec(`INSERT INTO organizations(id) VALUES ('${LATE_ORG}');
      INSERT INTO organization_roles(id, organization_id, name) VALUES ('${LATE_ROLE}','${LATE_ORG}','Chủ công ty');`);
    const before = await rows(db), versionsBefore = await versions(db);
    await expect(db.exec(sql)).rejects.toThrow(/chu_cong_ty_lock_room_role_missing/);
    await db.exec('ROLLBACK');
    expect(await rows(db)).toEqual(before);
    expect(await versions(db)).toEqual(versionsBefore);
  }, PGLITE_TIMEOUT_MS);

  it('DB dựng lại không có org/vai nào (baseline schema-only) ⇒ chạy sạch, 0 dòng, kể cả khi vắng khoá', async () => {
    const db = await database({ withLockKey: false, roles: false });
    await db.exec(sql);
    expect(await rows(db)).toEqual([]);
    await db.exec(`INSERT INTO permission_definitions VALUES ('sale_phong.lock_room','TENANT',true);`);
    await db.exec(sql);
    expect(await rows(db)).toEqual([]);
  }, PGLITE_TIMEOUT_MS);

  it('vắng khoá sale_phong.lock_room mà có vai cần cấp, hoặc chỉ có org iHome ⇒ dừng trước khi ghi, báo đúng mã lỗi', async () => {
    const db = await database({ withLockKey: false });
    const before = await rows(db);
    await expect(db.exec(sql)).rejects.toThrow(/chu_cong_ty_lock_room_permission_missing/);
    await db.exec('ROLLBACK');
    expect(await rows(db)).toEqual(before);
    // Chỉ còn org iHome, vai đích đã đổi tên ⇒ không vai nào khớp neo, nhưng org iHome có mặt nên vẫn dừng.
    await db.exec(`DELETE FROM role_permissions WHERE organization_id <> '${IHOME}'; DELETE FROM organization_roles WHERE organization_id <> '${IHOME}';
      UPDATE organization_roles SET name = 'Chủ công ty (cũ)' WHERE id = '${ROLE.chu}';`);
    const onlyIhome = await rows(db);
    await expect(db.exec(sql)).rejects.toThrow(/chu_cong_ty_lock_room_permission_missing/);
    await db.exec('ROLLBACK');
    expect(await rows(db)).toEqual(onlyIhome);
  }, PGLITE_TIMEOUT_MS);

  it('vắng khoá, không có org iHome nhưng org khác có vai cần cấp ⇒ vẫn dừng', async () => {
    const db = await database({ withLockKey: false });
    await db.exec(`DELETE FROM organization_roles WHERE organization_id = '${IHOME}'; DELETE FROM organizations WHERE id = '${IHOME}';`);
    const before = await rows(db);
    await expect(db.exec(sql)).rejects.toThrow(/chu_cong_ty_lock_room_permission_missing/);
    await db.exec('ROLLBACK');
    expect(await rows(db)).toEqual(before);
  }, PGLITE_TIMEOUT_MS);
});
