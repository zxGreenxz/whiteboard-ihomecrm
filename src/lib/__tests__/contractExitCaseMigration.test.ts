import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const path='supabase/migrations/20260928015559_contract_exit_case_workflow.sql';
const notePath='supabase/migrations/20260929123356_contract_exit_return_note.sql';
const returnNote='Khách trả phòng trước hạn, đã bàn giao chìa khóa.';
const org='00000000-0000-4000-8000-000000000001';
const actor='00000000-0000-4000-8000-000000000002';
const building='00000000-0000-4000-8000-000000000003';
const room='00000000-0000-4000-8000-000000000004';
const contract='00000000-0000-4000-8000-000000000005';
const otherOrg='00000000-0000-4000-8000-000000000011';
const otherBuilding='00000000-0000-4000-8000-000000000013';
const otherRoom='00000000-0000-4000-8000-000000000014';
const otherContract='00000000-0000-4000-8000-000000000015';
const db=new PGlite();
const guard="IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;";
const physical=(date:string)=>`  UPDATE contracts\n     SET status = 'TERMINATED', actual_end_date = ${date}, notes = 'Legacy', updated_at = NOW()\n   WHERE id = p_contract_id;`;

beforeAll(async()=>{
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${actor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.actor',true),''),'${actor}')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY); INSERT INTO organizations VALUES('${org}'),('${otherOrg}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,UNIQUE(organization_id,id)); INSERT INTO buildings VALUES('${building}','${org}','Building A'),('${otherBuilding}','${otherOrg}','Building B');
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text,status text DEFAULT 'OCCUPIED',updated_at timestamptz,UNIQUE(organization_id,id)); INSERT INTO rooms(id,organization_id,building_id,name) VALUES('${room}','${org}','${building}','Room A'),('${otherRoom}','${otherOrg}','${otherBuilding}','Room B');
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,contract_number text,status text DEFAULT 'ACTIVE',actual_end_date date,start_date date DEFAULT '2026-01-01',user_id uuid,tenant_id uuid,parent_contract_id uuid,notes text,updated_at timestamptz DEFAULT '2026-09-27',deleted_at timestamptz,UNIQUE(organization_id,id));
    CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,full_name text);
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text); INSERT INTO profiles VALUES('${actor}','Actor A');
    CREATE TABLE contract_customers(contract_id uuid,customer_id uuid,is_representative boolean);
    CREATE TABLE contract_tenants(contract_id uuid,tenant_id uuid);
    CREATE TABLE room_pass_listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),room_id uuid,organization_id uuid,user_id uuid,active boolean,updated_at timestamptz);
    CREATE TABLE contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid UNIQUE,organization_id uuid,actual_move_out_date date,status text);
    CREATE TABLE canonical_calls(kind text,contract_id uuid,on_date date,args jsonb);
    CREATE TABLE meter_boundary_calls(organization_id uuid,contract_id uuid,room_id uuid,kind text,effective_on date,payload jsonb,UNIQUE(contract_id,kind));
    CREATE FUNCTION app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text DEFAULT 'contracts.edit') RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN IF coalesce(current_setting('test.meter_fail',true),'')='yes' THEN RAISE EXCEPTION 'Meter failure' USING ERRCODE='22023'; END IF;
      IF NOT EXISTS(SELECT 1 FROM contracts WHERE id=$2 AND status='TERMINATED' AND actual_end_date=$5) THEN RAISE EXCEPTION 'Physical boundary must follow actual return'; END IF;
      INSERT INTO meter_boundary_calls VALUES($1,$2,$3,$4,$5,$6);RETURN $6; END $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT ($1='${building}' OR ($1='${otherBuilding}' AND current_setting('test.member2',true)='yes')) AND coalesce(current_setting('test.denied',true),'')<> 'yes' $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT can_access_building($3) $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT CASE WHEN current_setting('test.member2',true)='yes' THEN ARRAY['${org}'::uuid,'${otherOrg}'::uuid] ELSE ARRAY['${org}'::uuid] END $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-09-28'::date $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE; RETURN 1; END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2=ANY(my_org_ids()) AND $3='contracts.edit' AND can_access_building($4) $$;
    CREATE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid,p_forfeit_date date,p_extra_charges jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql AS $fn$
    DECLARE v_contract record; BEGIN SELECT * INTO v_contract FROM contracts WHERE id=p_contract_id FOR UPDATE; ${guard}
    INSERT INTO canonical_calls VALUES('FORFEIT',p_contract_id,p_forfeit_date,jsonb_build_object('extra_charges',p_extra_charges));
