import { readFileSync } from 'node:fs';
import { fixture, id, USER, ORG, FOREIGN, SESSION, CONNECTION, ACCOUNT } from '../hermes-zalo-router/private-command-fixture.mjs';

// Actual SQL on a disposable PGlite: the candidate hermes_zalo_broadcast_v1, the
// one-shot migration it wraps (20261016101450), the released CRM bodies it calls
// (zalo_luu_tu_dong_hoa, zalo_config_int_v1, zalo_in_allowed_hours_v1, the
// begin_provider/dừng khẩn cấp bodies the one-shot migration attests) and the
// shared Hermes actor/connection/policy functions. CRM authority (RBAC v3,
// zalo_can), the authz audit chain and the legacy Hermes-schedule owner trigger
// are explicit synthetic ports. No PostgREST/JWT/RLS or concurrent MVCC evidence.
export const CANDIDATE = new URL('../../supabase/migrations/20261016111855_hermes_zalo_broadcast_v1.sql', import.meta.url);
const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8').replace(/\r\n/g, '\n');
export const extract = (src, name) => {
  const match = src.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\b[\\s\\S]*?(?:END;?\\s*)?\\$(?:fn)?\\$;`));
  if (!match) throw new Error(`missing ${name}`);
  return match[0];
};
export const ACCOUNT2 = id('e'), FOREIGN_ACCOUNT = id('f');
export const G1 = '10000000-0000-4000-8000-000000000001', G2 = '10000000-0000-4000-8000-000000000002', G3 = '10000000-0000-4000-8000-000000000003',
  G4 = '10000000-0000-4000-8000-000000000004', U1 = '10000000-0000-4000-8000-000000000005', GF = '10000000-0000-4000-8000-000000000006';
export const WHOLE_DAY = { antiSpam: { allowedHours: { from: '00:00', to: '23:59' }, dailyCap: 120 } };
export const binding = Object.freeze({ connectionId: CONNECTION, tokenDigest: 'b'.repeat(64), expectedEpoch: 1, expectedPolicyVersion: 1,
  expectedMembershipId: USER, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 });
export const code = expected => error => error.code === expected;

export async function setupZaloBroadcast(t, { sql = readFileSync(CANDIDATE, 'utf8') } = {}) {
  const f = await fixture(t, { migrations: ['20261013084000_hermes_private_command_dispatch_v1'] }), { db } = f;
  await db.exec(`
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
    ALTER TABLE public.zalo_conversations ADD COLUMN user_id uuid,ADD COLUMN peer_name text NOT NULL DEFAULT '',ADD COLUMN label_ids jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN is_sale_partner boolean NOT NULL DEFAULT false,ADD COLUMN last_message_at timestamptz,ADD COLUMN last_message_dir text;
    CREATE TABLE public.zalo_labels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,account_id uuid,label_id integer NOT NULL,name text NOT NULL,
      organization_id uuid,UNIQUE(account_id,label_id));
    CREATE TABLE public.zalo_automations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,kind text,enabled boolean NOT NULL DEFAULT false,
      config jsonb NOT NULL DEFAULT '{}',stats jsonb NOT NULL DEFAULT '{}',created_at timestamptz DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(organization_id,kind));
    CREATE TABLE public.zalo_automation_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,account_id uuid,conversation_id uuid,kind text,
      mode text,reason text,recipients_count integer DEFAULT 0,messages_count integer DEFAULT 0,detail jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
    CREATE TABLE public.zalo_send_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,conversation_id uuid,account_id uuid,
      message_id uuid,channel text,payload jsonb,status text,not_before timestamptz,created_at timestamptz DEFAULT now(),processing_started_at timestamptz,
      provider_started_at timestamptz,processing_instance_id uuid,attempts integer DEFAULT 0,result jsonb,processed_at timestamptz,last_error text);
    ALTER TABLE public.zalo_messages ADD COLUMN status text;
    CREATE TABLE IF NOT EXISTS app_private.hermes_group_jobs(job_id uuid PRIMARY KEY);
    CREATE FUNCTION app_private.autofill_org_strict() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.organization_id IS NULL THEN RAISE EXCEPTION 'organization_id' USING ERRCODE='23502'; END IF; RETURN NEW; END $$;
    CREATE FUNCTION app_private.zalo_assert_attachment_v1(uuid,jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
    -- updated_at trigger of the real table (set_zalo_automations_updated_at → update_updated_at_column: now()).
    CREATE FUNCTION public.fixture_touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at:=now(); RETURN NEW; END$$;
    CREATE TRIGGER set_zalo_automations_updated_at BEFORE UPDATE ON public.zalo_automations FOR EACH ROW EXECUTE FUNCTION public.fixture_touch();
    -- Stand-in for app_private.hermes_schedule_legacy_owner_v1 (20261014081344): an
    -- ACTIVE Hermes text schedule owning a recipient refuses the CRM write with PT409.
    CREATE TABLE public.fixture_legacy_owner(conversation_id uuid PRIMARY KEY);
    CREATE FUNCTION public.fixture_legacy_owner_check() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.enabled AND EXISTS(SELECT 1 FROM public.fixture_legacy_owner o WHERE NEW.config->'recipients' ? o.conversation_id::text) THEN
        RAISE EXCEPTION 'hermes_schedule_owner_conflict' USING ERRCODE='PT409'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER hermes_schedule_legacy_owner BEFORE INSERT OR UPDATE ON public.zalo_automations FOR EACH ROW EXECUTE FUNCTION public.fixture_legacy_owner_check();
    -- CRM authority port: RBAC v3 decision and zalo_can read the same switches.
    CREATE TABLE public.fixture_authority(view_zalo boolean NOT NULL,send_zalo boolean NOT NULL,manage_zalo boolean NOT NULL);
    INSERT INTO public.fixture_authority VALUES(true,true,true);
    CREATE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid,p_org uuid,p_key text,p_building uuid DEFAULT NULL,p_cashbook uuid DEFAULT NULL)
      RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz) LANGUAGE sql AS $$
      SELECT p_actor='${USER}'::uuid AND p_org='${ORG}'::uuid AND CASE p_key WHEN 'chat_zalo.view' THEN view_zalo WHEN 'chat_zalo.send' THEN send_zalo
        WHEN 'chat_zalo.manage_automation' THEN manage_zalo ELSE false END,1::bigint,NULL::timestamptz FROM public.fixture_authority$$;
    CREATE FUNCTION public.zalo_authorized_org_ids(p_action text) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT '${ORG}'::uuid FROM public.fixture_authority WHERE auth.uid()='${USER}'::uuid AND CASE p_action WHEN 'view' THEN view_zalo
        WHEN 'send' THEN send_zalo WHEN 'manage_automation' THEN manage_zalo ELSE false END$$;
    CREATE FUNCTION public.zalo_can(_action text,_org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT _org IN (SELECT public.zalo_authorized_org_ids(_action))$$;
    CREATE TABLE public.fixture_audit(event text,resource text,resource_id uuid,metadata jsonb);
    CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,e text,k text,i uuid,old_state jsonb DEFAULT NULL,new_state jsonb DEFAULT NULL,reason text DEFAULT NULL)
      RETURNS uuid LANGUAGE sql AS $$INSERT INTO public.fixture_audit VALUES(e,k,i,new_state) RETURNING gen_random_uuid()$$;
    INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('chat_zalo.view','read',true),('chat_zalo.send','action',true),
      ('chat_zalo.manage_automation','action',true) ON CONFLICT(capability) DO UPDATE SET enabled=true,mode=EXCLUDED.mode;
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['chat_zalo.view'],action_capabilities=ARRAY['chat_zalo.manage_automation','chat_zalo.send'];
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['chat_zalo.view'],action_capabilities=ARRAY['chat_zalo.manage_automation','chat_zalo.send'];
    INSERT INTO public.zalo_accounts(id,organization_id,user_id,kind,status,name) VALUES
      ('${ACCOUNT2}','${ORG}','${USER}','personal','connected','Nick Hai'),('${FOREIGN_ACCOUNT}','${FOREIGN}','${USER}','personal','connected','Nick ngoài');
    INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,unread_count,peer_name,label_ids,is_sale_partner) VALUES
      ('${G1}','${ACCOUNT}','${ORG}','group','g1',0,'Nhóm MG Quận 7','[1]',true),
      ('${G2}','${ACCOUNT2}','${ORG}','group','g2',0,'Môi giới Bình Thạnh','[1]',true),
      ('${G3}','${ACCOUNT}','${ORG}','group','g3',0,'Nhóm khách thuê MG','[1]',false),
      ('${G4}','${ACCOUNT}','${ORG}','group','g4',0,'Đối tác Thủ Đức','[2]',true),
      ('${U1}','${ACCOUNT}','${ORG}','user','u1',0,'Anh Sale lẻ','[1]',true),
      ('${GF}','${FOREIGN_ACCOUNT}','${FOREIGN}','group','gf',0,'Nhóm MG ngoài','[1]',true);
    INSERT INTO public.zalo_labels(account_id,label_id,name,organization_id) VALUES('${ACCOUNT}',1,'Group MG IHOME','${ORG}'),
      ('${ACCOUNT2}',1,'Group MG IHOME','${ORG}'),('${ACCOUNT}',2,'Đối tác','${ORG}'),('${FOREIGN_ACCOUNT}',1,'Group MG IHOME','${FOREIGN}');
  `);
  const forward = source('20261014000503_hermes_optional_org_policy_v1');
  for (const name of ['app_private.hermes_effective_org_policy_v1', 'app_private.hermes_private_command_connection_v1', 'app_private.hermes_session_gate_v1',
    'app_private.hermes_store_read_connection_v1']) await db.exec(extract(forward, name));
  await db.exec(extract(source('20261014081344_hermes_room_schedule_v1'), 'app_private.hermes_schedule_actor_v1'));
  await db.exec(extract(source('20260830163815_zalo_tu_dong_hoa_broadcast_va_auto_reply'), 'public.zalo_luu_tu_dong_hoa'));
  const queue = source('20261011052259_zalo_rpc_only_scope_va_atomic_queue');
  for (const name of ['app_private.zalo_config_int_v1', 'app_private.zalo_in_allowed_hours_v1', 'public.zalo_dung_khan_cap']) await db.exec(extract(queue, name));
  // Released begin_provider plus the 20261013170125 Hermes line: the body the one-shot migration attests.
  await db.exec(extract(queue, 'public.zalo_worker_begin_provider_v1').replace('BEGIN\n  PERFORM 1 FROM public.zalo_worker_lease',
    'BEGIN\n  IF EXISTS(SELECT 1 FROM app_private.hermes_group_jobs WHERE job_id=p_job_id) THEN RETURN false; END IF;\n  PERFORM 1 FROM public.zalo_worker_lease'));
  const oneshot = source('20261016101450_zalo_broadcast_oneshot_v1');
  await db.exec(oneshot); await db.exec(oneshot);
  // 20261016110539 (P2.2): the stop holds until a later save/toggle of EITHER automation row.
  // Only this body is used here; its begin_provider/claim patches attest worker bodies outside this fixture.
  await db.exec(extract(source('20261016110539_zalo_broadcast_oneshot_review_fixes_v1'), 'app_private.zalo_dang_dung_khan_cap_v1'));
  await db.exec(sql); await db.exec(sql);

  async function as(sqlText, params, { role = 'authenticated', actor = USER } = {}) {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",
      [role, actor ?? '', SESSION]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    try { const value = (await db.query(sqlText, params)).rows[0].v; await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  let requests = 0;
  const call = (operation, input, { requestId, b = binding, role, actor } = {}) => as('SELECT public.hermes_zalo_broadcast_v1($1::jsonb) v',
    [JSON.stringify({ binding: { ...b, requestId: requestId ?? input?.requestId ?? `20000000-0000-4000-8000-${String(++requests).padStart(12, '0')}` }, operation, input })],
    { role, actor });
  const setConfig = (config, enabled = false) => db.query(`INSERT INTO public.zalo_automations(organization_id,kind,enabled,config) VALUES($3,'broadcast_vacant',$2,$1::jsonb)
    ON CONFLICT(organization_id,kind) DO UPDATE SET config=EXCLUDED.config,enabled=EXCLUDED.enabled`, [JSON.stringify(config), enabled, ORG]);
  const row = async () => (await db.query("SELECT enabled,config,updated_at FROM public.zalo_automations WHERE organization_id=$1 AND kind='broadcast_vacant'", [ORG])).rows[0];
  const scalar = async (text, params = []) => (await db.query(text, params)).rows[0].v;
  return { f, db, call, as, setConfig, row, scalar };
}

/** A window that excludes the current Vietnam minute (handles the overnight form too). */
export async function windowExcludingNow(db) {
  const minute = (await db.query("SELECT (extract(hour FROM clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')*60+extract(minute FROM clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int v")).rows[0].v;
  const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  return { from: hhmm(minute + 120), to: hhmm(minute + 130) };
}

export { USER, ORG, FOREIGN, SESSION, CONNECTION, ACCOUNT, id };
