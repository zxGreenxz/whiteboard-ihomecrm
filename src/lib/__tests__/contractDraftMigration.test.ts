import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { emptyContractDraftPayload } from '../contractDrafts';

const migration = readFileSync('supabase/migrations/20260928013253_contract_drafts_workflow.sql', 'utf8');
const db = new PGlite();
const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '99999999-9999-4999-8999-999999999999';
const building = '22222222-2222-4222-8222-222222222222';
const otherBuilding = '88888888-8888-4888-8888-888888888888';
const room = '33333333-3333-4333-8333-333333333333';
const customer = '44444444-4444-4444-8444-444444444444';
const template = '55555555-5555-4555-8555-555555555555';
const actor = '66666666-6666-4666-8666-666666666666';
const draftId = '77777777-7777-4777-8777-777777777777';
const requestId = '00000000-0000-4000-8000-000000000001';
const documentId = '00000000-0000-4000-8000-000000000002';
const payload = emptyContractDraftPayload();
const setup = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA storage;
  GRANT USAGE ON SCHEMA public, auth, app_private, storage TO authenticated;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
  CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
  CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${building}'::uuid $$;
  CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$
    SELECT false, CASE WHEN $2='${org}'::uuid AND COALESCE(current_setting('test.deny',true),'') <> $1 THEN ARRAY['${building}'::uuid] ELSE '{}'::uuid[] END, '{}'::uuid[] $$;
  CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM set_config('test.locked',$1::text,true); END $$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);
  INSERT INTO public.organizations VALUES('${org}','ACTIVE'),('${otherOrg}','ACTIVE');
  CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE plpgsql VOLATILE AS $$
    BEGIN IF current_setting('test.locked',true) IS DISTINCT FROM $2::text THEN RAISE EXCEPTION 'organization lock missing'; END IF;
      PERFORM 1 FROM public.organizations WHERE id=$2 FOR SHARE;
      RETURN QUERY SELECT $2='${org}'::uuid AND $4='${building}'::uuid AND COALESCE(current_setting('test.deny',true),'') <> $3; END $$;
  CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
  INSERT INTO public.buildings VALUES('${building}','${org}',null),('${otherBuilding}','${otherOrg}',null);
  CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz,status text DEFAULT 'AVAILABLE');
  INSERT INTO public.rooms(id,organization_id,building_id) VALUES('${room}','${org}','${building}');
  CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
  INSERT INTO public.customers VALUES('${customer}','${org}',null);
  CREATE TABLE public.services(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
  CREATE TABLE public.document_templates(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,is_active boolean,type text);
  INSERT INTO public.document_templates VALUES('${template}','${org}',null,true,'lease_contract');
  CREATE TABLE public.contracts(id uuid PRIMARY KEY); CREATE TABLE public.invoices(id uuid PRIMARY KEY);
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY); CREATE TABLE public.payments(id uuid PRIMARY KEY);
  CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner_id text,UNIQUE(bucket_id,name));
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
  CREATE POLICY existing_generic_policy ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);
