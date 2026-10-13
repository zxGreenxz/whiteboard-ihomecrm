import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Real foundation/member/session validators and candidate functions on minimal
// disposable CRM tables. No provider, Supabase JWT or concurrent MVCC evidence.
const sql = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const candidate = sql('20261013055055_hermes_zalo_private_command_v1');
export const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
export const ORG=id('1'),USER=id('2'),ACCOUNT=id('3'),INSTANCE=id('4'),ASSISTANT=id('5'),SESSION=id('6'),CONNECTION=id('7');
export const BINDING=id('8'),GENERATION=id('9'),CHALLENGE=id('a'),CONVERSATION=id('b'),MESSAGE=id('c'),FOREIGN=id('d');

export async function fixture(t, { migrations = [] } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA app_private; CREATE SCHEMA auth;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text,authorization_version bigint DEFAULT 1);
    CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,status text,revoked_at timestamptz,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
    CREATE TABLE public.zalo_accounts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,kind text,status text,name text,zalo_uid text,login_requested_at timestamptz);
    CREATE TABLE public.zalo_worker_lease(id text PRIMARY KEY,instance_id uuid,heartbeat_at timestamptz);
    CREATE TABLE public.zalo_conversations(id uuid PRIMARY KEY,account_id uuid,organization_id uuid,thread_type text,thread_id text,peer_zalo_uid text,last_message_text text,unread_count integer);
    CREATE TABLE public.zalo_messages(id uuid PRIMARY KEY,account_id uuid,organization_id uuid,conversation_id uuid,direction text,msg_type text,body text,zalo_msg_id text,zalo_raw jsonb,created_at timestamptz,
      media_url text,media_label text,media_meta jsonb,media_tone text,reply_to jsonb,reaction_emoji text,reactions jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(o uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      PERFORM 1 FROM public.organizations WHERE id=o AND status='ACTIVE' FOR NO KEY UPDATE;
    END $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    INSERT INTO auth.users VALUES('${USER}');
    INSERT INTO public.organizations VALUES('${ORG}','ACTIVE',1),('${FOREIGN}','ACTIVE',1);
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${USER}','${USER}','${ORG}','ACTIVE');
    INSERT INTO public.zalo_accounts VALUES('${ACCOUNT}','${ORG}','${USER}','personal','connected','Synthetic bot','123',null);
    INSERT INTO public.zalo_worker_lease VALUES('singleton','${INSTANCE}',clock_timestamp());
    INSERT INTO public.zalo_conversations VALUES('${CONVERSATION}','${ACCOUNT}','${ORG}','user','456','456',null,0);
    INSERT INTO public.zalo_messages(id,account_id,organization_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw,created_at)
      VALUES('${MESSAGE}','${ACCOUNT}','${ORG}','${CONVERSATION}','in','text','[Hermes link - hidden]','link','{}',clock_timestamp());
  `);
  await db.exec(sql('20261012061447_hermes_assistant_identity_policy_v1'));
  await db.exec(sql('20261012062043_hermes_encrypted_session_store_v1'));
  await db.exec(sql('20261012165523_hermes_zalo_binding_v1'));
  await db.exec(candidate); await db.exec(candidate);
  for (const migration of migrations) { await db.exec(sql(migration)); await db.exec(sql(migration)); }
  // Verified-binding and encrypted-credential fixtures, not a claim that the
  // handshake or Auth token can be created through this test's private intake.
  await db.exec(`
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${ASSISTANT}','${ORG}','${USER}');
    INSERT INTO app_private.hermes_org_policies(organization_id,enabled,updated_by) VALUES('${ORG}',true,'${USER}');
    INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
      VALUES('${SESSION}','${ASSISTANT}','${ORG}','${USER}','${SESSION}','ACTIVE','{}',clock_timestamp()+interval '1 hour');
    INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id)
      VALUES('${CONNECTION}','${ASSISTANT}','${ORG}','${USER}','ACTIVE','${SESSION}',repeat('a',64),clock_timestamp()+interval '1 hour','${CONNECTION}');
    INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(repeat('b',64),'${CONNECTION}',clock_timestamp()+interval '10 minutes');
    INSERT INTO app_private.hermes_zalo_bots(account_id,organization_id,enabled,updated_by) VALUES('${ACCOUNT}','${ORG}',true,'${USER}');
    INSERT INTO app_private.hermes_zalo_ingress_sessions(account_id,organization_id,account_owner_id,instance_id,generation,own_uid,registered_at)
      VALUES('${ACCOUNT}','${ORG}','${USER}','${INSTANCE}','${GENERATION}','123',clock_timestamp()-interval '1 minute');
    INSERT INTO app_private.hermes_zalo_link_challenges(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,
      challenge_digest,created_at,expires_at,state,candidate_version,sender_uid,conversation_id,message_id,ingress_generation)
      VALUES('${CHALLENGE}','${USER}','${ORG}','${ASSISTANT}','${CONNECTION}',1,'${ACCOUNT}',1,repeat('c',64),clock_timestamp(),clock_timestamp()+interval '1 minute',
      'CONFIRMED',1,'456','${CONVERSATION}','${MESSAGE}','${GENERATION}');
    INSERT INTO app_private.hermes_zalo_bindings(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,sender_uid,conversation_id,challenge_id)
      VALUES('${BINDING}','${USER}','${ORG}','${ASSISTANT}','${CONNECTION}',1,'${ACCOUNT}',1,'456','${CONVERSATION}','${CHALLENGE}');
  `);
  const sentAt=Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS time')).rows[0].time);
  const request={operation:'acceptPrivateCommand',accountId:ACCOUNT,organizationId:ORG,instanceId:INSTANCE,generation:GENERATION,
    senderUid:'456',providerMessageId:'live-1',sentAt,text:'PRIVATE: xem các phòng trống'};
  let inCase=false;
  async function rollbackCase(work) {
    await db.exec('BEGIN'); inCase=true;
    try { await work(); } finally { await db.exec('ROLLBACK; RESET ROLE'); inCase=false; }
  }
  async function rpc(name, payload, role='hermes_store_executor') {
    if (!/^(?:public|app_private)\.hermes_[a-z0-9_]+$/.test(name) || !['anon','authenticated','service_role','hermes_store_executor'].includes(role)) throw new Error('invalid_fixture_rpc');
    await db.exec(inCase ? 'SAVEPOINT rpc_call' : 'BEGIN');
    await db.exec(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claim.role',$1,false)",[role]);
    try {
      const result=(await db.query(`SELECT ${name}($1::jsonb) AS result`,[JSON.stringify(payload)])).rows[0].result;
      await db.exec(inCase ? 'RELEASE SAVEPOINT rpc_call' : 'COMMIT'); return result;
    } catch(error) { await db.exec(inCase ? 'ROLLBACK TO SAVEPOINT rpc_call; RELEASE SAVEPOINT rpc_call' : 'ROLLBACK'); throw error; }
    finally { await db.exec('RESET ROLE'); }
  }
  const call = (overrides={},role='service_role') => rpc('public.hermes_zalo_private_command_v1',{...request,...overrides},role);
  return {db,call,rpc,request,rollbackCase};
}
