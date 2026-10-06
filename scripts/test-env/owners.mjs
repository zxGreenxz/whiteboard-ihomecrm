// Metadata owner/ACL được đọc bằng cùng phiên snapshot với pg_dump.
import { APP_SCHEMAS, ident, lit } from './lib.mjs';

const PLATFORM_ROLES = ['postgres', 'anon', 'authenticated', 'service_role', 'authenticator', 'dashboard_user', 'pgbouncer', 'cli_login_postgres'];
const PLATFORM_PREFIX = /^(pg_|supabase_|pgsodium_)/;
const managed = (name) => PLATFORM_ROLES.includes(name) || PLATFORM_PREFIX.test(name);
const S = APP_SCHEMAS.map(lit).join(',');

// JSONB/catalog không cam kết thứ tự ACL hoặc membership; so theo nội dung đầy đủ.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};

export function kiemOwnersSnapshot(source, target, parts = ['roles', 'memberships', 'routines', 'schemaAcl']) {
  kiemMetadataOwners(source);
  for (const part of parts) {
    if (JSON.stringify(canonical(source[part])) !== JSON.stringify(canonical(target?.[part]))) {
      throw new Error(`Owner/role/ACL lệch snapshot production: ${part}.`);
    }
  }
}

/** Không đọc password/hash; chỉ chụp vai tùy chỉnh, quan hệ và quyền cần cho owner. */
export function sqlOwners() {
  return `WITH custom AS (
    SELECT * FROM pg_roles WHERE rolname NOT IN (${PLATFORM_ROLES.map(lit).join(',')})
      AND rolname !~ '^(pg_|supabase_|pgsodium_)'
  ), roles AS (
    SELECT rolname::text AS name, rolinherit AS inherit, rolcanlogin AS login, rolsuper AS superuser,
      rolcreatedb AS createdb, rolcreaterole AS createrole, rolreplication AS replication, rolbypassrls AS bypassrls,
      rolconnlimit AS "connectionLimit", nullif(rolvaliduntil::text, 'infinity') AS "validUntil", coalesce(rolconfig, '{}'::text[]) AS config
    FROM custom
  ), memberships AS (
    SELECT r.rolname::text AS role, m.rolname::text AS member, bool_or(a.admin_option) AS admin,
      bool_or(a.inherit_option) AS inherit, bool_or(a.set_option) AS set
    FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
    WHERE a.roleid IN (SELECT oid FROM custom) OR a.member IN (SELECT oid FROM custom)
    GROUP BY r.rolname, m.rolname
  ), routines AS (
    SELECT format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)) AS identity,
      r.rolname::text AS owner,
      coalesce((SELECT json_agg(t ORDER BY t.grantee NULLS FIRST) FROM (
        SELECT gr.rolname::text AS grantee, bool_or(a.is_grantable) AS grantable
        FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a LEFT JOIN pg_roles gr ON gr.oid=a.grantee
        GROUP BY gr.rolname
      ) t), '[]'::json) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname IN (${S}) AND r.rolname <> 'postgres' AND p.prokind IN ('f','p','w')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
  ), schema_acl AS (
    SELECT n.nspname::text AS schema, r.rolname::text AS grantee, a.privilege_type AS privilege,
      bool_or(a.is_grantable) AS grantable
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a JOIN custom r ON r.oid=a.grantee
    WHERE n.nspname NOT IN (${S}) GROUP BY n.nspname,r.rolname,a.privilege_type
  )
  SELECT coalesce((SELECT json_agg(r ORDER BY r.name) FROM roles r),'[]'::json) AS roles,
    coalesce((SELECT json_agg(m ORDER BY m.role,m.member) FROM memberships m),'[]'::json) AS memberships,
    coalesce((SELECT json_agg(f ORDER BY f.identity) FROM routines f),'[]'::json) AS routines,
    coalesce((SELECT json_agg(a ORDER BY a.schema,a.grantee,a.privilege) FROM schema_acl a),'[]'::json) AS "schemaAcl"`;
}

