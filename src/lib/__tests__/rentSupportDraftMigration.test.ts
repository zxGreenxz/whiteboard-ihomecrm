import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { emptyContractDraftPayload } from '../contractDrafts';
const path='supabase/migrations/20260928024559_contract_draft_sign_checkin.sql';
const sql=existsSync(path)?readFileSync(path,'utf8'):'';
const unifiedPath='supabase/migrations/20260929010015_unified_contract_editor_draft_signing.sql';
const unified=existsSync(unifiedPath)?readFileSync(unifiedPath,'utf8'):'';
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
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${building}'::uuid $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$ SELECT false,CASE WHEN current_setting('test.finance_off',true)='yes' AND $1 LIKE 'income_expenses.%' THEN '{}'::uuid[] ELSE ARRAY['${building}'::uuid] END,'{}'::uuid[] $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-09-28' $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION app_private.contract_draft_scope_allowed(uuid,uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${org}'::uuid AND $2='${building}'::uuid AND COALESCE(current_setting('test.deny',true),'')<>$3 $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM set_config('test.locked',$1::text,true);END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF current_setting('test.locked',true) IS DISTINCT FROM $2::text THEN RAISE EXCEPTION 'Org lock missing';END IF;RETURN QUERY SELECT app_private.contract_draft_scope_allowed($2,$4,$3) AND COALESCE(current_setting('test.deny_authorizer',true),'')<>'yes';END $$;
    CREATE TABLE public.document_templates(id uuid,organization_id uuid,deleted_at timestamptz,is_active boolean,type text);
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);INSERT INTO public.organizations VALUES('${org}','ACTIVE'),('${other}','ACTIVE');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,status text DEFAULT 'ACTIVE');
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text,deleted_at timestamptz);
    CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,phone text,id_number text,deleted_at timestamptz);
    CREATE TABLE public.services(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.meters(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,service_id uuid,status text,deleted_at timestamptz);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,status text,actual_end_date date,deleted_at timestamptz,contract_number text,created_at timestamptz DEFAULT now(),payload jsonb,start_date date,end_date date,discounts jsonb,UNIQUE(organization_id,id));
    CREATE TABLE public.contract_drafts(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,payload jsonb,template_id uuid,revision integer,updated_at timestamptz DEFAULT now());
    CREATE TABLE public.contract_draft_versions(draft_id uuid,revision integer,payload jsonb,PRIMARY KEY(draft_id,revision));
    CREATE TABLE public.contract_draft_documents(id uuid PRIMARY KEY,draft_id uuid,revision integer,organization_id uuid,building_id uuid,document_path text,template_path text,document_sha256 text,template_sha256 text,document_data jsonb,template_snapshot jsonb);
    CREATE TABLE public.room_turnovers(id uuid DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,status text);
    CREATE TABLE public.room_reservation_holds(room_id uuid,status text,expires_at timestamptz,held_by uuid);
    CREATE TABLE public.test_holds(room_id uuid);CREATE FUNCTION public.room_has_holding_deposit(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.test_holds WHERE room_id=$1) $$;
    CREATE TABLE public.test_core_calls(payload jsonb,key text);CREATE TABLE public.test_boundaries(contract_id uuid,payload jsonb,action text);CREATE TABLE public.test_money(amount numeric);INSERT INTO public.test_money VALUES(42);
    CREATE FUNCTION public.create_contract_v2(jsonb,text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE c public.contracts%ROWTYPE; v_contract_json jsonb:=$1->'contract'; v_org uuid:='${org}';v_building_id uuid:='${building}';v_contract_id uuid; BEGIN
      INSERT INTO public.test_core_calls VALUES($1,$2);
      INSERT INTO public.contracts(organization_id,room_id,status,contract_number,payload) VALUES('${org}',($1->'contract'->>'room_id')::uuid,'ACTIVE','HD-2026-00001',$1) RETURNING id INTO v_contract_id;
      SELECT * INTO c FROM public.contracts WHERE id=v_contract_id;
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
  await db.exec(`ALTER TABLE public.contract_drafts ADD COLUMN created_by uuid DEFAULT '${actor}', ADD COLUMN created_at timestamptz DEFAULT now();
    ALTER TABLE public.contract_draft_versions ADD COLUMN organization_id uuid,ADD COLUMN building_id uuid,ADD COLUMN room_id uuid,ADD COLUMN template_id uuid,ADD COLUMN created_by uuid,ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN request_id uuid;
    ALTER TABLE public.contract_draft_documents ADD COLUMN created_by uuid,ADD COLUMN created_at timestamptz DEFAULT now();`);
  const draftWorkflow=readFileSync('supabase/migrations/20260928013253_contract_drafts_workflow.sql','utf8');
  await db.exec(draftWorkflow.slice(draftWorkflow.indexOf('CREATE OR REPLACE FUNCTION public.list_contract_drafts('),draftWorkflow.indexOf('REVOKE ALL ON FUNCTION public.save_contract_draft(')));
  for(const name of ['20260929151043_contract_rent_support_plans.sql','20260929151415_contract_rent_support_draft_signing.sql','20260929154150_contract_rent_support_draft_privacy.sql']) {const migration=readFileSync('supabase/migrations/'+name,'utf8');await db.exec(migration);await db.exec(migration);}
},30000);
beforeEach(async()=>{
  await db.exec(`RESET ROLE;SELECT set_config('test.deny','',false),set_config('test.boundary_fail','',false),set_config('test.deny_authorizer','',false);
    INSERT INTO public.document_templates VALUES('${template}','${org}',NULL,true,'lease_contract');
    INSERT INTO public.buildings VALUES('${building}','${org}',NULL,'ACTIVE');INSERT INTO public.rooms VALUES('${room}','${org}','${building}','AVAILABLE',NULL);
    INSERT INTO public.customers VALUES('${customer}','${org}','Khách A','0900000000','0123456789',NULL);`);
  await db.query('INSERT INTO public.contract_drafts(id,organization_id,building_id,room_id,payload,template_id,revision) VALUES($1,$2,$3,$4,$5,$6,1)',[draft,org,building,room,JSON.stringify(terms),template]);
  await db.query('INSERT INTO public.contract_draft_versions(draft_id,revision,payload,organization_id,building_id,created_by) VALUES($1,1,$2,$3,$4,$5)',[draft,JSON.stringify(terms),org,building,actor]);
  await db.query('INSERT INTO public.contract_draft_documents(id,draft_id,revision,organization_id,building_id,document_path,template_path,document_sha256,template_sha256,document_data,template_snapshot) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)',[doc,draft,org,building,`${org}/${building}/${draft}/1/${doc}/document.docx`,`${org}/${building}/${draft}/1/${doc}/template.docx`,'a'.repeat(64),'b'.repeat(64),JSON.stringify({REPRESENT_NAME:'Khách A',REPRESENT_ID_NUMBER:'0123456789',CONTRACT_NUMBER:''}),JSON.stringify({id:template,name:'Mẫu',updated_at:'2026-09-28'})]);
});
afterAll(async()=>{await db.close();});

