import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localCluster,setup,jwt,settings,live,id,ORG,FOREIGN,USER,ROLE,BUILDING,ROOM,HIDDEN,ORG_SCOPE,MEMBER} from './crm-shared-read-sql-fixture.mjs';
const originalMigration=readFileSync('supabase/migrations/20261019040948_hermes_copied_text_parity_v1.sql','utf8');
const mutation=process.env.HERMES_COPIED_SQL_MUTATION;
const migration=mutation==='voucher-exclusion' ? originalMigration.replace("CASE WHEN p_ctx->'allowCopiedCustomerText'='true'::jsonb THEN v.payer_name END",'v.payer_name')
 : mutation==='owner-exclusion' ? originalMigration.replace('CASE WHEN p_allow_copied_owner OR x.customer_visible THEN x.owner_name END','x.owner_name')
 : mutation==='embedded-customer' ? originalMigration.replace('CASE WHEN x.customer_visible THEN x.customer_id END','x.customer_id') : originalMigration;

const [FUND,OTHER_FUND,VOUCHER,OTHER_VOUCHER,FOREIGN_VOUCHER,TYPE,B2,R2,VEHICLE,LOOSE]=Array.from({length:10},(_,i)=>id(i+300));
async function setupPii(pool){
 await setup(pool);
 await pool.query(`
 ALTER TABLE public.accounts ADD COLUMN user_id uuid;
 CREATE TABLE public.income_expenses(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,code text,type text,name text,payer_name text,
 building_id uuid,room_id uuid,account_id uuid,contract_id uuid,voucher_date date,approval_status text,deleted_at timestamptz);
 CREATE TABLE public.income_expense_items(income_expense_id uuid,income_expense_type_id uuid,amount numeric);
 CREATE TABLE public.income_expense_types(id uuid,organization_id uuid,is_deposit boolean);
 CREATE TABLE public.reservation_deposit_settlements(source_voucher_id uuid);
 CREATE TABLE public.reservation_hold_deadlines(income_expense_id uuid,organization_id uuid,hold_until date,topup_due_date date,deposit_target numeric);
 CREATE TABLE public.deposit_management_exclusions(voucher_id uuid,organization_id uuid);
 CREATE TABLE public.vehicles(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,vehicle_type text,vehicle_name text,license_plate text,color text,
 owner_name text,ticket_number text,parking_fee numeric,building_id uuid,room_id uuid,customer_id uuid,created_at timestamptz,deleted_at timestamptz);
 INSERT INTO public.permission_definitions(key) VALUES('deposits.view'),('vehicles.view') ON CONFLICT DO NOTHING;
 INSERT INTO public.role_permissions VALUES('${ORG}','${ROLE}','deposits.view','ALLOW'),('${ORG}','${ROLE}','vehicles.view','ALLOW');
 INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort) VALUES('${B2}','${ORG}','${USER}','Fund-only B','fund');
 INSERT INTO public.rooms VALUES('${R2}','${ORG}','${B2}','P201','p201',null);
 INSERT INTO public.accounts(id,organization_id,user_id) VALUES('${FUND}','${ORG}','${USER}'),('${OTHER_FUND}','${ORG}','${id(999)}');
 INSERT INTO public.income_expense_types VALUES('${TYPE}','${ORG}',true);
 INSERT INTO public.income_expenses VALUES
 ('${VOUCHER}','${ORG}','${id(999)}','PT-Q1','INCOME','Cọc PII-TEN-PHIEU','PII-NGUOI-NOP 0988000000','${B2}','${R2}','${FUND}',null,'2026-10-19','APPROVED',null),
 ('${OTHER_VOUCHER}','${ORG}','${id(999)}','PT-Q2','INCOME','Sổ người khác','Khách khác','${B2}','${R2}','${OTHER_FUND}',null,'2026-10-19','APPROVED',null),
 ('${FOREIGN_VOUCHER}','${FOREIGN}','${USER}','PT-X','INCOME','Foreign copied text','Foreign payer','${B2}','${R2}','${FUND}',null,'2026-10-19','APPROVED',null);
 INSERT INTO public.income_expense_items VALUES('${VOUCHER}','${TYPE}',600000),('${OTHER_VOUCHER}','${TYPE}',800000),('${FOREIGN_VOUCHER}','${TYPE}',900000);
 INSERT INTO public.vehicles VALUES
 ('${VEHICLE}','${ORG}','${USER}','CAR','Xe tổng hợp','30A12345',null,'Chủ xe đã ghi trên xe',null,12345.75,'${BUILDING}','${ROOM}','${HIDDEN}','2026-10-19',null),
 ('${LOOSE}','${ORG}','${USER}','CAR','Xe không khách','30A99999',null,'Tên chủ xe không gắn hồ sơ',null,100,null,null,null,'2026-10-18',null);
 ALTER TABLE public.income_expenses ENABLE ROW LEVEL SECURITY;
 CREATE POLICY fixture_fund ON public.income_expenses FOR SELECT TO authenticated USING(organization_id=ANY(public.my_org_ids())
 AND account_id IN(SELECT id FROM public.accounts WHERE user_id=auth.uid()));
 ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
 CREATE POLICY fixture_vehicle ON public.vehicles FOR SELECT TO authenticated USING(organization_id=ANY(public.my_org_ids()) AND public.can_access_org_entity('vehicles','view'));
 GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
 `);
 for(const name of ['public.has_full_building_scope','public.accessible_building_ids','public.safe_text_v1','public.deposit_reservation_vouchers_v1',
 'public.vehicles_list_v1','app_private.hermes_w2a_read_v1','app_private.hermes_w2c_read_v1']){assert(live.has(name),name);await pool.query(live.get(name));}
 // Summary is a fixture aggregate over the actual shared voucher source; the
 // migration changes no monetary formula or money writer.
 await pool.query(`CREATE FUNCTION public.get_reservation_deposit_summary(uuid[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('holding_amount',coalesce(sum(deposit_amount),0),'approved_count',count(*) FILTER(WHERE approval_status='APPROVED'),
 'unapproved_count',count(*) FILTER(WHERE approval_status='UNAPPROVED'),'cancelled_count',count(*) FILTER(WHERE approval_status='CANCELLED'))
 FROM public.deposit_reservation_vouchers_v1('${ORG}',$1) $$;`);
 for(const name of ['app_private.hermes_domain_date_v2','app_private.hermes_w2_reused_keys_v1','app_private.hermes_w2_org_keys_v1','app_private.hermes_w2_permission_kind_v1','app_private.hermes_w2_param_names_v1','app_private.hermes_w2_params_v1',
 'app_private.hermes_w2a_catalog_v1','app_private.hermes_w2b_catalog_v1','app_private.hermes_w2c_catalog_v1','app_private.hermes_w2d_catalog_v1',
 'app_private.hermes_w2_catalog_v1','app_private.hermes_full_read_scope_v1','app_private.hermes_private_command_connection_v1']) {
 assert(live.has(name),name);await pool.query(live.get(name));}
 await pool.query("INSERT INTO app_private.hermes_capabilities VALUES('deposits.view','read',true),('vehicles.view','read',true) ON CONFLICT DO NOTHING");
 await pool.query(migration);await pool.query(migration);
}
const ctx=(report,allowed=true)=>({organizationId:ORG,userId:USER,report,permission:report==='vehicles'?'vehicles.view':'deposits.view',
 buildings:[BUILDING,B2],orgWide:true,today:'2026-10-19',scopes:{'customers.view':[]},allowCopiedCustomerText:allowed});
