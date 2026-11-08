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
-- Extension do CHÍNH postgres sở hữu (như pgcrypto/uuid-ossp trên production): migration là chủ nên THU ĐƯỢC PUBLIC của
-- chúng nếu bỏ lọc extension — phép khẳng định "hàm extension giữ PUBLIC" vì thế có nghĩa (không như extension của superuser).
ALTER ROLE postgres SUPERUSER; SET ROLE postgres; CREATE EXTENSION pgcrypto SCHEMA public; RESET ROLE; ALTER ROLE postgres NOSUPERUSER;
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
CREATE FUNCTION app_private.default_code() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'MA-001' $$;
CREATE FUNCTION public.f_util(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p || '!' $$;
CREATE TABLE public.readings(id bigserial PRIMARY KEY, owner_id uuid NOT NULL DEFAULT auth.uid(), label text NOT NULL,
  sort_key text DEFAULT public.f_sort_key('A-1'), code text DEFAULT app_private.default_code(), audit text[] NOT NULL DEFAULT '{}');
CREATE FUNCTION app_private.public_helper(p boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
  AS $$ SELECT p $$;
CREATE TABLE public.notices(id int PRIMARY KEY, visible boolean NOT NULL);
ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY notices_public ON public.notices FOR SELECT TO public USING (app_private.public_helper(visible));
INSERT INTO public.notices VALUES (1, true), (2, false);
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
// bắt buộc sau migration (vai bị chặn, cửa anon đã cố ý đóng, read-only gọi thẳng hàm không view nào dùng); không có `after`
// thì kết quả sau phải Y HỆT trước — gồm mọi đường policy/view/default/trigger mà vai API tự chạy hàm.
const PROBES = [
  { id: 'authenticated gọi DEFINER ghi dưới auth.uid()', role: 'authenticated', sql: "SELECT public.f_impersonate('x')::text AS v" },
  { id: 'authenticated chèn dòng: default + trigger DEFINER/INVOKER', role: 'authenticated',
    sql: "INSERT INTO public.readings(label) VALUES ('y') RETURNING (audit::text || '|' || sort_key || '|' || code) AS v" },
  { id: 'anon đọc bảng có policy TO public gọi helper app_private', role: 'anon',
    sql: "SELECT string_agg(id::text, ',' ORDER BY id) AS v FROM public.notices" },
  { id: 'authenticated đọc qua RLS gọi helper app_private', role: 'authenticated', sql: 'SELECT count(*)::text AS v FROM public.readings' },
  { id: 'authenticated đọc view security_invoker gọi hàm app_private', role: 'authenticated',
    sql: "SELECT string_agg(label_up || k, ',' ORDER BY id) AS v FROM public.v_readings" },
  { id: 'authenticated gọi DEFINER do ie_detail_reader sở hữu', role: 'authenticated', sql: 'SELECT public.read_details()::text AS v' },
  { id: 'authenticated gọi DEFINER báo cáo', role: 'authenticated', sql: 'SELECT public.f_breakdown()::text AS v' },
  // Cửa đã cố ý đóng với anon (REVOKE anon, còn authenticated) — trước gọi được chỉ nhờ PUBLIC, sau phải 42501.
  { id: 'anon gọi DEFINER đã cố ý đóng, chỉ còn nhờ PUBLIC', role: 'anon', after: '42501', sql: 'SELECT public.f_breakdown()::text AS v' },
  { id: 'anon gọi DEFINER ghi', role: 'anon', sql: "SELECT public.f_impersonate('x')::text AS v" },
  { id: 'service_role gọi DEFINER báo cáo', role: 'service_role', sql: 'SELECT public.f_breakdown()::text AS v' },
  // Chọn đúng cột gọi hàm: count(*) cho planner bỏ cột không dùng, hàm trong view không chạy — thăm dò mù.
  { id: 'service_role đọc view', role: 'service_role', sql: "SELECT string_agg(label_up || k, ',' ORDER BY id) AS v FROM public.v_readings" },
  { id: 'read-only gọi hàm INVOKER mà view dùng', login: 'supabase_read_only_user', sql: "SELECT public.f_sort_key('AB') AS v" },
  { id: 'read-only gọi thẳng hàm INVOKER không view nào dùng', login: 'supabase_read_only_user', after: '42501',
    sql: "SELECT public.f_util('AB') AS v" },
  { id: 'read-only đọc view gọi hàm', login: 'supabase_read_only_user',
    sql: "SELECT string_agg(label_up || k, ',' ORDER BY id) AS v FROM public.v_readings" },
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
    return p.msg ? { ok: false, code: error.code, message: error.message } : { ok: false, code: error.code };
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
async function gate(pool, thieuMienTru = {}) {
  const { rows } = await pool('postgres').query(sqlPublicExecute(BLOCKED));
  return phanTichPublicExecute({ rows, blockedRoles: BLOCKED, thieuMienTru });
}

async function catalog(pool) {
  const q = (sql) => pool('supabase_admin').query(sql).then((r) => r.rows);
  return {
    acl: await q(`SELECT p.oid::regprocedure::text AS sig, COALESCE(p.proacl::text, 'NULL') AS acl ${APP_FUNCTIONS} ORDER BY 1`),
    defaults: await q(`SELECT pg_get_userbyid(defaclrole) AS r, defaclnamespace::regnamespace::text AS s, defaclobjtype::text AS t, defaclacl::text AS acl
      FROM pg_default_acl ORDER BY 1, 2, 3`),
    // Hàm extension trong public: chủ và ACL — để chứng minh migration KHÔNG đụng (chúng do postgres sở hữu, thu được nếu lọc hỏng).
    extension: await q(`SELECT pg_get_userbyid(p.proowner) AS owner, count(*)::int AS n,
        count(*) FILTER (WHERE ${PUBLIC_EXEC})::int AS cap_public
      FROM pg_proc p JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      WHERE p.pronamespace = 'public'::regnamespace GROUP BY 1`),
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
  assert.equal(before['anon gọi DEFINER đã cố ý đóng, chỉ còn nhờ PUBLIC'].ok, true);
  assert.equal(before['read-only gọi thẳng hàm INVOKER không view nào dùng'].ok, true);
  assert.equal(before['authenticated chèn dòng: default + trigger DEFINER/INVOKER'].v, '{definer,invoker:authenticated,public_invoker}|a-1|MA-001');
  assert.equal(before['authenticated đọc qua RLS gọi helper app_private'].v, '1');
  assert.equal(before['anon đọc bảng có policy TO public gọi helper app_private'].v, '1');
  assert.deepEqual(await ddlByAuthAdmin(pool, 'truoc'), ['supabase_auth_admin']);
  const catalogBefore = await catalog(pool);
  assert.equal(catalogBefore.extension.length, 1);
  assert.equal(catalogBefore.extension[0].owner, 'postgres', 'extension do chính postgres sở hữu ⇒ migration thu được nếu không lọc');
  assert(catalogBefore.extension[0].cap_public > 10 && catalogBefore.extension[0].cap_public === catalogBefore.extension[0].n);
  const publicBefore = (await pool('supabase_admin').query(`SELECT count(*)::int AS n ${APP_FUNCTIONS} AND ${PUBLIC_EXEC}`)).rows[0].n;
  assert.equal(publicBefore, 14, 'fixture có đủ 14 hàm ứng dụng cấp PUBLIC (7 proacl NULL ở app_private, 1 do vai khác sở hữu)');
  const gateBefore = await gate(pool);
  assert.equal(gateBefore.dat, false);
  assert.equal(gateBefore.hamPublic.length, 14);
  assert.deepEqual(gateBefore.thieuQuyen, [], 'còn PUBLIC thì chưa vai nào thiếu quyền');
  assert(gateBefore.vuotQuyen.includes('hermes_store_learning → f_impersonate(text)'), 'gate thấy login học gọi được DEFINER');
  assert(gateBefore.vuotQuyen.includes('pgbouncer → app_private.can_see(uuid)'), 'gate tính EXECUTE cả khi vai chưa có USAGE schema (chặt hơn)');
  assert.deepEqual(gateBefore.macDinh, ['postgres: (toàn cục)']);

  await pool('postgres').query(MIGRATION);
  const gateAfter = await gate(pool);
  assert.deepEqual({ ...gateAfter, thua: [] }, { hamPublic: [], vuotQuyen: [], macDinh: [], thieuQuyen: [], mienThua: [], thua: [], dat: true },
    'gate xanh sau migration');
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
  // Cấp ĐÚNG vai thật sự dùng (pg_depend), không cấp đại trà: ACL từng hàm sau migration.
  const acl = Object.fromEntries(catalogAfter.acl.map((r) => [r.sig, r.acl]));
  const ALL = 'postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres';
  assert.deepEqual({
    can_see: acl['app_private.can_see(uuid)'], public_helper: acl['app_private.public_helper(boolean)'],
    inv_helper: acl['app_private.inv_helper(text)'], default_code: acl['app_private.default_code()'],
    scope_label: acl['app_private.scope_label(uuid)'], trg_definer: acl['app_private.trg_definer()'], evt: acl['app_private.evt_log_fn()'],
    f_sort_key: acl['f_sort_key(text)'], f_util: acl['f_util(text)'], f_breakdown: acl['f_breakdown()'],
  }, {
    can_see: '{postgres=X/postgres,authenticated=X/postgres}', // policy TO authenticated
    public_helper: '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres}', // policy TO public; service_role BYPASSRLS
    inv_helper: `{${ALL},supabase_read_only_user=X/postgres}`, // view security_invoker: mọi vai đọc được view
    default_code: `{${ALL}}`, // default cột: vai ghi được bảng (read-only không ghi)
    scope_label: '{postgres=X/postgres}', trg_definer: '{postgres=X/postgres}', evt: '{postgres=X/postgres}', // không ai tự chạy qua đối tượng nào
    f_sort_key: `{${ALL},supabase_read_only_user=X/postgres}`, // public: vai API vốn có; read-only vì view dùng
    f_util: `{${ALL}}`, // không view nào dùng ⇒ read-only không nhận
    f_breakdown: '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', // anon đã cố ý đóng: giữ đóng
  });
  const publicAfter = await pool('supabase_admin').query(`SELECT p.oid::regprocedure::text AS sig ${APP_FUNCTIONS} AND ${PUBLIC_EXEC}`);
  assert.deepEqual(publicAfter.rows, []);
  assert.deepEqual(catalogAfter.extension, catalogBefore.extension, 'hàm extension do postgres sở hữu giữ nguyên PUBLIC');
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

  // Thăm dò không mù: thiếu đúng GRANT cho authenticated trên helper của policy thì đường đọc RLS đỏ 42501 — và gate thấy trước.
  const rlsProbe = PROBES.find((p) => p.id === 'authenticated đọc qua RLS gọi helper app_private');
  await pool('postgres').query('REVOKE EXECUTE ON FUNCTION app_private.can_see(uuid) FROM authenticated');
  assert.deepEqual(await probe(pool, rlsProbe), { ok: false, code: '42501' });
  assert.deepEqual((await gate(pool)).thieuQuyen, ['authenticated → app_private.can_see(uuid) @ pg_policy'], 'gate báo helper policy thiếu GRANT');
  await pool('postgres').query('GRANT EXECUTE ON FUNCTION app_private.can_see(uuid) TO authenticated');
  assert.deepEqual(await probe(pool, rlsProbe), before[rlsProbe.id]);

  // Thăm dò view cũng không mù: chọn cột gọi hàm thật, nên thiếu GRANT trên helper của view thì service_role và read-only
  // nhận 42501 — và gate thấy trước.
  const viewProbes = PROBES.filter((p) => ['service_role đọc view', 'read-only đọc view gọi hàm'].includes(p.id));
  assert.equal(viewProbes.length, 2);
  for (const p of viewProbes) assert.equal(before[p.id].v, 'CUA-TOIcua-toi,CUA-NGUOI-KHACcua-nguoi-khac', p.id);
  await pool('postgres').query('REVOKE EXECUTE ON FUNCTION app_private.inv_helper(text) FROM service_role, supabase_read_only_user');
  for (const p of viewProbes) assert.deepEqual(await probe(pool, p), { ok: false, code: '42501' }, p.id);
  assert.deepEqual((await gate(pool)).thieuQuyen,
    ['service_role → app_private.inv_helper(text) @ pg_rewrite', 'supabase_read_only_user → app_private.inv_helper(text) @ pg_rewrite']);
  await pool('postgres').query('GRANT EXECUTE ON FUNCTION app_private.inv_helper(text) TO service_role, supabase_read_only_user');
  for (const p of viewProbes) assert.deepEqual(await probe(pool, p), before[p.id], p.id);

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
      GRANT EXECUTE ON FUNCTION app_private.can_see_v2(uuid) TO PUBLIC;
      CREATE POLICY readings_v2 ON public.readings FOR SELECT TO authenticated USING (app_private.can_see_v2(owner_id));`);
    await assert.rejects(pool('postgres').query(MIGRATION.replace(GRANT_STEP, 'NULL;')), /public_execute_vai_dang_dung_mat_quyen/);
    await pool('postgres').query(MIGRATION);
    const kept = await pool('supabase_admin').query(`SELECT has_function_privilege('authenticated', 'app_private.can_see_v2(uuid)', 'EXECUTE') AS a,
      has_function_privilege('anon', 'app_private.can_see_v2(uuid)', 'EXECUTE') AS anon,
      has_function_privilege('hermes_store_learning', 'app_private.can_see_v2(uuid)', 'EXECUTE') AS h`);
    assert.deepEqual(kept.rows[0], { a: true, anon: false, h: false });
    await pool('postgres').query('DROP POLICY readings_v2 ON public.readings; DROP FUNCTION app_private.can_see_v2(uuid);');
  });

  await t.test('cửa đã cố ý đóng với anon: không tự mở lại; đường phụ thuộc đòi anon thì dừng chờ người quyết', async () => {
    // Giống get_*_breakdown_v2: REVOKE anon, còn authenticated, PUBLIC còn — nhưng lần này một policy TO public lại dùng nó.
    await pool('postgres').query(`CREATE FUNCTION public.f_closed(p boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=pg_catalog AS $$ SELECT p $$;
      REVOKE ALL ON FUNCTION public.f_closed(boolean) FROM anon; GRANT EXECUTE ON FUNCTION public.f_closed(boolean) TO PUBLIC;
      CREATE POLICY notices_closed ON public.notices FOR SELECT TO public USING (public.f_closed(visible));`);
    await assert.rejects(pool('postgres').query(MIGRATION), /public_execute_anon_da_dong_nhung_can: f_closed\(boolean\)/);
    // Không ai dùng thì thu PUBLIC bình thường, anon vẫn đóng.
    await pool('postgres').query('DROP POLICY notices_closed ON public.notices');
    await pool('postgres').query(MIGRATION);
    const closed = await pool('supabase_admin').query(`SELECT has_function_privilege('anon', 'public.f_closed(boolean)', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'public.f_closed(boolean)', 'EXECUTE') AS a`);
    assert.deepEqual(closed.rows[0], { anon: false, a: true });
    await pool('postgres').query('DROP FUNCTION public.f_closed(boolean)');
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

  // Từ đây: các đường mà câu 4 của gate ('thieu') phải thấy dù migration không cần (đo prod/TEST 05/11: không hàm cấp PUBLIC
  // nào dùng qua các đường này). Hàm tạo SAU migration: app_private chỉ chủ gọi được, public theo mặc định Supabase.
  await t.test('gate thấy hàm trong DEFAULT của tham số (kể cả hàm DEFINER) và thân BEGIN ATOMIC của hàm INVOKER', async () => {
    await pool('postgres').query(`
      CREATE FUNCTION app_private.today_c() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-01-01' $$;
      CREATE FUNCTION public.rpc_default(p date DEFAULT app_private.today_c()) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog AS $$ SELECT p::text $$;
      CREATE FUNCTION app_private.atomic_inv() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 7 $$;
      CREATE FUNCTION public.rpc_atomic() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT app_private.atomic_inv(); END;
      CREATE FUNCTION app_private.atomic_def() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 8 $$;
      CREATE FUNCTION public.rpc_atomic_def() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
        BEGIN ATOMIC SELECT app_private.atomic_def(); END;`);
    const goi = (sql) => probe(pool, { role: 'authenticated', sql });
    // DEFAULT của tham số chạy bằng NGƯỜI GỌI, kể cả khi hàm là DEFINER; truyền tham số thì default không chạy.
    assert.deepEqual(await goi('SELECT public.rpc_default() AS v'), { ok: false, code: '42501' });
    assert.deepEqual(await goi("SELECT public.rpc_default(DATE '2026-02-02') AS v"), { ok: true, v: '2026-02-02' });
    // Thân BEGIN ATOMIC của hàm INVOKER chạy bằng người gọi; của hàm DEFINER chạy bằng chủ.
    assert.deepEqual(await goi('SELECT public.rpc_atomic()::text AS v'), { ok: false, code: '42501' });
    assert.deepEqual(await goi('SELECT public.rpc_atomic_def()::text AS v'), { ok: true, v: '8' });
    const kq = await gate(pool);
    assert.equal(kq.dat, false);
    assert.deepEqual(kq.thieuQuyen, ['anon', 'authenticated', 'service_role']
      .flatMap((r) => [`${r} → app_private.atomic_inv() @ pg_proc`, `${r} → app_private.today_c() @ pg_proc`]), 'đủ hai đường, không tính thân DEFINER');
    await pool('postgres').query('GRANT EXECUTE ON FUNCTION app_private.today_c(), app_private.atomic_inv() TO anon, authenticated, service_role');
    assert.equal((await gate(pool)).dat, true);
    assert.deepEqual(await goi('SELECT public.rpc_default() AS v'), { ok: true, v: '2026-01-01' });
    assert.deepEqual(await goi('SELECT public.rpc_atomic()::text AS v'), { ok: true, v: '7' });
    await pool('postgres').query(`DROP FUNCTION public.rpc_default(date), public.rpc_atomic(), public.rpc_atomic_def();
      DROP FUNCTION app_private.today_c(), app_private.atomic_inv(), app_private.atomic_def();`);
  });

  await t.test('gate thấy DEFAULT và CHECK của domain', async () => {
    await pool('postgres').query(`
      CREATE FUNCTION app_private.dom_default() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'D-1' $$;
      CREATE FUNCTION app_private.dom_check(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p <> '' $$;
      CREATE DOMAIN public.ma_dom AS text DEFAULT app_private.dom_default() CHECK (app_private.dom_check(VALUE));
      CREATE TABLE public.dom_rows(id int PRIMARY KEY, v public.ma_dom);`);
    const chen = { role: 'authenticated', sql: 'INSERT INTO public.dom_rows(id) VALUES (1) RETURNING v' };
    assert.deepEqual(await probe(pool, chen), { ok: false, code: '42501' });
    assert.deepEqual((await gate(pool)).thieuQuyen, [
      'anon → app_private.dom_check(text) @ pg_constraint', 'anon → app_private.dom_default() @ pg_type',
      'authenticated → app_private.dom_check(text) @ pg_constraint', 'authenticated → app_private.dom_default() @ pg_type',
      'service_role → app_private.dom_check(text) @ pg_constraint', 'service_role → app_private.dom_default() @ pg_type',
      // read-only không INSERT được nên không cần DEFAULT; vẫn cần CHECK (ép kiểu sang domain trong truy vấn đọc cũng chạy CHECK).
      'supabase_read_only_user → app_private.dom_check(text) @ pg_constraint',
    ]);
    await pool('postgres').query(`GRANT EXECUTE ON FUNCTION app_private.dom_default(), app_private.dom_check(text) TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION app_private.dom_check(text) TO supabase_read_only_user;`);
    assert.equal((await gate(pool)).dat, true);
    assert.deepEqual(await probe(pool, chen), { ok: true, v: 'D-1' });
    await pool('postgres').query(`DROP TABLE public.dom_rows; DROP DOMAIN public.ma_dom;
      DROP FUNCTION app_private.dom_default(), app_private.dom_check(text);`);
  });

  await t.test('gate thấy hàm trong view THƯỜNG (không security_invoker), bỏ qua materialized view', async () => {
    // PostgreSQL kiểm EXECUTE của hàm trong MỌI view theo vai đang truy vấn; security_invoker chỉ đổi cách kiểm quyền bảng.
    await pool('postgres').query(`
      CREATE FUNCTION app_private.view_helper(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p || '?' $$;
      CREATE VIEW public.v_thuong AS SELECT id, app_private.view_helper(label) AS nhan FROM public.readings;
      CREATE FUNCTION app_private.mv_helper(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p || '#' $$;
      CREATE MATERIALIZED VIEW public.mv_readings AS SELECT id, app_private.mv_helper(label) AS nhan FROM public.readings;`);
    const doc = (rel) => ({ role: 'authenticated', sql: `SELECT string_agg(nhan, ',' ORDER BY id) AS v FROM public.${rel}` });
    assert.deepEqual(await probe(pool, doc('v_thuong')), { ok: false, code: '42501' });
    assert.deepEqual(await probe(pool, doc('mv_readings')), { ok: true, v: 'cua-toi#,cua-nguoi-khac#' }, 'materialized view không chạy hàm khi đọc');
    assert.deepEqual((await gate(pool)).thieuQuyen, ['anon', 'authenticated', 'service_role', 'supabase_read_only_user']
      .map((r) => `${r} → app_private.view_helper(text) @ pg_rewrite`));
    await pool('postgres').query('GRANT EXECUTE ON FUNCTION app_private.view_helper(text) TO anon, authenticated, service_role, supabase_read_only_user');
    assert.equal((await gate(pool)).dat, true);
    assert.deepEqual(await probe(pool, doc('v_thuong')), { ok: true, v: 'cua-toi?,cua-nguoi-khac?' });
    await pool('postgres').query(`DROP VIEW public.v_thuong; DROP MATERIALIZED VIEW public.mv_readings;
      DROP FUNCTION app_private.view_helper(text), app_private.mv_helper(text);`);
  });

  await t.test('miễn anon chỉ ở đường policy: DEFAULT của bảng anon ghi được vẫn đỏ; miễn tường minh khi RLS chặn anon trước chỉ mục', async () => {
    await pool('postgres').query(`
      CREATE FUNCTION app_private.chi_auth(p boolean) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT p $$;
      GRANT EXECUTE ON FUNCTION app_private.chi_auth(boolean) TO authenticated, service_role;
      CREATE POLICY notices_chi_auth ON public.notices FOR SELECT TO public USING (app_private.chi_auth(visible));`);
    // Policy TO public dùng hàm đã cố ý đóng với anon: anon nhận 42501, đúng ý người đóng — gate miễn.
    assert.deepEqual(await probe(pool, { role: 'anon', sql: 'SELECT count(*)::text AS v FROM public.notices' }), { ok: false, code: '42501' });
    assert.equal((await gate(pool)).dat, true);
    // Kịch bản của reviewer: cùng hàm làm DEFAULT của bảng anon INSERT được (không RLS) — anon chèn lỗi 42501, gate phải đỏ.
    await pool('postgres').query('CREATE TABLE public.mo_cho_anon(id int, ma boolean DEFAULT app_private.chi_auth(true))');
    assert.deepEqual(await probe(pool, { role: 'anon', sql: 'INSERT INTO public.mo_cho_anon(id) VALUES (1) RETURNING ma::text AS v' }),
      { ok: false, code: '42501' });
    assert.deepEqual((await gate(pool)).thieuQuyen, ['anon → app_private.chi_auth(boolean) @ pg_attrdef'], 'đường DEFAULT không được miễn');
    await pool('postgres').query('DROP TABLE public.mo_cho_anon; DROP POLICY notices_chi_auth ON public.notices; DROP FUNCTION app_private.chi_auth(boolean);');

    // Như hai cặp miễn trên production: hàm đã đóng với anon chỉ nằm trong chỉ mục biểu thức của bảng mà RLS WITH CHECK chặn anon
    // ghi. Anon chèn nhận 42501 từ RLS TRƯỚC khi chỉ mục chạy hàm (hành vi không đổi); người được phép chèn bình thường.
    await pool('postgres').query(`
      CREATE FUNCTION app_private.chuan_so(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(p, '[^0-9]', '', 'g') $$;
      GRANT EXECUTE ON FUNCTION app_private.chuan_so(text) TO authenticated, service_role;
      CREATE TABLE public.khach(id int PRIMARY KEY, owner_id uuid DEFAULT auth.uid(), phone text);
      ALTER TABLE public.khach ENABLE ROW LEVEL SECURITY;
      CREATE POLICY khach_ghi ON public.khach FOR INSERT TO public WITH CHECK (owner_id = auth.uid());
      CREATE INDEX khach_phone_idx ON public.khach (app_private.chuan_so(phone));`);
    const chen = (role) => probe(pool, { role, msg: true, sql: "WITH x AS (INSERT INTO public.khach(id, phone) VALUES (1, '090-1')) SELECT 'ok' AS v" });
    const anon = await chen('anon');
    assert.equal(anon.code, '42501');
    assert.match(anon.message, /row-level security/, 'RLS chặn anon trước khi chỉ mục chạy hàm');
    assert.deepEqual(await chen('authenticated'), { ok: true, v: 'ok' });
    const MIEN = { anon: ['app_private.chuan_so(text) @ pg_class'] };
    assert.deepEqual((await gate(pool)).thieuQuyen, ['anon → app_private.chuan_so(text) @ pg_class'], 'chưa miễn thì đỏ');
    assert.deepEqual({ ...(await gate(pool, MIEN)), thua: [] },
      { hamPublic: [], vuotQuyen: [], macDinh: [], thieuQuyen: [], mienThua: [], thua: [], dat: true }, 'miễn tường minh thì xanh');
    // Miễn khoá theo ĐƯỜNG (re-review #392): thêm một view anon đọc được, gọi đúng hàm đã miễn ở chỉ mục — anon đọc view
    // nhận 42501 thật, nên đường mới phải đỏ dù mục miễn của đường chỉ mục vẫn đứng.
    await pool('postgres').query('CREATE VIEW public.v_khach AS SELECT id, app_private.chuan_so(phone) AS so FROM public.khach');
    assert.deepEqual(await probe(pool, { role: 'anon', sql: "SELECT string_agg(so, ',') AS v FROM public.v_khach" }), { ok: false, code: '42501' });
    const duongMoi = await gate(pool, MIEN);
    assert.deepEqual(duongMoi.thieuQuyen,
      ['anon → app_private.chuan_so(text) @ pg_rewrite', 'supabase_read_only_user → app_private.chuan_so(text) @ pg_rewrite'],
      'miễn theo đường: view mới vẫn đỏ');
    assert.deepEqual(duongMoi.mienThua, [], 'đường chỉ mục vẫn còn nên mục miễn không thừa');
    await pool('postgres').query('DROP VIEW public.v_khach');
    // Mục miễn không còn cần (chỉ mục đã bỏ) phải đỏ — danh sách chỉ teo đi.
    await pool('postgres').query('DROP INDEX public.khach_phone_idx');
    const thua = await gate(pool, MIEN);
    assert.equal(thua.dat, false, 'mục miễn thừa thì đỏ (dat)');
    assert.deepEqual(thua.mienThua, ['anon → app_private.chuan_so(text) @ pg_class'], 'mục miễn thừa thì đỏ');
    await pool('postgres').query('DROP TABLE public.khach; DROP FUNCTION app_private.chuan_so(text);');
    assert.equal((await gate(pool)).dat, true);
  });

  await t.test('aggregate không gây đỏ giả: EXECUTE của sfunc kiểm theo CHỦ aggregate, không theo người gọi', async () => {
    await pool('postgres').query(`
      CREATE FUNCTION app_private.agg_cong(s integer, v integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT s + v $$;
      CREATE AGGREGATE public.tong_rieng(integer) (SFUNC = app_private.agg_cong, STYPE = integer, INITCOND = '0');`);
    // authenticated chỉ có EXECUTE trên aggregate (mặc định public), không có trên sfunc — aggregate vẫn chạy.
    const quyen = await pool('supabase_admin').query(`SELECT has_function_privilege('authenticated', 'app_private.agg_cong(integer,integer)', 'EXECUTE') AS sfunc,
      has_function_privilege('authenticated', 'public.tong_rieng(integer)', 'EXECUTE') AS agg`);
    assert.deepEqual(quyen.rows[0], { sfunc: false, agg: true });
    assert.deepEqual(await probe(pool, { role: 'authenticated', sql: 'SELECT public.tong_rieng(x)::text AS v FROM generate_series(1, 3) x' }),
      { ok: true, v: '6' });
    assert.deepEqual((await gate(pool)).thieuQuyen, [], 'aggregate không đòi GRANT sfunc cho người gọi');
    await pool('postgres').query('DROP AGGREGATE public.tong_rieng(integer); DROP FUNCTION app_private.agg_cong(integer, integer);');
  });

  await t.test('DEFAULT của domain chạy cả ở UPDATE … SET col = DEFAULT: vai chỉ có UPDATE vẫn cần', async () => {
    await pool('postgres').query(`
      CREATE FUNCTION app_private.dom_default_sua() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'S-1' $$;
      CREATE DOMAIN public.ma_dom_sua AS text DEFAULT app_private.dom_default_sua();
      CREATE TABLE public.dom_sua(id int PRIMARY KEY, v public.ma_dom_sua);
      INSERT INTO public.dom_sua(id, v) VALUES (1, 'cu');
      REVOKE INSERT ON public.dom_sua FROM anon, authenticated, service_role;`);
    const sua = { role: 'authenticated', sql: 'UPDATE public.dom_sua SET v = DEFAULT WHERE id = 1 RETURNING v' };
    assert.deepEqual(await probe(pool, sua), { ok: false, code: '42501' });
    assert.deepEqual((await gate(pool)).thieuQuyen, ['anon', 'authenticated', 'service_role']
      .map((r) => `${r} → app_private.dom_default_sua() @ pg_type`), 'vai chỉ có UPDATE cũng cần DEFAULT của domain');
    await pool('postgres').query('GRANT EXECUTE ON FUNCTION app_private.dom_default_sua() TO anon, authenticated, service_role');
    assert.equal((await gate(pool)).dat, true);
    assert.deepEqual(await probe(pool, sua), { ok: true, v: 'S-1' });
    await pool('postgres').query('DROP TABLE public.dom_sua; DROP DOMAIN public.ma_dom_sua; DROP FUNCTION app_private.dom_default_sua();');
  });
});
