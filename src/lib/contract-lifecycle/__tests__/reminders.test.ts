import { readFileSync, existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const db = new PGlite();
const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '11111111-1111-4111-8111-111111111112';
const user = '22222222-2222-4222-8222-222222222222';
const deniedUser = '22222222-2222-4222-8222-222222222223';
const building = '33333333-3333-4333-8333-333333333333';
const otherBuilding = '33333333-3333-4333-8333-333333333334';
const room = '44444444-4444-4444-8444-444444444444';
const contract = '55555555-5555-4555-8555-555555555555';
const path = 'supabase/migrations/20260928024843_lifecycle_reminders.sql';

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('${user}'),('${deniedUser}');
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);
    INSERT INTO public.organizations VALUES('${org}','ACTIVE'),('${otherOrg}','ACTIVE');
    CREATE TABLE public.organization_memberships(organization_id uuid,user_id uuid,status text,valid_from timestamptz,valid_to timestamptz);
    INSERT INTO public.organization_memberships VALUES('${org}','${user}','ACTIVE',null,null),('${org}','${deniedUser}','ACTIVE',null,null);
    CREATE TABLE public.super_admins(user_id uuid);
    CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT '{}'::uuid[] $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,deleted_at timestamptz);
    INSERT INTO public.buildings VALUES('${building}','${org}','${user}',null),('${otherBuilding}','${otherOrg}','${user}',null);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text,deleted_at timestamptz);
    INSERT INTO public.rooms VALUES('${room}','${org}','${building}','AVAILABLE',null);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text,actual_end_date date,expected_move_out_date date,deleted_at timestamptz,updated_at timestamptz);
    INSERT INTO public.contracts VALUES('${contract}','${org}','${room}','ACTIVE',null,now()::date,null,now());
    CREATE TABLE public.room_turnovers(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text,expected_ready_on date,version bigint,epoch integer);
    INSERT INTO public.room_turnovers VALUES(gen_random_uuid(),'${org}','${room}','PENDING',null,1,1);
    CREATE TABLE public.contract_exit_cases(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,state text,version bigint);
    INSERT INTO public.contract_exit_cases VALUES(gen_random_uuid(),'${org}','${building}','PENDING',1);
    CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,type text,channel text,subject text,content text,organization_id uuid,metadata jsonb,status text,push_state text);
    CREATE TABLE public.push_subscriptions(user_id uuid,is_active boolean);
    CREATE TABLE public.push_send_log(idempotency_key text PRIMARY KEY,outcome text,sent integer);
    CREATE TABLE public.notification_preferences(user_id uuid,organization_id uuid,event_key text,in_app boolean,push boolean,cadence text,
      CONSTRAINT notification_preferences_event_key_ck CHECK(event_key IN ('E1','E2','E3','E4','E5','E6')));
    CREATE TABLE app_private.notification_org_config(organization_id uuid,events jsonb,quiet_start smallint,quiet_end smallint);
    INSERT INTO app_private.notification_org_config VALUES('${org}','{}',0,0);
    CREATE FUNCTION app_private.notification_events_normalize_v1(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE k text[]:=array['E1','E2','E3','E4','E5','E6']; BEGIN RETURN $1; END $$;
    CREATE FUNCTION app_private.notification_prefs_normalize_v1(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE k text[]:=array['E1','E2','E3','E4','E5','E6']; BEGIN RETURN $1; END $$;
    CREATE FUNCTION app_private.notification_prefs_read_v1(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_agg(k) FROM (values ('E1'),('E2'),('E3'),('E4'),('E5'),('E6')) k $$;
    CREATE TABLE test_clock(local_now timestamp);
    INSERT INTO test_clock VALUES(date_trunc('day',now())+interval '8 hours');
    CREATE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'UTC'::text $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT local_now::date FROM test_clock $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    CREATE TABLE test_permissions(user_id uuid,organization_id uuid,building_id uuid,permission text,allowed boolean);
    INSERT INTO test_permissions VALUES('${user}','${org}','${building}','buildings.view',true),('${user}','${org}','${building}','contracts.view',true),('${user}','${org}','${building}','rooms.view',true);
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
      SELECT coalesce((SELECT p.allowed FROM test_permissions p WHERE p.user_id=$1 AND p.organization_id=$2 AND p.permission=$3 AND p.building_id=$4),false) $$;
  `);
  // Controlled org clock, same SQL implementation after replacing only its clock expression.
  if (existsSync(path)) {
    const sql = readFileSync(path, 'utf8').split("clock_timestamp() AT TIME ZONE app_private.org_timezone_v1(v_org.id)").join('(SELECT test_clock.local_now FROM test_clock)');
    await db.exec(sql);
    await db.exec(sql);
  }
}, 30000);
afterAll(async () => { await db.close(); });
const sweep = () => db.query<{ result: { inserted: number } }>('SELECT public.lifecycle_reminder_sweep_v1($1) result', [org]);
const claim = () => db.query<{ result: Array<{ id: string; lease: string; idempotency_key: string }> }>('SELECT public.lifecycle_reminder_claim_v1(10) result');

it('runs without browser, deduplicates all three families per user/org/day, and cannot mutate occupancy', async () => {
  expect((await sweep()).rows[0].result.inserted).toBe(3);
  expect((await sweep()).rows[0].result.inserted).toBe(0);
  expect((await db.query('SELECT * FROM public.notifications')).rows).toHaveLength(3);
  expect((await db.query('SELECT DISTINCT user_id,organization_id,push_state,status FROM public.notifications')).rows)
    .toEqual([{ user_id: user, organization_id: org, push_state: null, status: 'PENDING' }]);
  expect((await db.query('SELECT status FROM public.rooms')).rows[0]).toEqual({ status: 'AVAILABLE' });
  expect((await db.query('SELECT * FROM app_private.lifecycle_reminder_deliveries')).rows).toHaveLength(3);
});

it('new same-day source refreshes the existing inbox count/refs without another push or unread reset', async () => {
  await db.exec('BEGIN;');
  try {
    const original = (await db.query<{id:string;notification_id:string}>("SELECT id,notification_id FROM app_private.lifecycle_reminder_deliveries WHERE source_family='NOTICE'")).rows[0];
    await db.query("UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SENT',attempts=1,idempotency_key='accepted-attempt' WHERE id=$1",[original.id]);
    await db.query("UPDATE public.notifications SET status='READ' WHERE id=$1",[original.notification_id]);
    await db.exec(`INSERT INTO public.rooms VALUES('44444444-4444-4444-8444-444444444445','${org}','${building}','AVAILABLE',null);
      INSERT INTO public.contracts VALUES('55555555-5555-4555-8555-555555555556','${org}','44444444-4444-4444-8444-444444444445','ACTIVE',null,now()::date,null,now());`);
    expect((await sweep()).rows[0].result.inserted).toBe(0);
    const inbox = (await db.query<{metadata:{count:number;sources:Array<{id:string}>};status:string;content:string}>('SELECT metadata,status,content FROM public.notifications WHERE id=$1',[original.notification_id])).rows[0];
    expect(inbox.metadata.count).toBe(2);
    expect(inbox.metadata.sources).toHaveLength(2);
    expect(inbox.content).toContain('2 việc');
    expect(inbox.status).toBe('READ');
    expect((await db.query("SELECT push_status,attempts,idempotency_key FROM app_private.lifecycle_reminder_deliveries WHERE id=$1",[original.id])).rows[0])
      .toEqual({push_status:'SENT',attempts:1,idempotency_key:'accepted-attempt'});
    expect((await sweep()).rows[0].result.inserted).toBe(0);
    expect((await db.query('SELECT * FROM public.notifications')).rows).toHaveLength(3);
    await db.exec("UPDATE public.contracts SET status='TERMINATED';");
    await sweep();
    expect((await db.query<{metadata:{count:number;sources:unknown[]}}>('SELECT metadata FROM public.notifications WHERE id=$1',[original.notification_id])).rows[0].metadata)
      .toMatchObject({count:0,sources:[]});
  } finally { await db.exec('ROLLBACK;'); }
});

it('records NO_DEVICE explicitly without claiming success and retains the operational queue after inbox read', async () => {
  expect((await claim()).rows[0].result).toEqual([]);
  expect((await db.query('SELECT DISTINCT push_status FROM app_private.lifecycle_reminder_deliveries')).rows).toEqual([{ push_status: 'NO_DEVICE' }]);
  await db.exec("UPDATE public.notifications SET status='READ';");
  expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.room_turnovers WHERE status='PENDING' AND expected_ready_on IS NULL")).rows[0].n).toBe(1);
});

it('new-day catch-up respects per-building authorization and removes resolved sources before drain', async () => {
  await db.exec("UPDATE test_clock SET local_now=local_now+interval '1 day'; INSERT INTO public.push_subscriptions VALUES('"+user+"',true);");
  expect((await sweep()).rows[0].result.inserted).toBe(3);
  await db.exec("UPDATE public.room_turnovers SET status='READY';");
  const batch = (await claim()).rows[0].result;
  expect(batch).toHaveLength(2);
  await db.exec("UPDATE test_permissions SET allowed=false WHERE permission='contracts.view';");
  for (const item of batch) {
    const validation = await db.query<{ result: unknown }>('SELECT public.lifecycle_reminder_validate_v1($1,$2) result', [item.id,item.lease]);
    expect(validation.rows[0].result).toBeNull();
  }
  expect((await db.query<{n:number}>("SELECT count(*)::int n FROM app_private.lifecycle_reminder_deliveries WHERE push_status='SKIPPED'")).rows[0].n).toBe(3);
  await db.exec("UPDATE test_permissions SET allowed=true;");
});

it('retry persists failure, uses a fresh provider attempt key, and never treats DUPLICATE as SENT without receipt', async () => {
  await db.exec("UPDATE test_clock SET local_now=local_now+interval '1 day';");
  await sweep();
  const first = (await claim()).rows[0].result[0];
  expect(first).toBeDefined();
  await db.query('SELECT public.lifecycle_reminder_settle_v1($1,$2,$3,$4,$5)', [first.id,first.lease,'DUPLICATE',0,'ambiguous duplicate']);
  expect((await db.query<{push_status:string}>('SELECT push_status FROM app_private.lifecycle_reminder_deliveries WHERE id=$1',[first.id])).rows[0].push_status).toBe('PENDING');
  await db.exec("UPDATE app_private.lifecycle_reminder_deliveries SET next_attempt_at=now()-interval '1 minute' WHERE push_status='PENDING';");
  const retried = (await claim()).rows[0].result.find(x=>x.id===first.id)!;
  expect(retried.idempotency_key).not.toBe(first.idempotency_key);
  await db.query('INSERT INTO public.push_send_log VALUES($1,$2,$3)', [retried.idempotency_key,'SENT',1]);
  await db.query('SELECT public.lifecycle_reminder_settle_v1($1,$2,$3,$4,$5)', [retried.id,retried.lease,'SENT',1,null]);
  expect((await db.query<{push_status:string}>('SELECT push_status FROM app_private.lifecycle_reminder_deliveries WHERE id=$1',[first.id])).rows[0].push_status).toBe('SENT');
  await expect(db.query('SELECT public.lifecycle_reminder_settle_v1($1,$2,$3,$4,$5)', [retried.id,first.lease,'SENT',1,null])).rejects.toMatchObject({code:'PT409'});
});

it('service-only RPCs/private outbox reject authenticated callers; missing recipients are visible', async () => {
  await db.exec("UPDATE test_permissions SET allowed=false; UPDATE test_clock SET local_now=local_now+interval '1 day';");
  const result = (await sweep()).rows[0].result;
  expect(result.inserted).toBe(0);
  expect((await db.query<{no_recipient_families:string[]}>('SELECT no_recipient_families FROM app_private.lifecycle_reminder_runs ORDER BY finished_at DESC LIMIT 1')).rows[0].no_recipient_families).toEqual(['NOTICE','EXIT']);
  await db.exec('SET ROLE authenticated;');
  await expect(db.query('SELECT public.lifecycle_reminder_sweep_v1(null)')).rejects.toMatchObject({code:'42501'});
  await expect(db.query('SELECT * FROM app_private.lifecycle_reminder_deliveries')).rejects.toMatchObject({code:'42501'});
  await db.exec('RESET ROLE;');
});

it('membership expiry and another organization/building deny recipients even with a forged allow witness', async () => {
  await db.exec("UPDATE test_permissions SET allowed=true; UPDATE public.organization_memberships SET valid_to=now()-interval '1 minute' WHERE user_id='"+user+"';");
  expect((await db.query<{allowed:boolean}>('SELECT app_private.lifecycle_recipient_allowed_v1($1,$2,$3,$4) allowed',[user,org,building,'NOTICE'])).rows[0].allowed).toBe(false);
  await db.exec("UPDATE public.organization_memberships SET valid_to=null; INSERT INTO test_permissions VALUES('"+user+"','"+org+"','"+otherBuilding+"','buildings.view',true),('"+user+"','"+org+"','"+otherBuilding+"','contracts.view',true);");
  expect((await db.query<{allowed:boolean}>('SELECT app_private.lifecycle_recipient_allowed_v1($1,$2,$3,$4) allowed',[user,org,otherBuilding,'NOTICE'])).rows[0].allowed).toBe(false);
});

it('before 08:00 creates no digest; catch-up respects organization and personal preference gates', async () => {
  await db.exec("UPDATE test_clock SET local_now=date_trunc('day',local_now)+interval '1 day 7 hours';");
  expect((await sweep()).rows[0].result.inserted).toBe(0);
  await db.exec("UPDATE test_clock SET local_now=local_now+interval '1 hour'; INSERT INTO public.notification_preferences VALUES('"+user+"','"+org+"','LIFECYCLE',false,false,'OFF');");
  const before = (await db.query<{n:number}>('SELECT count(*)::int n FROM public.notifications')).rows[0].n;
  expect((await sweep()).rows[0].result.inserted).toBe(2);
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.notifications')).rows[0].n).toBe(before);
  expect((await db.query('SELECT DISTINCT push_status FROM app_private.lifecycle_reminder_deliveries WHERE reminder_day=public.org_today_v1($1)',[org])).rows).toEqual([{push_status:'DISABLED'}]);
});

it('delivery health preserves failures and distinguishes inbox persistence from actual push success', async () => {
  await db.query('SELECT public.lifecycle_reminder_record_failure_v1($1)',['provider unavailable']);
  const health = (await db.query<{value: {latest_run:{status:string};push_states:Record<string,number>}}>('SELECT public.lifecycle_reminder_health_v1() value')).rows[0].value;
  expect(health.latest_run.status).toBe('FAILED');
  expect(health.push_states.NO_DEVICE).toBe(3);
  expect(health.push_states.SENT).toBe(1);
  await expect(db.query('SELECT public.lifecycle_reminder_claim_v1(0)')).rejects.toMatchObject({code:'22023'});
});