async function read(pool,report,query='',allowed=true){return jwt(pool,async c=>(await c.query(`SELECT app_private.hermes_w2${report==='vehicles'?'c':'a'}_read_v1($1,$2,$3) value`,
 [report,JSON.stringify({query,kind:null,status:null,fromDate:null,toDate:null,roomId:null,customerId:null}),JSON.stringify(ctx(report,allowed))])).rows[0].value);}
test('TG5 copied voucher/vehicle text follows own source RLS, explicit exclusions still suppress search/output, customer JOIN stays private',{timeout:120000},async t=>{
 const {pool,cleanup}=await localCluster(t);t.after(async()=>{await pool.end();cleanup();});await setupPii(pool);
 const vouchers=await read(pool,'reservation_vouchers');assert.deepEqual(vouchers.rows.map(r=>r.voucherId),[VOUCHER]);
 assert.equal(vouchers.rows[0].name,'Cọc PII-TEN-PHIEU');assert.equal(vouchers.rows[0].payerName,'PII-NGUOI-NOP 0988000000');
 assert.equal((await read(pool,'reservation_vouchers','pii-ten-phieu')).rows.length,1);
 assert.equal((await read(pool,'reservation_vouchers','0988000000')).rows.length,1);
 const hidden=await read(pool,'reservation_vouchers','',false);assert.equal(hidden.rows[0].name,null);assert.equal(hidden.rows[0].payerName,null);
 assert.deepEqual((await read(pool,'reservation_vouchers','0988000000',false)).rows,[]);
 assert.equal((await read(pool,'reservation_vouchers','pt-q1',false)).rows.length,1,'Explicit text exclusion does not remove permitted source rows');
 const vehicles=await read(pool,'vehicles');const vehicle=vehicles.rows.find(r=>r.id===VEHICLE);assert.equal(vehicle.ownerName,'Chủ xe đã ghi trên xe');
 assert.equal(vehicle.customerName,null);assert.equal(vehicle.customerPhone,null);assert.equal(vehicle.customerId,null);
 assert.equal((await read(pool,'vehicles','Chủ xe đã ghi')).rows.length,1);assert.deepEqual((await read(pool,'vehicles','Hidden Owner')).rows,[]);
 assert.equal(vehicles.rows.find(r=>r.id===LOOSE).ownerName,'Tên chủ xe không gắn hồ sơ');
 assert.equal((await read(pool,'vehicles','',false)).rows.find(r=>r.id===VEHICLE).ownerName,null);
 assert.deepEqual((await read(pool,'vehicles','Chủ xe đã ghi',false)).rows,[]);
 await pool.query("UPDATE role_permissions SET effect='DENY' WHERE permission_key='vehicles.view'");assert.deepEqual((await read(pool,'vehicles')).rows,[]);
 await pool.query("UPDATE role_permissions SET effect='ALLOW' WHERE permission_key='vehicles.view'");
 const prepared=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value",[ORG])).rows[0].value);
 const tokenDigest='c'.repeat(64);
 let connection=(await pool.query('SELECT app_private.hermes_store_activate_v1($1) value',[JSON.stringify({connectionId:prepared.id,expectedEpoch:1,operationId:id(430),intentSecret:prepared.intentSecret,
 userId:USER,providerSessionId:id(432),credentialRef:id(431),tokenDigest,tokenExpiresAt:Date.now()+600000,sessionExpiresAt:Date.now()+3600000,
 sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',nonce:'a'.repeat(16),tag:'a'.repeat(22),ciphertext:'abcd'}})])).rows[0].value.connection;
 const admitted=()=>jwt(pool,async c=>{await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:USER,session_id:id(432)})]);
 return (await c.query('SELECT app_private.hermes_w2_scope_v1($1,$2,$3,$4) value',[JSON.stringify({connectionId:connection.id,tokenDigest,expectedEpoch:connection.epoch,expectedPolicyVersion:0,
 expectedMembershipId:MEMBER,expectedAuthorizationVersion:1,expectedSessionRevision:1}),'report',JSON.stringify({report:'vehicles',params:{query:'',kind:null,buildingId:null,roomId:null,customerId:null},limit:20,offset:0}),'authenticated'])).rows[0].value;});
 assert.equal((await admitted()).ctx.allowCopiedCustomerText,true,'Actual admission conveys the inherited copied-text intent');
 await pool.query("UPDATE role_permissions SET effect='DENY' WHERE permission_key='customers.view'");
 assert.equal((await admitted()).ctx.allowCopiedCustomerText,true,'Lack of CRM customer-profile permission does not remove permitted copied voucher/vehicle text');
 connection=await settings(pool,connection,{read:['customers.view'],action:[]});
 assert.equal((await admitted()).ctx.allowCopiedCustomerText,false,'Explicit Hermes customer exclusion remains effective');
 connection=await settings(pool,connection);
 await pool.query("INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,read_capabilities,action_capabilities,scope_ids,updated_by) VALUES($1,true,1,ARRAY['vehicles.view'],'{}',ARRAY[$2]::uuid[],$3)",[ORG,ORG_SCOPE,USER]);
 // Observe the company flag directly from the reviewed expression in a scope
 // snapshot: the current policy version is part of this legacy W2 binding.
 const companyPlan=await jwt(pool,async c=>{await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:USER,session_id:id(432)})]);
 return(await c.query('SELECT app_private.hermes_w2_scope_v1($1,$2,$3,$4) value',[JSON.stringify({connectionId:connection.id,tokenDigest,expectedEpoch:connection.epoch,expectedPolicyVersion:1,
 expectedMembershipId:MEMBER,expectedAuthorizationVersion:1,expectedSessionRevision:1}),'report',JSON.stringify({report:'vehicles',params:{query:'',kind:null,buildingId:null,roomId:null,customerId:null},limit:20,offset:0}),'authenticated'])).rows[0].value;});
 assert.equal(companyPlan.ctx.allowCopiedCustomerText,false,'Explicit company customer ceiling still suppresses copied text');


});
