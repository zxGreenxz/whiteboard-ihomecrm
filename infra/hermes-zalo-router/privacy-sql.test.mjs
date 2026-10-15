import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';

// Disposable, in-memory PostgreSQL with minimal fixture tables and explicit
// Auth/RBAC stubs. Exercises actual P4 SQL; not Supabase, JWT or concurrent MVCC.
const migration = readFileSync(new URL('../../supabase/migrations/20261012165523_hermes_zalo_binding_v1.sql', import.meta.url), 'utf8');
const foundation = readFileSync(new URL('../../supabase/migrations/20261012062043_hermes_encrypted_session_store_v1.sql', import.meta.url), 'utf8');
const legacySend = readFileSync(new URL('../../supabase/migrations/20260813110000_zalo_gui_media_va_idempotency.sql', import.meta.url), 'utf8');
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ORG=id('1'), USER=id('2'), ACCOUNT=id('3'), OTHER=id('4'), INSTANCE=id('5'), DM=id('6'), GROUP=id('7'), OTHER_DM=id('8');
const OTHER_ORG=id('9'), MISSING=id('a');

test('private DM SQL executes on a disposable fixture and protects every shared write path', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE hermes_store_executor NOLOGIN;
    CREATE SCHEMA app_private; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.organizations(id uuid PRIMARY KEY);
    CREATE TABLE public.zalo_accounts(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations, user_id uuid, kind text, status text, name text, zalo_uid text, login_requested_at timestamptz);
    CREATE TABLE public.zalo_worker_lease(id text PRIMARY KEY, instance_id uuid, heartbeat_at timestamptz);
    -- Match the relevant baseline keys/FK actions; account_id and thread_id are
    -- key columns, while thread_type and preview fields are not.
    CREATE TABLE public.zalo_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES public.zalo_accounts ON DELETE SET NULL,
      user_id uuid NOT NULL DEFAULT '${USER}', organization_id uuid NOT NULL REFERENCES public.organizations,
      thread_type text NOT NULL CHECK(thread_type IN ('user','group')), thread_id text, peer_zalo_uid text,
      last_message_text text, unread_count integer DEFAULT 0, last_message_at timestamptz, last_message_dir text, updated_at timestamptz,
      UNIQUE(account_id,thread_id));
    CREATE TABLE public.zalo_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES public.zalo_accounts ON DELETE SET NULL,
      organization_id uuid NOT NULL REFERENCES public.organizations, conversation_id uuid NOT NULL REFERENCES public.zalo_conversations ON DELETE CASCADE, user_id uuid,
      direction text, msg_type text, body text, zalo_msg_id text, zalo_raw jsonb, created_at timestamptz DEFAULT clock_timestamp(),
      media_url text, media_label text, media_meta jsonb, media_tone text, reply_to jsonb, reaction_emoji text, reactions jsonb DEFAULT '{}',
      status text, cli_msg_id text, client_dedup_key text, sent_by uuid, sent_at timestamptz);
    CREATE TABLE public.zalo_send_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid,
      conversation_id uuid REFERENCES public.zalo_conversations ON DELETE CASCADE, message_id uuid REFERENCES public.zalo_messages ON DELETE CASCADE,
      account_id uuid REFERENCES public.zalo_accounts ON DELETE SET NULL, channel text, payload jsonb, status text);
    CREATE TABLE app_private.hermes_assistants(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, state text);
    CREATE TABLE app_private.hermes_sessions(id uuid PRIMARY KEY, state text, expires_at timestamptz);
    CREATE TABLE app_private.hermes_connections(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, assistant_id uuid, credential_ref uuid, state text, epoch bigint);
    CREATE TABLE app_private.hermes_org_policies(organization_id uuid PRIMARY KEY, enabled boolean);
    CREATE TABLE app_private.hermes_connection_tokens(connection_id uuid, revoked_at timestamptz, expires_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
    CREATE FUNCTION public.zalo_can(action text, org uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT action='send' AND org='${ORG}'::uuid AND auth.uid()='${USER}'::uuid
    $$;
    CREATE FUNCTION app_private.hermes_member_v1(u uuid,o uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      IF u IS DISTINCT FROM '${USER}'::uuid OR o IS DISTINCT FROM '${ORG}'::uuid THEN RAISE EXCEPTION 'fixture_member_denied' USING ERRCODE='42501'; END IF;
    END $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(o uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      PERFORM 1 FROM public.organizations WHERE id=o FOR NO KEY UPDATE;
    END $$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION app_private.require_perm_v1(o uuid,k text,reason text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      IF NOT k=ANY(string_to_array(current_setting('fixture.permissions',true),',')) THEN RAISE EXCEPTION 'fixture_permission_denied' USING ERRCODE='42501'; END IF;
    END $$;
    CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,event text,kind text,entity uuid,prev jsonb,next jsonb,reason text)
      RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT SELECT,INSERT,UPDATE ON public.zalo_messages,public.zalo_conversations TO service_role;
    INSERT INTO auth.users VALUES('${USER}'); INSERT INTO public.organizations VALUES('${ORG}'),('${OTHER_ORG}');
    INSERT INTO public.zalo_accounts VALUES('${ACCOUNT}','${ORG}','${USER}','personal','connected','Fixture bot','123',null),
      ('${OTHER}','${ORG}','${USER}','personal','connected','Fixture shared','999',null);
    INSERT INTO public.zalo_worker_lease VALUES('singleton','${INSTANCE}',clock_timestamp());
    INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_zalo_uid) VALUES
      ('${DM}','${ACCOUNT}','${ORG}','user','456','456'),('${GROUP}','${ACCOUNT}','${ORG}','group','789',null),
      ('${OTHER_DM}','${OTHER}','${ORG}','user','456','456');
  `);
  const validators=splitSqlStatements(foundation).filter(statement => /CREATE OR REPLACE FUNCTION app_private\.hermes_(?:request|uuid|integer)_v1\(/.test(statement));
  assert.equal(validators.length,3,'use the three real CRM input validators');
  for (const statement of validators) await db.exec(statement);
  // Load only the actual legacy send functions and dedup index, not the legacy
  // migration's storage setup or acceptance fixture. Calls below are sequential.
  const sendStatements=splitSqlStatements(legacySend).filter(statement =>
    /CREATE OR REPLACE FUNCTION public\.zalo_send_(?:message|media)\(/.test(statement)
    || /CREATE UNIQUE INDEX IF NOT EXISTS zalo_messages_client_dedup_uidx/.test(statement));
  assert.equal(sendStatements.length,3,'use both real legacy send functions and their dedup index');
  for (const statement of sendStatements) await db.exec(statement);
  await db.exec(migration); await db.exec(migration);
  async function roleCall(role, action) {
    await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true),set_config('fixture.permissions',$3,true)",
      [USER, role, 'users.edit,chat_zalo.manage_automation']);
    try { const result=await action(); await db.exec('COMMIT'); return result; }
    catch(error) { await db.exec('ROLLBACK'); throw error; }
  }
  const privacy = (overrides={}, role='service_role') => roleCall(role, async () =>
    (await db.query('SELECT public.hermes_zalo_ingress_v1($1::jsonb) AS data', [JSON.stringify({operation:'privacy', accountId:ACCOUNT,
      organizationId:ORG,instanceId:INSTANCE,accountOwnerId:USER,ownUid:'123',loginRequestedAt:null,...overrides})])).rows[0].data);
  const configure = (enabled, version) => roleCall('authenticated', async () =>
    (await db.query('SELECT public.hermes_zalo_binding_v1($1::jsonb) AS data', [JSON.stringify({operation:'setBot',organizationId:ORG,
      accountId:ACCOUNT,expectedVersion:version,enabled})])).rows[0].data);
  const insert = (body, account=ACCOUNT, conversation=DM, extra={}) => roleCall('service_role', () => db.query(`
    INSERT INTO public.zalo_messages(account_id,organization_id,conversation_id,user_id,msg_type,direction,body,zalo_raw,media_url,media_meta,reply_to)
    VALUES($1,$2,$3,$4,'text','in',$5,$6::jsonb,$7,$8::jsonb,$9::jsonb) RETURNING *`, [account,ORG,conversation,USER,body,
      JSON.stringify(extra.raw ?? {uidFrom:'456',idTo:'123'}),extra.url ?? null,JSON.stringify(extra.meta ?? null),JSON.stringify(extra.quote ?? null)]));
  const denied = work => assert.rejects(work, error => error.code==='42501');
  // Roll back even an unexpectedly accepted mutation so each regression gets
  // the same identity fixture when the unfixed SQL is run for red evidence.
  async function deniedChange(statement, parameters) {
    await db.exec('BEGIN; SET LOCAL ROLE service_role;');
    try {
      await assert.rejects(db.query(statement,parameters), error => error.code==='42501' && error.message.includes('hermes_private_channel'));
    } finally { await db.exec('ROLLBACK'); }
  }
  const send = (conversation,body,dedup) => roleCall('authenticated', () => db.query(`
    SELECT * FROM public.zalo_send_message(p_conversation_id => $1::uuid,p_body => $2::text,p_cli_msg_id => $3::text)`,[conversation,body,dedup]));
  async function assertLegacyPreview(conversation, label) {
    const first=(await send(conversation,label,label)).rows[0];
    const retry=(await send(conversation,'ignored sequential retry',label)).rows[0];
    assert.equal(retry.id,first.id);
    assert.equal(first.body,label);
    const preview=(await db.query('SELECT * FROM public.zalo_conversations WHERE id=$1',[conversation])).rows[0];
    assert.equal(preview.last_message_text,label);
    assert.equal(preview.last_message_dir,'out');
    assert(preview.last_message_at);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.zalo_send_queue WHERE message_id=$1',[first.id])).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.zalo_messages WHERE conversation_id=$1 AND client_dedup_key=$2',[conversation,label])).rows[0].n,1);
  }
  let legacy, linkRow, groupRow;
  await t.test('unconfigured account resolves shared and supports the legacy inbox', async () => {
    assert.deepEqual(await privacy(), {status:'shared',accountId:ACCOUNT,organizationId:ORG});
    legacy=(await insert('pre-configuration',null)).rows[0].id;
    assert.equal((await insert('shared body')).rows[0].body,'shared body');
  });
  await t.test('legacy send updates an ordinary account preview and sequential dedup returns the same row', async () => {
    await assertLegacyPreview(DM,'ordinary preview');
  });
  await t.test('enabling commits a permanent private channel; stale classification cannot authorize a later write', async () => {
    assert.equal((await configure(true,0)).version,1);
    assert.equal((await privacy()).status,'private');
    await denied(insert('PRIVATE_LATE_AFTER_ENABLE'));
    await denied(insert('PRIVATE_NULL_ACCOUNT',null));
  });
  await t.test('group messages and another unconfigured account still accept content', async () => {
    groupRow=(await insert('Group rooms',ACCOUNT,GROUP)).rows[0];
    assert.equal(groupRow.body,'Group rooms');
    assert.equal((await insert('Shared customer',OTHER,OTHER_DM)).rows[0].body,'Shared customer');
  });
  for (const [name,conversation] of [['shared account',OTHER_DM],['retained bot group',GROUP]]) {
    await t.test(`legacy text/media sends and preview updates remain allowed for ${name}`, async () => {
      await assertLegacyPreview(conversation,`${name} preview`);
      const media=(await roleCall('authenticated',()=>db.query(`SELECT * FROM public.zalo_send_media(
        p_conversation_id => $1::uuid,p_kind => 'image',p_media => $2::jsonb,p_caption => $3::text,p_cli_msg_id => $4::text)`,
      [conversation,JSON.stringify([{url:'https://invalid.test/fixture.png',size:10}]),`${name} media`,`${name} media key`]))).rows[0];
      assert.equal(media.msg_type,'image');
      const preview=(await roleCall('service_role',()=>db.query(`UPDATE public.zalo_conversations
        SET unread_count=4,thread_type=thread_type,thread_id=thread_id WHERE id=$1 RETURNING last_message_text,unread_count`,[conversation]))).rows[0];
      assert.deepEqual(preview,{last_message_text:`${name} media`,unread_count:4});
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.zalo_send_queue WHERE message_id=$1',[media.id])).rows[0].n,1);
    });
  }
  await t.test('preview and unread updates cannot expose private content', async () => {
    const result=await roleCall('service_role',()=>db.query('UPDATE public.zalo_conversations SET last_message_text=$1,unread_count=4 WHERE id=$2 RETURNING *',['PRIVATE_PREVIEW',DM]));
    assert.equal(result.rows[0].last_message_text,'[Hermes private - hidden]'); assert.equal(result.rows[0].unread_count,0);
  });
  await t.test('link rows contain only numeric identity and a fixed marker; quoted/media content is discarded', async () => {
    const row=(await insert('[Hermes link - hidden]',ACCOUNT,DM,{raw:{uidFrom:'456',idTo:'123',content:'PRIVATE_RAW',propertyExt:'PRIVATE_PROPERTY'},
      url:'https://invalid.test/PRIVATE_MEDIA',meta:{caption:'PRIVATE_CAPTION'},quote:{text:'PRIVATE_QUOTE'}})).rows[0];
    linkRow=row;
    assert.deepEqual(row.zalo_raw,{uidFrom:'456',idTo:'123',msgType:'webchat',content:'[Hermes link - hidden]'});
    assert.equal(row.media_url,null); assert.equal(row.media_meta,null); assert.equal(row.reply_to,null);
    assert(!JSON.stringify(row).includes('PRIVATE_'));
    await denied(insert('[Hermes link - hidden]',ACCOUNT,DM,{raw:{uidFrom:'PRIVATE_ID',idTo:'123'}}));
  });
  await t.test('changing parent, company or thread type cannot reclassify protected rows as shared', async () => {
    await denied(roleCall('service_role',()=>db.query('UPDATE public.zalo_messages SET conversation_id=$1,body=$2 WHERE id=$3',[OTHER_DM,'PRIVATE_REPARENT',legacy])));
    await denied(roleCall('service_role',()=>db.query("UPDATE public.zalo_conversations SET thread_type='group' WHERE id=$1",[DM])));
    await denied(roleCall('service_role',()=>db.query('UPDATE public.zalo_conversations SET account_id=$1 WHERE id=$2',[OTHER,DM])));
    await denied(roleCall('service_role',()=>db.query('UPDATE public.zalo_conversations SET organization_id=$1 WHERE id=$2',[OTHER,DM])));
    await denied(insert('PRIVATE_MISMATCH',OTHER,DM));
  });
  for (const [name,conversation,type,thread] of [['DM',DM,'user','456'],['group',GROUP,'group','789']]) {
    await t.test(`retained bot ${name} thread type and id are immutable`, async () => {
      await deniedChange('UPDATE public.zalo_conversations SET thread_type=$1 WHERE id=$2',[type==='group'?'user':'group',conversation]);
      await deniedChange('UPDATE public.zalo_conversations SET thread_id=$1 WHERE id=$2',['987',conversation]);
      await deniedChange('UPDATE public.zalo_conversations SET thread_id=NULL WHERE id=$1',[conversation]);
      assert.deepEqual((await db.query('SELECT thread_type,thread_id FROM public.zalo_conversations WHERE id=$1',[conversation])).rows[0],{thread_type:type,thread_id:thread});
    });
    await t.test(`retained bot ${name} cannot escape through account or company changes`, async () => {
      for (const account of [OTHER,null]) await deniedChange('UPDATE public.zalo_conversations SET account_id=$1 WHERE id=$2',[account,conversation]);
      await deniedChange('UPDATE public.zalo_conversations SET organization_id=$1 WHERE id=$2',[OTHER_ORG,conversation]);
      await deniedChange('UPDATE public.zalo_conversations SET account_id=$1,organization_id=$2 WHERE id=$3',[OTHER,OTHER_ORG,conversation]);
    });
  }
  await t.test('nullable accounts, forged accounts and parent moves cannot bypass retained bot message identity', async () => {
    await denied(insert('PRIVATE_NULL_GROUP',null,GROUP));
    await denied(insert('PRIVATE_FORGED_GROUP',OTHER,GROUP));
    await denied(insert('PRIVATE_FORGED_SHARED',ACCOUNT,OTHER_DM));
    for (const message of [legacy,linkRow.id,groupRow.id]) {
      for (const account of [OTHER,null]) await deniedChange('UPDATE public.zalo_messages SET account_id=$1,body=$2 WHERE id=$3',[account,'PRIVATE_ACCOUNT_ESCAPE',message]);
      await deniedChange('UPDATE public.zalo_messages SET organization_id=$1 WHERE id=$2',[OTHER_ORG,message]);
      await deniedChange('UPDATE public.zalo_messages SET conversation_id=$1,account_id=$2,body=$3 WHERE id=$4',[OTHER_DM,OTHER,'PRIVATE_PARENT_ESCAPE',message]);
    }
    await deniedChange('UPDATE public.zalo_messages SET conversation_id=$1 WHERE id=$2',[GROUP,linkRow.id]);
    await deniedChange('UPDATE public.zalo_messages SET conversation_id=$1 WHERE id=$2',[DM,groupRow.id]);
  });
  await t.test('account organization changes cannot authorize messages with a mismatched parent organization', async () => {
    for (const organization of [ORG,OTHER_ORG]) {
      await db.exec('BEGIN;');
      try {
        await db.query('UPDATE public.zalo_accounts SET organization_id=$1 WHERE id=$2',[OTHER_ORG,ACCOUNT]);
        await db.exec('SET LOCAL ROLE service_role;');
        await denied(db.query(`INSERT INTO public.zalo_messages(account_id,organization_id,conversation_id,user_id,msg_type,body,zalo_raw)
          VALUES($1,$2,$3,$4,'text','[Hermes link - hidden]','{"uidFrom":"456","idTo":"123"}')`,[ACCOUNT,organization,DM,USER]));
      } finally { await db.exec('ROLLBACK'); }
    }
  });
  await t.test('missing parents fail and sequential deletes preserve the baseline FK behavior', async () => {
    await denied(insert('[Hermes link - hidden]',ACCOUNT,MISSING));
    await assert.rejects(insert('orphan shared',OTHER,MISSING),error=>error.code==='23503');
    await assert.rejects(insert('null parent shared',OTHER,null),error=>error.code==='23502');
    // A delete racing a key-share holder must wait in PostgreSQL. This fixture
    // checks only the FK outcome after ordering those operations sequentially.
    await db.exec('BEGIN;');
    try {
      await db.query('DELETE FROM public.zalo_conversations WHERE id=$1',[GROUP]);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.zalo_messages WHERE conversation_id=$1',[GROUP])).rows[0].n,0);
      await denied(db.query(`INSERT INTO public.zalo_messages(account_id,organization_id,conversation_id,msg_type,body)
        VALUES($1,$2,$3,'text','orphan group')`,[ACCOUNT,ORG,GROUP]));
    } finally { await db.exec('ROLLBACK'); }
    await assert.rejects(db.query('DELETE FROM public.zalo_accounts WHERE id=$1',[ACCOUNT]),error=>error.code==='23503' || (error.code==='42501' && error.message.includes('hermes_private_channel')));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_private.hermes_zalo_bots WHERE account_id=$1',[ACCOUNT])).rows[0].n,1);
  });
  await t.test('disabling the bot retains privacy without requiring a usable registration', async () => {
    assert.equal((await configure(false,1)).version,2);
    assert.equal((await privacy()).status,'private');
    await denied(insert('PRIVATE_AFTER_DISABLE'));
    await denied(privacy({operation:'register'}));
  });
  await t.test('disabled retained bot groups keep immutable identity while previews remain writable', async () => {
    await deniedChange("UPDATE public.zalo_conversations SET thread_type='user' WHERE id=$1",[GROUP]);
    await deniedChange("UPDATE public.zalo_conversations SET thread_id='987' WHERE id=$1",[GROUP]);
    await assertLegacyPreview(GROUP,'disabled group preview');
  });
  await t.test('privacy response is bound to role, owner, company and login snapshot', async () => {
    await denied(privacy({},'authenticated'));
    await denied(privacy({organizationId:OTHER}));
    for(const overrides of [{accountOwnerId:OTHER},{ownUid:'999'},{loginRequestedAt:'2026-10-13T00:00:00Z'}])
      await assert.rejects(privacy(overrides), error=>error.code==='PT409');
    await denied(roleCall('service_role',()=>db.query('SELECT * FROM app_private.hermes_zalo_bots')));
  });
  await t.test('expired worker lease closes the privacy query rather than claiming shared', async () => {
    await db.exec("UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()-interval '31 seconds'");
    await denied(privacy());
  });
  await t.test('negative control proves private body becomes writable if the database fence is removed', async () => {
    await db.exec('BEGIN; ALTER TABLE public.zalo_messages DISABLE TRIGGER hermes_zalo_private_message_guard;');
    try {
      const result=await db.query(`INSERT INTO public.zalo_messages(account_id,organization_id,conversation_id,user_id,msg_type,direction,body)
        VALUES($1,$2,$3,$4,'text','in','NEGATIVE_CONTROL_LEAK') RETURNING body`,[ACCOUNT,ORG,DM,USER]);
      assert.equal(result.rows[0].body,'NEGATIVE_CONTROL_LEAK');
    } finally { await db.exec('ROLLBACK'); }
    await denied(insert('FENCE_RESTORED'));
  });
});
