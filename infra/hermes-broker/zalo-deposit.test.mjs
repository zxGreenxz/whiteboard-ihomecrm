import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { saleSetup, ROOM, ORG, USER, REQUEST, BUILDING, binding } from './sale-action-sql-fixture.mjs';
import { ACCOUNT, GENERATION, INSTANCE, SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';
import { ZALO_DEPOSIT_KEY, ZALO_DEPOSIT_GRANTS, zaloDepositInput, zaloDepositResult } from './zalo-deposit-contract.mjs';
import { createSaleActionReads } from './sale-action-adapter.mjs';
import { mayUseSaleAction } from './sale-action-contract.mjs';

let sql = readFileSync(new URL('../../supabase/migrations/20261127172703_hermes_zalo_confirmed_deposit.sql', import.meta.url), 'utf8');
// Exercise the real authorization and money invariants against a deliberately weakened in-memory migration.
const mutations = {
  missing_consent: ['IF draft.consent_message IS NULL THEN RETURN', 'IF false THEN RETURN'],
  wrong_details: ['AND normalize(d.confirmation) = normalize(p_confirmation)', ''],
  wrong_peer: ['AND x.sender_uid=p_sender AND', 'AND'],
  duplicate_transfer: ["WHERE p.organization_id=org AND p.account_id=book) THEN", "WHERE false) THEN"],
};
if (process.env.HERMES_ZALO_DEPOSIT_MUTATION) {
  const [original, replacement] = mutations[process.env.HERMES_ZALO_DEPOSIT_MUTATION];
  assert.equal(sql.split(original).length, 2);
  sql = sql.replace(original, replacement);
}
const input = { roomId: ROOM, requestId: REQUEST, payerName: 'Khách thử', accountId: ACCOUNT,
  voucherDate: '2026-01-02', intendedMoveInOn: null, depositTarget: null,
  payments: [{ amount: 11, reference: 'TEST-A' }, { amount: 22, reference: 'TEST-B' }] };
const identity = { row: { organizationId: ORG }, scopesByPermission: Object.fromEntries(ZALO_DEPOSIT_GRANTS.map(k => [k, {buildingIds:[BUILDING]}])) };
test('Zalo deposit tool checks all scoped grants and rejects double-counting a transfer', () => {
  assert.equal(mayUseSaleAction({action: ZALO_DEPOSIT_GRANTS}, 'zalo_deposit'), true);
  for (const key of ZALO_DEPOSIT_GRANTS)
    assert.equal(mayUseSaleAction({ action: ZALO_DEPOSIT_GRANTS.filter(k => k !== key) }, 'zalo_deposit'), false);
  assert.deepEqual(zaloDepositInput(input),input);
  for (const reference of [' test-a ', null])
    assert.throws(() => zaloDepositInput({...input,payments:[input.payments[0],{amount:22,reference}]}));
});

test('the Sale HTTP adapter distinguishes an existing hold from a duplicate transfer or expired preview', async () => {
  const claims = Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION})).toString('base64url');
  for (const reason of ['zalo_deposit_held','zalo_deposit_duplicate','zalo_deposit_expired','zalo_deposit_locked','zalo_deposit_ambiguous']) {
    let rejected = false;
    const reads = createSaleActionReads({ url:'https://example.invalid/',publishableKey:'sb_publishable_test',
      dependencyScope:{track: work => work()},fetch:async (url, options) => {
        assert.ok(url.endsWith('/rpc/hermes_zalo_deposit_v1'));
        assert.equal(options.headers['x-client-info'],'hermes-sale-zalo-deposit/1');
        return Response.json({code:'PT409',message:reason,details:null,hint:null},{status:409});
      } });
    await assert.rejects(reads.execute('zalo_deposit',{binding,input,accessToken:'header.'+claims+'.signature'},
      {signal:new AbortController().signal,onDispatch(){},onRejected(){rejected=true;}}),{code:'action_rejected',reason});
    assert.equal(rejected,true);
  }
});

