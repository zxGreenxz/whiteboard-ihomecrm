import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { contractDraftSchema, emptyContractDraftPayload } from '../contractDrafts';

const db = new PGlite();
const org = '11111111-1111-4111-8111-111111111111';
const building = '22222222-2222-4222-8222-222222222222';
const customer = '44444444-4444-4444-8444-444444444444';
const service = '55555555-5555-4555-8555-555555555555';
const actor = '66666666-6666-4666-8666-666666666666';

// Focused payload boundary fixture. Role/scope/side-effect checks stay in the migration suite.
beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA storage;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${building}'::uuid $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
      LANGUAGE sql STABLE AS $$ SELECT false,ARRAY['${building}'::uuid],'{}'::uuid[] $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN; END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean)
      LANGUAGE sql VOLATILE AS $$ SELECT true $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);
    INSERT INTO public.organizations VALUES('${org}','ACTIVE');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    INSERT INTO public.buildings VALUES('${building}','${org}',null);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz);
    CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    INSERT INTO public.customers VALUES('${customer}','${org}',null);
    CREATE TABLE public.services(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    INSERT INTO public.services VALUES('${service}','${org}',null);
    CREATE TABLE public.document_templates(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,is_active boolean,type text);
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,owner_id text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  `);
  await db.exec(readFileSync('supabase/migrations/20260928013253_contract_drafts_workflow.sql', 'utf8'));
}, 30000);
afterAll(async () => { await db.close(); });

it('rejects malformed nested customer/service and fractional discount fields before they can poison draft list parsing', async () => {
  const base = emptyContractDraftPayload();
  const invalid = [
    { ...base, customers: [{ id: customer, full_name: 42, phone: [], id_number: null, is_representative: 'yes', notes: {} }] },
    { ...base, services: [{ id: service, name: 'Internet', unit_price: 'abc', unit: null, type: 'FIXED', pricing_type: null, initial_reading: 0, quantity: 1 }] },
    { ...base, form: { ...base.form, discount_months: 0.5 } },
    { ...base, services: [{ id: service, name: 'Internet', unit_price: -1, unit: null, type: 'FIXED', pricing_type: null, initial_reading: 0, quantity: 1 }] },
    { ...base, services: [{ id: service, name: 'Internet', unit_price: 0, unit: [], type: 'FIXED', pricing_type: null, initial_reading: 0, quantity: 1 }] },
  ];
  for (let index = 0; index < invalid.length; index++) {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const request = `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`;
    await expect(db.query('SELECT public.save_contract_draft($1,$2,$3,$4,$5,$6,$7,$8)',
      [org, building, null, JSON.stringify(invalid[index]), null, id, null, request])).rejects.toMatchObject({ code: '22023' });
  }
  expect((await db.query('SELECT * FROM public.contract_drafts')).rows).toHaveLength(0);
  const partial = { ...base, customers: [{ id: customer, full_name: '', phone: '', id_number: null, is_representative: false, notes: null }],
    services: [{ id: service, name: '', unit_price: 0, unit: null, type: '', pricing_type: null, initial_reading: 0, quantity: 0 }] };
  await db.query('SELECT public.save_contract_draft($1,$2,$3,$4,$5,$6,$7,$8)',
    [org, building, null, JSON.stringify(partial), null, '00000000-0000-4000-8000-000000000009', null, '00000000-0000-4000-8001-000000000009']);
  const listed = await db.query<{ result: unknown }>('SELECT public.list_contract_drafts($1,$2) result', [org, null]);
  expect(z.array(contractDraftSchema).safeParse(listed.rows[0].result).success).toBe(true);
});
