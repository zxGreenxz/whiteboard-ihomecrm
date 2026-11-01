import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

// 31/10/2026: chủ yêu cầu cấp sale_phong.lock_room (Lock tạm phòng) cho vai "Quản Lý Tòa" của công ty iHome bằng dữ liệu.
// Migration cấp đúng khoá đó cho đúng vai đó (org iHome, system_key NULL, ACTIVE). Mọi dòng / vai / org khác giữ nguyên,
// chạy lại không đổi gì, vai đổi từ lần đo hoặc vắng khoá thì dừng mà không ghi.
const sql = readFileSync('supabase/migrations/20261031061232_quan_ly_toa_quyen_lock_tam_phong.sql', 'utf8');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IHOME = 'aaaa0000-0000-4000-8000-000000000001', DEMO = id(2);
const ROLE = { chu: id(11), owner: id(12), manager: id(13), partner: id(14), demoManager: id(21) };
type Row = { organization_id: string; role_id: string; permission_key: string; effect: string };
// Dựng PGlite mất vài giây trên máy bận / CI đầy tải: trần riêng cho từng bài, như các test PGlite khác.
const PGLITE_TIMEOUT_MS = 30_000;
const open: PGlite[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(db => db.close())); });

type Fixture = { withLockKey?: boolean; orgs?: boolean; manager?: { name?: string; status?: string; systemKey?: string | null } };
async function database({ withLockKey = true, orgs = true, manager = {} }: Fixture = {}) {
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
  if (!orgs) return db;
  const systemKey = manager.systemKey ?? null;
  await db.exec(`
    INSERT INTO organizations(id) VALUES ('${IHOME}'),('${DEMO}');
    INSERT INTO organization_roles(id, organization_id, name, is_system, system_key, status) VALUES
      ('${ROLE.chu}','${IHOME}','Chủ công ty',false,NULL,'ACTIVE'),
      ('${ROLE.owner}','${IHOME}','Chủ sở hữu tổ chức',true,'TENANT_OWNER','ACTIVE'),
      ('${ROLE.manager}','${IHOME}','${manager.name ?? 'Quản Lý Tòa'}',${systemKey === null ? 'false' : 'true'},
        ${systemKey === null ? 'NULL' : `'${systemKey}'`},'${manager.status ?? 'ACTIVE'}'),
      ('${ROLE.partner}','${IHOME}','Partner',false,NULL,'ACTIVE'),
      ('${ROLE.demoManager}','${DEMO}','Quản Lý Tòa',false,NULL,'ACTIVE');
    INSERT INTO role_permissions VALUES
      ('${IHOME}','${ROLE.chu}','deposits.create','ALLOW'),('${IHOME}','${ROLE.manager}','deposits.create','ALLOW'),
      ('${IHOME}','${ROLE.partner}','deposits.create','ALLOW'),('${DEMO}','${ROLE.demoManager}','deposits.create','ALLOW');
  `);
  if (withLockKey) await db.exec(`INSERT INTO role_permissions VALUES ('${IHOME}','${ROLE.owner}','sale_phong.lock_room','ALLOW');`);
  return db;
}
const rows = async (db: PGlite) => (await db.query<Row>(
  'SELECT organization_id, role_id, permission_key, effect FROM role_permissions ORDER BY organization_id, role_id, permission_key')).rows;
const versions = async (db: PGlite) => (await db.query<{ id: string; authorization_version: number }>(
  'SELECT id, authorization_version::int AS authorization_version FROM organizations ORDER BY id')).rows;
const key = (row: Row) => `${row.organization_id}|${row.role_id}|${row.permission_key}|${row.effect}`;
const lockOf = (all: Row[], role: string) => all.filter(row => row.role_id === role && row.permission_key === 'sale_phong.lock_room').map(row => row.effect);