`;
async function save(id: string, request: string, data = payload, expected?: number, targetOrg = org, targetBuilding = building) {
  return db.query<{ result: { id: string; revision: number; payload: unknown } }>('SELECT public.save_contract_draft($1,$2,$3,$4,$5,$6,$7,$8) result', [targetOrg,targetBuilding,data.form.room_id || null,JSON.stringify(data),expected ? template : null,id,expected ?? null,request]);
}
async function register(id = documentId, revision = 2) {
  return db.query<{ result: { id: string; revision: number } }>('SELECT public.register_contract_draft_document($1,$2,$3,$4,$5,$6,$7,$8,$9) result', [org,draftId,revision,id,template,JSON.stringify({id:template,name:'Mẫu gốc',updated_at:'2026-09-28'}),'a'.repeat(64),'b'.repeat(64),JSON.stringify({DRAFT_TITLE:'BẢN NHÁP'})]);
}
beforeAll(async () => { await db.exec(setup); await db.exec(migration); await db.exec(migration); }, 30000);
afterAll(async () => { await db.close(); });

describe('contract draft migration executes on PostgreSQL (stubbed existing authority)', () => {
  it('persists incomplete draft, replays create safely and rejects a changed request identity', async () => {
    const created = await save(draftId,requestId);
    expect(created.rows[0].result.revision).toBe(1);
    const replay = await save(draftId,requestId);
    expect(replay.rows[0].result.id).toBe(draftId);
    expect((await db.query('SELECT * FROM public.contract_drafts')).rows).toHaveLength(1);
    const changed = { ...payload, form: { ...payload.form, notes: 'khác' } };
    await expect(save(draftId,requestId,changed)).rejects.toMatchObject({ code: '22023' });
  });
  it('enforces organization/building/create permissions, including direct RLS reads', async () => {
    await expect(save('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000011',payload,undefined,otherOrg,otherBuilding)).rejects.toMatchObject({ code:'42501' });
    await db.exec("SELECT set_config('test.deny','contracts.create',false)");
    await expect(save('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013')).rejects.toMatchObject({ code:'42501' });
    await db.exec("SELECT set_config('test.deny','contracts.view',false); SET ROLE authenticated");
    try { expect((await db.query('SELECT * FROM public.contract_drafts')).rows).toHaveLength(0); }
    finally { await db.exec("RESET ROLE; SELECT set_config('test.deny','',false)"); }
  });
  it('compares the expected revision, snapshots every save and rejects a stale editor', async () => {
    const complete = { ...payload, form: { ...payload.form, room_id:room, start_date:'2026-09-28',end_date:'2027-09-28',signed_date:'2026-09-28' }, customers: [{id:customer,full_name:'Nguyễn A',phone:'0900000000',id_number:'0123456789',is_representative:true,notes:null}] };
    expect((await save(draftId,'00000000-0000-4000-8000-000000000020',complete,1)).rows[0].result.revision).toBe(2);
    await expect(save(draftId,'00000000-0000-4000-8000-000000000021',complete,1)).rejects.toMatchObject({ code:'40001' });
    expect((await db.query('SELECT * FROM public.contract_draft_versions')).rows).toHaveLength(2);
    expect((await save(draftId,requestId)).rows[0].result.revision).toBe(1);
  });
  it('rejects receipt/invoice keys before persisting and leaves money plus room status unchanged', async () => {
    await expect(save('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000031',{ ...payload, deposit_receipts: [{amount:500}] } as typeof payload)).rejects.toMatchObject({ code:'22023' });
    for (const table of ['contracts','invoices','income_expenses','payments']) expect((await db.query(`SELECT * FROM public.${table}`)).rows).toHaveLength(0);
    expect((await db.query<{status:string}>('SELECT status FROM public.rooms')).rows[0].status).toBe('AVAILABLE');
  });
  it('binds document registration to uploaded exact-revision files, then replays the immutable artifact', async () => {
    await expect(register()).rejects.toMatchObject({ code:'22023' });
    const root = `${org}/${building}/${draftId}/2/${documentId}`;
    await db.query('INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES($1,$2,$4),($1,$3,$4)', ['contract-draft-documents',`${root}/document.docx`,`${root}/template.docx`,actor]);
    expect((await register()).rows[0].result.id).toBe(documentId);
    expect((await register('00000000-0000-4000-8000-000000000099')).rows[0].result.id).toBe(documentId);
    expect((await db.query('SELECT * FROM public.contract_draft_documents')).rows).toHaveLength(1);
  });
  it('fences the private bucket against existing broad policies, refuses replacement/deletion and preserves older exports after template deletion', async () => {
    await db.exec('SET ROLE authenticated');
    try {
      expect((await db.query('UPDATE storage.objects SET name=name RETURNING *')).rows).toHaveLength(0);
      expect((await db.query('DELETE FROM storage.objects RETURNING *')).rows).toHaveLength(0);
      const wrong = `${otherOrg}/${otherBuilding}/${draftId}/2/${documentId}/document.docx`;
      await expect(db.query('INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES($1,$2,$3)',['contract-draft-documents',wrong,actor])).rejects.toMatchObject({code:'42501'});
    } finally { await db.exec('RESET ROLE'); }
    await db.exec('DELETE FROM public.document_templates');
    await db.exec('SET ROLE authenticated');
    try { expect((await db.query('SELECT * FROM storage.objects')).rows).toHaveLength(2); }
    finally { await db.exec('RESET ROLE'); }
    expect((await register()).rows[0].result.id).toBe(documentId);
  });
  it('requires existing document-print permission for downloads despite contract view permission', async () => {
    await db.exec("SELECT set_config('test.deny','contracts.print',false); SET ROLE authenticated");
    try {
      expect((await db.query('SELECT * FROM public.contract_drafts')).rows).toHaveLength(1);
      expect((await db.query('SELECT * FROM storage.objects')).rows).toHaveLength(0);
      await expect(register()).rejects.toMatchObject({code:'42501'});
    } finally { await db.exec("RESET ROLE; SELECT set_config('test.deny','',false)"); }
  });
});