test('only a fresh reply from the bound peer authorizes the exact voucher and room; retries return that voucher', { timeout: 60000 }, async t => {
  const { db } = await saleSetup(t);
  await db.exec(`
    CREATE TABLE public.accounts(id uuid,organization_id uuid,deleted_at timestamptz,name text);
    INSERT INTO public.accounts VALUES('${ACCOUNT}','${ORG}',null,'Sổ thử');
    CREATE TABLE public.room_next_claims(room_id uuid,organization_id uuid,status text);
    ALTER TABLE public.room_sale_locks ADD released_at timestamptz, ADD expires_at timestamptz, ADD locked_by uuid;
    CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz)
      LANGUAGE sql AS $$ SELECT $1='${USER}' AND $2='${ORG}' AND $4='${BUILDING}' AND $5='${ACCOUNT}',1::bigint,null::timestamptz $$;
    CREATE FUNCTION public.create_deposit_income_v1(uuid,text,jsonb,jsonb,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF $1<>'${ORG}' OR $3->>'amount'<>'33' OR $3->>'room_id'<>'${ROOM}' OR $3->>'payer_name'<>'Khách thử'
        OR $5->>'channel'<>'sale' OR $5->'expected_hold' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'wrong canonical payload'; END IF;
      INSERT INTO public.fixture_sale_writes VALUES('confirmed_deposit',$3);
      INSERT INTO public.room_next_claims VALUES('${ROOM}','${ORG}','LIVE');
      RETURN jsonb_build_object('id','${REQUEST}','code','PT-TEST','reservation_id','${ROOM}','approval_status','UNAPPROVED');
    END $$;
  `);
  await db.exec(sql); await db.exec(sql);
  await db.query('UPDATE app_private.hermes_connections SET action_capabilities=array_append(action_capabilities,$1)',[ZALO_DEPOSIT_KEY]);
  await db.query('UPDATE app_private.hermes_org_policies SET action_capabilities=array_append(action_capabilities,$1)',[ZALO_DEPOSIT_KEY]);
  async function call(role, command, params) {
    await db.exec('BEGIN');
    try {
      await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",[role,USER,SESSION]);
      await db.query("SELECT set_config('request.headers',$1,true)",[JSON.stringify({'x-client-info':'hermes-sale-zalo-deposit/1'})]);
      await db.exec('SET LOCAL ROLE '+role);
      const result=(await db.query(command,params)).rows[0].v;
      await db.exec('COMMIT');
      return result;
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
  }
  const submit = (args=input, role='authenticated') => call(role,'SELECT public.hermes_zalo_deposit_v1($1,$2) v',[binding,args]);
  const consent = (confirmation, sender='456', role='service_role', gen=GENERATION) => call(role,
    'SELECT public.hermes_zalo_deposit_consent_v1($1,$2,$3,$4,$5,floor(extract(epoch from clock_timestamp())*1000)::bigint,$6) v',
    [ACCOUNT,INSTANCE,gen,sender,randomUUID(),confirmation]);
  assert.equal((await call('authenticated','SELECT public.hermes_sale_capabilities_v1($1) v',[ORG])).permissions[ZALO_DEPOSIT_KEY].allowed,true);
  await assert.rejects(submit(input,'service_role'),{code:'42501'});
  const old = await submit({...input,requestId:randomUUID()});
  const pending = await submit();
  assert.equal(zaloDepositResult(pending,identity,input).total,33);
  const confirmation=pending.confirmation;
  assert.match(confirmation,/^Xác nhận cọc [0-9A-F]{12} · 33 đ · /u);
  assert.ok(confirmation.includes('Người nộp Khách thử · Sổ Sổ thử · Ngày 2026-01-02'));
  assert.equal(await consent(confirmation.replace('33 đ','34 đ')),false,'the same code cannot authorize a different amount');
  assert.equal(await consent(confirmation.replace(pending.room,'phòng khác')),false,'the same code cannot authorize a different room');
  assert.equal(await consent(old.confirmation),false,'a superseded preview cannot authorize the replacement');
  await assert.rejects(consent(confirmation,'456','authenticated'),{code:'42501'});
  assert.equal(await consent(confirmation,'789'),false);
  assert.equal(await consent(confirmation,'456','service_role',randomUUID()),false);
  assert.deepEqual(await submit(),pending);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.fixture_sale_writes')).rows[0].n,0);
  assert.equal(await consent(confirmation),true);
  assert.equal(await consent(confirmation),false);
  await assert.rejects(submit({...input,payerName:'Khách khác'}),{code:'PT409'});
  await db.query("UPDATE public.fixture_sale_acl SET allowed=false WHERE key='deposits.create'");
  await assert.rejects(submit(),{code:'42501'});
  await db.query("UPDATE public.fixture_sale_acl SET allowed=true WHERE key='deposits.create'");
  const receipt=await submit();
  assert.equal(zaloDepositResult(receipt,identity,input).voucherCode,'PT-TEST');
  assert.deepEqual(await submit(),receipt);
  await assert.rejects(submit({...input,requestId:randomUUID()}),{code:'PT409',message:'zalo_deposit_held'});
  await db.exec('DELETE FROM public.room_next_claims');
  await assert.rejects(submit({...input,requestId:randomUUID()}),{code:'PT409',message:'zalo_deposit_duplicate'},'the same bank references cannot pay twice');
  const secondBot=randomUUID(), secondChallenge=randomUUID(), secondChat=randomUUID(), secondMessage=randomUUID();
  await db.query("INSERT INTO public.zalo_accounts SELECT (jsonb_populate_record(a,jsonb_build_object('id',$1::uuid,'zalo_uid','999'))).* FROM public.zalo_accounts a WHERE id=$2",[secondBot,ACCOUNT]);
  await db.query("INSERT INTO public.zalo_conversations SELECT (jsonb_populate_record(c,jsonb_build_object('id',$1::uuid,'account_id',$2::uuid))).* FROM public.zalo_conversations c WHERE account_id=$3 LIMIT 1",[secondChat,secondBot,ACCOUNT]);
  await db.query("INSERT INTO public.zalo_messages SELECT (jsonb_populate_record(m,jsonb_build_object('id',$1::uuid,'account_id',$2::uuid,'conversation_id',$3::uuid))).* FROM public.zalo_messages m WHERE account_id=$4 LIMIT 1",[secondMessage,secondBot,secondChat,ACCOUNT]);
  await db.query("INSERT INTO app_private.hermes_zalo_bots SELECT (jsonb_populate_record(b,jsonb_build_object('account_id',$1::uuid))).* FROM app_private.hermes_zalo_bots b WHERE account_id=$2",[secondBot,ACCOUNT]);
  await db.query("INSERT INTO app_private.hermes_zalo_link_challenges SELECT (jsonb_populate_record(x,jsonb_build_object('id',$1::uuid,'account_id',$2::uuid,'challenge_digest',repeat('f',64),'conversation_id',$4::uuid,'message_id',$5::uuid))).* FROM app_private.hermes_zalo_link_challenges x WHERE account_id=$3",[secondChallenge,secondBot,ACCOUNT,secondChat,secondMessage]);
  await db.query("INSERT INTO app_private.hermes_zalo_bindings SELECT (jsonb_populate_record(x,jsonb_build_object('id',gen_random_uuid(),'account_id',$1::uuid,'challenge_id',$2::uuid,'conversation_id',$4::uuid))).* FROM app_private.hermes_zalo_bindings x WHERE account_id=$3",[secondBot,secondChallenge,ACCOUNT,secondChat]);
  await assert.rejects(submit({...input,requestId:randomUUID()}),{code:'PT409',message:'zalo_deposit_ambiguous'});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.fixture_sale_writes')).rows[0].n,1);
});
