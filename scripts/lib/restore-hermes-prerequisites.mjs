// Disposable restore adapter, not a migration or an apply-lane prerequisite.
// The schema-only legacy lane deliberately stops before creating these objects.
// Reconstruct just the dependencies consumed by Hermes, AFTER observing the
// original stops. Never seed DEMO, invent an authorization helper, replay a whole
// legacy migration, or replace a definition already installed by a later file.
import { createHash } from 'node:crypto';
import { splitSqlStatements, extractFunctionDefinitions } from '../network-center-function-bodies.mjs';

export const HERMES_RESTORE_BEFORE = '20261012061447_hermes_assistant_identity_policy_v1.sql';
export const HERMES_RESTORE_SOURCES = Object.freeze({
  '20260813110000_zalo_gui_media_va_idempotency.sql': '95d9a6ed4bc075d76e63bb8f024330d183e96e43d00bb18cf870b6d32aefe8c4',
  '20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql': '2b3c8502062e033c1c28c2b5120f346fe87056fd4adb033cddfa883fa556cc26',
});
const BODY_SHA = '2310b70ca4b48ba39cbda53f5baba9df5995f8c3eb028965f52dbd55f12a9402';
const SIGNATURE = 'public.zalo_worker_begin_provider_v1(uuid,uuid)';
const STOPS = Object.freeze({
  '20260813110000_zalo_gui_media_va_idempotency.sql': 'zalo_authorized_org_ids(unknown) does not exist',
  '20260830163815_zalo_tu_dong_hoa_broadcast_va_auto_reply.sql': 'zalo_authorized_org_ids(unknown) does not exist',
  '20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql': 'relation "public.zalo_automation_runs" does not exist',
});
const sha256 = text => createHash('sha256').update(text).digest('hex');
const leadingComments = text => text.replace(/^(?:\s|--[^\n]*(?:\n|$))*/, '');

export function assertHermesRestoreStops(results, expectations) {
  for (const [file, message] of Object.entries(STOPS)) {
    const rows = results.filter(result => result.ten === file);
    if (expectations[file]?.kyVong !== 'cascade' || expectations[file]?.thongDiep !== message
      || rows.length !== 1 || rows[0].ok !== false || !String(rows[0].stderr).includes(message)) {
      throw Error(`Hermes restore prerequisite stop mismatch: ${file}`);
    }
  }
}