describe('20261031061232 — vai "Quản Lý Tòa" của iHome nhận quyền Lock tạm phòng', () => {
  it('thêm đúng một dòng ALLOW cho Quản Lý Tòa của iHome, tăng authorization_version đúng org đó; chạy lại không đổi gì', async () => {
    const db = await database();
    const before = await rows(db), versionsBefore = await versions(db);
    await db.exec(sql);
    const once = await rows(db);
    expect(once.filter(row => !before.some(old => key(old) === key(row))))
      .toEqual([{ organization_id: IHOME, role_id: ROLE.manager, permission_key: 'sale_phong.lock_room', effect: 'ALLOW' }]);
    expect(before.every(old => once.some(row => key(row) === key(old)))).toBe(true);
    const versionsOnce = await versions(db);
    expect(versionsOnce).toEqual(versionsBefore.map(org => ({ ...org, authorization_version: org.authorization_version + (org.id === IHOME ? 1 : 0) })));
    await db.exec(sql);
    expect(await rows(db)).toEqual(once);
    expect(await versions(db)).toEqual(versionsOnce);
  }, PGLITE_TIMEOUT_MS);

  it('không cấp cho Quản Lý Tòa của DEMO, Chủ công ty, Partner', async () => {
    const db = await database();
    await db.exec(sql);
    const after = await rows(db);
    expect(lockOf(after, ROLE.demoManager)).toEqual([]);
    expect(lockOf(after, ROLE.chu)).toEqual([]);
    expect(lockOf(after, ROLE.partner)).toEqual([]);
    expect(lockOf(after, ROLE.manager)).toEqual(['ALLOW']);
  }, PGLITE_TIMEOUT_MS);

  it('giữ nguyên DENY chủ tự đặt cho Quản Lý Tòa: 0 dòng thêm, version không đổi', async () => {
    const db = await database();
    await db.exec(`INSERT INTO role_permissions VALUES ('${IHOME}','${ROLE.manager}','sale_phong.lock_room','DENY');`);
    const before = await rows(db), versionsBefore = await versions(db);
    await db.exec(sql);
    expect(await rows(db)).toEqual(before);
    expect(await versions(db)).toEqual(versionsBefore);
    expect(lockOf(before, ROLE.manager)).toEqual(['DENY']);
  }, PGLITE_TIMEOUT_MS);

  for (const [label, manager] of [
    ['đổi tên', { name: 'Quản lý toà nhà' }],
    ['RETIRED', { status: 'RETIRED' }],
    ['mang system_key', { systemKey: 'BUILDING_MANAGER' }],
  ] as const) {
    it(`vai đích của iHome ${label} từ lần đo ⇒ dừng, không ghi dòng nào`, async () => {
      const db = await database({ manager });
      const before = await rows(db), versionsBefore = await versions(db);
      await expect(db.exec(sql)).rejects.toThrow(/quan_ly_toa_lock_room_role_missing/);
      await db.exec('ROLLBACK');
      expect(await rows(db)).toEqual(before);
      expect(await versions(db)).toEqual(versionsBefore);
    }, PGLITE_TIMEOUT_MS);
  }

  it('org iHome có mặt mà vắng khoá sale_phong.lock_room ⇒ dừng, không ghi dòng nào', async () => {
    const db = await database({ withLockKey: false });
    const before = await rows(db);
    await expect(db.exec(sql)).rejects.toThrow(/quan_ly_toa_lock_room_permission_missing/);
    await db.exec('ROLLBACK');
    expect(await rows(db)).toEqual(before);
  }, PGLITE_TIMEOUT_MS);

  it('DB dựng lại không có org iHome (baseline schema-only) ⇒ chạy sạch, 0 dòng, có hay vắng khoá', async () => {
    const db = await database({ withLockKey: false, orgs: false });
    await db.exec(sql);
    expect(await rows(db)).toEqual([]);
    await db.exec(`INSERT INTO permission_definitions VALUES ('sale_phong.lock_room','TENANT',true);`);
    await db.exec(sql);
    expect(await rows(db)).toEqual([]);
  }, PGLITE_TIMEOUT_MS);
});
