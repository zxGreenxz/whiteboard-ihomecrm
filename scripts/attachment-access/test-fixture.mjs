import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const org = 'dddd0000-0000-4000-8000-000000000001';
const otherOrg = 'cccc0000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-000000000001';
const staff = '00000000-0000-4000-8000-000000000002';
const outsider = '00000000-0000-4000-8000-000000000003';
const revoked = '00000000-0000-4000-8000-000000000004';
const admin = '00000000-0000-4000-8000-000000000005';
const noOrg = '00000000-0000-4000-8000-000000000006';
const bucket = 'income-expense-attachments';
const date = '2026-09-10T05:00:00.000000+00:00';
const prefix = `https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/${bucket}/`;
const makeEvidence = n => ({
  object_name: `${owner}/receipt-${n}.webp`, storage_object_id: `00000000-0000-4000-8001-${String(n).padStart(12,'0')}`,
  storage_owner: owner, archived_at: null, is_delete_marker: false, is_supplement: false,
  original_link: {bucket_id:bucket,object_name:`${owner}/receipt-${n}.webp`,owner_user_id:owner,organization_id:null,derivation:'quarantine',created_at:date},
  vouchers: [{id:`00000000-0000-4000-8002-${String(n).padStart(12,'0')}`,org,deleted:null}],
  finance_evidence: [{org,state:'ATTACHED'}],
});
const evidence = [makeEvidence(1), makeEvidence(2)];
const snapshot = readFileSync(new URL('../authz-prepared/prod-snapshot/PS03_storage_shield.sql',import.meta.url),'utf8');
function originalFunction(name) {
  const start = snapshot.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = snapshot.indexOf('$function$;',start) + '$function$;'.length;
  assert.ok(start >= 0 && end > start);
  return snapshot.slice(start,end);
}
export async function setup() {
  const db = new PGlite();
  try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA storage;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE TABLE public.organization_memberships(user_id uuid,organization_id uuid,status text,member_type text);
    CREATE TABLE public.super_admins(user_id uuid);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,owner uuid,owner_id text,archived_at timestamptz,is_delete_marker boolean DEFAULT false,UNIQUE(bucket_id,name));
    CREATE TABLE app_private.storage_object_links(bucket_id text,object_name text,organization_id uuid,owner_user_id uuid,derivation text,created_at timestamptz,PRIMARY KEY(bucket_id,object_name));
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY,organization_id uuid,attachments jsonb,deleted_at timestamptz,amount numeric DEFAULT 12345);
    CREATE TABLE public.finance_evidence_objects(bucket_id text,object_name text,organization_id uuid,state text);
    CREATE TABLE app_private.ie_supplement_objects(bucket_id text,object_name text);
    CREATE FUNCTION app_private.ie_storage_is_supplement_v1(p_bucket text,p_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$SELECT EXISTS(SELECT 1 FROM app_private.ie_supplement_objects WHERE bucket_id=p_bucket AND object_name=p_name)$$;
    GRANT USAGE ON SCHEMA auth,storage,app_private TO authenticated,anon;
    GRANT SELECT ON storage.objects TO authenticated,anon;
    INSERT INTO public.organization_memberships VALUES ('${owner}','${org}','ACTIVE','OWNER'),('${owner}','${otherOrg}','ACTIVE','OWNER'),('${staff}','${org}','ACTIVE','STAFF'),('${outsider}','${otherOrg}','ACTIVE','STAFF'),('${revoked}','${org}','REVOKED','STAFF');
    INSERT INTO public.super_admins VALUES ('${admin}');
    ${originalFunction('public.my_org_ids')}
    ${originalFunction('public.is_super_admin')}
    ${originalFunction('app_private.derive_uploader_org_v1')}
    ${originalFunction('app_private.can_read_storage_object_v1')}
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ie_attachments_select_authenticated ON storage.objects FOR SELECT TO authenticated USING(bucket_id='${bucket}');
    CREATE POLICY storage_objects_super_admin_all ON storage.objects FOR ALL TO authenticated USING(public.is_super_admin());
    CREATE POLICY storage_pii_org_isolation ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated USING(app_private.can_read_storage_object_v1(bucket_id,name));
    CREATE POLICY ie_supplement_storage_parent_read ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated USING(NOT app_private.ie_storage_is_supplement_v1(bucket_id,name));
    CREATE FUNCTION app_private.protect_supplement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF app_private.ie_storage_is_supplement_v1(OLD.bucket_id,OLD.object_name) THEN RAISE EXCEPTION 'Protected supplement'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER a00_ie_supplement_link_guard BEFORE UPDATE ON app_private.storage_object_links FOR EACH ROW EXECUTE FUNCTION app_private.protect_supplement();`);
  for (const x of evidence) {
    await db.query('INSERT INTO storage.objects VALUES ($1,$2,$3,$4::uuid,$4::text,NULL,false)',[x.storage_object_id,bucket,x.object_name,owner]);
    await db.query('INSERT INTO app_private.storage_object_links VALUES ($1,$2,NULL,$3,\'quarantine\',$4)',[bucket,x.object_name,owner,date]);
    await db.query('INSERT INTO public.income_expenses(id,organization_id,attachments) VALUES($1,$2,$3)',[x.vouchers[0].id,org,JSON.stringify([prefix+x.object_name])]);
    await db.query('INSERT INTO public.finance_evidence_objects VALUES ($1,$2,$3,\'ATTACHED\')',[bucket,x.object_name,org]);
  }
  // A separate image is not in the explicit repair manifest.
  await db.exec(`INSERT INTO storage.objects VALUES ('00000000-0000-4000-8001-000000000003','${bucket}','${owner}/unrelated.webp','${owner}','${owner}',NULL,false);
    INSERT INTO app_private.storage_object_links VALUES ('${bucket}','${owner}/unrelated.webp',NULL,'${owner}','quarantine','${date}');`);
  return db;
  } catch (error) { await db.close(); throw error; }
}
async function readable(db, user, role='authenticated') {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE ${role};`);
  try { return (await db.query('SELECT name FROM storage.objects ORDER BY name')).rows.map(x=>x.name); }
  finally { await db.exec('RESET ROLE'); }
}
const commitForDisposableTest = sql => sql.replace(/ROLLBACK;\s*$/,'COMMIT;');
const fingerprint = async db => (await db.query(`SELECT jsonb_agg(to_jsonb(x)) data FROM (SELECT * FROM pg_policies WHERE schemaname='storage' ORDER BY policyname) x`)).rows[0].data;

export { org, otherOrg, owner, staff, outsider, revoked, admin, noOrg, bucket, date, prefix, evidence, readable, commitForDisposableTest, fingerprint };