${physical('p_forfeit_date')}
    IF coalesce(current_setting('test.skip_audit',true),'')<>'yes' THEN INSERT INTO contract_terminations(contract_id,organization_id,actual_move_out_date,status) VALUES(p_contract_id,v_contract.organization_id,p_forfeit_date,'COMPLETED'); END IF;
    RETURN jsonb_build_object('contract_id',p_contract_id,'cancelled_invoices',2); END $fn$;
    CREATE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid,p_move_out_date date,p_deposit_refund numeric,p_penalty_fee numeric,p_excess_rent numeric,p_outstanding_debt numeric,p_notes text,p_extra_charges jsonb,p_shortfall_mode text,p_receipt_account_id uuid,p_refund_items jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
    DECLARE v_contract record; BEGIN SELECT * INTO v_contract FROM contracts WHERE id=p_contract_id FOR UPDATE; ${guard}
    INSERT INTO canonical_calls VALUES('MOVE_OUT',p_contract_id,p_move_out_date,jsonb_build_object('deposit_refund',p_deposit_refund,'penalty_fee',p_penalty_fee,'excess_rent',p_excess_rent,'outstanding_debt',p_outstanding_debt,'notes',p_notes,'extra_charges',p_extra_charges,'shortfall_mode',p_shortfall_mode,'receipt_account_id',p_receipt_account_id,'refund_items',p_refund_items));