/** Fail closed: metadata chỉ được tạo vai NOLOGIN và không có quyền quản trị. */
export function kiemMetadataOwners(meta) {
  if (!meta || !['roles', 'memberships', 'routines', 'schemaAcl'].every((key) => Array.isArray(meta[key]))) {
    throw new Error('Thiếu metadata owner/role từ snapshot production.');
  }
  const custom = new Set(meta.roles.map((role) => role.name));
  for (const role of meta.roles) {
    if (typeof role.name !== 'string' || !role.name || managed(role.name)) throw new Error('Không sửa vai nền tảng từ metadata custom.');
    if (['login', 'superuser', 'createdb', 'createrole', 'replication', 'bypassrls'].some((key) => role[key] !== false)) {
      throw new Error(`Vai ${role.name} không còn là vai hạn chế (restricted).`);
    }
    if (typeof role.inherit !== 'boolean' || !Number.isInteger(role.connectionLimit) || !Array.isArray(role.config)) {
      throw new Error(`Sai metadata vai ${role.name}.`);
    }
  }
  for (const m of meta.memberships) {
    const safeParent = custom.has(m.role) || ['anon', 'authenticated', 'service_role'].includes(m.role);
    const safeMember = custom.has(m.member) || ['postgres', 'anon', 'authenticated', 'service_role'].includes(m.member);
    if (!safeParent || !safeMember || !(custom.has(m.role) || custom.has(m.member)) ||
      (m.admin && (!custom.has(m.role) || m.member !== 'postgres')) ||
      !['admin', 'inherit', 'set'].every((key) => typeof m[key] === 'boolean')) {
      throw new Error('Không thể tái lập membership nguy hiểm hoặc ngoài vai tùy chỉnh.');
    }
  }
  for (const routine of meta.routines) {
    if (!custom.has(routine.owner) || typeof routine.identity !== 'string' || !Array.isArray(routine.acl) ||
      routine.acl.some((acl) => !(acl.grantee === null || typeof acl.grantee === 'string') || typeof acl.grantable !== 'boolean')) {
      throw new Error('Sai metadata routine owner/ACL.');
    }
  }
  for (const acl of meta.schemaAcl) {
    if (!custom.has(acl.grantee) || typeof acl.schema !== 'string' || /^(pg_|information_schema$)/.test(acl.schema) ||
      acl.privilege !== 'USAGE' || acl.grantable !== false) {
      throw new Error('Không cấp quyền quản trị schema nền tảng cho vai tùy chỉnh.');
    }
  }
}

