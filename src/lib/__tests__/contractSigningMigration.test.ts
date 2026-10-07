import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { emptyContractDraftPayload } from '../contractDrafts';
const path='supabase/migrations/20260928024559_contract_draft_sign_checkin.sql';
const sql=existsSync(path)?readFileSync(path,'utf8'):'';
const unifiedPath='supabase/migrations/20260929010015_unified_contract_editor_draft_signing.sql';
const unified=existsSync(unifiedPath)?readFileSync(unifiedPath,'utf8'):'';
// 20261007003604 [2]: register_contract_signed_document_v1 kiểm view+print TRƯỚC khoá tổ chức.
const orderPath='supabase/migrations/20261007003604_authorize_before_org_lock.sql';
const orderSql=existsSync(orderPath)?readFileSync(orderPath,'utf8'):'';
const registerPatch=orderSql.slice(orderSql.indexOf('-- [2]'));
const registerOriginal=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.register_contract_signed_document_v1'),
  sql.indexOf('END $$;',sql.indexOf('CREATE OR REPLACE FUNCTION public.register_contract_signed_document_v1'))+'END $$;'.length);
const db=new PGlite();
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=uid(1),other=uid(2),building=uid(3),room=uid(4),draft=uid(5),doc=uid(6),actor=uid(7),customer=uid(8),template=uid(9),request=uid(10);
const terms=emptyContractDraftPayload();terms.form={...terms.form,room_id:room,signed_date:'2026-09-28',start_date:'2026-09-28',end_date:'2027-09-28',start_billing_date:'2026-09-28',end_billing_date:'2026-09-30'};
terms.customers=[{id:customer,full_name:'Khách A',phone:'0900000000',id_number:'0123456789',is_representative:true,notes:null}];
const boundary={state:'VERIFIED',reason:null,readings:[]};
async function sign(overrides:Record<string,unknown>={}){
  const p={org,draft,revision:1,doc,hash:'a'.repeat(64),request,date:'2026-09-28',boundary,options:{},reservation:null,reservationRevision:null,vouchers:null,...overrides};
  return db.query<{result:Record<string,unknown>}>('SELECT public.sign_and_checkin_contract_draft_v1($1,$2,$3,$4,$5,$6,$7,true,true,$8,$9,$10,$11,$12) result',[p.org,p.draft,p.revision,p.doc,p.hash,p.request,p.date,JSON.stringify(p.boundary),JSON.stringify(p.options),p.reservation,p.reservationRevision,p.vouchers]);
}
beforeAll(async()=>{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE SCHEMA auth;CREATE SCHEMA app_private;CREATE SCHEMA storage;
    GRANT USAGE ON SCHEMA public,auth,app_private,storage TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-09-28' $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION app_private.contract_draft_scope_allowed(uuid,uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${org}'::uuid AND $2='${building}'::uuid AND COALESCE(current_setting('test.deny',true),'')<>$3 $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM set_config('test.locked',$1::text,true);END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF current_setting('test.locked',true) IS DISTINCT FROM $2::text THEN RAISE EXCEPTION 'Org lock missing';END IF;RETURN QUERY SELECT app_private.contract_draft_scope_allowed($2,$4,$3) AND COALESCE(current_setting('test.deny_authorizer',true),'')<>'yes';END $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY);INSERT INTO public.organizations VALUES('${org}'),('${other}');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text,deleted_at timestamptz);
    CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,phone text,id_number text,deleted_at timestamptz);
    CREATE TABLE public.services(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.meters(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,service_id uuid,status text,deleted_at timestamptz);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,status text,actual_end_date date,deleted_at timestamptz,contract_number text,created_at timestamptz DEFAULT now(),payload jsonb);
    CREATE TABLE public.contract_drafts(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,payload jsonb,template_id uuid,revision integer,updated_at timestamptz DEFAULT now());
    CREATE TABLE public.contract_draft_versions(draft_id uuid,revision integer,payload jsonb,PRIMARY KEY(draft_id,revision));
    CREATE TABLE public.contract_draft_documents(id uuid PRIMARY KEY,draft_id uuid,revision integer,organization_id uuid,building_id uuid,document_path text,template_path text,document_sha256 text,template_sha256 text,document_data jsonb,template_snapshot jsonb);
    CREATE TABLE public.room_turnovers(id uuid DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,status text);
    CREATE TABLE public.room_reservation_holds(room_id uuid,status text,expires_at timestamptz,held_by uuid);
    CREATE TABLE public.test_holds(room_id uuid);CREATE FUNCTION public.room_has_holding_deposit(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.test_holds WHERE room_id=$1) $$;
    CREATE TABLE public.test_core_calls(payload jsonb,key text);CREATE TABLE public.test_boundaries(contract_id uuid,payload jsonb,action text);CREATE TABLE public.test_money(amount numeric);INSERT INTO public.test_money VALUES(42);
    CREATE FUNCTION public.create_contract_v2(jsonb,text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE c public.contracts%ROWTYPE; BEGIN
      INSERT INTO public.test_core_calls VALUES($1,$2);
      INSERT INTO public.contracts(organization_id,room_id,status,contract_number,payload) VALUES('${org}',($1->'contract'->>'room_id')::uuid,'ACTIVE','HD-2026-00001',$1) RETURNING * INTO c;
      UPDATE public.rooms SET status='OCCUPIED' WHERE id=c.room_id;
      RETURN jsonb_build_object('contract',to_jsonb(c),'invoice',NULL,'deposit_paid',0,'deposit_shortfall',0); END $$;
    CREATE FUNCTION app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.test_boundaries VALUES($2,$6,$7); RETURN $6;END $$;
    CREATE FUNCTION app_private.validate_meter_boundary_payload_v1(uuid,uuid,uuid,jsonb) RETURNS void LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN;END $$;
    CREATE FUNCTION app_private.assert_contract_move_in_boundaries_v1(uuid,uuid,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF current_setting('test.boundary_fail',true)='yes' THEN RAISE EXCEPTION 'Missing meter' USING ERRCODE='55000';END IF;END $$;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner_id text,UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
    CREATE POLICY existing_generic_policy ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);
  `);await db.exec(sql);await db.exec(sql);if(unified){await db.exec(unified);await db.exec(unified);}
  // Mọi bài dưới đây chạy trên register đã vá thứ tự kiểm quyền/khoá.
  await db.exec(registerPatch);await db.exec(registerPatch);
},30000);
beforeEach(async()=>{
  await db.exec(`RESET ROLE;SELECT set_config('test.deny','',false),set_config('test.boundary_fail','',false),set_config('test.deny_authorizer','',false);
    TRUNCATE public.contract_draft_signings,public.contract_drafts,public.contract_draft_versions,public.contract_draft_documents,public.contracts,public.rooms,public.buildings,public.customers,public.services,public.meters,public.room_turnovers,public.room_reservation_holds,public.test_holds,public.test_core_calls,public.test_boundaries,storage.objects CASCADE;
    INSERT INTO public.buildings VALUES('${building}','${org}',NULL);INSERT INTO public.rooms VALUES('${room}','${org}','${building}','AVAILABLE',NULL);
    INSERT INTO public.customers VALUES('${customer}','${org}','Khách A','0900000000','0123456789',NULL);`);
  await db.query('INSERT INTO public.contract_drafts(id,organization_id,building_id,room_id,payload,template_id,revision) VALUES($1,$2,$3,$4,$5,$6,1)',[draft,org,building,room,JSON.stringify(terms),template]);
  await db.query('INSERT INTO public.contract_draft_versions VALUES($1,1,$2)',[draft,JSON.stringify(terms)]);
  await db.query('INSERT INTO public.contract_draft_documents VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)',[doc,draft,org,building,`${org}/${building}/${draft}/1/${doc}/document.docx`,`${org}/${building}/${draft}/1/${doc}/template.docx`,'a'.repeat(64),'b'.repeat(64),JSON.stringify({REPRESENT_NAME:'Khách A',REPRESENT_ID_NUMBER:'0123456789',CONTRACT_NUMBER:''}),JSON.stringify({id:template,name:'Mẫu',updated_at:'2026-09-28'})]);
});
afterAll(async()=>{await db.close();});
describe('actual sign/check-in SQL, existing core and authority stubbed',()=>{
  it.each([0,123])('uses B verified actual reading %s in the core while retaining the printed draft proposal',async reading=>{
    const service=uid(41),meter=uid(42);const proposal={...terms,use_custom_services:true,services:[{id:service,name:'Electric',unit_price:3000,initial_reading:7,quantity:1,type:'METER_READING',unit:'kWh',pricing_type:'METER'}]};
    await db.query('INSERT INTO public.services VALUES($1,$2,NULL)',[service,org]);
    await db.query('INSERT INTO public.meters VALUES($1,$2,$3,$4,$5,$6,NULL)',[meter,org,building,room,service,'ACTIVE']);
    await db.query('UPDATE public.contract_drafts SET payload=$2 WHERE id=$1',[draft,JSON.stringify(proposal)]);await db.query('UPDATE public.contract_draft_versions SET payload=$2 WHERE draft_id=$1',[draft,JSON.stringify(proposal)]);
    const actual={state:'VERIFIED',reason:null,readings:[{meter_id:meter,reading,measured_at:'2026-09-28T01:00:00Z',evidence:null}]};
    const result=(await sign({boundary:actual})).rows[0].result;
    const core=(await db.query<{payload:{services:{initial_reading:number;unit_price:number}[]}}>('SELECT payload FROM public.test_core_calls')).rows[0].payload;
    expect(core.services).toMatchObject([{initial_reading:reading,unit_price:3000}]);
    expect(result.terms).toMatchObject({services:[{initial_reading:7,unit_price:3000}]});
    expect((await db.query<{payload:unknown}>('SELECT payload FROM public.test_boundaries')).rows[0].payload).toEqual(actual);
  });
  it('rejects differing physical readings for one legacy scalar service instead of guessing a meter',async()=>{
    const service=uid(41),a=uid(42),b=uid(43);const proposal={...terms,use_custom_services:true,services:[{id:service,name:'Electric',unit_price:3000,initial_reading:7,quantity:1,type:'METER_READING',unit:'kWh',pricing_type:'METER'}]};
    await db.query('INSERT INTO public.services VALUES($1,$2,NULL)',[service,org]);
    for(const meter of[a,b])await db.query('INSERT INTO public.meters VALUES($1,$2,$3,$4,$5,$6,NULL)',[meter,org,building,room,service,'ACTIVE']);
    await db.query('UPDATE public.contract_drafts SET payload=$2 WHERE id=$1',[draft,JSON.stringify(proposal)]);await db.query('UPDATE public.contract_draft_versions SET payload=$2 WHERE draft_id=$1',[draft,JSON.stringify(proposal)]);
    await expect(sign({boundary:{state:'VERIFIED',readings:[{meter_id:a,reading:0,measured_at:'2026-09-28T01:00:00Z'},{meter_id:b,reading:123,measured_at:'2026-09-28T01:00:00Z'}]}})).rejects.toMatchObject({code:'22023'});
    expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(0);
  });
  it.each(['METER_READING','FIXED'])('requires a physical mapping only for selected %s services',async type=>{
    const service=uid(41);const proposal={...terms,use_custom_services:true,services:[{id:service,name:'Service',unit_price:3000,initial_reading:7,quantity:1,type,unit:'unit',pricing_type:type==='METER_READING'?'METER':'FIXED'}]};
    await db.query('INSERT INTO public.services VALUES($1,$2,NULL)',[service,org]);
    await db.query('UPDATE public.contract_drafts SET payload=$2 WHERE id=$1',[draft,JSON.stringify(proposal)]);await db.query('UPDATE public.contract_draft_versions SET payload=$2 WHERE draft_id=$1',[draft,JSON.stringify(proposal)]);
    if(type==='METER_READING'){
      await expect(sign()).rejects.toMatchObject({code:'22023'});
      expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(0);
    }else{
      await sign();
      expect((await db.query<{payload:{services:{initial_reading:number}[]}}>('SELECT payload FROM public.test_core_calls')).rows[0].payload.services).toMatchObject([{initial_reading:7}]);
    }
  });
  it('creates exactly one official contract and records CREATE boundary atomically; retries return the same source',async()=>{
    const first=(await sign()).rows[0].result;
    expect(first).toMatchObject({draft_id:draft,revision:1,document_id:doc,contract_number:'HD-2026-00001',received_on:'2026-09-28'});
    expect((await sign()).rows[0].result.id).toBe(first.id);
    expect((await sign({request:uid(11)})).rows[0].result.id).toBe(first.id);
    expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM public.test_boundaries')).rows).toMatchObject([{action:'contracts.create',payload:boundary}]);
    expect((await db.query('SELECT status,converted_contract_id FROM public.contract_drafts')).rows[0]).toMatchObject({status:'SIGNED',converted_contract_id:first.contract_id});
    expect((await db.query('SELECT * FROM public.test_money')).rows).toEqual([{amount:'42'}]);
  });
  it('rejects stale revision, altered source artifact/hash and different replay contents',async()=>{
    for(const changes of [{revision:2},{doc:uid(99)},{hash:'c'.repeat(64)}]) await expect(sign(changes)).rejects.toMatchObject({code:'40001'});
    await sign();await expect(sign({options:{deposit_debt_mode:'DEBT'}})).rejects.toMatchObject({code:'23505'});
    expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(1);
  });
  it('uses existing CREATE authority without EDIT, rejects revoked/cross-org and scopes direct reads',async()=>{
    await db.exec("SELECT set_config('test.deny','contracts.edit',false);SET ROLE authenticated");await sign();
    await db.exec("RESET ROLE;SELECT set_config('test.deny','contracts.create',false)");await expect(sign()).rejects.toMatchObject({code:'42501'});
    await db.exec("SELECT set_config('test.deny','',false)");await expect(sign({org:other})).rejects.toMatchObject({code:'42501'});
    await db.exec("SELECT set_config('test.deny','contracts.view',false);SET ROLE authenticated");expect((await db.query('SELECT * FROM public.contract_draft_signings')).rows).toHaveLength(0);await db.exec('RESET ROLE');
  });
  it('rechecks the authoritative CREATE decision after locking the organization',async()=>{
    await db.exec("SELECT set_config('test.deny_authorizer','yes',false)");await expect(sign()).rejects.toMatchObject({code:'42501'});
    expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(0);
  });
  it('blocks existing deposits, RESERVED room, own operational hold and current old occupancy',async()=>{
    await db.exec(`INSERT INTO public.test_holds VALUES('${room}')`);await expect(sign()).rejects.toMatchObject({code:'55P03'});
    await db.exec(`DELETE FROM public.test_holds;UPDATE public.rooms SET status='RESERVED'`);await expect(sign()).rejects.toMatchObject({code:'55000'});
    await db.exec(`UPDATE public.rooms SET status='AVAILABLE';INSERT INTO public.room_reservation_holds VALUES('${room}','PENDING_APPROVAL',now()+interval '1 day','${actor}')`);await expect(sign()).rejects.toMatchObject({code:'55P03'});
    await db.exec(`DELETE FROM public.room_reservation_holds;INSERT INTO public.contracts(organization_id,room_id,status) VALUES('${org}','${room}','EXTENDED')`);await expect(sign()).rejects.toMatchObject({code:'55000'});
    expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(0);
  });
  it('requires room preparation readiness and immutable receive/billing dates',async()=>{
    await db.exec(`INSERT INTO public.room_turnovers(organization_id,room_id,status) VALUES('${org}','${room}','PENDING')`);await expect(sign()).rejects.toMatchObject({code:'55000'});
    await db.exec("UPDATE public.room_turnovers SET status='READY'");await expect(sign({date:'2026-09-29'})).rejects.toMatchObject({code:'22023'});await sign();
    expect((await db.query<{payload:typeof terms}>('SELECT payload FROM public.test_core_calls')).rows[0].payload).toMatchObject({contract:{start_date:'2026-09-28',start_billing_date:'2026-09-28',end_billing_date:'2026-09-30'}});
  });
  it('rejects changed parties and injected mutable contract or reservation options',async()=>{
    await db.exec("UPDATE public.customers SET full_name='Khách khác'");await expect(sign()).rejects.toMatchObject({code:'40001'});await db.exec("UPDATE public.customers SET full_name='Khách A'");
    for(const options of [{contract:{rent_price:1}},{reservation_id:uid(11)},{deposit_receipts:{}},{existing_deposit_voucher_ids:'wrong'}]) await expect(sign({options})).rejects.toMatchObject({code:'22023'});
  });
  it('forwards prepared receipts, invoice template and deduplicated voucher sources only to existing core',async()=>{
    const receipt={amount:250000,account_id:null,received_date:'2026-09-28',attachments:[]};
    const options={deposit_receipts:[receipt],existing_deposit_voucher_ids:[uid(32),uid(32)],invoice_template_id:uid(33)};
    const first=(await sign({options})).rows[0].result;
    const core=(await db.query<{payload:Record<string,unknown>}>('SELECT payload FROM public.test_core_calls')).rows[0].payload;
    expect(core).toMatchObject({deposit_receipts:[receipt],existing_deposit_voucher_ids:[uid(32)],contract:{invoice_template_id:uid(33)}});
    expect((core.contract as Record<string,unknown>)).not.toHaveProperty('deposit_receipts');
    expect((core.contract as Record<string,unknown>)).not.toHaveProperty('existing_deposit_voucher_ids');
    expect(first.creation_options).toMatchObject(options);
    expect((await sign({options})).rows[0].result.id).toBe(first.id);
    await expect(sign({options:{...options,deposit_receipts:[{...receipt,amount:250001}]}})).rejects.toMatchObject({code:'23505'});
    expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(1);
  });
  it('keeps custom-services OFF empty when the saved draft still carries displayed defaults',async()=>{
    const service=uid(41);
    const proposal={...terms,use_custom_services:false,services:[{id:service,name:'Default service',unit_price:3000,initial_reading:0,quantity:1,type:'FIXED',unit:'unit',pricing_type:'FIXED'}]};
    await db.query('INSERT INTO public.services VALUES($1,$2,NULL)',[service,org]);
    await db.query('UPDATE public.contract_drafts SET payload=$2 WHERE id=$1',[draft,JSON.stringify(proposal)]);
    await db.query('UPDATE public.contract_draft_versions SET payload=$2 WHERE draft_id=$1',[draft,JSON.stringify(proposal)]);
    await sign();
    expect((await db.query<{payload:{services:unknown[]}}>('SELECT payload FROM public.test_core_calls')).rows[0].payload.services).toEqual([]);
  });
  it('rolls the official create back completely when physical boundary assertion fails',async()=>{
    await db.exec("SELECT set_config('test.boundary_fail','yes',false)");await expect(sign()).rejects.toMatchObject({code:'55000'});
    for(const table of ['contracts','contract_draft_signings','test_core_calls','test_boundaries']) expect((await db.query(`SELECT * FROM public.${table}`)).rows).toHaveLength(0);
    expect((await db.query('SELECT status FROM public.rooms')).rows[0]).toEqual({status:'AVAILABLE'});
    expect((await db.query('SELECT status FROM public.contract_drafts')).rows[0]).toEqual({status:'EDITABLE'});
  });
  it('keeps signed draft terms immutable and retains historical official source',async()=>{
    await sign();await expect(db.exec(`UPDATE public.contract_drafts SET revision=2`)).rejects.toMatchObject({code:'55000'});
    await expect(db.exec('DELETE FROM public.contract_drafts')).rejects.toMatchObject({code:'55000'});
    await expect(db.exec("UPDATE public.contract_draft_signings SET terms='{}'::jsonb")).rejects.toMatchObject({code:'55000'});
    await db.exec("UPDATE public.customers SET full_name='Later change'");expect((await sign()).rows[0].result).toMatchObject({terms});
  });
  it('blocks a pure LIVE next claim when the separately deployed P9 assertion is available',async()=>{
    await db.exec(`CREATE OR REPLACE FUNCTION app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[]) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Live next claim requires exact owner' USING ERRCODE='55P03'; END $$`);
    try { await expect(sign()).rejects.toMatchObject({code:'55P03'});expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(0); }
    finally { await db.exec('DROP FUNCTION app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])'); }
  });
  it('converts only the exact selected claim through current core voucher links and consumes it once',async()=>{
    await db.exec(`CREATE TABLE IF NOT EXISTS public.test_claim(id uuid,revision bigint,contract_id uuid);
      TRUNCATE public.test_claim;INSERT INTO public.test_claim VALUES('${uid(31)}',4,NULL);
      CREATE OR REPLACE FUNCTION app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[]) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF $3 IS DISTINCT FROM '${uid(31)}'::uuid OR $4 IS DISTINCT FROM 4::bigint OR $5<>ARRAY['${customer}'::uuid] OR $6<>ARRAY['${uid(32)}'::uuid] THEN RAISE EXCEPTION 'Wrong claim/source' USING ERRCODE='40001';END IF;END $$;
      CREATE OR REPLACE FUNCTION app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE public.test_claim SET contract_id=$4 WHERE id=$2 AND revision=$3 AND (contract_id IS NULL OR contract_id=$4);IF NOT FOUND THEN RAISE EXCEPTION 'Wrong consumed claim' USING ERRCODE='40001';END IF;END $$;
      UPDATE public.rooms SET status='RESERVED';INSERT INTO public.test_holds VALUES('${room}');`);
    try {
      await expect(sign({reservation:uid(31),reservationRevision:3,vouchers:[uid(32)]})).rejects.toMatchObject({code:'40001'});
      const chosen={reservation:uid(31),reservationRevision:4,vouchers:[uid(32)]};const first=(await sign(chosen)).rows[0].result;
      expect(first).toMatchObject({reservation_id:uid(31),reservation_revision:4,source_voucher_ids:[uid(32)]});
      const core=(await db.query<{payload:Record<string,unknown>}>('SELECT payload FROM public.test_core_calls')).rows[0].payload;
      expect(core).toMatchObject({reservation_id:uid(31),reservation_revision:4,existing_deposit_voucher_ids:[uid(32)],deposit_receipts:[]});
      expect((await db.query<{contract_id:string}>('SELECT contract_id FROM public.test_claim')).rows[0].contract_id).toBe(first.contract_id);
      expect((await sign(chosen)).rows[0].result.id).toBe(first.id);expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(1);
      expect((await db.query('SELECT * FROM public.test_money')).rows).toEqual([{amount:'42'}]);
    } finally { await db.exec('DROP FUNCTION app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[]);DROP FUNCTION app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid)'); }
  });
  it('fails closed for a selected reservation before P9 is installed and rejects malformed source identities',async()=>{
    await expect(sign({reservation:uid(31),reservationRevision:1,vouchers:[]})).rejects.toMatchObject({code:'55000'});
    for(const choice of [{reservation:uid(31)},{reservationRevision:1},{vouchers:[uid(32)]},{reservation:uid(31),reservationRevision:1,vouchers:[uid(32),uid(32)]}]) await expect(sign(choice)).rejects.toMatchObject({code:'22023'});
  });
  it('official file registration is independent and retryable, fenced by PRINT even under broad storage policies',async()=>{
    const result=(await sign()).rows[0].result;const signingId=result.id;const file=`${org}/${building}/${signingId}/document.docx`;
    await db.exec('SET ROLE authenticated');await db.query('INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES($1,$2,$3)',['contract-signed-documents',file,actor]);
    await db.query('SELECT public.register_contract_signed_document_v1($1,$2,$3)',[org,signingId,'c'.repeat(64)]);
    await db.query('SELECT public.register_contract_signed_document_v1($1,$2,$3)',[org,signingId,'c'.repeat(64)]);
    await expect(db.query('SELECT public.register_contract_signed_document_v1($1,$2,$3)',[org,signingId,'d'.repeat(64)])).rejects.toMatchObject({code:'23505'});
    expect((await db.query('UPDATE storage.objects SET name=name RETURNING *')).rows).toHaveLength(0);
    await db.exec("RESET ROLE;SELECT set_config('test.deny','contracts.print',false);SET ROLE authenticated");expect((await db.query('SELECT * FROM storage.objects')).rows).toHaveLength(0);await db.exec('RESET ROLE');
  });
  it('registration refuses outsiders before taking the org lock (20261007003604); the 28/09 body locked first',async()=>{
    const signingId=(await sign()).rows[0].result.id;
    const register=(organization:string,signing:string)=>db.query('SELECT public.register_contract_signed_document_v1($1,$2,$3)',[organization,signing,'c'.repeat(64)]);
    // Khoá giả ném LK001: lỗi đó còn nguyên dù transaction ROLLBACK, nên đo được hàm có TỚI bước khoá hay không.
    await db.exec(`CREATE OR REPLACE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN RAISE EXCEPTION 'lock reached' USING ERRCODE='LK001';END $$`);
    try{
      await db.exec("SELECT set_config('test.deny','contracts.print',false)");
      await expect(register(org,signingId)).rejects.toMatchObject({code:'42501'});
      await db.exec("SELECT set_config('test.deny','contracts.view',false)");
      await expect(register(org,signingId)).rejects.toMatchObject({code:'42501'});
      await db.exec("SELECT set_config('test.deny','',false)");
      await expect(register(other,signingId)).rejects.toMatchObject({code:'42501'});
      await expect(register(org,uid(99))).rejects.toMatchObject({code:'42501'});
      await expect(register(org,signingId)).rejects.toMatchObject({code:'LK001'});
      // Đột biến: thân 20260928024559 khoá trước rồi mới kiểm quyền.
      await db.exec(registerOriginal);
      await db.exec("SELECT set_config('test.deny','contracts.print',false)");
      await expect(register(org,signingId)).rejects.toMatchObject({code:'LK001'});
      await db.exec("SELECT set_config('test.deny','',false)");
      await expect(register(other,signingId)).rejects.toMatchObject({code:'LK001'});
    }finally{
      await db.exec(`SELECT set_config('test.deny','',false);
        CREATE OR REPLACE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM set_config('test.locked',$1::text,true);END $$`);
      await db.exec(registerPatch);
    }
  });
});
