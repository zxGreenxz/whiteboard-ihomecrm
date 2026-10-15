import {readFileSync} from 'node:fs';
import {setup} from '../hermes-broker/group-preview-sql-fixture.mjs';
import {ORG,USER,INSTANCE,SESSION,GENERATION,FOREIGN} from './private-command-fixture.mjs';

// Actual candidate SQL on a disposable fixture; synthetic CRM authority/sale
// facts are explicit ports, not evidence of real JWT/RLS or MVCC behavior.
const sql=readFileSync(new URL('../../supabase/migrations/20261013170125_hermes_group_authorized_queue_v1.sql',import.meta.url),'utf8');
const queueBase=readFileSync(new URL('../../supabase/migrations/20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql',import.meta.url),'utf8');
const workerBegin=queueBase.match(/CREATE OR REPLACE FUNCTION public\.zalo_worker_begin_provider_v1[\s\S]*?END \$\$;/)[0];

export async function installGroupSendSql(x){
  const {f,BUILDING,ROOM,GROUP}=x;
  await f.db.exec(`
    ALTER TABLE public.zalo_conversations ADD COLUMN user_id uuid,ADD COLUMN last_message_at timestamptz,ADD COLUMN last_message_dir text,ADD COLUMN updated_at timestamptz;
    ALTER TABLE public.zalo_messages ADD COLUMN user_id uuid,ADD COLUMN sent_by uuid,ADD COLUMN status text,ADD COLUMN sent_at timestamptz,ADD COLUMN client_dedup_key text;
    ALTER TABLE public.buildings ADD COLUMN user_id uuid,ADD COLUMN name text,ADD COLUMN code text,ADD COLUMN is_virtual boolean DEFAULT false;
    UPDATE public.buildings SET user_id='${USER}',name='Synthetic building',code='B';
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz,status text,name text,code text,area numeric,rent_price numeric);
    INSERT INTO public.rooms VALUES('${ROOM}','${ORG}','${BUILDING}',NULL,'VACANT','101','101',25,5000000);
    CREATE TABLE public.public_room_settings(owner_id uuid,organization_id uuid,soon_days integer);
    CREATE TABLE public.room_pass_listings(id uuid,room_id uuid,user_id uuid,organization_id uuid,active boolean);
    CREATE TABLE public.zalo_automations(id uuid,organization_id uuid,kind text,enabled boolean,config jsonb);
    CREATE TABLE public.zalo_send_queue(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,account_id uuid,conversation_id uuid,message_id uuid REFERENCES public.zalo_messages(id),
      channel text,payload jsonb,status text,created_at timestamptz DEFAULT clock_timestamp(),not_before timestamptz,processing_started_at timestamptz,
      processing_instance_id uuid,provider_started_at timestamptz,attempts integer DEFAULT 0,result jsonb,processed_at timestamptz,last_error text);
    CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid,p_organization_id uuid,p_permission_key text,p_building_id uuid DEFAULT NULL,p_cashbook_id uuid DEFAULT NULL)
      RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz,evaluated_at timestamptz,decision_reason text)
      LANGUAGE sql AS $$SELECT p_actor='${USER}'::uuid AND p_organization_id='${ORG}'::uuid AND CASE p_permission_key
        WHEN 'chat_zalo.send' THEN send_zalo AND org_wide WHEN 'chat_zalo.view' THEN view_zalo AND org_wide
        WHEN 'rooms.view' THEN rooms AND p_building_id='${BUILDING}'::uuid ELSE false END,version,NULL::timestamptz,clock_timestamp(),'fixture'::text FROM public.fixture_authority$$;
    CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_fact_v1(p_room_id uuid,p_organization_id uuid,p_room_status text,p_has_pass boolean,p_soon_days integer)
      RETURNS TABLE(status_public text,sale_state text,avail_date date,sale_today date,expected_ready_on date) LANGUAGE sql STABLE AS $$
      SELECT r->>'status_public',r->>'sale_state',(r->>'avail_date')::date,(r->>'sale_today')::date,(r->>'expected_ready_on')::date
      FROM public.fixture_rooms CROSS JOIN LATERAL jsonb_array_elements(payload->'rooms') r WHERE r->>'id'=p_room_id::text$$;
    UPDATE public.zalo_accounts SET user_id='${FOREIGN}';
    UPDATE app_private.hermes_zalo_ingress_sessions SET account_owner_id='${FOREIGN}';
    UPDATE public.zalo_conversations SET user_id='${FOREIGN}';
    UPDATE public.copilot_feature_flags SET state='disabled';
    UPDATE app_private.copilot_action_registry SET enabled=false;
    SELECT set_config('request.jwt.claim.sub','${USER}',false),set_config('request.jwt.claim.session','${SESSION}',false);
  `);
  await f.db.exec(workerBegin); await f.db.exec(sql); await f.db.exec(sql);
  async function request(overrides={}){
    const base={...x.baseline};
    const directory=await f.rpc('public.hermes_group_directory_v1',base,'authenticated');
    return {...base,roomIds:[ROOM],conversationIds:[GROUP],expectedContextVersion:directory.authority.contextVersion,
      intentDigest:'c'.repeat(64),roomReadDigest:'d'.repeat(64),...overrides};
  }
  async function provider(jobId,overrides={},generic=false){
    await f.db.exec('SAVEPOINT provider; SET LOCAL ROLE service_role');
    await f.db.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
    try {
      const result=generic ? await f.db.query('SELECT public.zalo_worker_begin_provider_v1($1,$2) AS ok',[jobId,INSTANCE]) :
        await f.db.query('SELECT public.zalo_worker_begin_hermes_group_provider_v1($1,$2,$3::jsonb) AS ok',[jobId,INSTANCE,JSON.stringify({
          method:'sendMessage',body:'PHÒNG ĐÃ CHỌN\n1. Synthetic building · 101 | 25 m² | 5.000.000 đ/tháng | Trống sẵn',
          threadId:'987',threadType:'group',ownUid:'123',generation:GENERATION,...overrides})]);
      await f.db.exec('RELEASE SAVEPOINT provider'); return result.rows[0].ok;
    }catch(error){await f.db.exec('ROLLBACK TO SAVEPOINT provider; RELEASE SAVEPOINT provider');throw error;}
    finally{await f.db.exec('RESET ROLE');}
  }
  const send=p=>f.rpc('public.hermes_group_send_v1',p,'authenticated');
  async function status(id){
    await f.db.query("SELECT set_config('request.jwt.claim.role','authenticated',true)");
    return (await f.db.query('SELECT public.hermes_group_send_status_v1($1) AS value',[id])).rows[0].value;
  }
  return {...x,request,send,provider,status};
}

export async function setupGroupSendSql(t){return installGroupSendSql(await setup(t));}
