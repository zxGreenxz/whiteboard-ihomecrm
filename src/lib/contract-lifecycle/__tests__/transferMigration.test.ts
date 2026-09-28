import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll,afterAll,beforeEach,afterEach,expect,it } from 'vitest';
const db=new PGlite();
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const [org,actor,building,room,old,newContract,exit,draft,customer,oldCustomer]=[1,2,3,4,5,6,7,8,9,10].map(id);
const path='supabase/migrations/20260928032349_contract_transfer_links.sql';
beforeAll(async()=>{
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${actor}'::uuid$$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid);INSERT INTO buildings VALUES('${building}','${org}');
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text);INSERT INTO rooms VALUES('${room}','${org}','${building}','AVAILABLE');
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,contract_number text,status text,end_date date,deleted_at timestamptz,total_deposit numeric,deposit_paid numeric);INSERT INTO contracts VALUES('${old}','${org}','${room}','OLD','TERMINATED','2026-12-31',null,4000000,4000000),('${newContract}','${org}','${room}','NEW','ACTIVE','2027-12-31',null,4000000,4000000);
    CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);INSERT INTO customers VALUES('${customer}','${org}',null),('${oldCustomer}','${org}',null);
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text);INSERT INTO profiles VALUES('${actor}','Actor');
    CREATE TABLE contract_exit_cases(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,contract_id uuid,room_at_handover_id uuid,state text,version bigint,party_snapshot jsonb,customer_name text);
    INSERT INTO contract_exit_cases VALUES('${exit}','${org}','${building}','${old}','${room}','PENDING',1,'{"customers":[{"customer_id":"${oldCustomer}","is_representative":true}]}','Old');
    CREATE TABLE contract_drafts(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,payload jsonb,revision int,status text,converted_contract_id uuid);
    INSERT INTO contract_drafts VALUES('${draft}','${org}','${building}','${room}','{"form":{"start_date":"2026-10-01","end_date":"2026-12-31","total_deposit":4000000},"customers":[{"id":"${customer}","full_name":"New","is_representative":true}]}',1,'EDITABLE',null);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,type text,commission_kind text,total_amount numeric,recipient_name text,approval_status text,deleted_at timestamptz,code text);
    CREATE TABLE canonical_calls(kind text,args jsonb);
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${org}'::uuid]$$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT '{}'::uuid[]$$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN RETURN;END$$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$SELECT '2026-09-28'::date$$;
    CREATE FUNCTION app_private.contract_draft_scope_allowed(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$SELECT $1='${org}'::uuid AND $2='${building}'::uuid AND coalesce(current_setting('test.denied',true),'')<>'yes' AND ($3<>'contracts.edit' OR coalesce(current_setting('test.readonly',true),'')<>'yes')$$;
    CREATE FUNCTION app_private.assert_contract_exit_writer_v1(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF NOT app_private.contract_draft_scope_allowed($1,$2,'contracts.edit') THEN RAISE EXCEPTION 'Denied' USING ERRCODE='42501'; END IF; END$$;
    CREATE FUNCTION app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('basisStatus','OK','netHeld',CASE WHEN $2='${newContract}'::uuid AND current_setting('test.shortfall',true)='yes' THEN 1 ELSE 4000000 END,'postedReleaseOut',0,'fingerprint','basis1')$$;
    CREATE FUNCTION app_private.run_contract_exit_settlement_v1(uuid,text,jsonb,text,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN INSERT INTO canonical_calls VALUES('settlement',$3);RETURN $3;END$$;
    CREATE FUNCTION public.finalize_contract_exit_case_v1(p_organization_id uuid,p_case_id uuid,p_expected_version bigint,p_idempotency_key text,p_current_kind text,p_reason text,p_settlement jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE e contract_exit_cases%ROWTYPE;v_key text:=p_idempotency_key;v_result jsonb; BEGIN SELECT * INTO e FROM contract_exit_cases WHERE id=p_case_id; v_result:=app_private.run_contract_exit_settlement_v1(e.id,p_current_kind,p_settlement,v_key,true); UPDATE contract_exit_cases SET state='FINALIZED',version=version+1 WHERE id=e.id;RETURN jsonb_build_object('id',e.id);END$$;
    CREATE FUNCTION public.create_commission_voucher(uuid,text,numeric,date,uuid DEFAULT null,text DEFAULT null,text DEFAULT null,text DEFAULT null,text DEFAULT null,text DEFAULT null,jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE v_id uuid:=gen_random_uuid();BEGIN INSERT INTO canonical_calls VALUES('commission',jsonb_build_object('contract_id',$1,'amount',$3));INSERT INTO income_expenses VALUES(v_id,'${org}',$1,'EXPENSE','broker',$3,$7,'UNAPPROVED',null,'HH1');RETURN jsonb_build_object('id',v_id,'code','HH1');END$$;
    CREATE FUNCTION public.create_contract_v2(jsonb,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
    CREATE FUNCTION public.sign_and_checkin_contract_draft_v1(p_organization_id uuid,p_draft_id uuid,p_expected_revision integer,p_document_id uuid,p_document_sha256 text,p_request_id uuid,p_received_on date,p_room_ready boolean,p_terms_confirmed boolean,p_boundary jsonb,p_creation_options jsonb,p_reservation_id uuid DEFAULT null,p_reservation_revision bigint DEFAULT null,p_source_voucher_ids uuid[] DEFAULT null) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE d contract_drafts%ROWTYPE;c contracts%ROWTYPE;v_result jsonb;v_payload jsonb:='{}';BEGIN SELECT * INTO d FROM contract_drafts WHERE id=p_draft_id;v_result:=public.create_contract_v2(v_payload,'draft-sign:'||d.id::text);SELECT * INTO c FROM contracts WHERE id='${newContract}';UPDATE public.contract_drafts SET status='SIGNED',converted_contract_id=c.id WHERE id=d.id;RETURN '{}';END$$;
  `);
  const sql=readFileSync(path,'utf8');await db.exec(sql);await db.exec(sql);
},30000);
afterAll(()=>db.close());beforeEach(()=>db.exec('BEGIN'));afterEach(()=>db.exec('ROLLBACK'));
const create=async(mode='SELF_FOUND',deposit='NEW_PAYMENT',request=id(20))=>(await db.query<{result:Record<string,unknown>}>(`SELECT public.create_contract_transfer_link_v1($1,$2,$3,1,1,$4,$5,'KEEP_OLD_END_DATE',$6,'Reason',$7) result`,[org,exit,draft,mode,deposit,mode==='BROKER'?'Broker':null,request])).rows[0].result;
async function rejects(sql:string,args:unknown[],code:string){await db.exec('SAVEPOINT failure');await expect(db.query(sql,args)).rejects.toMatchObject({code});await db.exec('ROLLBACK TO SAVEPOINT failure');}
it('applies twice; creates separate linked contracts without occupancy or money effects; retries exactly',async()=>{
  const link=await create();expect(link.new_contract_id).toBeNull();expect(link.old_contract_id).toBe(old);expect(await create()).toEqual(link);
  expect((await db.query('SELECT * FROM canonical_calls')).rows).toHaveLength(0);
  expect((await db.query<{status:string}>('SELECT status FROM rooms')).rows[0].status).toBe('AVAILABLE');
  await rejects(`SELECT public.create_contract_transfer_link_v1($1,$2,$3,1,1,'SELF_FOUND','NEW_PAYMENT','NEW_TERM',null,'Other',$4)`,[org,exit,draft,id(20)],'23505');
});
it('rejects cross organization, building permission denial, stale draft/exit and changed party',async()=>{
  await rejects(`SELECT public.create_contract_transfer_link_v1($1,$2,$3,1,1,'SELF_FOUND','NEW_PAYMENT','NEW_TERM',null,'Reason',$4)`,[id(99),exit,draft,id(20)],'42501');
  await db.exec("SET test.denied='yes'");await rejects(`SELECT public.read_contract_transfer_links_v1($1,$2,null,null)`,[org,old],'42501');await db.exec("SET test.denied=''");
  await db.exec(`UPDATE contract_drafts SET revision=2`);await rejects(`SELECT public.create_contract_transfer_link_v1($1,$2,$3,1,1,'SELF_FOUND','NEW_PAYMENT','NEW_TERM',null,'Reason',$4)`,[org,exit,draft,id(20)],'PT409');
});
it('cancels with CAS/history and permits a new live link; direct ledger writes unavailable',async()=>{
  const link=await create();await rejects('SELECT public.cancel_contract_transfer_link_v1($1,$2,99,$3,$4)',[org,link.id,'Cancel',id(21)],'PT409');
  await db.query('SELECT public.cancel_contract_transfer_link_v1($1,$2,1,$3,$4)',[org,link.id,'Cancel',id(21)]);
  expect((await create('SELF_FOUND','NEW_PAYMENT',id(22))).id).not.toBe(link.id);
  expect((await db.query<{event:string}>('SELECT event FROM app_private.contract_transfer_events ORDER BY created_at')).rows.map(x=>x.event)).toEqual(['CREATED','CANCELLED','CREATED']);
  expect((await db.query<{allowed:boolean}>("SELECT has_table_privilege('authenticated','public.contract_transfer_links','UPDATE') allowed")).rows[0].allowed).toBe(false);
});
it('offset remains recorded but blocks signing; changed linked terms cannot silently sign',async()=>{
  await create('SELF_FOUND','OLD_DEPOSIT_OFFSET');await rejects('SELECT app_private.assert_contract_transfer_draft_v1($1)',[draft],'55000');
  await db.exec("UPDATE contract_transfer_links SET deposit_mode='NEW_PAYMENT'");
  await db.exec(`UPDATE contract_drafts SET payload=jsonb_set(payload,'{form,end_date}','"2027-01-01"')`);
  await rejects('SELECT app_private.assert_contract_transfer_draft_v1($1)',[draft],'PT409');
});
it('broker fee is half of pinned old basis; all finalizer entries reject missing/duplicate fee and FORFEIT before core',async()=>{
  const link=await create('BROKER');expect(link.broker_fee).toBe(2_000_000);
  const sql=`SELECT public.finalize_contract_exit_case_v1($1,$2,1,'settle-123','EARLY_RETURN',null,$3)`;
  await rejects(sql,[org,exit,{extra_charges:[]}],'22023');
  const fee={kind:'CUSTOM',description:`TRANSFER_BROKER_FEE:${link.id}`,amount:2_000_000};
  await rejects(sql,[org,exit,{extra_charges:[fee,fee]}],'22023');
  await rejects(`SELECT public.finalize_contract_exit_case_v1($1,$2,1,'settle-123','FORFEIT',null,$3)`,[org,exit,{extra_charges:[fee]}],'55000');
  expect((await db.query('SELECT * FROM canonical_calls')).rows).toHaveLength(0);
  await db.query(sql,[org,exit,{extra_charges:[fee],deposit_refund:4_000_000}]);
  expect((await db.query<{fee_state:string}>('SELECT fee_state FROM contract_transfer_links')).rows[0].fee_state).toBe('APPLIED');
  expect((await db.query<{args:Record<string,unknown>}>('SELECT args FROM canonical_calls')).rows[0].args).toMatchObject({deposit_refund:4_000_000,extra_charges:[fee]});
});
it('new full deposit is mandatory for broker; signed link and existing commission consume once after fee',async()=>{
  const link=await create('BROKER');await db.exec(`UPDATE contracts SET deposit_paid=1 WHERE id='${newContract}'`);await rejects('SELECT app_private.complete_contract_transfer_signing_v1($1,$2)',[draft,newContract],'55000');await db.exec(`UPDATE contracts SET deposit_paid=4000000 WHERE id='${newContract}'`);
  await db.query('SELECT app_private.complete_contract_transfer_signing_v1($1,$2)',[draft,newContract]);
  await rejects('SELECT public.create_contract_transfer_commission_v1($1,$2,2,$3)',[org,link.id,id(21)],'55000');
  const fee={kind:'CUSTOM',description:`TRANSFER_BROKER_FEE:${link.id}`,amount:2_000_000};
  await db.query(`SELECT public.finalize_contract_exit_case_v1($1,$2,1,'settle-123','EARLY_RETURN',null,$3)`,[org,exit,{extra_charges:[fee]}]);
  const current=(await db.query<{version:number}>('SELECT version FROM contract_transfer_links')).rows[0].version;
  const first=(await db.query<{result:Record<string,unknown>}>('SELECT public.create_contract_transfer_commission_v1($1,$2,$3,$4) result',[org,link.id,current,id(21)])).rows[0].result;
  expect(first.commission_approval_status).toBe('UNAPPROVED');
  expect((await db.query<{result:Record<string,unknown>}>('SELECT public.create_contract_transfer_commission_v1($1,$2,$3,$4) result',[org,link.id,current,id(21)])).rows[0].result).toEqual(first);
  expect((await db.query("SELECT * FROM canonical_calls WHERE kind='commission'")).rows).toHaveLength(1);
});
it('rejects another representative/room and a second live link; readers redact money without edit scope',async()=>{
  await db.exec(`UPDATE contract_drafts SET payload=jsonb_set(payload,'{customers,0,id}','"${oldCustomer}"')`);
  await rejects(`SELECT public.create_contract_transfer_link_v1($1,$2,$3,1,1,'SELF_FOUND','NEW_PAYMENT','NEW_TERM',null,'Reason',$4)`,[org,exit,draft,id(20)],'22023');
  await db.exec(`UPDATE contract_drafts SET payload=jsonb_set(payload,'{customers,0,id}','"${customer}"')`);
  await create('BROKER');
  await rejects(`SELECT public.create_contract_transfer_link_v1($1,$2,$3,1,1,'SELF_FOUND','NEW_PAYMENT','NEW_TERM',null,'Reason',$4)`,[org,exit,draft,id(22)],'23505');
  await db.exec("SET test.readonly='yes'");
  const links=(await db.query<{result:Array<Record<string,unknown>>}>('SELECT public.read_contract_transfer_links_v1($1,$2,null,null) result',[org,old])).rows[0].result;
  expect(links[0].deposit_base).toBeNull();expect(links[0].broker_fee).toBeNull();expect(links[0].old_party_snapshot).toBeUndefined();
  await db.exec("SET test.readonly=''");
});
it('existing broker commission with different amount is an explicit incompatibility; never creates a second voucher',async()=>{
  const link=await create('BROKER');await db.query('SELECT app_private.complete_contract_transfer_signing_v1($1,$2)',[draft,newContract]);
  const fee={kind:'CUSTOM',description:`TRANSFER_BROKER_FEE:${link.id}`,amount:2_000_000};
  await db.query(`SELECT public.finalize_contract_exit_case_v1($1,$2,1,'settle-123','EARLY_RETURN',null,$3)`,[org,exit,{extra_charges:[fee]}]);
  await db.exec(`INSERT INTO income_expenses VALUES('${id(40)}','${org}','${newContract}','EXPENSE','broker',100,'Broker','APPROVED',null,'Existing')`);
  await rejects('SELECT public.create_contract_transfer_commission_v1($1,$2,3,$3)',[org,link.id,id(21)],'55000');
  expect((await db.query("SELECT * FROM canonical_calls WHERE kind='commission'")).rows).toHaveLength(0);
});
it('uses contracted old base and existing paid-deposit semantics without imposing real-cash classification',async()=>{
  await db.exec(`CREATE OR REPLACE FUNCTION app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"basisStatus":"RECOGNIZED_ONLY","netHeld":0,"postedReleaseOut":100,"fingerprint":"historical"}'::jsonb$$`);
  const link=await create('BROKER');expect(link.money_state).toBe('FEE_PENDING');expect(link.broker_fee).toBe(2_000_000);
  await db.query('SELECT app_private.complete_contract_transfer_signing_v1($1,$2)',[draft,newContract]);
  const fee={kind:'CUSTOM',description:`TRANSFER_BROKER_FEE:${link.id}`,amount:2_000_000};
  await db.query(`SELECT public.finalize_contract_exit_case_v1($1,$2,1,'settle-123','EARLY_RETURN',null,$3)`,[org,exit,{extra_charges:[fee],deposit_refund:4_000_000}]);
  expect((await db.query('SELECT * FROM canonical_calls')).rows).toHaveLength(1);
});
