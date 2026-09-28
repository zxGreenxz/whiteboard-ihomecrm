import {existsSync,readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const path='supabase/migrations/20260928025848_room_reservation_workflow.sql';
const org='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',room='00000000-0000-4000-8000-000000000003',building='00000000-0000-4000-8000-000000000004',customer='00000000-0000-4000-8000-000000000005',account='00000000-0000-4000-8000-000000000006',type='00000000-0000-4000-8000-000000000007';
const db=new PGlite();
beforeAll(async()=>{
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}');CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);INSERT INTO buildings VALUES('${building}','${org}','Tower',NULL);
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text,name text,deleted_at timestamptz);INSERT INTO rooms VALUES('${room}','${org}','${building}','AVAILABLE','101',NULL);
    CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,phone text,deleted_at timestamptz);INSERT INTO customers VALUES('${customer}','${org}','Customer','0900',NULL);
    CREATE TABLE contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,status text,deleted_at timestamptz,expected_move_out_date date,actual_end_date date,created_at timestamptz DEFAULT now());
    CREATE TABLE contract_customers(contract_id uuid,customer_id uuid);
    CREATE TABLE deposits(id uuid PRIMARY KEY,room_id uuid,contract_id uuid,status text,deleted_at timestamptz,organization_id uuid);
    CREATE TABLE room_reservation_holds(id uuid PRIMARY KEY,room_id uuid,status text,expires_at timestamptz,held_by uuid,contract_id uuid);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY,organization_id uuid,type text,is_deposit boolean,deleted_at timestamptz);INSERT INTO income_expense_types VALUES('${type}','${org}','INCOME',true,NULL);
    CREATE TABLE accounts(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,is_virtual boolean);INSERT INTO accounts VALUES('${account}','${org}',NULL,false);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,room_id uuid,contract_id uuid,type text,name text,payer_name text,approval_status text DEFAULT 'UNAPPROVED',deleted_at timestamptz,total_amount numeric,code text DEFAULT 'PT001');
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,income_expense_type_id uuid,accounting_class text,amount numeric);
    CREATE TABLE contract_deposit_links(organization_id uuid,contract_id uuid,income_expense_id uuid);
    CREATE TABLE writer_calls(args jsonb);
    CREATE FUNCTION my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${building}'::uuid AND coalesce(current_setting('test.denied',true),'')<>'yes' $$;
    CREATE FUNCTION can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT can_access_building($3) $$;
    CREATE FUNCTION is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;CREATE FUNCTION sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-09-28'::date $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $2=ANY(my_org_ids()) AND can_access_building($4) $$;
    CREATE FUNCTION ie_has_deposit_item(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM income_expense_items WHERE income_expense_id=$1 AND accounting_class='DEPOSIT') $$;
    CREATE FUNCTION app_private.reservation_deposit_is_settled_v1(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.settled',true),'')=$1::text $$;
    CREATE FUNCTION app_private.reservation_settlement_basis_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('amount',v.total_amount,'received',v.approval_status='APPROVED','mismatch',false) FROM income_expenses v WHERE id=$1 $$;
    CREATE FUNCTION public.create_reservation_deposit_v1(uuid,numeric,text) RETURNS json LANGUAGE sql AS $$ SELECT '{}'::json $$;
    CREATE FUNCTION public.create_income_expense_v1(p_type text,p_name text,p_building_id uuid,p_room_id uuid,p_tenant_id uuid,p_contract_id uuid,p_payer_name text,p_receive_bank_account text,p_receive_bank_name text,p_account_id uuid,p_attachments jsonb,p_business_result_accounting boolean,p_notes text,p_voucher_date date,p_items jsonb,p_idempotency_key text) RETURNS income_expenses LANGUAGE plpgsql AS $$ DECLARE v income_expenses;BEGIN
      IF coalesce(current_setting('test.writer_fail',true),'')='yes' THEN RAISE EXCEPTION 'Denied' USING ERRCODE='42501';END IF;
      INSERT INTO writer_calls VALUES(jsonb_build_object('room',p_room_id,'account',p_account_id,'payer',p_payer_name,'items',p_items,'key',p_idempotency_key,'date',p_voucher_date,'attachments',p_attachments));
      INSERT INTO income_expenses(organization_id,building_id,room_id,type,name,payer_name,total_amount) VALUES('${org}',p_building_id,p_room_id,p_type,p_name,p_payer_name,(p_items->0->>'unit_price')::numeric) RETURNING * INTO v;
      INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,accounting_class,amount) VALUES(v.id,'${type}','DEPOSIT',v.total_amount);RETURN v;END $$;
    CREATE FUNCTION public.ie_compat_insert_v2(jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.create_contract_v2(p_payload jsonb,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v_org uuid:='${org}';v_room_id uuid:=(p_payload->'contract'->>'room_id')::uuid;v_actor uuid:=auth.uid();v_contract_id uuid;v_response jsonb;BEGIN
      UPDATE public.room_reservation_holds
     SET status = 'EXPIRED'
       WHERE room_id = v_room_id AND status='PENDING_APPROVAL' AND expires_at<=now();
      INSERT INTO contracts(organization_id,room_id,status) VALUES(v_org,v_room_id,'ACTIVE') RETURNING id INTO v_contract_id;
      INSERT INTO contract_customers SELECT v_contract_id,(value->>'customer_id')::uuid FROM jsonb_array_elements(p_payload->'customers');
      INSERT INTO contract_deposit_links SELECT v_org,v_contract_id,(value#>>'{}')::uuid FROM jsonb_array_elements(coalesce(p_payload->'existing_deposit_voucher_ids','[]'));
      UPDATE income_expenses SET contract_id=v_contract_id WHERE id IN(SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(coalesce(p_payload->'existing_deposit_voucher_ids','[]')));
      v_response := jsonb_build_object('contract',jsonb_build_object('id',v_contract_id));RETURN v_response;END $$;
  `);
  if(existsSync(path)){await db.exec(readFileSync(path,'utf8'));await db.exec(readFileSync(path,'utf8'));}
},30000);
afterAll(()=>db.close());
async function tx(fn:()=>Promise<void>){await db.exec('BEGIN');try{await fn();}finally{await db.exec('ROLLBACK');}}
async function deny(fn:()=>Promise<unknown>,code:string){await db.exec('SAVEPOINT denied');try{await expect(fn()).rejects.toMatchObject({code});}finally{await db.exec('ROLLBACK TO SAVEPOINT denied;RELEASE SAVEPOINT denied');}}
async function create(payload:unknown,key='hold-key-0001'){return (await db.query<{r:Record<string,unknown>}>('SELECT create_room_reservation_v1($1,$2,$3::jsonb) r',[org,key,JSON.stringify(payload)])).rows[0].r;}
const hold={room_id:room,customer_id:customer,hold_until:'2026-09-29',intended_move_in_on:'2026-10-01'};
const receipt={amount:100000,account_id:account,voucher_date:'2026-09-28',attachments:[],description:'Actual source'};
async function mutate(id:unknown,revision:number,action:string,changes:unknown={},money:unknown=null,key='hold-change-0001'){return(await db.query<{r:Record<string,unknown>}>('SELECT update_room_reservation_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) r',[org,id,revision,key,action,JSON.stringify(changes),JSON.stringify(money)])).rows[0].r;}
describe('reservation identity and exact next claim',()=>{
  it('exists and applies twice',()=>expect(existsSync(path)).toBe(true));
  it('matches current contract core room-before-organization lock order in every new writer',async()=>{
    for(const signature of ['create_room_reservation_v1(uuid,text,jsonb)','update_room_reservation_v1(uuid,uuid,bigint,text,text,jsonb,jsonb)','app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])','app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid)']){
      const body=(await db.query<{body:string}>('SELECT pg_get_functiondef($1::regprocedure) body',[signature])).rows[0].body;
      expect(body.indexOf('FOR NO KEY UPDATE')).toBeGreaterThan(-1);expect(body.indexOf('FOR NO KEY UPDATE')).toBeLessThan(body.indexOf('PERFORM app_private.lock_org_for_decision_v1'));
    }
  });
  it('persists a real zero hold with no money, replay and one next claimant',()=>tx(async()=>{
    const r=await create(hold);expect(r).toMatchObject({customer_id:customer,status:'HOLD',revision:1,receipts:[],overdue:false});expect(await create(hold)).toEqual(r);
    expect((await db.query<{n:number}>('SELECT count(*)::int n FROM writer_calls')).rows[0].n).toBe(0);
    await deny(()=>create({...hold,notes:'Different same key'}),'23505');await deny(()=>create(hold,'hold-key-0002'),'55000');
    expect((await db.query<{status:string}>('SELECT status FROM rooms')).rows[0].status).toBe('AVAILABLE');
  }));
  it('pure holds need a user deadline and cannot clear it while still live',()=>tx(async()=>{
    await deny(()=>create({...hold,hold_until:null}),'22023');const r=await create(hold);await deny(()=>mutate(r.id,1,'UPDATE',{hold_until:null}),'22023');
  }));
  it('next hold can await an explicit notice; no notice/early planned move-in fails and occupancy stays unchanged',()=>tx(async()=>{
    const occupant=(await db.query<{id:string}>('INSERT INTO contracts(organization_id,room_id,status) VALUES($1,$2,$3) RETURNING id',[org,room,'ACTIVE'])).rows[0].id;
    await db.exec("UPDATE rooms SET status='OCCUPIED'");await deny(()=>create(hold),'55000');
    await db.query("UPDATE contracts SET expected_move_out_date='2026-10-02' WHERE id=$1",[occupant]);await deny(()=>create(hold),'55000');
    const before=(await db.query('SELECT to_jsonb(c) FROM contracts c')).rows;const r=await create({...hold,intended_move_in_on:'2026-10-03'});expect(r).toMatchObject({status:'HOLD',claim_status:'LIVE'});
    expect((await db.query<{status:string}>('SELECT status FROM rooms')).rows[0].status).toBe('OCCUPIED');expect((await db.query('SELECT to_jsonb(c) FROM contracts c')).rows).toEqual(before);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM writer_calls')).rows[0].n).toBe(0);
  }));
  it('expiry remains live reminder; CAS and stable mutation replay are exact',()=>tx(async()=>{
    const r=await create(hold);await db.exec(`CREATE OR REPLACE FUNCTION org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-10-01'::date $$`);
    const list=(await db.query<{r:{reservations:{overdue:boolean}[]}}>('SELECT list_room_reservations_v1($1,NULL,NULL,NULL,100) r',[org])).rows[0].r;
    expect(list.reservations[0].overdue).toBe(true);await deny(()=>create(hold,'hold-key-0002'),'55000');
    const changed=await mutate(r.id,1,'UPDATE',{notes:'Follow up'});expect(changed.revision).toBe(2);expect(await mutate(r.id,1,'UPDATE',{notes:'Follow up'})).toEqual(changed);
    await deny(()=>mutate(r.id,1,'UPDATE',{notes:'Stale'},null,'hold-change-0002'),'PT409');
  }));
  it('requires scoped customer and rechecks authorization before replay/read',()=>tx(async()=>{
    await deny(()=>create({...hold,customer_id:account}),'42501');const r=await create(hold);await db.exec("SET LOCAL test.denied='yes'");await deny(()=>create(hold),'42501');await deny(()=>mutate(r.id,1,'CANCEL'),'42501');await deny(()=>db.query('SELECT list_room_reservations_v1($1,NULL,NULL,NULL,100)',[account]),'42501');
  }));
  it('positive receipt pins exact item, preserves canonical arguments and pending is not received',()=>tx(async()=>{
    const r=await create({...hold,receipt});expect(r.receipts).toMatchObject([{amount:100000,received:false,approval_status:'UNAPPROVED'}]);
    const call=(await db.query<{args:Record<string,unknown>}>('SELECT args FROM writer_calls')).rows[0].args;expect(call).toMatchObject({room,account,payer:'Customer',date:'2026-09-28',items:[{unit_price:100000,quantity:1,start_date:'2026-09-28',end_date:'2026-09-28'}]});
    await deny(()=>mutate(r.id,1,'CANCEL'),'55000');await deny(()=>db.query('SELECT app_private.assert_room_next_claim_for_signing_v1($1,$2,$3,1,$4::uuid[],$5::uuid[])',[org,room,r.id,[customer],[]]),'55000');
    const before=await db.query('SELECT * FROM income_expenses');await db.exec("SET LOCAL test.writer_fail='yes'");await deny(()=>mutate(r.id,1,'TOPUP',{},receipt),'42501');expect((await db.query('SELECT * FROM income_expenses')).rows).toEqual(before.rows);
  }));
  it('money failure rolls back claim and pure cancel permits a next claim',()=>tx(async()=>{
    await db.exec("SET LOCAL test.writer_fail='yes'");await deny(()=>create({...hold,receipt}),'42501');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM room_next_claims')).rows[0].n).toBe(0);
    const r=await create(hold);expect(await mutate(r.id,1,'CANCEL')).toMatchObject({status:'CANCELLED',revision:2});expect(await create(hold,'hold-key-0002')).toMatchObject({status:'HOLD'});
  }));
  it('legacy unlinked sources block; explicit voucher adoption pins chosen customer and source',()=>tx(async()=>{
    const v=(await db.query<{id:string}>(`INSERT INTO income_expenses(organization_id,building_id,room_id,type,total_amount,approval_status,payer_name) VALUES($1,$2,$3,'INCOME',25,'APPROVED','Unreliable name') RETURNING id`,[org,building,room])).rows[0].id;
    await db.query(`INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,accounting_class,amount) VALUES($1,$2,'DEPOSIT',25)`,[v,type]);await deny(()=>create(hold),'55000');
    const r=await create({...hold,existing_voucher_ids:[v]});expect(r.receipts).toMatchObject([{source_voucher_id:v,amount:25,received:true}]);
    await deny(()=>db.query('SELECT create_reservation_deposit_v1($1,25,$2)',[room,'legacy-key-0001']),'55000');
  }));
  it('signing rejects an omitted/wrong claim, consumes exact source and customer atomically',()=>tx(async()=>{
    const r=await create({...hold,receipt});const voucher=(r.receipts as {source_voucher_id:string}[])[0].source_voucher_id;
    await db.query("UPDATE income_expenses SET approval_status='APPROVED' WHERE id=$1",[voucher]);
    const payload={contract:{room_id:room},customers:[{customer_id:customer}],existing_deposit_voucher_ids:[voucher]};await deny(()=>db.query('SELECT create_contract_v2($1::jsonb,$2)',[JSON.stringify(payload),'sign-key-0001']),'55000');
    await db.exec('SAVEPOINT signing_subtransaction');
    const result=(await db.query<{r:{contract:{id:string}}}>('SELECT create_contract_v2($1::jsonb,$2) r',[JSON.stringify({...payload,reservation_id:r.id,reservation_revision:1}),'sign-key-0001'])).rows[0].r;
    await db.exec('RELEASE SAVEPOINT signing_subtransaction');
    expect((await db.query<{status:string;converted_contract_id:string}>('SELECT status,converted_contract_id FROM room_reservations')).rows[0]).toEqual({status:'CONVERTED',converted_contract_id:result.contract.id});
    expect((await db.query<{status:string}>('SELECT status FROM room_next_claims')).rows[0].status).toBe('CONSUMED');
    await db.query('SELECT app_private.consume_room_next_claim_v1($1,$2,1,$3)',[org,r.id,result.contract.id]);
    await deny(()=>db.query('SELECT app_private.consume_room_next_claim_v1($1,$2,1,$3)',[org,r.id,account]),'42501');
    await deny(()=>create(hold,'hold-key-0002'),'55000');
  }));
  it('cannot adopt cross-org sources or reassign pinned items; history stays immutable',()=>tx(async()=>{
    const v=(await db.query<{id:string}>(`INSERT INTO income_expenses(organization_id,building_id,room_id,type,total_amount,approval_status) VALUES($1,$2,$3,'INCOME',25,'APPROVED') RETURNING id`,[account,building,room])).rows[0].id;
    await db.query(`INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,accounting_class,amount) VALUES($1,$2,'DEPOSIT',25)`,[v,type]);await deny(()=>create({...hold,existing_voucher_ids:[v]}),'42501');
    const r=await create({...hold,receipt});await deny(()=>db.query('DELETE FROM reservation_receipts WHERE reservation_id=$1',[r.id]),'42501');await deny(()=>db.query('DELETE FROM app_private.room_reservation_history WHERE reservation_id=$1',[r.id]),'42501');
  }));
  it('cancellation consumes existing settlement outcome and never writes refund money',()=>tx(async()=>{
    const r=await create({...hold,receipt});const v=(r.receipts as {source_voucher_id:string}[])[0].source_voucher_id;
    await db.exec(`SET LOCAL test.settled='${v}'`);const before=(await db.query('SELECT * FROM writer_calls')).rows;
    expect(await mutate(r.id,1,'CANCEL')).toMatchObject({status:'CANCELLED'});expect((await db.query('SELECT * FROM writer_calls')).rows).toEqual(before);
  }));
  it('readers are read-only, no direct table/helper grants, cross-org source denied',()=>tx(async()=>{
    await create(hold);await db.exec('SET TRANSACTION READ ONLY');expect((await db.query<{r:{reservations:unknown[]}}>('SELECT list_room_reservations_v1($1,NULL,NULL,NULL,100) r',[org])).rows[0].r.reservations).toHaveLength(1);
    expect((await db.query<{allowed:boolean}>("SELECT has_table_privilege('authenticated','room_reservations','INSERT') allowed")).rows[0].allowed).toBe(false);
  }));
});
