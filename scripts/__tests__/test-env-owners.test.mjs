import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { kiemOwnersSnapshot, sqlKhoiPhucOwners, sqlKhoiPhucVai, sqlOwners } from '../test-env/owners.mjs';

const roles = [{ name: 'ie_detail_reader', inherit: true, login: false, superuser: false,
  createdb: false, createrole: false, replication: false, bypassrls: false, connectionLimit: -1,
  validUntil: null, config: [] }];
const memberships = [
  { role: 'authenticated', member: 'ie_detail_reader', admin: false, inherit: true, set: true },
  { role: 'ie_detail_reader', member: 'postgres', admin: false, inherit: true, set: true },
];
const routine = { identity: 'public.read_details(uuid)', owner: 'ie_detail_reader', acl: [
  { grantee: 'ie_detail_reader', grantable: false }, { grantee: 'authenticated', grantable: false },
] };
const metadata = () => ({ roles: structuredClone(roles), memberships: structuredClone(memberships),
  routines: [structuredClone(routine)], schemaAcl: [{ schema: 'auth', grantee: 'ie_detail_reader', privilege: 'USAGE', grantable: false }] });

async function fixture(run) {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA app_private;
      CREATE FUNCTION public.read_details(uuid) RETURNS text LANGUAGE sql SECURITY DEFINER
        SET search_path = pg_catalog AS 'SELECT current_user::text';`);
    await run(db);
  } finally { await db.close(); }
}

describe('TEST restore preserves restricted routine execution identity', () => {
  it('restores custom owner and denies anon while authenticated runs as restricted owner', async () => fixture(async (db) => {
    const meta = metadata();
    await db.exec(sqlKhoiPhucVai(meta));
    await db.exec(sqlKhoiPhucOwners(meta));
    const owner = (await db.query(`SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid='public.read_details(uuid)'::regprocedure`)).rows[0];
    expect(owner.owner).toBe('ie_detail_reader');
    await db.exec('SET ROLE authenticated');
    expect((await db.query(`SELECT public.read_details(null) AS who`)).rows[0].who).toBe('ie_detail_reader');
    await db.exec('RESET ROLE; SET ROLE anon');
    await expect(db.query('SELECT public.read_details(null)')).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE');
    expect((await db.query(`SELECT has_schema_privilege('ie_detail_reader','public','CREATE') AS can_create,
      has_schema_privilege('ie_detail_reader','auth','USAGE') AS auth_usage`)).rows[0]).toEqual({ can_create: false, auth_usage: true });
  }));

  it('captures application roles, memberships, schema grants and routine ACL in a read-only snapshot', async () => fixture(async (db) => {
    await db.exec(`CREATE ROLE ie_detail_reader NOLOGIN INHERIT; CREATE ROLE supabase_fixture;
      CREATE ROLE cli_login_postgres LOGIN;
      GRANT authenticated TO ie_detail_reader WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
      GRANT ie_detail_reader TO postgres WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;
      GRANT USAGE ON SCHEMA auth TO ie_detail_reader;
      ALTER FUNCTION public.read_details(uuid) OWNER TO ie_detail_reader;
      REVOKE ALL ON FUNCTION public.read_details(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.read_details(uuid) TO authenticated WITH GRANT OPTION;`);
    await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog;');
    const result = (await db.query(sqlOwners())).rows[0];
    await db.exec('ROLLBACK');
    expect(result.roles).toEqual(roles);
    expect(result.memberships).toEqual([
      { role: 'authenticated', member: 'ie_detail_reader', admin: false, inherit: true, set: false },
      memberships[1],
    ]);
    expect(result.routines).toEqual([{ identity: 'public.read_details(uuid)', owner: 'ie_detail_reader', acl: [
      { grantee: 'authenticated', grantable: true }, { grantee: 'ie_detail_reader', grantable: false },
    ] }]);
    expect(result.schemaAcl).toEqual(metadata().schemaAcl);
    await db.exec(sqlKhoiPhucVai(result));
    await db.exec(sqlKhoiPhucOwners(result));
    expect((await db.query(sqlOwners())).rows[0]).toEqual(result);
  }));

  it('removes stale memberships, grant options and role settings on repeated restore', async () => fixture(async (db) => {
    await db.exec(`CREATE ROLE ie_detail_reader NOLOGIN NOINHERIT;
      GRANT ie_detail_reader TO anon;
      GRANT authenticated TO ie_detail_reader WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
      ALTER ROLE ie_detail_reader SET statement_timeout='1s';
      GRANT CREATE, USAGE ON SCHEMA auth TO ie_detail_reader;
      GRANT EXECUTE ON FUNCTION public.read_details(uuid) TO anon WITH GRANT OPTION;`);
    const meta = metadata();
    for (let i = 0; i < 2; i++) {
      await db.exec(sqlKhoiPhucVai(meta));
      await db.exec(sqlKhoiPhucOwners(meta));
    }
    expect((await db.query(`SELECT rolname::text AS name, rolinherit AS inherit, rolconfig AS config
      FROM pg_roles WHERE rolname='ie_detail_reader'`)).rows[0]).toEqual({ name: 'ie_detail_reader', inherit: true, config: null });
    expect((await db.query(`SELECT r.rolname::text AS role, m.rolname::text AS member, a.admin_option AS admin,
      a.inherit_option AS inherit, a.set_option AS set FROM pg_auth_members a
      JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
      WHERE r.rolname='ie_detail_reader' OR m.rolname='ie_detail_reader' ORDER BY 1,2`)).rows).toEqual(memberships);
    expect((await db.query(`SELECT has_function_privilege('anon','public.read_details(uuid)','EXECUTE') AS anon,
      has_schema_privilege('ie_detail_reader','auth','CREATE') AS create_auth`)).rows[0]).toEqual({ anon: false, create_auth: false });
  }));

  it.each(['login', 'superuser', 'createdb', 'createrole', 'replication', 'bypassrls'])('rejects unsafe source role attribute %s before SQL is generated', (attribute) => {
    const meta = metadata(); meta.roles[0][attribute] = true;
    expect(() => sqlKhoiPhucVai(meta)).toThrow(/restricted|hạn chế/);
  });

  it.each(['pg_monitor', 'supabase_admin', 'postgres', 'authenticated', 'cli_login_postgres'])('never alters managed role %s from custom-role metadata', (name) => {
    const meta = metadata(); meta.roles[0].name = name;
    expect(() => sqlKhoiPhucVai(meta)).toThrow(/managed|nền tảng/);
  });

  it('rejects powerful managed membership and grant option on managed membership', () => {
    const meta = metadata(); meta.memberships[0].role = 'pg_read_all_data';
    expect(() => sqlKhoiPhucVai(meta)).toThrow(/membership|thành viên/);
    meta.memberships[0].role = 'authenticated'; meta.memberships[0].admin = true;
    expect(() => sqlKhoiPhucVai(meta)).toThrow(/membership|thành viên/);
  });

  it('fails closed on an elevated existing TEST role and rolls back earlier mutations', async () => fixture(async (db) => {
    await db.exec('CREATE ROLE ie_detail_reader NOLOGIN BYPASSRLS');
    await expect(db.exec(sqlKhoiPhucVai(metadata()))).rejects.toThrow(/restricted|hạn chế/);
    await db.exec('ROLLBACK');
    expect((await db.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname='ie_detail_reader'`)).rows[0].rolbypassrls).toBe(true);
  }));

  it('requires snapshot metadata instead of silently reverting to postgres ownership', () => {
    expect(() => sqlKhoiPhucVai(undefined)).toThrow(/metadata|snapshot/);
    expect(() => sqlKhoiPhucOwners({})).toThrow(/metadata|snapshot/);
  });

  it.each(['roles', 'memberships', 'routines', 'schemaAcl'])('fails verification when captured %s differs after restore', (part) => {
    const source = metadata(); const target = structuredClone(source); target[part] = [];
    expect(() => kiemOwnersSnapshot(source, target)).toThrow(/owner|role|ACL|snapshot/);
    expect(() => kiemOwnersSnapshot(source, structuredClone(source))).not.toThrow();
  });

  it('restores twice under a non-superuser postgres with CREATEROLE and granted membership administration', async () => fixture(async (db) => {
    await db.exec(`CREATE ROLE supabase_admin SUPERUSER;
      SET SESSION AUTHORIZATION supabase_admin;
      ALTER ROLE postgres RENAME TO bootstrap;
      CREATE ROLE postgres NOSUPERUSER CREATEROLE CREATEDB LOGIN;
      ALTER SCHEMA public OWNER TO postgres; ALTER SCHEMA auth OWNER TO postgres;
      ALTER FUNCTION public.read_details(uuid) OWNER TO postgres;
      GRANT authenticated TO postgres WITH ADMIN TRUE;
      SET ROLE postgres;`);
    const meta = metadata(); meta.memberships[1].admin = true;
    for (let i = 0; i < 2; i++) {
      await db.exec(sqlKhoiPhucVai(meta));
      await db.exec(sqlKhoiPhucOwners(meta));
    }
    expect((await db.query(`SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid='public.read_details(uuid)'::regprocedure`)).rows[0].owner).toBe('ie_detail_reader');
    expect((await db.query(`SELECT has_schema_privilege('ie_detail_reader','public','CREATE') AS can_create`)).rows[0].can_create).toBe(false);
  }));
});
