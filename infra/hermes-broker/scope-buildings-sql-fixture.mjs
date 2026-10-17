import { readFileSync, readdirSync } from 'node:fs';

// Candidate forward migration hermes_scope_buildings_v1: Hermes reads its rooms.view
// building scope from its own function (over the shared authorized_scope_v3 resolver)
// instead of the Copilot wrapper. Composition fixtures replay it on top of the final
// Hermes chain, then move their existing SYNTHETIC CRM scope port from the Copilot name
// to fixture_room_scope_port_v1 and point the Hermes function at it. A final Hermes body
// that still called the Copilot wrapper would therefore fail with undefined_function.
// The real hermes_scope_buildings_v1 body is proven against the real resolver and the
// production Copilot body in scope-buildings-sql.test.mjs, not here.
const root = new URL('../../supabase/migrations/', import.meta.url);
export const SCOPE_BUILDINGS_SLUG = 'hermes_scope_buildings_v1';
export function scopeBuildingsMigration() {
  const names = readdirSync(root).filter(name => new RegExp(`^\\d{14}_${SCOPE_BUILDINGS_SLUG}\\.sql$`).test(name));
  if (names.length !== 1) throw new Error(`expected one ${SCOPE_BUILDINGS_SLUG} migration`);
  return readFileSync(new URL(names[0], root), 'utf8');
}

/** Apply the candidate twice (idempotent forward file) and re-home the synthetic scope port. */
export async function installScopeBuildingsSql(db) {
  const sql = scopeBuildingsMigration();
  // Preview-only fixtures lack some Hermes tables; plpgsql bodies are validated on call.
  await db.exec('SET check_function_bodies=off');
  try { await db.exec(sql); await db.exec(sql); } finally { await db.exec('SET check_function_bodies=on'); }
  await db.exec(`ALTER FUNCTION public.copilot_org_scope_buildings_v1(text,uuid) RENAME TO fixture_room_scope_port_v1;
    CREATE OR REPLACE FUNCTION public.hermes_scope_buildings_v1(p_permission_key text,p_organization_id uuid) RETURNS uuid[]
      LANGUAGE sql STABLE AS $$SELECT public.fixture_room_scope_port_v1(p_permission_key,p_organization_id)$$;`);
}
