import { readFileSync } from 'node:fs';
import { USER, ORG } from './customer-action-fixture.mjs';

export const optionsPath = 'supabase/migrations/20261015191139_hermes_customer_options_v7.sql';
export const member = { userId: USER, organizationId: ORG, membershipId: USER, authorizationVersion: 1, isSuperadmin: false };
export const baseOptions = { ...member, policyVersion: 1, enabled: true, read: [], action: [], scopes: [] };

/** Installs the candidate v7 layer over a fixed v6 stub (table public.fixture_v6)
 * on the customer-action PGlite fixture. The CRM capability reader, effective
 * policy, registry and scope rows underneath are the real/canonical SQL there. */
export async function installV7(db, { sql = readFileSync(process.env.HERMES_CUSTOMER_OPTIONS_SQL ?? optionsPath, 'utf8') } = {}) {
  await db.exec(`CREATE TABLE public.fixture_v6(kind text PRIMARY KEY,value jsonb NOT NULL);
    CREATE FUNCTION public.hermes_org_policy_options_v6(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_v6 WHERE kind='org_options'$$;
    CREATE FUNCTION public.hermes_connection_options_v6(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_v6 WHERE kind='connection_options'$$;
    CREATE FUNCTION public.hermes_connection_context_v6(p_connection_id uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_v6 WHERE kind='context'$$;`);
  await db.exec(sql); await db.exec(sql);
  const base = (kind, value) => db.query('INSERT INTO public.fixture_v6 VALUES($1,$2::jsonb) ON CONFLICT(kind) DO UPDATE SET value=EXCLUDED.value',
    [kind, JSON.stringify(value)]);
  async function call(name, arg, { actor = USER, role = 'authenticated' } = {}) {
    if (!/^hermes_(?:org_policy_options|connection_options|connection_context)_v7$/.test(name) || !['authenticated', 'anon'].includes(role)) throw new Error('invalid_fixture_rpc');
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)", [role, actor]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    try { const value = (await db.query(`SELECT public.${name}($1::uuid) result`, [arg])).rows[0].result; await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  return { base, call };
}
