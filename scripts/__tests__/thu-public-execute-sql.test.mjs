// Test PostgreSQL thật cho migration 20261104173640_thu_public_execute_ham_ung_dung.sql (thu EXECUTE của PUBLIC).
//
// Cụm dùng một lần dựng giống Supabase ở những điểm quyết định kết quả: superuser là supabase_admin, còn `postgres`
// KHÔNG phải superuser mà là chủ mọi hàm và là vai chạy migration; mặc định theo schema public cấp anon/authenticated/
// service_role; PostgREST vào bằng authenticator rồi SET ROLE; login hermes_store_* thuộc nhóm NOLOGIN riêng.
// Mỗi hình dạng hàm trên production có một bản nhỏ: DEFINER ghi dưới auth.uid() (như bulk_create_meter_readings),
// DEFINER đã REVOKE anon nhưng còn PUBLIC (như get_*_breakdown_v2), helper app_private proacl NULL trong policy TO
// authenticated (như buildings_i_can_see), trigger DEFINER/INVOKER ở app_private và public, event trigger, view
// security_invoker, default cột, hàm DEFINER do ie_detail_reader sở hữu, hàm extension (pgcrypto) trong public.
//
// Bộ thăm dò chạy TRƯỚC và SAU migration: trước phải tái hiện được lỗ (login học gọi hàm DEFINER, giả danh được người
// dùng), sau phải bít đúng chỗ đó và mọi kết quả của vai đang dùng giữ nguyên. Cuối file là các ca đỏ bắt buộc của tự
// kiểm (còn hàm PUBLIC, mất GRANT cần thiết, vai bị chặn gọi được DEFINER, mặc định còn PUBLIC).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import pg from 'pg';
import { drainOnEnd } from '../../infra/hermes-broker/pg-pool-drain.mjs';
import { phanTichPublicExecute, sqlPublicExecute } from '../check-definer-acl.mjs';
import { assertSupportedLocalPostgresVersion, candidateLocalPostgresBins } from '../network-center-disposable-db.mjs';

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261104173640_thu_public_execute_ham_ung_dung.sql', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');
const GRANT_STEP = "EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I',f.sig,v_role);";
const REVOKE_STEP = "EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC',f.sig);";
const SELF_CHECK = /DO \$kiem\$[\s\S]*?END \$kiem\$;/.exec(MIGRATION)?.[0];
const BLOCKED = JSON.parse(readFileSync(new URL('../definer-acl-baseline.json', import.meta.url), 'utf8')).publicExecute.blockedRoles;
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, ...options });
  assert.equal(result.status, 0, `${binary}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

async function startCluster(t) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const bin = candidateLocalPostgresBins().find((p) => existsSync(join(p, `initdb${suffix}`)));
  assert(bin, 'PostgreSQL 16+ required: set POSTGRES_BIN; no remote fallback');
  const binary = (name) => join(bin, name + suffix);
  t.diagnostic(String(assertSupportedLocalPostgresVersion('initdb', run(binary('initdb'), ['--version']))));
  const root = mkdtempSync(join(tmpdir(), 'thu-public-execute-pg-'));
  const server = createServer();
  await new Promise((ok, bad) => server.once('error', bad).listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  let started = false;
  const cleanup = () => {
    if (started) run(binary('pg_ctl'), ['-D', root, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    const target = resolve(root), temp = resolve(tmpdir()) + sep;
    assert(target.startsWith(temp) && target.slice(temp.length).startsWith('thu-public-execute-pg-'));
    rmSync(target, { recursive: true, force: true });
  };
  try {
    // Superuser mang tên supabase_admin như Supabase; `postgres` dựng sau, không phải superuser.
    run(binary('initdb'), ['-D', root, '--auth=trust', '--username=supabase_admin', '--encoding=UTF8', '--no-locale']);
    const sockets = process.platform !== 'win32' ? " -k ''" : '';
    run(binary('pg_ctl'), ['-D', root, '-l', join(root, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1${sockets}`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    const pools = new Map();
    const pool = (user) => {
      if (!pools.has(user)) {
        pools.set(user, drainOnEnd(new pg.Pool({ host: '127.0.0.1', port, user, database: 'postgres', max: 2,
          connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000 -c jit=off' })));
      }
      return pools.get(user);
    };
    t.after(async () => {
      for (const p of pools.values()) await p.end();
      cleanup();
    });
    return pool;
  } catch (error) { cleanup(); throw error; }
}

const SETUP_SUPERUSER = `
CREATE ROLE postgres LOGIN CREATEROLE BYPASSRLS;
ALTER DATABASE postgres OWNER TO postgres;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO postgres;
CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE;
CREATE ROLE supabase_read_only_user LOGIN BYPASSRLS; GRANT pg_read_all_data TO supabase_read_only_user;
CREATE ROLE pgbouncer LOGIN;
CREATE ROLE hermes_store_executor NOLOGIN NOINHERIT; CREATE ROLE hermes_store_host LOGIN INHERIT; GRANT hermes_store_executor TO hermes_store_host;
CREATE ROLE hermes_learning_ingest NOLOGIN NOINHERIT; CREATE ROLE hermes_store_learning LOGIN INHERIT; GRANT hermes_learning_ingest TO hermes_store_learning;
CREATE ROLE ie_detail_reader NOLOGIN INHERIT; GRANT authenticated TO ie_detail_reader; GRANT ie_detail_reader TO postgres WITH INHERIT TRUE, SET TRUE;
CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;
CREATE EXTENSION pgcrypto SCHEMA public;
CREATE SCHEMA app_private AUTHORIZATION postgres;
`;

// Chạy bằng `postgres` (không phải superuser) — đúng như migration trên production.
const SETUP_OWNER = `
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA app_private TO hermes_store_executor, hermes_learning_ingest, ie_detail_reader;
CREATE FUNCTION public.f_sort_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(p) $$;
CREATE FUNCTION app_private.inv_helper(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper(p) $$;
CREATE TABLE public.readings(id bigserial PRIMARY KEY, owner_id uuid NOT NULL DEFAULT auth.uid(), label text NOT NULL,
  sort_key text DEFAULT public.f_sort_key('A-1'), audit text[] NOT NULL DEFAULT '{}');
ALTER TABLE public.readings ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION app_private.can_see(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path=pg_catalog,public AS $$ SELECT p = auth.uid() $$;
CREATE POLICY readings_own ON public.readings TO authenticated USING (app_private.can_see(owner_id)) WITH CHECK (app_private.can_see(owner_id));
CREATE FUNCTION public.f_impersonate(p text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path=pg_catalog,public AS $$ BEGIN INSERT INTO public.readings(owner_id, label) VALUES (auth.uid(), p); RETURN auth.uid(); END $$;
CREATE FUNCTION public.f_breakdown() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path=pg_catalog,public AS $$ SELECT count(*) FROM public.readings WHERE owner_id = auth.uid() $$;
REVOKE ALL ON FUNCTION public.f_breakdown() FROM anon;
CREATE FUNCTION app_private.trg_definer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
  AS $$ BEGIN NEW.audit := NEW.audit || 'definer'::text; RETURN NEW; END $$;
CREATE FUNCTION app_private.trg_invoker() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
  AS $$ BEGIN NEW.audit := NEW.audit || ('invoker:' || current_user)::text; RETURN NEW; END $$;
CREATE FUNCTION public.trg_public_invoker() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
  AS $$ BEGIN NEW.audit := NEW.audit || 'public_invoker'::text; RETURN NEW; END $$;
CREATE TRIGGER a_definer BEFORE INSERT ON public.readings FOR EACH ROW EXECUTE FUNCTION app_private.trg_definer();
CREATE TRIGGER b_invoker BEFORE INSERT ON public.readings FOR EACH ROW EXECUTE FUNCTION app_private.trg_invoker();
CREATE TRIGGER c_public BEFORE INSERT ON public.readings FOR EACH ROW EXECUTE FUNCTION public.trg_public_invoker();
CREATE VIEW public.v_readings WITH (security_invoker = true) AS
  SELECT id, app_private.inv_helper(label) AS label_up, public.f_sort_key(label) AS k FROM public.readings;
CREATE TABLE app_private.evt_log(tag text, actor text);
CREATE FUNCTION app_private.evt_log_fn() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
  AS $$ BEGIN INSERT INTO app_private.evt_log(tag, actor) VALUES (tg_tag, session_user); END $$;
CREATE FUNCTION app_private.scope_label(p uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
  AS $$ SELECT 'Phạm vi ' || p::text $$;
CREATE FUNCTION app_private.hermes_store_learning_ingest_v1(p jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
  SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('nap', true) $$;
CREATE FUNCTION app_private.hermes_store_read_connection_v1(p jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
  SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('doc', true) $$;
REVOKE ALL ON FUNCTION app_private.hermes_store_learning_ingest_v1(jsonb), app_private.hermes_store_read_connection_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_learning_ingest_v1(jsonb) TO hermes_learning_ingest;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_read_connection_v1(jsonb) TO hermes_store_executor;
GRANT CREATE ON SCHEMA public TO ie_detail_reader;
CREATE FUNCTION public.read_details() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
  AS $$ SELECT count(*) FROM public.readings $$;
ALTER FUNCTION public.read_details() OWNER TO ie_detail_reader;
REVOKE CREATE ON SCHEMA public FROM ie_detail_reader;
INSERT INTO public.readings(owner_id, label) VALUES ('${USER}', 'cua-toi'), ('${OTHER}', 'cua-nguoi-khac');
`;

const APP_FUNCTIONS = `
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'app_private')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;
const PUBLIC_EXEC = `EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`;
const NOT_TRIGGER = `p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)`;

// Mỗi thăm dò: vai, cách vào (qua authenticator + SET ROLE như PostgREST, hoặc login thẳng), câu SQL. `after` = SQLSTATE
// bắt buộc sau migration (vai bị chặn); không có `after` thì kết quả sau phải Y HỆT trước.
const PROBES = [
  { id: 'authenticated gọi DEFINER ghi dưới auth.uid()', role: 'authenticated', sql: "SELECT public.f_impersonate('x')::text AS v" },
  { id: 'authenticated chèn dòng: default + trigger DEFINER/INVOKER', role: 'authenticated',
    sql: "INSERT INTO public.readings(label) VALUES ('y') RETURNING (audit::text || '|' || sort_key) AS v" },
  { id: 'authenticated đọc qua RLS gọi helper app_private', role: 'authenticated', sql: 'SELECT count(*)::text AS v FROM public.readings' },
  { id: 'authenticated đọc view security_invoker gọi hàm app_private', role: 'authenticated',
    sql: "SELECT string_agg(label_up || k, ',' ORDER BY id) AS v FROM public.v_readings" },
  { id: 'authenticated gọi DEFINER do ie_detail_reader sở hữu', role: 'authenticated', sql: 'SELECT public.read_details()::text AS v' },
  { id: 'authenticated gọi DEFINER báo cáo', role: 'authenticated', sql: 'SELECT public.f_breakdown()::text AS v' },
  { id: 'anon gọi DEFINER chỉ nhờ PUBLIC', role: 'anon', sql: 'SELECT public.f_breakdown()::text AS v' },
  { id: 'anon gọi DEFINER ghi', role: 'anon', sql: "SELECT public.f_impersonate('x')::text AS v" },
  { id: 'service_role gọi DEFINER báo cáo', role: 'service_role', sql: 'SELECT public.f_breakdown()::text AS v' },
  { id: 'service_role đọc view', role: 'service_role', sql: 'SELECT count(*)::text AS v FROM public.v_readings' },
  { id: 'read-only gọi hàm INVOKER', login: 'supabase_read_only_user', sql: "SELECT public.f_sort_key('AB') AS v" },
  { id: 'read-only đọc view gọi hàm', login: 'supabase_read_only_user', sql: 'SELECT count(*)::text AS v FROM public.v_readings' },
  { id: 'login học gọi đúng hàm nạp', login: 'hermes_store_learning', sql: "SELECT app_private.hermes_store_learning_ingest_v1('{}')::text AS v" },
  { id: 'login học giả danh người dùng qua DEFINER', login: 'hermes_store_learning', claim: USER, after: '42501',
    sql: "SELECT public.f_impersonate('gia-danh')::text AS v" },
  { id: 'login học gọi DEFINER app_private', login: 'hermes_store_learning', after: '42501',
    sql: `SELECT app_private.scope_label('${OTHER}') AS v` },
  { id: 'login kho bền gọi đúng hàm kho', login: 'hermes_store_host', sql: "SELECT app_private.hermes_store_read_connection_v1('{}')::text AS v" },
  { id: 'login kho bền giả danh qua DEFINER', login: 'hermes_store_host', claim: USER, after: '42501',
    sql: "SELECT public.f_impersonate('gia-danh')::text AS v" },
  { id: 'read-only gọi DEFINER (ghi được nhờ PUBLIC)', login: 'supabase_read_only_user', claim: USER, after: '42501',
    sql: "SELECT public.f_impersonate('ghi-len')::text AS v" },
  { id: 'pgbouncer gọi DEFINER', login: 'pgbouncer', after: '42501', sql: 'SELECT public.f_breakdown()::text AS v' },
];

async function probe(pool, p) {
  const client = await pool(p.login ?? 'authenticator').connect();
  try {
    await client.query('BEGIN');
    if (p.role) await client.query(`SET LOCAL ROLE ${p.role}`);
    if (p.role === 'authenticated' || p.claim) {
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [p.claim ?? USER]);
    }
    const { rows } = await client.query(p.sql);
    return { ok: true, v: rows[0]?.v ?? null };
  } catch (error) {
    return { ok: false, code: error.code };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function battery(pool) {
  const out = {};
  for (const p of PROBES) out[p.id] = await probe(pool, p);
  return out;
}

async function ddlByAuthAdmin(pool, name) {
  await pool('supabase_auth_admin').query(`CREATE TABLE auth.${name}(id int)`);
  const { rows } = await pool('supabase_admin').query('SELECT actor FROM app_private.evt_log WHERE tag = $1 ORDER BY ctid', ['CREATE TABLE']);
  return rows.map((r) => r.actor);
}

// Đúng SQL và luật của gate check-definer-acl (cùng chạy trong kiem-bao-mat-sau-khoi-phuc), trên cụm này.
async function gate(pool) {
  const { rows } = await pool('postgres').query(sqlPublicExecute(BLOCKED));
  return phanTichPublicExecute({ rows, blockedRoles: BLOCKED });
}

async function catalog(pool) {
  const q = (sql) => pool('supabase_admin').query(sql).then((r) => r.rows);
  return {
    acl: await q(`SELECT p.oid::regprocedure::text AS sig, COALESCE(p.proacl::text, 'NULL') AS acl ${APP_FUNCTIONS} ORDER BY 1`),
    defaults: await q(`SELECT pg_get_userbyid(defaclrole) AS r, defaclnamespace::regnamespace::text AS s, defaclobjtype::text AS t, defaclacl::text AS acl
      FROM pg_default_acl ORDER BY 1, 2, 3`),
    apiExec: await q(`SELECT p.oid::regprocedure::text AS sig, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE') AS co
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r
      WHERE n.nspname IN ('public', 'app_private') AND ${NOT_TRIGGER}
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        AND (r.rolname IN ('anon', 'authenticated', 'service_role') OR (r.rolname = 'supabase_read_only_user' AND NOT p.prosecdef))
      ORDER BY 1, 2`),
  };
}

test('thu EXECUTE của PUBLIC: lỗ có thật trước, bịt đúng chỗ sau, vai đang dùng giữ nguyên, chạy lại không đổi', async (t) => {
  assert(SELF_CHECK, 'migration phải có khối DO $kiem$ … END $kiem$;');
  for (const anchor of [GRANT_STEP, REVOKE_STEP]) assert(MIGRATION.includes(anchor), `neo đột biến phải có trong migration: ${anchor}`);
  const pool = await startCluster(t);
  await pool('supabase_admin').query(SETUP_SUPERUSER);
  await pool('postgres').query(SETUP_OWNER);
  await pool('supabase_admin').query('CREATE EVENT TRIGGER evt_log ON ddl_command_end EXECUTE FUNCTION app_private.evt_log_fn()');

  const before = await battery(pool);
  // Fixture phải tái hiện lỗ, nếu không phần "sau" xanh rỗng.
  assert.deepEqual(before['login học giả danh người dùng qua DEFINER'], { ok: true, v: USER });
  assert.deepEqual(before['login kho bền giả danh qua DEFINER'], { ok: true, v: USER });
  assert.equal(before['login học gọi DEFINER app_private'].ok, true);
  assert.equal(before['read-only gọi DEFINER (ghi được nhờ PUBLIC)'].ok, true);
  assert.equal(before['anon gọi DEFINER chỉ nhờ PUBLIC'].ok, true);
  assert.equal(before['authenticated chèn dòng: default + trigger DEFINER/INVOKER'].v, '{definer,invoker:authenticated,public_invoker}|a-1');
  assert.equal(before['authenticated đọc qua RLS gọi helper app_private'].v, '1');
  assert.deepEqual(await ddlByAuthAdmin(pool, 'truoc'), ['supabase_auth_admin']);
  const catalogBefore = await catalog(pool);
  const publicBefore = (await pool('supabase_admin').query(`SELECT count(*)::int AS n ${APP_FUNCTIONS} AND ${PUBLIC_EXEC}`)).rows[0].n;
  assert.equal(publicBefore, 11, 'fixture có đủ 11 hàm ứng dụng cấp PUBLIC (5 proacl NULL ở app_private, 1 do vai khác sở hữu)');
  const gateBefore = await gate(pool);
  assert.equal(gateBefore.dat, false);
  assert.equal(gateBefore.hamPublic.length, 11);
  assert(gateBefore.vuotQuyen.includes('hermes_store_learning → f_impersonate(text)'), 'gate thấy login học gọi được DEFINER');
  assert(gateBefore.vuotQuyen.includes('pgbouncer → app_private.can_see(uuid)'), 'gate tính EXECUTE cả khi vai chưa có USAGE schema (chặt hơn)');
  assert.deepEqual(gateBefore.macDinh, ['postgres: (toàn cục)']);

  await pool('postgres').query(MIGRATION);
  const gateAfter = await gate(pool);
  assert.deepEqual({ ...gateAfter, thua: [] }, { hamPublic: [], vuotQuyen: [], macDinh: [], thua: [], dat: true }, 'gate xanh sau migration');
  const after = await battery(pool);
  for (const p of PROBES) {
    if (p.after) assert.deepEqual(after[p.id], { ok: false, code: p.after }, p.id);
    else assert.deepEqual(after[p.id], before[p.id], p.id);
  }
  // Trigger và event trigger vẫn chạy dù người gây ra không còn EXECUTE trên hàm trigger.
  const noExec = (await pool('supabase_admin').query(`SELECT
      has_function_privilege('authenticated', 'app_private.trg_definer()', 'EXECUTE') AS d,
      has_function_privilege('authenticated', 'app_private.trg_invoker()', 'EXECUTE') AS i,
      has_function_privilege('supabase_auth_admin', 'app_private.evt_log_fn()', 'EXECUTE') AS e`)).rows[0];
  assert.deepEqual(noExec, { d: false, i: false, e: false });
  assert.deepEqual(await ddlByAuthAdmin(pool, 'sau'), ['supabase_auth_admin', 'supabase_auth_admin']);

  const catalogAfter = await catalog(pool);
  assert.deepEqual(catalogAfter.apiExec, catalogBefore.apiExec, 'vai API (và read-only trên INVOKER) giữ đúng quyền EXECUTE');
  const publicAfter = await pool('supabase_admin').query(`SELECT p.oid::regprocedure::text AS sig ${APP_FUNCTIONS} AND ${PUBLIC_EXEC}`);
  assert.deepEqual(publicAfter.rows, []);
  const extension = await pool('supabase_admin').query(`SELECT count(*)::int AS n FROM pg_proc p
    JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    WHERE p.pronamespace = 'public'::regnamespace AND ${PUBLIC_EXEC}`);
  assert(extension.rows[0].n > 10, 'hàm extension (pgcrypto trong public) không bị đụng');
  const untouched = (rows) => rows.filter((r) => /hermes_store_/.test(r.sig));
  assert.equal(untouched(catalogBefore.acl).length, 2);
  assert.deepEqual(untouched(catalogAfter.acl), untouched(catalogBefore.acl), 'hàm vốn không cấp PUBLIC giữ nguyên ACL');
  // Hàm do vai khác sở hữu (postgres là thành viên INHERIT của chủ) vẫn thu được PUBLIC, vai API giữ quyền.
  assert.deepEqual(catalogAfter.acl.find((r) => r.sig === 'read_details()'), { sig: 'read_details()',
    acl: '{ie_detail_reader=X/ie_detail_reader,anon=X/ie_detail_reader,authenticated=X/ie_detail_reader,service_role=X/ie_detail_reader}' });
  const reach = await pool('supabase_admin').query(`SELECT r.rolname, string_agg(p.oid::regprocedure::text, ',' ORDER BY 1) AS fns
    FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname IN ('public','app_private')
    WHERE r.rolname IN ('hermes_store_learning','hermes_store_host','pgbouncer','supabase_read_only_user','supabase_auth_admin','authenticator')
      AND p.prosecdef AND ${NOT_TRIGGER} AND has_function_privilege(r.oid, p.oid, 'EXECUTE') GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(reach.rows, [
    { rolname: 'hermes_store_host', fns: 'app_private.hermes_store_read_connection_v1(jsonb)' },
    { rolname: 'hermes_store_learning', fns: 'app_private.hermes_store_learning_ingest_v1(jsonb)' },
  ]);

  // Chạy lại: không đổi gì.
  await pool('postgres').query(MIGRATION);
  assert.deepEqual(await catalog(pool), catalogAfter, 'chạy lại migration không đổi ACL hay mặc định');

  // Hàm postgres tạo SAU migration: public theo mặc định Supabase (không PUBLIC), app_private chỉ chủ.
  await pool('postgres').query(`CREATE FUNCTION public.f_moi() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE FUNCTION app_private.f_moi() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`);
  const fresh = await pool('supabase_admin').query(`SELECT p.oid::regprocedure::text AS sig, p.proacl::text AS acl ${APP_FUNCTIONS}
    AND p.proname = 'f_moi' ORDER BY 1`);
  assert.deepEqual(fresh.rows, [
    { sig: 'app_private.f_moi()', acl: '{postgres=X/postgres}' },
    { sig: 'f_moi()', acl: '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' },
  ]);
  await pool('postgres').query('DROP FUNCTION public.f_moi(); DROP FUNCTION app_private.f_moi();');

  // Thăm dò không mù: thiếu đúng GRANT cho authenticated trên helper của policy thì đường đọc RLS đỏ 42501.
  await pool('postgres').query('REVOKE EXECUTE ON FUNCTION app_private.can_see(uuid) FROM authenticated');
  assert.deepEqual(await probe(pool, PROBES[2]), { ok: false, code: '42501' });
  await pool('postgres').query('GRANT EXECUTE ON FUNCTION app_private.can_see(uuid) TO authenticated');
  assert.deepEqual(await probe(pool, PROBES[2]), before[PROBES[2].id]);

  await t.test('tự kiểm đỏ khi còn một hàm cấp PUBLIC', async () => {
    await pool('postgres').query('GRANT EXECUTE ON FUNCTION public.f_sort_key(text) TO PUBLIC');
    await assert.rejects(pool('postgres').query(SELF_CHECK), /public_execute_con_ham_cap_public: 1 \(f_sort_key\(text\)\)/);
    // Bản migration bỏ bước REVOKE (đột biến) cũng phải đỏ ở tự kiểm, không lọt.
    await assert.rejects(pool('postgres').query(MIGRATION.replace(REVOKE_STEP, 'NULL;')), /public_execute_con_ham_cap_public/);
    await pool('postgres').query(MIGRATION);
    assert.equal((await pool('supabase_admin').query(`SELECT count(*)::int AS n ${APP_FUNCTIONS} AND ${PUBLIC_EXEC}`)).rows[0].n, 0);
  });

  await t.test('tự kiểm đỏ khi bỏ GRANT cần thiết cho vai đang dùng', async () => {
    await pool('postgres').query(`CREATE FUNCTION app_private.can_see_v2(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,public AS $$ SELECT p = auth.uid() $$;
      GRANT EXECUTE ON FUNCTION app_private.can_see_v2(uuid) TO PUBLIC;`);
    await assert.rejects(pool('postgres').query(MIGRATION.replace(GRANT_STEP, 'NULL;')), /public_execute_vai_dang_dung_mat_quyen/);
    await pool('postgres').query(MIGRATION);
    const kept = await pool('supabase_admin').query(`SELECT has_function_privilege('authenticated', 'app_private.can_see_v2(uuid)', 'EXECUTE') AS a,
      has_function_privilege('hermes_store_learning', 'app_private.can_see_v2(uuid)', 'EXECUTE') AS h`);
    assert.deepEqual(kept.rows[0], { a: true, h: false });
  });

  await t.test('tự kiểm đỏ khi vai bị chặn gọi được hàm DEFINER (cấp thẳng hoặc qua nhóm chỉ SET ROLE)', async () => {
    await pool('postgres').query('GRANT EXECUTE ON FUNCTION public.f_impersonate(text) TO hermes_store_learning');
    await assert.rejects(pool('postgres').query(SELF_CHECK), /public_execute_vai_chan_goi_duoc_definer: 1 \(hermes_store_learning → f_impersonate\(text\)\)/);
    await pool('postgres').query('REVOKE EXECUTE ON FUNCTION public.f_impersonate(text) FROM hermes_store_learning');
    await pool('supabase_admin').query('GRANT authenticated TO hermes_store_host WITH INHERIT FALSE');
    await assert.rejects(pool('postgres').query(SELF_CHECK), /public_execute_vai_chan_goi_duoc_definer: \d+ \(hermes_store_host → /);
    assert((await gate(pool)).vuotQuyen.includes('hermes_store_host → f_impersonate(text)'), 'gate cũng thấy đường qua nhóm chỉ SET ROLE');
    await pool('supabase_admin').query('REVOKE authenticated FROM hermes_store_host');
    await pool('postgres').query(SELF_CHECK);
    assert.equal((await gate(pool)).dat, true);
  });

  await t.test('tự kiểm đỏ khi mặc định hàm của postgres cấp lại PUBLIC', async () => {
    await pool('postgres').query('ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC');
    await assert.rejects(pool('postgres').query(SELF_CHECK), /public_execute_mac_dinh_postgres_con_cap_public/);
    await pool('postgres').query('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app_private GRANT EXECUTE ON FUNCTIONS TO PUBLIC');
    await pool('postgres').query(MIGRATION.replace(/DO \$kiem\$[\s\S]*?END \$kiem\$;/, ''));
    await assert.rejects(pool('postgres').query(SELF_CHECK), /public_execute_mac_dinh_postgres_con_cap_public/);
    await pool('postgres').query('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
    await pool('postgres').query(MIGRATION);
  });
});
