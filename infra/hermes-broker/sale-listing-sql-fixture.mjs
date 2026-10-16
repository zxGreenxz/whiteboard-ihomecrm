import { readFileSync, readdirSync } from 'node:fs';
import { installGroupSendSql } from '../hermes-zalo-router/group-send-sql-fixture.mjs';
import { ORG, USER } from '../hermes-zalo-router/private-command-fixture.mjs';

// Candidate forward migration (Hermes reads the published sale page) on top of the
// production chain of a disposable PGlite fixture. The page reader itself,
// public.get_public_available_rooms, is an explicit synthetic PORT here: it keeps the
// real reader's owner rule (buildings.user_id = owner of a live share token) over
// public.fixture_rooms. Real JWT/RLS, PostgREST and the production reader body are
// NOT exercised; the SQL under test is the candidate wrapper/decision/fact/schedule.
const root = new URL('../../supabase/migrations/', import.meta.url);
const migration = name => readFileSync(new URL(`${name}.sql`, root), 'utf8');
export const TOKEN_ROW = 'fixture-share-token';
export function saleListingCandidate() {
  const names = readdirSync(root).filter(name => /^\d{14}_hermes_sale_listing_parity_v1\.sql$/.test(name));
  if (names.length !== 1) throw new Error('expected one hermes_sale_listing_parity_v1 migration');
  return readFileSync(new URL(names[0], root), 'utf8');
}

/** Group SQL applied after the group queue migration, in production order. */
export const FULL_CHAIN = Object.freeze(['20261013095000_hermes_zalo_private_reply_v1', '20261014000503_hermes_optional_org_policy_v1',
  '20261014000538_hermes_external_group_connector_v1']);
/** The private-reply authority guard needs CRM role tables this preview fixture does
 * not model; it does not touch preview/send room facts, so preview-only flows skip it. */
export const PREVIEW_CHAIN = Object.freeze(FULL_CHAIN.filter(name => !name.includes('private_reply')));

/** chain (array) installs the group queue SQL and then these migrations first; false
 * means the caller already applied them (schedule/external fixtures). */
export async function installSaleListingSql(x, { chain = FULL_CHAIN } = {}) {
  const db = x.f.db;
  if (chain) {
    Object.assign(x, await installGroupSendSql(x));
    for (const name of chain) await db.exec(migration(name));
  }
  await db.exec(`
    ALTER TABLE public.room_pass_listings ADD COLUMN IF NOT EXISTS pass_price numeric,ADD COLUMN IF NOT EXISTS contact_name text,
      ADD COLUMN IF NOT EXISTS contact_phone text,ADD COLUMN IF NOT EXISTS contact_manager boolean,ADD COLUMN IF NOT EXISTS avail_date date;
    CREATE TABLE IF NOT EXISTS public.public_room_share_tokens(token text PRIMARY KEY,owner_id uuid,organization_id uuid,revoked boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),label text);
    INSERT INTO public.public_room_share_tokens(token,owner_id,organization_id) VALUES('${TOKEN_ROW}','${USER}','${ORG}') ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $$
      WITH owner AS (SELECT owner_id FROM public.public_room_share_tokens WHERE token=p_token AND revoked=false),
      page AS (SELECT payload FROM public.fixture_rooms LIMIT 1)
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM owner) THEN NULL ELSE jsonb_build_object('areas','[]'::jsonb,
        'buildings',COALESCE((SELECT jsonb_agg(b) FROM page,jsonb_array_elements(page.payload->'buildings') b
          WHERE EXISTS(SELECT 1 FROM public.buildings x,owner WHERE x.id=(b->>'id')::uuid AND x.user_id=owner.owner_id)),'[]'::jsonb),
        'rooms',COALESCE((SELECT jsonb_agg(r) FROM page,jsonb_array_elements(page.payload->'rooms') r
          WHERE EXISTS(SELECT 1 FROM public.buildings x,owner WHERE x.id=(r->>'building_id')::uuid AND x.user_id=owner.owner_id)),'[]'::jsonb),
        'contact',jsonb_build_object('name','Hotline thử','phone','0900000001'),'sale_policy','Chính sách thử') END
    $$;`);
  // The schedule/queue tables of later migrations may be absent in a preview-only
  // fixture; plpgsql bodies are then validated on first call instead of at CREATE.
  const sql = saleListingCandidate();
  await db.exec('SET check_function_bodies=off');
  try { await db.exec(sql); await db.exec(sql); } finally { await db.exec('SET check_function_bodies=on'); }
  return x;
}