export function buildHermesRestoreFixture(sources) {
  const statements = Object.entries(HERMES_RESTORE_SOURCES).map(([file, digest]) => {
    const text = sources[file]?.replaceAll('\r\n', '\n');
    if (typeof text !== 'string' || sha256(text) !== digest) throw Error(`Hermes restore source digest mismatch: ${file}`);
    return splitSqlStatements(text).map(leadingComments);
  });
  const exactlyOne = (list, pattern) => {
    const matches = list.filter(statement => pattern.test(statement));
    if (matches.length !== 1) throw Error(`Hermes restore source statement mismatch: ${pattern}`);
    return matches[0];
  };
  const lease = [
    /^CREATE TABLE IF NOT EXISTS public\.zalo_worker_lease \(/,
    /^ALTER TABLE public\.zalo_worker_lease ENABLE ROW LEVEL SECURITY$/,
    /^REVOKE ALL ON public\.zalo_worker_lease FROM anon, authenticated$/,
    /^GRANT SELECT, INSERT, UPDATE, DELETE ON public\.zalo_worker_lease TO service_role$/,
  ].map(pattern => exactlyOne(statements[0], pattern));
  const result = exactlyOne(statements[0], /^ALTER TABLE public\.zalo_send_queue ADD COLUMN IF NOT EXISTS result jsonb$/);
  const provider = exactlyOne(statements[1], /^CREATE OR REPLACE FUNCTION public\.zalo_worker_begin_provider_v1\(/);
  if (extractFunctionDefinitions(provider)[0]?.bodyDigest !== BODY_SHA) throw Error('Hermes restore provider body mismatch');
  // The original grants share a statement with claim/recover functions. Select
  // only this exact signature; retain the original privilege and recipient list.
  const targets = 'public.zalo_worker_claim_job_v1(uuid,uuid),public.zalo_worker_begin_provider_v1(uuid,uuid),public.zalo_worker_recover_jobs_v1(uuid)';
  const acl = [
    `REVOKE ALL ON FUNCTION ${targets} FROM PUBLIC,anon,authenticated`,
    `GRANT EXECUTE ON FUNCTION ${targets} TO service_role`,
  ].map(expected => {
    const statement = statements[1].filter(item => item === expected);
    if (statement.length !== 1) throw Error('Hermes restore provider ACL source mismatch');
    return statement[0].replace(targets, SIGNATURE);
  });
  return `BEGIN;
SET LOCAL search_path=public,pg_catalog;
DO $before$ BEGIN
  IF current_user <> 'postgres' OR to_regclass('public.zalo_worker_lease') IS NOT NULL
    OR to_regprocedure('${SIGNATURE}') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.zalo_send_queue'::regclass AND attname='result' AND NOT attisdropped)
    OR to_regclass('public.zalo_automation_runs') IS NOT NULL
    OR to_regprocedure('public.zalo_authorized_org_ids(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Hermes restore before catalog drift';
  END IF;
END $before$;
${[result, ...lease, provider, ...acl].join(';\n')};
${hermesRestoreWitnessSql()}
COMMIT;`;
}

export function hermesRestoreWitnessSql() {
  // ACLs include Supabase's platform-shim defaults. In particular service_role
  // has the original table's ALL grant; this adapter does not silently narrow
  // or widen it. The source hash pins column/default/check/PK DDL verbatim.
  // PG18 also catalogs NOT NULL as contype=n. attnotnull checks it exactly on
  // both PG17 (the drill) and PGlite's PG18 engine, so omit that duplicate form.
  return `DO $witness$ DECLARE f record; t record; BEGIN
  SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') body,
    proowner::regrole::text owner, proacl::text acl, provolatile, prosecdef, proconfig
    INTO f FROM pg_proc WHERE oid=to_regprocedure('${SIGNATURE}');
  IF NOT FOUND OR f.body IS DISTINCT FROM '${BODY_SHA}' OR f.owner IS DISTINCT FROM 'postgres'
    OR f.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR f.provolatile IS DISTINCT FROM 'v'::"char" OR f.prosecdef IS DISTINCT FROM true
    OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
    RAISE EXCEPTION 'Hermes restore provider witness drift';
  END IF;
  SELECT relowner::regrole::text owner, relacl::text acl, relrowsecurity, relforcerowsecurity
    INTO t FROM pg_class WHERE oid=to_regclass('public.zalo_worker_lease');
  IF NOT FOUND OR t.owner IS DISTINCT FROM 'postgres'
    OR t.acl IS DISTINCT FROM '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'
    OR t.relrowsecurity IS DISTINCT FROM true OR t.relforcerowsecurity IS DISTINCT FROM false
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.zalo_worker_lease'::regclass)
    OR EXISTS(SELECT 1 FROM public.zalo_worker_lease) THEN
    RAISE EXCEPTION 'Hermes restore lease witness drift';
  END IF;
  IF (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.zalo_worker_lease'::regclass AND a.attnum>0 AND NOT a.attisdropped)
    IS DISTINCT FROM '[ ["id","text",true,"''singleton''::text"], ["instance_id","uuid",true,null], ["hostname","text",false,null],
      ["heartbeat_at","timestamp with time zone",true,"now()"], ["claimed_at","timestamp with time zone",true,"now()"] ]'::jsonb
    OR (SELECT jsonb_agg(jsonb_build_array(conname,contype,pg_get_constraintdef(oid)) ORDER BY conname)
      FROM pg_constraint WHERE conrelid='public.zalo_worker_lease'::regclass AND contype<>'n')
    IS DISTINCT FROM '[ ["zalo_worker_lease_id_check","c","CHECK ((id = ''singleton''::text))"], ["zalo_worker_lease_pkey","p","PRIMARY KEY (id)"] ]'::jsonb THEN
    RAISE EXCEPTION 'Hermes restore lease structure witness drift';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.zalo_send_queue'::regclass AND a.attname='result' AND NOT a.attisdropped
      AND a.atttypid='jsonb'::regtype AND NOT a.attnotnull AND a.attgenerated='' AND d.oid IS NULL) THEN
    RAISE EXCEPTION 'Hermes restore result column witness drift';
  END IF;
END $witness$;`;
}
