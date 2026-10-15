import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { installGroupSendSql } from '../hermes-zalo-router/group-send-sql-fixture.mjs';
import { setupMount, token } from './group-preview-fixture.mjs';
import { ORG, USER, INSTANCE, SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';
import { applyNotifyRetryDigest, notifyRetryDigestSql } from './notify-retry-digest-fixture.mjs';

// Actual candidate SQL (schedule v1 + health/reconcile + notify digest forward migrations) on a
// disposable PGlite fixture. CRM authority, sale facts, timezone, push JWT and
// pg_net are explicit synthetic ports: NOT Supabase JWT/RLS, MVCC or delivery.
const root = new URL('../../supabase/migrations/', import.meta.url);
const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
export const candidate = slug => {
  const names = readdirSync(root).filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  if (names.length !== 1) throw new Error(`expected one ${slug} migration`);
  return readFileSync(new URL(names[0], root), 'utf8');
};
export const SCHEDULE = '56789012-1234-4567-8123-123456789abc';
export const NEXT = '67890123-1234-4567-8123-123456789abc';

export async function setupScheduleHealth(t, { reconcile = false, hooks = {}, digest = notifyRetryDigestSql() } = {}) {
  const x = await setupMount(t, hooks), { f, BUILDING } = x, db = f.db;
  Object.assign(x, await installGroupSendSql(x));
  await db.exec(migration('20261013095000_hermes_zalo_private_reply_v1'));
  await db.exec(migration('20261014000503_hermes_optional_org_policy_v1'));
  await db.exec(migration('20261014000538_hermes_external_group_connector_v1'));
  await db.exec(`CREATE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Asia/Ho_Chi_Minh'::text$$;
    ALTER TABLE public.fixture_authority ADD COLUMN manage_schedule boolean DEFAULT true;
    INSERT INTO app_private.hermes_capabilities VALUES('chat_zalo.manage_automation','action',true);
    UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.send','chat_zalo.manage_automation'];
    UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['chat_zalo.send','chat_zalo.manage_automation'];
    CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid,p_organization_id uuid,p_permission_key text,p_building_id uuid DEFAULT NULL,p_cashbook_id uuid DEFAULT NULL)
      RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz,evaluated_at timestamptz,decision_reason text)
      LANGUAGE sql AS $$SELECT p_actor='${USER}'::uuid AND p_organization_id='${ORG}'::uuid AND CASE p_permission_key
        WHEN 'chat_zalo.send' THEN send_zalo AND org_wide WHEN 'chat_zalo.view' THEN view_zalo AND org_wide
        WHEN 'chat_zalo.manage_automation' THEN manage_schedule AND org_wide WHEN 'rooms.view' THEN rooms AND p_building_id='${BUILDING}'::uuid ELSE false END,
        version,NULL::timestamptz,clock_timestamp(),'fixture'::text FROM public.fixture_authority$$;
    ALTER TABLE public.rooms ADD COLUMN sale_note text;
    ALTER TABLE public.public_room_settings ADD COLUMN sale_policy text;
    CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid NOT NULL,type text NOT NULL,
      channel text NOT NULL,status text,subject text,content text NOT NULL CHECK(char_length(content)>0),metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE public.fixture_push(enabled boolean NOT NULL);
    INSERT INTO public.fixture_push VALUES(false);
    -- Marked-TEST behaviour by default: the reminder JWT slot refuses, so only
    -- the bell row is written. A case may flip the port to observe pg_net.
    CREATE FUNCTION app_private.lifecycle_reminder_service_jwt_v1() RETURNS text LANGUAGE plpgsql AS $$
      BEGIN IF NOT (SELECT enabled FROM public.fixture_push) THEN RAISE EXCEPTION 'fixture TEST marker' USING ERRCODE='55000'; END IF;
        RETURN 'fixture.service.jwt'; END $$;
    CREATE SCHEMA net;
    CREATE TABLE net.fixture_requests(id bigserial PRIMARY KEY,url text,body jsonb,headers jsonb);
    CREATE FUNCTION net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO net.fixture_requests(url,body,headers) VALUES(url,body,headers) RETURNING id$$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;`);
  const draft = candidate('hermes_room_schedule_v1');
  await db.exec(draft); await db.exec(draft);
  const health = candidate('hermes_schedule_health_v1');
  await db.exec(health); await db.exec(health);
  if (reconcile) { const sql = candidate('hermes_delivery_reconcile_v1'); await db.exec(sql); await db.exec(sql); }
  // Latest sweep: 20261015181525 groups owner notices (applied twice);
  // digest:null keeps the health migration's per-incident sweep.
  if (digest !== null) await applyNotifyRetryDigest(db, digest);
  const binding = { ...x.baseline, tokenDigest: createHash('sha256').update(token).digest('hex') };
  delete binding.commandId; delete binding.claimId;
  const temporal = (await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI') time,
    extract(isodow FROM clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::integer weekday`)).rows[0];
  const settings = (template = 'rooms_public_text_v1', overrides = {}) => ({ template, buildingIds: [BUILDING], conversationIds: [x.GROUP],
    weekdays: [temporal.weekday], time: temporal.time, timeZone: 'Asia/Ho_Chi_Minh', maxRooms: 20, maxMessagesPerDay: 8,
    expiresAt: new Date(Date.now() + 10 * 86400000).toISOString(), ...overrides });
  // The production worker renews its 30-second lease independently; this
  // fixture has no background worker, so each boundary renews it explicitly.
  const heartbeat = () => db.exec('UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()');
  const provider = x.provider;
  x.provider = async (...args) => { await heartbeat(); return provider(...args); };
  async function manage(operation, input, { version = 1, liveWorker = true } = {}) {
    if (liveWorker) await heartbeat();
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session',$2,false)", [USER, SESSION]);
    return f.rpc(`public.hermes_room_schedule_manage_v${version}`, { binding, operation, input }, 'authenticated');
  }
  async function worker(name, params, { liveWorker = true } = {}) {
    if (liveWorker) await heartbeat();
    await db.exec('SAVEPOINT schedule_worker; SET LOCAL ROLE service_role');
    await db.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
    try {
      const result = await db.query(`SELECT public.${name}(${params.map((_, i) => '$' + (i + 1)).join(',')}) result`, params);
      await db.exec('RELEASE SAVEPOINT schedule_worker'); return result.rows[0].result;
    } catch (error) { await db.exec('ROLLBACK TO SAVEPOINT schedule_worker; RELEASE SAVEPOINT schedule_worker'); throw error; }
    finally { await db.exec('RESET ROLE'); }
  }
  const run = (id = SCHEDULE, revision = 1) => worker('hermes_room_schedule_run_v2', [id, revision, INSTANCE]);
  const runV1 = (id = SCHEDULE, revision = 1) => worker('hermes_room_schedule_run_v1', [id, revision, INSTANCE]);
  const probe = (id = SCHEDULE) => worker('hermes_room_schedule_probe_v1', [id, INSTANCE]);
  const sweep = (orgs = [ORG]) => worker('hermes_room_schedule_sweep_v1', [INSTANCE, orgs]);
  const incidents = async () => (await db.query(`SELECT kind,reason,occurrences,detail,notified_at IS NOT NULL notified,closed_at IS NOT NULL closed,
    close_reason,closed_notified_at IS NOT NULL closed_notified FROM app_private.hermes_schedule_incidents ORDER BY opened_at,id`)).rows;
  const notifications = async () => (await db.query('SELECT user_id,organization_id,type,channel,subject,content,metadata FROM public.notifications ORDER BY created_at,id')).rows;
  const count = async sql => (await db.query(`SELECT count(*)::integer n FROM ${sql}`)).rows[0].n;
  // Human CRM caller (JWT role authenticated) for the reconciliation RPCs.
  async function ui(name, arg, sub = USER) {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session',$2,false)", [sub, SESSION]);
    if (name === 'list') {
      await db.exec('SAVEPOINT ui_call; SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true)");
      try { const value = (await db.query('SELECT public.hermes_delivery_reconcile_list_v1($1::uuid) result', [arg])).rows[0].result;
        await db.exec('RELEASE SAVEPOINT ui_call'); return value; }
      catch (error) { await db.exec('ROLLBACK TO SAVEPOINT ui_call; RELEASE SAVEPOINT ui_call'); throw error; }
      finally { await db.exec('RESET ROLE'); }
    }
    return f.rpc('public.hermes_delivery_reconcile_resolve_v1', arg, 'authenticated');
  }
  // Fixture-only: bypass immutable/authority triggers to age a row in time.
  async function ageRow(sql, params = []) {
    await db.exec("SET session_replication_role='replica'");
    try { await db.query(sql, params); } finally { await db.exec("SET session_replication_role='origin'"); }
  }
  const markUnknown = jobId => db.query(`UPDATE public.zalo_send_queue SET status='failed',processed_at=clock_timestamp(),
    last_error='UNKNOWN_EFFECT: cần đối soát, không tự gửi lại. PROVIDER_TIMEOUT',result='{"outcome":"unknown","requires_reconciliation":true,"provider_message_ids":[]}'::jsonb
    WHERE id=$1`, [jobId]);
  const jobs = async () => (await db.query('SELECT id,status,payload,result,last_error,hermes_group_dispatch_id FROM public.zalo_send_queue ORDER BY created_at,id')).rows;
  const each = (name, body) => t.test(name, () => f.rollbackCase(async () => { await heartbeat(); await body(); }));
  return { ...x, db, binding, settings, temporal, heartbeat, manage, worker, run, runV1, probe, sweep, incidents, notifications, count, ui,
    ageRow, markUnknown, jobs, each };
}
