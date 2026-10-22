/**
 * Disposable source-level reproduction, synthetic data only.
 * Run: node docs/plans/sale-phong-actions-20261021/proofs/pass-listing-scope.mjs
 * The authorization primitives are fixture functions; can_manage_pass_listing,
 * upsert_room_pass_listing and organization triggers come from repository SQL.
 * This is not a production/JWT/PostgREST certification.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const sources = {
  initial: 'supabase/migrations/20260617090000_room_pass_listings.sql',
  upsert: 'supabase/migrations/20260629100000_room_pass_listings_contact_manager.sql',
  org: 'supabase/migrations/20261011042329_chan_null_org_va_khoa_dau_cong_ty.sql',
};
const sql = Object.fromEntries(Object.entries(sources).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
function definition(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`CREATE OR REPLACE FUNCTION ${escaped}\\([\\s\\S]*?\\bAS (\\$[a-zA-Z_]*\\$)[\\s\\S]*?\\1;`));
  assert.ok(match, `Function missing: ${name}`);
  return match[0];
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [org, owner, actor, buildingA, buildingB, roomA, roomB, listing] = Array.from({ length: 8 }, (_, n) => id(n + 1));
const db = new PGlite();
let result;
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('test.actor')::uuid $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT auth.uid()='${actor}' AND $3='${buildingA}' $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT auth.uid()='${actor}' AND $1='${buildingA}' $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,building_id uuid REFERENCES public.buildings(id),organization_id uuid,deleted_at timestamptz);
    ${sql.initial.match(/CREATE TABLE IF NOT EXISTS public\.room_pass_listings \([\s\S]*?\n\);/)[0]}
    ALTER TABLE public.room_pass_listings ADD COLUMN organization_id uuid;
    ALTER TABLE public.room_pass_listings ADD COLUMN avail_date date;
    ALTER TABLE public.room_pass_listings ADD COLUMN contact_manager boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX room_pass_listings_room_active_uniq ON public.room_pass_listings(room_id) WHERE active;
    ${definition(sql.initial, 'public.can_manage_pass_listing')}
    ${definition(sql.upsert, 'public.upsert_room_pass_listing')}
    ${definition(sql.org, 'app_private.khoa_organization_id_v1')}
    ${definition(sql.org, 'app_private.autofill_org_strict')}
    INSERT INTO public.buildings VALUES('${buildingA}','${owner}','${org}',NULL),('${buildingB}','${owner}','${org}',NULL);
    INSERT INTO public.rooms VALUES('${roomA}','${buildingA}','${org}',NULL),('${roomB}','${buildingB}','${org}',NULL);
    INSERT INTO public.room_pass_listings(id,user_id,building_id,room_id,organization_id,contact_name,active)
      VALUES('${listing}','${owner}','${buildingB}','${roomB}','${org}','Synthetic tenant B',true);
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.room_pass_listings
      FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE OF organization_id ON public.room_pass_listings
      FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    ALTER TABLE public.room_pass_listings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY rpl_select ON public.room_pass_listings FOR SELECT
      USING(auth.uid()=user_id OR public.can_access_building(building_id));
    CREATE POLICY room_pass_listings_org_boundary ON public.room_pass_listings
      AS RESTRICTIVE FOR ALL TO authenticated
      USING(organization_id IS NULL OR public.is_super_admin() OR organization_id=ANY(public.my_org_ids()))
      WITH CHECK(organization_id IS NULL OR public.is_super_admin() OR organization_id=ANY(public.my_org_ids()));
    GRANT USAGE ON SCHEMA public,auth TO authenticated;
    GRANT SELECT,UPDATE ON public.room_pass_listings TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public,auth TO authenticated;
    SELECT set_config('test.actor','${actor}',false);
    SET ROLE authenticated;
  `);
  const visibleBefore = (await db.query('SELECT * FROM public.room_pass_listings')).rows.length;
  assert.equal(visibleBefore, 0, 'Actor must not see building B listing');
  const direct = await db.query(`UPDATE public.room_pass_listings SET contact_name='Direct write' WHERE id=$1 RETURNING id`, [listing]);
  assert.equal(direct.rows.length, 0, 'RLS must deny direct update');
  let deniedTargetB = false;
  try {
    await db.query(`SELECT public.upsert_room_pass_listing($1,$2,'Denied target',NULL,NULL,NULL,true,NULL,false)`, [listing, roomB]);
  } catch (error) {
    deniedTargetB = /Không có quyền/.test(error.message);
  }
  assert.ok(deniedTargetB, 'Negative control: target B must be denied');
  const changed = (await db.query(`
    SELECT (r).* FROM public.upsert_room_pass_listing($1,$2,'Synthetic replacement',NULL,NULL,NULL,true,NULL,false) r
  `, [listing, roomA])).rows[0];
  assert.equal(changed.id, listing);
  assert.equal(changed.building_id, buildingA);
  assert.equal(changed.room_id, roomA);
  assert.equal(changed.organization_id, org);
  assert.equal(changed.contact_name, 'Synthetic replacement');
  result = {
    status: 'BUG_REPRODUCED',
    finding: 'upsert checks target room A, but overwrites supplied listing from unauthorized building B',
    controls: { actorCannotReadListingB: visibleBefore === 0, directUpdateDeniedByRls: direct.rows.length === 0, targetBRejected: deniedTargetB },
    effect: { originalListingIdReused: true, movedFromUnauthorizedBuildingBToA: true, organizationIdUnchanged: true },
    limitations: ['PGlite fixture, not production', 'auth.uid/can_do_on_building/can_access_building/org membership primitives use synthetic fixtures', 'Actual upsert, management guard, organization trigger bodies are loaded unchanged from source', 'Does not certify JWT/PostgREST or deployed database catalog'],
    sourceSha256: Object.fromEntries(Object.entries(sources).map(([key, path]) => [path, createHash('sha256').update(sql[key]).digest('hex')])),
  };
  writeFileSync(new URL('./pass-listing-scope-result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.close();
}