${physical('p_move_out_date')}
    IF coalesce(current_setting('test.skip_audit',true),'')<>'yes' THEN INSERT INTO contract_terminations(contract_id,organization_id,actual_move_out_date,status) VALUES(p_contract_id,v_contract.organization_id,p_move_out_date,'COMPLETED'); END IF;
    RETURN jsonb_build_object('contract_id',p_contract_id,'refund_voucher_id',null); END $fn$;
    CREATE FUNCTION public.terminate_contract_forfeit_with_credit_v1(uuid,date,jsonb,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('termination',terminate_contract_forfeit_impl($1,$2,$3),'credit',jsonb_build_object('deferred',true),'inner_key',$4) $$;
    CREATE FUNCTION public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('termination',terminate_contract_move_out_impl($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12),'credit',jsonb_build_object('applied_amount',0),'inner_key',$11) $$;
  `);
  // Actual current immediate room trigger; financial wrapper doubles stop at the external money boundary.
  const triggerSource=readFileSync('supabase/migrations/20260915144610_trang_thai_phong_theo_hop_dong_definer.sql','utf8');
  const start=triggerSource.indexOf('CREATE OR REPLACE FUNCTION public.update_room_status_on_contract_change()');
  await db.exec(triggerSource.slice(start,triggerSource.indexOf('$fn$;',start)+6));
  await db.exec('CREATE TRIGGER trigger_update_room_status AFTER INSERT OR UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION update_room_status_on_contract_change()');
  if(existsSync(path)) {await db.exec(readFileSync(path,'utf8'));await db.exec(readFileSync(path,'utf8'));}
  if(existsSync(notePath)) {await db.exec(readFileSync(notePath,'utf8'));await db.exec(readFileSync(notePath,'utf8'));}
},30000);
afterAll(async()=>{await db.close();});
async function scenario(fn:()=>Promise<void>){
  await db.exec(`BEGIN; INSERT INTO contracts(id,organization_id,room_id,user_id) VALUES('${contract}','${org}','${room}','${actor}');`);
  try {await fn();} finally {await db.exec('ROLLBACK');}
}
async function confirm(opts:Record<string,unknown>={}){
  return (await db.query<{result:Record<string,unknown>}>(`SELECT confirm_contract_return_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) AS result`,[opts.org??org,opts.contract??contract,opts.updated??'2026-09-27',opts.key??'physical-key-0001',opts.date??'2026-09-28',opts.kind??'EARLY_RETURN',opts.mode??'DEFERRED',opts.money===undefined?null:JSON.stringify(opts.money),opts.meter===undefined?null:JSON.stringify(opts.meter),opts.note===undefined?returnNote:opts.note])).rows[0].result;
}
async function finalize(id:unknown,opts:Record<string,unknown>={}){
  return (await db.query<{result:Record<string,unknown>}>(`SELECT finalize_contract_exit_case_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS result`,[opts.org??org,id,opts.version??1,opts.key??'settlement-key-0001',opts.kind??'EARLY_RETURN',opts.reason??null,JSON.stringify(opts.money??{deposit_refund:100,shortfall_mode:'DEBT'})])).rows[0].result;
}
async function rejected(fn:()=>Promise<unknown>,code:string){
  await db.exec('SAVEPOINT expected_failure');
  try {await expect(fn()).rejects.toMatchObject({code});}
  finally {await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');}
}
describe('actual return / old canonical settlement SQL seam',()=>{
  it('requires a nonblank return note before any physical, meter or financial effect',()=>scenario(async()=>{
    for(const note of [null,'','   ','\n\t ']) {
      await rejected(()=>confirm({note}),'22023');
      await rejected(()=>confirm({note,mode:'IMMEDIATE',kind:'FORFEIT',money:{}}),'22023');
    }
    expect((await db.query('SELECT status,actual_end_date FROM contracts WHERE id=$1',[contract])).rows[0]).toEqual({status:'ACTIVE',actual_end_date:null});
    for(const table of ['contract_exit_cases','canonical_calls','contract_terminations','meter_boundary_calls']) {
      expect((await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    expect((await db.query<{status:string}>('SELECT status FROM rooms WHERE id=$1',[room])).rows[0].status).toBe('OCCUPIED');
  }));
  it('stores a trimmed return note and exposes it through detail and list in deferred cases',()=>scenario(async()=>{
    const result=await confirm({note:`  ${returnNote}\n`});
    expect(result).toMatchObject({state:'PENDING',return_note:returnNote});
    expect((await db.query<{return_note:string}>('SELECT return_note FROM contract_exit_cases WHERE id=$1',[result.id])).rows[0].return_note).toBe(returnNote);
    const detail=(await db.query<{result:Record<string,unknown>}>('SELECT get_contract_exit_case_v1($1,$2) AS result',[org,result.id])).rows[0].result;
    expect(detail.return_note).toBe(returnNote);
    const list=(await db.query<{result:{items:Record<string,unknown>[]}}>('SELECT list_contract_exit_cases_v1($1) AS result',[org])).rows[0].result;
    expect(list.items[0].return_note).toBe(returnNote);
  }));
  it.each(['NATURAL_EXPIRY','EARLY_RETURN','FORFEIT'])('retains the return note when %s is settled immediately',kind=>scenario(async()=>{
    const result=await confirm({kind,mode:'IMMEDIATE',money:{},note:returnNote});
    expect(result).toMatchObject({state:'FINALIZED',return_note:returnNote});
    const readback=(await db.query<{result:Record<string,unknown>}>('SELECT get_contract_exit_case_v1($1,$2) AS result',[org,result.id])).rows[0].result;
    expect(readback.return_note).toBe(returnNote);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(1);
  }));
  it('binds the normalized return note to physical replay intent',()=>scenario(async()=>{
    const result=await confirm({note:returnNote});
    expect(await confirm({note:` ${returnNote} `})).toEqual(result);
    await rejected(()=>confirm({note:'Khách bỏ cọc và đã dọn hết đồ.'}),'23505');
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM meter_boundary_calls')).rows[0].n).toBe(1);
  }));
  it('keeps return notes immutable through kind changes and final settlement',()=>scenario(async()=>{
    const pending=await confirm({note:returnNote});
    await rejected(()=>db.query("UPDATE contract_exit_cases SET return_note='Rewritten',version=version+1 WHERE id=$1",[pending.id]),'42501');
    const settled=await finalize(pending.id,{kind:'FORFEIT',reason:'Bổ sung xác nhận bỏ cọc',money:{}});
    expect(settled).toMatchObject({state:'FINALIZED',return_note:returnNote});
    expect(settled.kind_history).toMatchObject([{reason:'Bổ sung xác nhận bỏ cọc'}]);
    await rejected(()=>db.query("UPDATE contract_exit_cases SET return_note='Rewritten',version=version+1 WHERE id=$1",[pending.id]),'42501');
  }));
  it('keeps pre-migration pending cases readable and finalizable with a null return note',()=>scenario(async()=>{
    // Reproduce a real row written before the note migration, then upgrade in place.
    await db.exec('DROP FUNCTION public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb,jsonb,text)');
    await db.exec(readFileSync(path,'utf8'));
    const pending=(await db.query<{result:Record<string,unknown>}>('SELECT confirm_contract_return_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) AS result',[org,contract,'2026-09-27','legacy-physical-0001','2026-09-28','EARLY_RETURN','DEFERRED',null,null])).rows[0].result;
    await db.exec(readFileSync(notePath,'utf8'));
    const upgraded=(await db.query<{result:Record<string,unknown>}>('SELECT get_contract_exit_case_v1($1,$2) AS result',[org,pending.id])).rows[0].result;
    expect(upgraded).toMatchObject({state:'PENDING',return_note:null});
    expect(await finalize(pending.id)).toMatchObject({state:'FINALIZED',return_note:null});
  }));
  it('requires the additive API rather than silently accepting a missing migration',async()=>{expect(existsSync(path)).toBe(true);});
  it('exposes only the extended RPC signature and retains least-privilege access',()=>scenario(async()=>{
    const signature='public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb,jsonb,text)';
    expect((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',['authenticated',signature])).rows[0]).toEqual({allowed:true});
    for(const role of ['anon','service_role']) {
      expect((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',[role,signature])).rows[0]).toEqual({allowed:false});
    }
    expect((await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname='confirm_contract_return_v1'")).rows[0]).toEqual({n:1});
    expect((await db.query("SELECT has_function_privilege('authenticated','app_private.contract_exit_case_response_v1(uuid)','EXECUTE') AS allowed")).rows[0]).toEqual({allowed:false});
    expect((await db.query("SELECT p.prosecdef,p.provolatile,p.proconfig,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure",[signature])).rows[0]).toMatchObject({prosecdef:true,provolatile:'v',proconfig:['search_path=pg_catalog, public, app_private'],rolname:'postgres'});
    await rejected(()=>db.query('SELECT confirm_contract_return_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)',[org,contract,'2026-09-27','legacy-request-0001','2026-09-28','EARLY_RETURN','DEFERRED',null,null]),'22023');
  }));
  it('applies twice and DEFERRED leaves all financial effects absent',()=>scenario(async()=>{
    const result=await confirm(); expect(result).toMatchObject({state:'PENDING',initial_kind:'EARLY_RETURN',version:1,settlement_result:null});
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(0);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM contract_terminations')).rows[0].n).toBe(0);
    expect((await db.query(`SELECT status,actual_end_date FROM contracts WHERE id='${contract}'`)).rows[0]).toMatchObject({status:'TERMINATED'});
    expect((await db.query<{status:string}>(`SELECT status FROM rooms WHERE id='${room}'`)).rows[0].status).toBe('AVAILABLE');
    expect((await db.query('SELECT contract_id,kind,payload FROM meter_boundary_calls')).rows).toEqual([{contract_id:contract,kind:'MOVE_OUT',payload:{state:'MISSING',reason:'Chưa ghi chỉ số khi trả phòng',readings:[]}}]);
  }));
  it('records exactly one physical boundary in either mode and meter failure rolls back physical/pass/money/case effects',()=>scenario(async()=>{
    await db.exec("SET LOCAL test.meter_fail='yes'");
    await rejected(()=>confirm(),'22023');
    await rejected(()=>confirm({mode:'IMMEDIATE',kind:'FORFEIT',money:{}}),'22023');
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM contract_exit_cases')).rows[0].n).toBe(0);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(0);
    expect((await db.query<{status:string}>('SELECT status FROM contracts WHERE id=$1',[contract])).rows[0].status).toBe('ACTIVE');
    await db.exec("SET LOCAL test.meter_fail='no'");
    const result=await confirm({mode:'IMMEDIATE',kind:'FORFEIT',money:{},meter:{state:'VERIFIED',reason:null,readings:[]}});
    expect(await confirm({mode:'IMMEDIATE',kind:'FORFEIT',money:{},meter:{state:'VERIFIED',reason:null,readings:[]}})).toEqual(result);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM meter_boundary_calls')).rows[0].n).toBe(1);
    await rejected(()=>confirm({mode:'IMMEDIATE',kind:'FORFEIT',money:{},meter:{state:'MISSING',reason:'Different',readings:[]}}),'23505');
  }));
  it('replays physical intent before stale CAS, rejects reuse and denies revoked replay',()=>scenario(async()=>{
    const result=await confirm(); expect(await confirm()).toEqual(result);
    await rejected(()=>confirm({kind:'FORFEIT'}),'23505');
    await db.exec("SET LOCAL test.denied='yes'");
    await rejected(()=>confirm(),'42501');
  }));
  it('closes the old room pass at handover and replay never closes the next tenant pass',()=>scenario(async()=>{
    await db.query('INSERT INTO room_pass_listings(room_id,organization_id,user_id,active) VALUES($1,$2,$3,true)',[room,org,actor]);
    await confirm();
    expect((await db.query<{active:boolean}>('SELECT active FROM room_pass_listings')).rows[0].active).toBe(false);
    await db.query('INSERT INTO room_pass_listings(room_id,organization_id,user_id,active) VALUES($1,$2,$3,true)',[room,org,actor]);
    await confirm();
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM room_pass_listings WHERE active')).rows[0].n).toBe(1);
  }));
  it('rejects stale contract and hidden monetary payload without any case',()=>scenario(async()=>{
    await rejected(()=>confirm({updated:'2026-09-26'}),'PT409');
    await rejected(()=>confirm({money:{deposit_refund:0}}),'22023');
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM contract_exit_cases')).rows[0].n).toBe(0);
  }));
  it('rejects a future handover and an active contract with existing physical end facts',()=>scenario(async()=>{
    await rejected(()=>confirm({date:'2026-09-29'}),'22023');
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM contract_exit_cases')).rows[0].n).toBe(0);
    expect((await db.query<{status:string}>('SELECT status FROM rooms WHERE id=$1',[room])).rows[0].status).toBe('OCCUPIED');
    await db.exec("UPDATE contracts SET actual_end_date='2026-09-27'");
    await rejected(()=>confirm(),'55000');
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(0);
  }));
  it('retains immutable initial kind and a CAS-controlled kind history',()=>scenario(async()=>{
    const result=await confirm();
    const changed=(await db.query<{result:Record<string,unknown>}>(`SELECT update_contract_exit_case_kind_v1($1,$2,1,'FORFEIT','Changed facts','kind-key-0001') AS result`,[org,result.id])).rows[0].result;
    expect(changed).toMatchObject({initial_kind:'EARLY_RETURN',current_kind:'FORFEIT',version:2});
    expect(changed.kind_history).toMatchObject([{before_kind:'EARLY_RETURN',after_kind:'FORFEIT',reason:'Changed facts',changed_by:actor,actor_name:'Actor A'}]);
    await rejected(()=>finalize(result.id),'PT409');
    await rejected(()=>db.query(`UPDATE contract_exit_cases SET initial_kind='FORFEIT',version=3 WHERE id=$1`,[result.id]),'42501');
    await rejected(()=>db.query('UPDATE app_private.contract_exit_kind_history SET actor_id=null WHERE case_id=$1',[result.id]),'42501');
    expect((await db.query<{result:Record<string,unknown>}>(`SELECT update_contract_exit_case_kind_v1($1,$2,1,'FORFEIT','Changed facts','kind-key-0001') AS result`,[org,result.id])).rows[0].result).toEqual(changed);
  }));
  it('late FORFEIT calls exactly the current canonical route and cannot mutate B or the room',()=>scenario(async()=>{
    const result=await confirm({kind:'FORFEIT'});
    const b='00000000-0000-4000-8000-000000000006';
    await db.exec(`INSERT INTO contracts(id,organization_id,room_id,user_id,notes) VALUES('${b}','${org}','${room}','${actor}','B untouched')`);
    const before=(await db.query(`SELECT to_jsonb(c) AS snapshot FROM contracts c WHERE id='${b}'`)).rows[0];
    const oldA=(await db.query(`SELECT to_jsonb(c) AS snapshot FROM contracts c WHERE id='${contract}'`)).rows[0];
    await rejected(()=>db.query('SELECT terminate_contract_forfeit_with_credit_v1($1,$2,$3,$4)',[contract,'2026-09-28','[]','direct-key-0001']),'P0001');
    const settled=await finalize(result.id,{kind:'FORFEIT',money:{extra_charges:[{description:'Extra',amount:50}]}});
    expect(settled).toMatchObject({state:'FINALIZED',initial_kind:'FORFEIT',settlement_result:{termination:{cancelled_invoices:2},credit:{deferred:true}}});
    expect((await db.query('SELECT kind,args FROM canonical_calls')).rows).toEqual([{kind:'FORFEIT',args:{extra_charges:[{description:'Extra',amount:50}]}}]);
    expect((await db.query(`SELECT to_jsonb(c) AS snapshot FROM contracts c WHERE id='${b}'`)).rows[0]).toEqual(before);
    expect((await db.query(`SELECT to_jsonb(c) AS snapshot FROM contracts c WHERE id='${contract}'`)).rows[0]).toEqual(oldA);
    expect((await db.query<{status:string}>(`SELECT status FROM rooms WHERE id='${room}'`)).rows[0].status).toBe('OCCUPIED');
    expect(await finalize(result.id,{kind:'FORFEIT',money:{extra_charges:[{description:'Extra',amount:50}]}})).toEqual(settled);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(1);
    await rejected(()=>finalize(result.id,{kind:'FORFEIT',money:{extra_charges:[]}}),'23505');
    await rejected(()=>finalize(result.id,{kind:'FORFEIT',key:'different-key-0001',money:{extra_charges:[]}}),'PT409');
  }));
  it('IMMEDIATE dispatches old MOVE_OUT arguments and finalizes in one transaction',()=>scenario(async()=>{
    const result=await confirm({mode:'IMMEDIATE',money:{deposit_refund:120,penalty_fee:10,excess_rent:0,outstanding_debt:20,notes:'Case',extra_charges:[],shortfall_mode:'DEBT',receipt_account_id:null,refund_items:[{amount:30,description:'Rent'}]}});
    expect(result).toMatchObject({state:'FINALIZED'});
    expect((await db.query('SELECT kind,args FROM canonical_calls')).rows).toEqual([{kind:'MOVE_OUT',args:{deposit_refund:120,penalty_fee:10,excess_rent:0,outstanding_debt:20,notes:'Case',extra_charges:[],shortfall_mode:'DEBT',receipt_account_id:null,refund_items:[{amount:30,description:'Rent'}]}}]);
  }));
  it('pins selected organization even for a member of both organizations, and filters a deep-link',()=>scenario(async()=>{
    await db.exec(`SET LOCAL test.member2='yes'; INSERT INTO contracts(id,organization_id,room_id,user_id) VALUES('${otherContract}','${otherOrg}','${otherRoom}','${actor}')`);
    const a=await confirm(); const b=await confirm({org:otherOrg,contract:otherContract});
    const list=(await db.query<{result:{items:Record<string,unknown>[];total:number}}>('SELECT list_contract_exit_cases_v1($1,NULL,NULL,1,0,$2) AS result',[org,contract])).rows[0].result;
    expect(list.total).toBe(1); expect(list.items.map(x=>x.id)).toEqual([a.id]);
    await rejected(()=>db.query('SELECT get_contract_exit_case_v1($1,$2)',[org,b.id]),'42501');
    await rejected(()=>finalize(b.id),'42501');
    await rejected(()=>db.query("SELECT update_contract_exit_case_kind_v1($1,$2,1,'FORFEIT','Reason','cross-org-key')",[org,b.id]),'42501');
    await rejected(()=>confirm({contract:otherContract}),'42501');
    await rejected(()=>db.query('SELECT list_contract_exit_cases_v1($1,$2)',[org,otherBuilding]),'42501');
    expect((await db.query<{result:{total:number}}>('SELECT list_contract_exit_cases_v1($1,NULL,NULL,50,0,NULL,$2) AS result',[org,[otherBuilding]])).rows[0].result.total).toBe(0);
  }));
  it('rolls back all immediate effects when the old audit is missing and retains pending on late failure',()=>scenario(async()=>{
    await db.exec("SET LOCAL test.skip_audit='yes'");
    await rejected(()=>confirm({mode:'IMMEDIATE',kind:'FORFEIT',money:{}}),'55000');
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(0);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM contract_exit_cases')).rows[0].n).toBe(0);
    expect((await db.query<{status:string}>('SELECT status FROM contracts WHERE id=$1',[contract])).rows[0].status).toBe('ACTIVE');
    const pending=await confirm({kind:'FORFEIT'});
    await rejected(()=>finalize(pending.id,{kind:'FORFEIT',money:{}}),'55000');
    expect((await db.query('SELECT state,version FROM contract_exit_cases')).rows[0]).toEqual({state:'PENDING',version:1});
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM app_private.contract_exit_writer_context')).rows[0].n).toBe(0);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(0);
  }));
  it('blocks direct authenticated table/helper access and rejects an altered party before money',()=>scenario(async()=>{
    const pending=await confirm();
    await db.exec("UPDATE contracts SET tenant_id='00000000-0000-4000-8000-000000000099'");
    await rejected(()=>finalize(pending.id),'55000');
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(0);
    expect((await db.query("SELECT has_table_privilege('authenticated','contract_exit_cases','SELECT') AS allowed, has_function_privilege('authenticated','app_private.is_contract_exit_settlement_v1(uuid,date)','EXECUTE') AS helper")).rows[0]).toEqual({allowed:false,helper:false});
  }));
  it('keeps read RPCs and their helper pure and acquires existing authorization lock before subject locks',async()=>{
    const rows=(await db.query<{proname:string;provolatile:string;body:string}>("SELECT proname,provolatile,pg_get_functiondef(oid) AS body FROM pg_proc WHERE proname IN ('get_contract_exit_case_v1','list_contract_exit_cases_v1','assert_contract_exit_scope_v1','confirm_contract_return_v1','finalize_contract_exit_case_v1','update_contract_exit_case_kind_v1')")).rows;
    for(const row of rows){
      if(['get_contract_exit_case_v1','list_contract_exit_cases_v1','assert_contract_exit_scope_v1'].includes(row.proname)){
        expect(row.provolatile).toBe('s');expect(row.body).not.toContain('lock_org_for_decision_v1');expect(row.body).not.toContain('authorize_tenant_action_v3');
      }else{
        expect(row.provolatile).toBe('v');expect(row.body.indexOf('lock_org_for_decision_v1')).toBeLessThan(row.body.indexOf('FOR UPDATE'));
      }
    }
    await db.exec('BEGIN READ ONLY');
    try {expect((await db.query<{result:{items:unknown[]}}>('SELECT list_contract_exit_cases_v1($1) AS result',[org])).rows[0].result.items).toEqual([]);}
    finally {await db.exec('ROLLBACK');}
  });
  it('patches only the two physical seams in the real current function bodies and remains rerunnable',async()=>{
    for(const [file,name] of [
      ['20260731070000_current_date_to_org_today.sql','terminate_contract_forfeit_impl'],
      ['20260915074638_coc_thanh_ly_va_cap_hoan_coc.sql','terminate_contract_move_out_impl'],
    ]){
      const source=readFileSync(`supabase/migrations/${file}`,'utf8');
      const start=source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      await db.exec(source.slice(start,source.indexOf('$function$;',start)+12));
    }
    const definitions=async()=>(await db.query<{name:string;body:string}>("SELECT proname AS name,pg_get_functiondef(oid) AS body FROM pg_proc WHERE proname IN ('terminate_contract_forfeit_impl','terminate_contract_move_out_impl') ORDER BY proname")).rows;
    const before=await definitions(); await db.exec(readFileSync(path,'utf8')); const after=await definitions();
    expect(after.length).toBe(2);
    for(let i=0;i<2;i++){
      const date=before[i].name.includes('forfeit')?'p_forfeit_date':'p_move_out_date';
      const expected=before[i].body.replace("IF v_contract.status IN ('TERMINATED','EXPIRED') THEN",`IF v_contract.status IN ('TERMINATED','EXPIRED') AND NOT (v_contract.status = 'TERMINATED' AND app_private.is_contract_exit_settlement_v1(p_contract_id,${date})) THEN`)
        .replace(/ {2}UPDATE contracts\s+SET status\s*=\s*'TERMINATED'[\s\S]*?WHERE id = p_contract_id;/,match=>`  IF NOT app_private.is_contract_exit_settlement_v1(p_contract_id,${date}) THEN\n${match}\n  END IF;`);
      expect(after[i].body).toBe(expected);
    }
    await db.exec(readFileSync(path,'utf8')); expect(await definitions()).toEqual(after);
    await db.exec(readFileSync(notePath,'utf8'));
  });
  it('pairs the actual exit and meter migrations: A missing still returns, B requires its own verified reading',async()=>{
    await db.exec(`ALTER TABLE contracts ADD COLUMN created_at timestamptz DEFAULT now();
      CREATE TABLE meters(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,building_id uuid,status text,deleted_at timestamptz,code text,meter_type text);
      CREATE TABLE meter_readings(id uuid PRIMARY KEY,meter_id uuid,contract_id uuid,organization_id uuid,room_id uuid,building_id uuid,
        reading_code text,reading_date date,current_reading numeric,status text,deleted_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,billing_month text,status text,approved_at timestamptz,deleted_at timestamptz);
      CREATE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'Asia/Ho_Chi_Minh' $$;`);
    const meterMigration=readFileSync('supabase/migrations/20260928023413_contract_meter_boundaries.sql','utf8');
    await db.exec(meterMigration);await db.exec(meterMigration);
    // Định nghĩa đang sống của record_contract_meter_boundary_set_v1 (đồng bộ mốc từ số chốt khi quyết toán).
    const liveMeterMigration=readFileSync('supabase/migrations/20261008025958_contract_meter_boundary_final_reading_sync.sql','utf8');
    await db.exec(liveMeterMigration);await db.exec(liveMeterMigration);
    await scenario(async()=>{
      const meter='00000000-0000-4000-8000-000000000099';
      const next='00000000-0000-4000-8000-000000000098';
      await db.exec(`INSERT INTO meters VALUES('${meter}','${org}','${room}','${building}','ACTIVE',NULL,'E1','ELECTRICITY')`);
      const a=await confirm();expect(await confirm()).toEqual(a);
      const out=(await db.query<{result:{state:string;readings:{reading:number|null}[]}}>("SELECT read_contract_meter_boundary_set_v1($1,$2,'MOVE_OUT') AS result",[org,contract])).rows[0].result;
      expect(out.state).toBe('MISSING');expect(out.readings[0].reading).toBeNull();
      expect((await db.query<{status:string}>('SELECT status FROM rooms WHERE id=$1',[room])).rows[0].status).toBe('AVAILABLE');
      await db.exec(`INSERT INTO contracts(id,organization_id,room_id,user_id,start_date) VALUES('${next}','${org}','${room}','${actor}','2026-09-28')`);
      await rejected(()=>db.query('SELECT app_private.assert_contract_move_in_boundaries_v1($1,$2)',[org,next]),'55000');
      await db.query("SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,'MOVE_IN','2026-09-28',$4::jsonb)",[org,next,room,JSON.stringify({state:'VERIFIED',reason:null,readings:[{meter_id:meter,reading:0,measured_at:'2026-09-28T09:00:00+07:00',evidence:'Verified B'}]})]);
      await db.query('SELECT app_private.assert_contract_move_in_boundaries_v1($1,$2)',[org,next]);
      expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM canonical_calls')).rows[0].n).toBe(0);
      expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM meter_readings')).rows[0].n).toBe(0);
      expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM contract_meter_boundary_sets')).rows[0].n).toBe(2);
    });
  });
});
