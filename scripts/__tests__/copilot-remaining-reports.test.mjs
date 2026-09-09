import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
const migration = readdirSync(migrationDir).find(n => n.endsWith('_copilot_remaining_report_readers_v1.sql'));
test('three remaining report RPCs exist and execute with bounded organization scope', async () => {
  assert.ok(migration, 'remaining report migration must exist');
  const sql = readFileSync(new URL(migration, migrationDir), 'utf8');
  for (const name of ['promotions', 'handover', 'collection_cycle']) assert.match(sql, new RegExp(`FUNCTION public.copilot_report_${name}_v1`));
});

const org='dddd0000-0000-4000-8000-000000000001', foreign='cccc0000-0000-4000-8000-000000000001';
const id=n=>`dddd0000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=id(2), building=id(3), deniedBuilding=id(4), account=id(5), deniedAccount=id(6), dest=id(7), room=id(8);
function definition(sql,name) {
 const start=sql.search(new RegExp(`create or replace function ${name.replace('.','\\.')}\\s*\\(`,'i'));
 assert.notEqual(start,-1); const tail=sql.slice(start), q=tail.match(/\bAS\s+(\$\w*\$)/i);
 return tail.slice(0,tail.indexOf(';',tail.indexOf(q[1],q.index+q[0].length)+q[1].length)+1);
}
async function setup() {
 const db=new PGlite();
 await db.exec(`
 CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE SCHEMA auth; CREATE SCHEMA app_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE TABLE organizations(id uuid,status text);
 CREATE TABLE organization_memberships(organization_id uuid,user_id uuid,status text,revoked_at timestamptz,valid_from timestamptz,valid_to timestamptz);
 CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz,is_virtual boolean DEFAULT false);
 CREATE TABLE staff_assignments(organization_id uuid,staff_id uuid,building_id uuid,area_id uuid);
 CREATE TABLE area_buildings(organization_id uuid,area_id uuid,building_id uuid);
 CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 INSERT INTO staff_assignments VALUES('${org}','${actor}','${building}',NULL);
 CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text,deleted_at timestamptz);
 CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,contract_number text,signed_date date,status text,rent_price numeric,discounts jsonb,deleted_at timestamptz);
 CREATE TABLE accounts(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz,is_virtual boolean DEFAULT false,bank_name text);
 CREATE TABLE accounts_with_balance(id uuid,current_amount numeric);
 CREATE TABLE income_expenses(id uuid,organization_id uuid,account_id uuid,type text,total_amount numeric,approval_status text,deleted_at timestamptz,handover_transfer_id uuid,voucher_date date);
 CREATE TABLE cash_handovers(id uuid PRIMARY KEY,organization_id uuid,from_account_id uuid,to_account_id uuid,giver_id uuid,status text,confirmed_at timestamptz,code text,total_amount numeric,gross_amount numeric,expense_amount numeric);
 CREATE TABLE cashbook_reconciliations(id uuid,organization_id uuid,account_id uuid,status text,as_of_date date,system_balance numeric,counted_balance numeric,diff numeric);
 CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz,status text,total_amount numeric,paid_amount numeric,remaining_amount numeric,issue_date date);
 CREATE TABLE payment_receipt_events(organization_id uuid,invoice_id uuid,payment_date date,payment_method text,collected_amount numeric,applied_amount numeric);
 -- Resolver seam: effective scope already excludes denied resources (the actual
 -- authorized_scope_v3 resolver has its own SQL harness). Report SQL and both
 -- organization/membership scope helpers below are production definitions.
 CREATE TABLE fixture_policy(permission text PRIMARY KEY,allowed boolean DEFAULT true,org_wide boolean DEFAULT false,building_ids uuid[],cashbook_ids uuid[]);
 CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$
 SELECT p.org_wide AND p.allowed,CASE WHEN p.allowed THEN p.building_ids ELSE '{}'::uuid[] END,CASE WHEN p.allowed THEN p.cashbook_ids ELSE '{}'::uuid[] END
 FROM fixture_policy p WHERE p.permission=$1 AND $2='${org}' $$;
 CREATE TABLE fixture_flags(enabled boolean); INSERT INTO fixture_flags VALUES(true);
 CREATE FUNCTION app_private.copilot_page_flag_allows_v1(text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT enabled FROM fixture_flags $$;
 CREATE TABLE fixture_visible(cashbook_id uuid);
 CREATE FUNCTION app_private.ie_visible_cashbook_ids_v1() RETURNS TABLE(cashbook_id uuid) LANGUAGE sql STABLE AS $$ SELECT cashbook_id FROM fixture_visible $$;
 CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-09-09'::date $$;
 INSERT INTO organizations VALUES('${org}','ACTIVE'),('${foreign}','ACTIVE');
 INSERT INTO organization_memberships VALUES('${org}','${actor}','ACTIVE',NULL,NULL,NULL);
 INSERT INTO buildings(id,organization_id,name) VALUES('${building}','${org}','Allowed'),('${deniedBuilding}','${org}','DENIED'),('${id(9)}','${foreign}','FOREIGN');
 INSERT INTO rooms VALUES('${room}','${org}','${building}','A1',NULL),('${id(10)}','${org}','${deniedBuilding}','DENIED',NULL),('${id(11)}','${foreign}','${id(9)}','FOREIGN',NULL);
 INSERT INTO accounts(id,organization_id,name) VALUES('${account}','${org}','Manager Thu'),('${deniedAccount}','${org}','DENIED Thu'),('${dest}','${org}','Owner'),('${id(12)}','${foreign}','FOREIGN Thu');
 INSERT INTO accounts_with_balance VALUES('${account}',700),('${deniedAccount}',9999),('${id(12)}',99999);
 INSERT INTO fixture_visible VALUES('${account}'),('${deniedAccount}');
 INSERT INTO fixture_policy SELECT p,true,false,ARRAY['${building}'::uuid],ARRAY['${account}'::uuid] FROM unnest(ARRAY['reports_real_estate.promotions','reports_finance.handover_report','reports_finance.collection_cycle','cashbooks.view']) p;
 INSERT INTO contracts VALUES('${id(20)}','${org}','${room}','PROMO-PERCENT','2026-09-01','ACTIVE',1000,'{"type":"percent","amount":10}',NULL),
 ('${id(21)}','${org}','${room}','PROMO-FIXED','2026-09-02','ACTIVE',1000,'{"type":"fixed","value":200}',NULL),
 ('${id(22)}','${org}','${id(10)}','DENIED','2026-09-03','ACTIVE',9999,'{"amount":9999}',NULL),
 ('${id(23)}','${foreign}','${room}','CROSS-ORG-JOIN','2026-09-03','ACTIVE',9999,'{"amount":9999}',NULL);
 INSERT INTO income_expenses VALUES('${id(30)}','${org}','${account}','INCOME',500,'APPROVED',NULL,NULL,'2026-09-01'),
 ('${id(31)}','${org}','${account}','EXPENSE',100,'APPROVED',NULL,NULL,'2026-09-01'),
 ('${id(32)}','${org}','${account}','INCOME',9000,'APPROVED',NULL,'${id(40)}','2026-09-01'),
 ('${id(33)}','${foreign}','${account}','INCOME',9999,'APPROVED',NULL,NULL,'2026-09-01'),
 ('${id(34)}','${org}','${account}','INCOME',9999,'UNAPPROVED',NULL,NULL,'2026-09-01');
 INSERT INTO cash_handovers VALUES('${id(40)}','${org}','${account}','${dest}','${actor}','CONFIRMED','2026-09-03 05:00Z','H1',200,250,50),
 ('${id(41)}','${org}','${account}','${dest}','${actor}','CONFIRMED','2026-09-05 05:00Z','H2',100,120,20),
 ('${id(42)}','${foreign}','${account}','${dest}','${actor}','CONFIRMED','2026-09-06 05:00Z','FOREIGN',9999,9999,0),
 ('${id(43)}','${org}','${deniedAccount}','${dest}','${actor}','CONFIRMED','2026-09-06 05:00Z','DENIED',9999,9999,0);
 INSERT INTO cashbook_reconciliations VALUES('${id(44)}','${org}','${account}','CONFIRMED','2026-09-05',700,690,-10),
 ('${id(45)}','${foreign}','${account}','CONFIRMED','2026-09-06',9999,9999,0);
 INSERT INTO invoices VALUES('${id(50)}','${org}','${building}',NULL,'PAID',1000,500,500,'2026-09-01'),
 ('${id(51)}','${org}','${building}',NULL,'PAID',100,200,-100,'2026-09-01'),
 ('${id(52)}','${org}','${deniedBuilding}',NULL,'PAID',9999,9999,0,'2026-09-01'),
 ('${id(53)}','${foreign}','${building}',NULL,'PAID',9999,9999,0,'2026-09-01'),
 ('${id(54)}','${org}','${building}',NULL,'DRAFT',9999,0,9999,'2026-09-01');
 INSERT INTO payment_receipt_events VALUES('${org}','${id(50)}','2026-09-02','CASH',300,300),
 ('${org}','${id(50)}','2026-09-04','CT',0,100),('${org}','${id(50)}','2026-09-06','CASH',100,100),
 ('${org}','${id(51)}','2026-09-02','CASH',200,200),('${foreign}','${id(50)}','2026-09-02','CASH',9999,9999);
 UPDATE fixture_policy SET org_wide=true WHERE permission LIKE 'reports_finance.%';
 SELECT set_config('request.jwt.claim.sub','${actor}',false);
 `);
 const helpers=readFileSync(new URL('20260829090000_copilot_org_scope_semantics_v1.sql',migrationDir),'utf8');
 await db.exec(definition(helpers,'public.copilot_org_scope_buildings_v1'));
 await db.exec(definition(helpers,'app_private.copilot_scope_cashbooks_v1'));
 await db.exec(readFileSync(new URL(migration,migrationDir),'utf8'));
 return db;
}
async function call(db,name,limit=1,selected=org,tu='2026-09-01',den='2026-09-09') {
 const extra=name==='promotions'?',NULL':'';
 return (await db.query(`SELECT public.copilot_report_${name}_v1($1::uuid,$2::date,$3::date${extra},$4::integer) AS value`,[selected,tu,den,limit])).rows[0].value;
}
test('report SQL: formulas, tenant joins, cashbook/building denies and full totals precede LIMIT',async()=>{
 const db=await setup(); try {
  const promo=await call(db,'promotions');
  assert.equal(promo.khuyen_mai.length,1); assert.equal(promo.tong_hop.tong_giam_gia,300); assert.equal(promo.tong_hop.so_hop_dong,2);
  assert.equal(promo.khuyen_mai[0].thuc_thue,800);
  const hand=await call(db,'handover');
  assert.equal(hand.tong_hop.da_thu,500); assert.equal(hand.tong_hop.da_chi,100); assert.equal(hand.tong_hop.da_ban_giao,300);
  assert.equal(hand.tong_hop.dang_giu,700); assert.equal(hand.phien.length,1); assert.equal(hand.tong_hop.so_phien,2); assert.equal(hand.doi_soat.length,1);
  const cycle=await call(db,'collection_cycle');
  assert.equal(cycle.tong_hop.da_thu_trong_ky,600); assert.equal(cycle.tong_hop.da_ban_giao,300);
  assert.equal(cycle.tong_hop.chua_thu_hien_tai,400); assert.equal(cycle.tong_hop.tong_len_hoa_don,1100);
  assert.equal(cycle.moc_ban_giao.length,1); assert.equal(cycle.moc_ban_giao[0].ma,'H2');
  assert.equal(cycle.moc_ban_giao[0].thu_trong_doan,0); assert.equal(cycle.moc_ban_giao[0].chua_thu_tai_moc,500);
  assert.equal(cycle.hien_tai.thu_trong_doan,100);
  assert.doesNotMatch(JSON.stringify([promo,hand,cycle]),/FOREIGN|DENIED|9999/);
 } finally {await db.close();}
});
test('report SQL: missing auth, revoked membership, foreign org, missing permission, flag, dates, ACL fail closed',async()=>{
 const db=await setup(); try {
  for(const name of ['promotions','handover','collection_cycle']) {
   await assert.rejects(call(db,name,20,foreign),e=>e.code==='42501');
   await assert.rejects(call(db,name,20,org,'2026-09-09','2026-09-01'),e=>e.code==='22023');
   await assert.rejects(call(db,name,20,org,'2020-01-01','2026-09-01'),e=>e.code==='22023');
   assert.equal((await call(db,name,999)).gioi_han,50); assert.equal((await call(db,name,-5)).gioi_han,1);
  }
  for(const change of ["UPDATE fixture_policy SET allowed=false", "UPDATE fixture_flags SET enabled=false", "SELECT set_config('request.jwt.claim.sub','',false)","UPDATE organization_memberships SET revoked_at=now()"]) {
   await db.exec('BEGIN'); await db.exec(change);
   for(const name of ['promotions','handover','collection_cycle']) { await db.exec('SAVEPOINT denial'); await assert.rejects(call(db,name),e=>e.code==='42501'); await db.exec('ROLLBACK TO SAVEPOINT denial'); }
   await db.exec('ROLLBACK');
  }
  for(const role of ['anon','service_role']) {
   await db.exec(`SET ROLE ${role}`);
   for(const name of ['promotions','handover','collection_cycle']) await assert.rejects(call(db,name),e=>e.code==='42501');
   await db.exec('RESET ROLE');
  }
  await db.exec(`SET ROLE authenticated`);
  assert.equal((await call(db,'promotions')).tong_hop.so_hop_dong,2);
  await db.exec('RESET ROLE');
  await db.exec('DELETE FROM fixture_visible');
  assert.equal((await call(db,'handover')).so_quy.length,0);
  assert.equal((await call(db,'collection_cycle')).tong_hop.da_ban_giao,0);
 } finally {await db.close();}
});

test('account totals fail closed when report org-wide grant contains a scoped deny',async()=>{
 const db=await setup();try{
  await db.exec("UPDATE fixture_policy SET org_wide=false WHERE permission LIKE 'reports_finance.%'");
  for(const name of ['handover','collection_cycle'])await assert.rejects(call(db,name),e=>e.code==='42501');
 }finally{await db.close();}
});

test('real authorized_scope_v3: ORGANIZATION allow plus BUILDING deny never reopens report totals',async()=>{
 const db=await setup(); try {
  await db.exec(`
    ALTER TABLE organization_memberships ADD COLUMN id uuid DEFAULT gen_random_uuid();
    UPDATE organization_memberships SET id='${id(70)}';
    CREATE TABLE permission_definitions(key text,permission_domain text,is_active boolean,scope_kinds text[],requires_cashbook_possession boolean,accepted_possession_kinds text[],required_dimensions text[]);
    CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid,permission_key text,active_from timestamptz,expires_at timestamptz);
    CREATE TABLE member_permission_overrides(id uuid,organization_id uuid,membership_id uuid,permission_key text,effect text,revoked_at timestamptz,expires_at timestamptz);
    CREATE TABLE member_override_scopes(organization_id uuid,override_id uuid,scope_id uuid);
    CREATE TABLE authorization_scopes(id uuid,organization_id uuid,scope_type text,building_id uuid,cashbook_id uuid,area_id uuid);
    CREATE TABLE role_bindings(id uuid,organization_id uuid,membership_id uuid,role_id uuid,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE organization_roles(id uuid,organization_id uuid,status text);
    CREATE TABLE role_permissions(organization_id uuid,role_id uuid,permission_key text,effect text);
    CREATE TABLE role_binding_scopes(organization_id uuid,role_binding_id uuid,scope_id uuid);
    CREATE TABLE cashbook_possession_bindings(organization_id uuid,membership_id uuid,cashbook_id uuid,possession_kind text,valid_from timestamptz,valid_to timestamptz);
    INSERT INTO permission_definitions SELECT permission,'TENANT',true,ARRAY['ORGANIZATION','BUILDING','CASHBOOK'],false,'{}','{}' FROM fixture_policy;
    INSERT INTO authorization_scopes VALUES('${id(71)}','${org}','ORGANIZATION',NULL,NULL,NULL),('${id(72)}','${org}','BUILDING','${deniedBuilding}',NULL,NULL);
    INSERT INTO member_permission_overrides SELECT gen_random_uuid(),'${org}','${id(70)}',permission,'ALLOW',NULL,NULL FROM fixture_policy;
    INSERT INTO member_override_scopes SELECT '${org}',id,'${id(71)}' FROM member_permission_overrides;
  `);
  const real=readFileSync(new URL('20260908162757_authz_scope_org_wide_scoped_deny_v1.sql',migrationDir),'utf8');
  await db.exec(definition(real,'app_private.authorized_scope_v3'));
  for(const name of ['promotions','handover','collection_cycle'])assert.ok(await call(db,name));
  await db.exec(`
    INSERT INTO member_permission_overrides SELECT gen_random_uuid(),'${org}','${id(70)}',permission,'DENY',NULL,NULL FROM fixture_policy WHERE permission LIKE 'reports_%';
    INSERT INTO member_override_scopes SELECT '${org}',id,'${id(72)}' FROM member_permission_overrides WHERE effect='DENY';
  `);
  const scope=(await db.query("SELECT * FROM app_private.authorized_scope_v3('reports_finance.handover_report',$1)",[org])).rows[0];
  assert.equal(scope.org_wide,false); assert.ok(scope.cashbook_ids.includes(account));
  assert.ok(!scope.building_ids.includes(deniedBuilding));
  for(const name of ['handover','collection_cycle'])await assert.rejects(call(db,name),e=>e.code==='42501');
  assert.equal((await call(db,'promotions')).tong_hop.tong_giam_gia,300);
  await db.exec(`INSERT INTO app_private.tenant_emergency_denies VALUES('${org}',NULL,now(),NULL)`);
  for(const name of ['promotions','handover','collection_cycle'])await assert.rejects(call(db,name),e=>e.code==='42501');
 }finally{await db.close();}
});

test('collection-cycle intersects report buildings with selected manager assignments',async()=>{
 const db=await setup();try{
  await db.exec('DELETE FROM staff_assignments');
  assert.equal((await call(db,'collection_cycle')).toa_nha.length,0);
  await db.exec(`INSERT INTO staff_assignments VALUES('${foreign}','${actor}','${building}',NULL)`);
  assert.equal((await call(db,'collection_cycle')).toa_nha.length,0);
  await db.exec(`INSERT INTO staff_assignments VALUES('${org}','${actor}',NULL,'${id(80)}'); INSERT INTO area_buildings VALUES('${org}','${id(80)}','${building}')`);
  assert.equal((await call(db,'collection_cycle')).tong_hop.chua_thu_hien_tai,400);
 }finally{await db.close();}
});

test('SQL caps real result sets at 50 and runs under authenticated READ ONLY',async()=>{
 const db=await setup();try{
  await db.exec(`
   INSERT INTO contracts SELECT gen_random_uuid(),'${org}','${room}','EXTRA-'||n,'2026-09-01','ACTIVE',1000,'{"amount":1}',NULL FROM generate_series(1,60) n;
   INSERT INTO cash_handovers SELECT gen_random_uuid(),'${org}','${account}','${dest}','${actor}','CONFIRMED','2026-09-07','EXTRA-'||n,1,1,0 FROM generate_series(1,60) n;
   INSERT INTO cashbook_reconciliations SELECT gen_random_uuid(),'${org}','${account}','CONFIRMED','2026-09-07',1,1,0 FROM generate_series(1,60);
   SET ROLE authenticated;
   BEGIN READ ONLY;
  `);
  const p=await call(db,'promotions',999);assert.equal(p.khuyen_mai.length,50);assert.equal(p.tong_hop.so_hop_dong,62);assert.equal(p.tong_hop.tong_giam_gia,360);
  const h=await call(db,'handover',999);assert.equal(h.phien.length,50);assert.equal(h.doi_soat.length,50);assert.equal(h.tong_hop.so_phien,62);assert.equal(h.tong_hop.da_ban_giao,360);
  const c=await call(db,'collection_cycle',999);assert.equal(c.moc_ban_giao.length,50);assert.equal(c.tong_hop.so_moc,62);assert.equal(c.tong_hop.da_ban_giao,360);
  await db.exec('COMMIT; RESET ROLE;');
 }finally{await db.close();}
});