const support={version:2,start_billing_month:'2026-09',payer:'SALE',sale_party_id:uid(31),deduction_policy:'COMMISSION_ONLY',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:3,monthly_amount:'300000'},{month_count:9,monthly_amount:'100000'}]};
it('SQL draft round trip separates customer document identity from funding revision and blocks unready signing',async()=>{
 const save=async(payload:unknown,revision:number,req:string)=>(await db.query<{result:Record<string,unknown>}>('SELECT public.save_contract_draft($1,$2,$3,$4,$5,$6,$7,$8) result',[org,building,room,JSON.stringify(payload),template,draft,revision,req])).rows[0].result;
 const initial={...terms,rent_support:support};
 await expect(save({...initial,rent_support:{...support,extra:1}},1,uid(21))).rejects.toMatchObject({code:'22023'});
 await expect(save({...initial,rent_support:{...support,segments:[{month_count:1,monthly_amount:'NaN'}]}},1,uid(21))).rejects.toMatchObject({code:'22023'});
 const saved=await save(initial,1,uid(21));expect(saved).toMatchObject({revision:2,customer_revision:2,payload:{rent_support:support}});
 const publicPayloads=JSON.stringify((await db.query('SELECT payload FROM public.contract_drafts UNION ALL SELECT payload FROM public.contract_draft_versions')).rows);
 expect(publicPayloads).not.toContain('sale_party_id');expect(publicPayloads).not.toContain('deduction_policy');expect(publicPayloads).not.toContain('payer');
 expect(publicPayloads).toContain('300000');expect(publicPayloads).toContain('100000');
 expect(await save(initial,1,uid(21))).toMatchObject({revision:2,payload:{rent_support:support}});
 await expect(save({...initial,rent_support:{...support,sale_party_id:uid(32)}},1,uid(21))).rejects.toMatchObject({code:'22023'});
 const financeList=(await db.query<{result:Record<string,unknown>[]}>('SELECT public.list_contract_drafts($1,$2) result',[org,building])).rows[0].result;
 expect(financeList[0]).toMatchObject({payload:{rent_support:support}});
 await db.exec("SELECT set_config('test.finance_off','yes',false)");
 try {
   const list=(await db.query<{result:Record<string,unknown>[]}>('SELECT public.list_contract_drafts($1,$2) result',[org,building])).rows[0].result;
   expect(list[0]).toMatchObject({payload:{rent_support:{version:2,start_billing_month:'2026-09',segments:support.segments}}});
   for(const key of ['payer','sale_party_id','deduction_policy','collection_mode'])expect(JSON.stringify(list)).not.toContain(key);
   await expect(save({...initial,rent_support:{...support,sale_party_id:uid(32)}},2,uid(40))).rejects.toMatchObject({code:'42501'});
   await expect(save(terms,2,uid(41))).rejects.toMatchObject({code:'42501'});
 }finally{await db.exec("SELECT set_config('test.finance_off','',false)");}
 await expect(db.exec("UPDATE app_private.contract_draft_rent_support_funding SET funding='{}'")).rejects.toMatchObject({code:'42501'});
 await db.exec('SET ROLE authenticated');
 try{await expect(db.query('SELECT * FROM app_private.contract_draft_rent_support_funding')).rejects.toMatchObject({code:'42501'});}finally{await db.exec('RESET ROLE');}
 await expect(sign()).rejects.toMatchObject({code:'40001'});
 // A document exported at revision 2 remains usable when only internal funding changes.
 await db.query('DELETE FROM public.contract_draft_documents WHERE id=$1',[doc]);
 const root=org+'/'+building+'/'+draft+'/2/'+doc;
 await db.query("INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('contract-draft-documents',$1,$3),('contract-draft-documents',$2,$3)",[root+'/document.docx',root+'/template.docx',actor]);
 await db.query('SELECT public.register_contract_draft_document($1,$2,2,$3,$4,$5,$6,$7,$8)',[org,draft,doc,template,JSON.stringify({id:template,name:'Mẫu',updated_at:'2026-09-28'}),'a'.repeat(64),'b'.repeat(64),JSON.stringify({REPRESENT_NAME:'Khách A',REPRESENT_ID_NUMBER:'0123456789',rent_support:support})]);
 const registered=(await db.query<{document_data:unknown}>('SELECT document_data FROM public.contract_draft_documents WHERE id=$1',[doc])).rows[0].document_data;
 for(const key of ['payer','sale_party_id','deduction_policy','collection_mode'])expect(JSON.stringify(registered)).not.toContain(key);
 const funding={...initial,rent_support:{...support,deduction_policy:'BONUS_THEN_COMMISSION'}};
 expect(await save(funding,2,uid(22))).toMatchObject({revision:3,customer_revision:2});
 await expect(sign({revision:3})).rejects.toMatchObject({code:'55000'});
 expect((await db.query('SELECT * FROM public.test_core_calls')).rows).toHaveLength(0);
 expect((await db.query('SELECT * FROM app_private.contract_rent_support_plans')).rows).toHaveLength(0);
 // Changing customer amounts invalidates the formerly compatible artifact, even at the current draft revision.
 const changed={...funding,rent_support:{...funding.rent_support,segments:[{month_count:12,monthly_amount:'75000'}]}};
 expect(await save(changed,3,uid(23))).toMatchObject({revision:4,customer_revision:4});
 await expect(sign({revision:4})).rejects.toMatchObject({code:'40001'});
 expect(await save(funding,4,uid(24))).toMatchObject({revision:5,customer_revision:5});
 await db.query("UPDATE public.contract_draft_documents SET revision=5,document_data=document_data||jsonb_build_object('rent_support',$2::jsonb) WHERE id=$1",[doc,JSON.stringify(funding.rent_support)]);
 const customerDocument=(await db.query<{document_data:Record<string,unknown>}>('SELECT document_data FROM public.contract_draft_documents WHERE id=$1',[doc])).rows[0].document_data;
 expect(customerDocument).toMatchObject({rent_support:{version:2,start_billing_month:'2026-09',segments:support.segments}});
 for(const key of ['payer','sale_party_id','deduction_policy','collection_mode'])expect(JSON.stringify(customerDocument)).not.toContain(key);
 // Only this disposable fixture enables the integration path; deployed gate remains false.
 await db.exec('CREATE OR REPLACE FUNCTION app_private.rent_support_writers_enabled_v1() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$');
 await db.exec("SELECT set_config('test.boundary_fail','yes',false)");
 await expect(sign({revision:5})).rejects.toMatchObject({code:'55000'});
 expect((await db.query('SELECT * FROM app_private.contract_rent_support_plans')).rows).toHaveLength(0);
 expect((await db.query('SELECT * FROM public.contracts')).rows).toHaveLength(0);
 await db.exec("SELECT set_config('test.boundary_fail','',false)");
 const signed=(await sign({revision:5})).rows[0].result;
 expect(signed.terms).toMatchObject({rent_support:{version:2,start_billing_month:'2026-09',segments:support.segments}});
 for(const key of ['payer','sale_party_id','deduction_policy','collection_mode'])expect(JSON.stringify(signed)).not.toContain(key);
 expect(signed.party_snapshot).toMatchObject([{id:customer,full_name:'Khách A'}]);
 expect(signed.document_data).toMatchObject({REPRESENT_NAME:'Khách A'});
 const privacy=readFileSync('supabase/migrations/20260929154150_contract_rent_support_draft_privacy.sql','utf8');await db.exec(privacy);
 await expect(db.query("UPDATE public.contract_draft_signings SET terms=terms||jsonb_build_object('changed',true) WHERE draft_id=$1",[draft])).rejects.toMatchObject({code:'55000'});
 expect((await db.query('SELECT * FROM app_private.contract_rent_support_months')).rows).toHaveLength(12);
 expect((await db.query('SELECT payload FROM public.test_core_calls')).rows[0]).toMatchObject({payload:{contract:{discounts:{version:2,kind:'RENT_SUPPORT_SCHEDULE'},rent_support:funding.rent_support}}});
 await expect(sign({revision:5,hash:'c'.repeat(64)})).rejects.toMatchObject({code:'40001'});
});