export function sqlKhoiPhucVai(meta) {
  kiemMetadataOwners(meta);
  const sql = ['BEGIN;'];
  for (const role of meta.roles) {
    sql.push(`DO $owner_restore$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(role.name)}) THEN
        CREATE ROLE ${ident(role.name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${lit(role.name)}
        AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
        RAISE EXCEPTION 'Existing TEST role is not restricted';
      END IF;
    END $owner_restore$;`);
    sql.push(`ALTER ROLE ${ident(role.name)} ${role.inherit ? 'INHERIT' : 'NOINHERIT'} CONNECTION LIMIT ${role.connectionLimit} VALID UNTIL ${lit(role.validUntil ?? 'infinity')};`);
    sql.push(`ALTER ROLE ${ident(role.name)} RESET ALL;`);
    for (const cfg of role.config) {
      const i = cfg.indexOf('=');
      if (i <= 0) throw new Error('Sai metadata role config.');
      sql.push(`ALTER ROLE ${ident(role.name)} SET ${ident(cfg.slice(0, i))} = ${lit(cfg.slice(i + 1))};`);
    }
  }
  const names = meta.roles.map((r) => lit(r.name)).join(',') || 'NULL';
  const wanted = meta.memberships.map((m) => `(r.rolname=${lit(m.role)} AND m.rolname=${lit(m.member)})`).join(' OR ') || 'false';
  sql.push(`DO $owner_restore$ DECLARE x record; BEGIN
    FOR x IN SELECT r.rolname AS role, m.rolname AS member, g.rolname AS grantor
      FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
      JOIN pg_roles g ON g.oid=a.grantor
      WHERE (r.rolname IN (${names}) OR m.rolname IN (${names})) AND NOT (${wanted})
    LOOP EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE', x.role,x.member,x.grantor); END LOOP;
  END $owner_restore$;`);
  for (const m of meta.memberships) sql.push(`DO $owner_restore$ DECLARE a boolean; i boolean; s boolean; BEGIN
    SELECT bool_or(am.admin_option),bool_or(am.inherit_option),bool_or(am.set_option) INTO a,i,s
      FROM pg_auth_members am JOIN pg_roles r ON r.oid=am.roleid JOIN pg_roles m ON m.oid=am.member
      WHERE r.rolname=${lit(m.role)} AND m.rolname=${lit(m.member)};
    IF a IS DISTINCT FROM ${m.admin} OR i IS DISTINCT FROM ${m.inherit} OR s IS DISTINCT FROM ${m.set} THEN
      EXECUTE ${lit(`GRANT ${ident(m.role)} TO ${ident(m.member)} WITH INHERIT ${m.inherit}, SET ${m.set}`)}
        || CASE WHEN a IS DISTINCT FROM ${m.admin} THEN ${lit(`, ADMIN ${m.admin}`)} ELSE '' END;
    END IF;
  END $owner_restore$;`);
  sql.push('COMMIT;');
  return sql.join('\n');
}

export function sqlKhoiPhucOwners(meta) {
  kiemMetadataOwners(meta);
  const sql = ['BEGIN;', 'SET LOCAL search_path = pg_catalog;'];
  const names = meta.roles.map((r) => lit(r.name)).join(',') || 'NULL';
  sql.push(`DO $owner_restore$ DECLARE x record; BEGIN
    FOR x IN SELECT DISTINCT n.nspname, r.rolname FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid=a.grantee
      WHERE n.nspname NOT IN (${S}) AND r.rolname IN (${names})
    LOOP EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I CASCADE', x.nspname,x.rolname); END LOOP;
  END $owner_restore$;`);
  for (const acl of meta.schemaAcl) {
    sql.push(`GRANT ${acl.privilege} ON SCHEMA ${ident(acl.schema)} TO ${ident(acl.grantee)}${acl.grantable ? ' WITH GRANT OPTION' : ''};`);
  }
  for (const routine of meta.routines) {
    sql.push(`DO $owner_restore$ DECLARE fn regprocedure; ns text; had_create boolean; grantee text;
    BEGIN
      fn := to_regprocedure(${lit(routine.identity)});
      IF fn IS NULL THEN RAISE EXCEPTION 'Missing routine during owner restore'; END IF;
      SELECT n.nspname INTO ns FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn;
      had_create := has_schema_privilege(${lit(routine.owner)}, ns, 'CREATE');
      IF NOT had_create THEN EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I', ns, ${lit(routine.owner)}); END IF;
      EXECUTE format('ALTER ROUTINE %s OWNER TO %I', fn, ${lit(routine.owner)});
      IF NOT had_create THEN EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', ns, ${lit(routine.owner)}); END IF;
      FOR grantee IN SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid=fn
      LOOP EXECUTE format('REVOKE ALL ON ROUTINE %s FROM %s CASCADE', fn, grantee); END LOOP;
      ${routine.acl.map((acl) => `EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %s${acl.grantable ? ' WITH GRANT OPTION' : ''}', fn, ${lit(acl.grantee === null ? 'PUBLIC' : ident(acl.grantee))});`).join('\n')}
    END $owner_restore$;`);
  }
  sql.push('COMMIT;');
  return sql.join('\n');
}
