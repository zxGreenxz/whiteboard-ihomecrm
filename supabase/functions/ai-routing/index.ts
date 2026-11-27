import { APPS, inScope, loadCatalog, endpoint, isObject, routePair, type App, type CatalogModel, type Env } from '../_shared/ai-routing.ts';
import { probe } from './probe.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const reply = (status: number, data: unknown) => Response.json(data, { status, headers: cors });
const providers = ['nous', '9router'] as const;

export async function manage(req: Request, env: Env, send: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const base = env('SUPABASE_URL'), anon = env('SUPABASE_ANON_KEY'), service = env('SUPABASE_SERVICE_ROLE_KEY');
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply(401, { error: 'login_required' });
  if (!base || !anon || !service) return reply(503, { error: 'unconfigured' });
  const db = (path: string, init: RequestInit = {}) => send(base + '/rest/v1/' + path, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { apikey: service, Authorization: 'Bearer ' + service, 'Content-Type': 'application/json',
      'Accept-Profile': 'public', 'Content-Profile': 'public', ...init.headers },
  });
  try {
    // The JWT supplied by the caller must carry the real platform-wide role. An org owner's sentinel is insufficient.
    const perm = await send(base + '/rest/v1/rpc/is_super_admin', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { apikey: anon, Authorization: auth, 'Content-Type': 'application/json', 'Content-Profile': 'public' }, body: '{}' });
    if ([401,403].includes(perm.status)) return reply(perm.status, { error: 'forbidden' });
    if (!perm.ok) return reply(503, { error: 'auth_unavailable' });
    if (await perm.json() !== true) return reply(403, { error: 'forbidden' });
    let input: unknown;
    try { const text = await req.text(); if (text.length > 2500) return reply(413, { error: 'body_size' }); input = JSON.parse(text); }
    catch { return reply(400, { error: 'invalid_request' }); }
    if (!isObject(input) || !['read', 'sync', 'save', 'verify'].includes(String(input.action))) return reply(400, { error: 'invalid_request' });
    const syncErrors: string[] = [];
    if (input.action === 'sync') {
      await Promise.all(providers.map(async provider => {
        const target = endpoint(provider, env);
        if (!target) { syncErrors.push(provider); return; }
        try {
          const models = await loadCatalog(provider, target, send, 20000);
          if (!models.length) throw Error('empty_entitlement');
          const stored = await db('ai_route_catalogs?on_conflict=provider', { method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ provider, models, synced_at: new Date().toISOString() }) });
          if (!stored.ok) throw Error('catalog_store_unavailable');
        } catch { syncErrors.push(provider); }
      }));
    }
    const raw = await db('ai_route_catalogs?select=provider,models,synced_at');
    if (!raw.ok) throw Error('catalog_store_unavailable');
    const catalogs: { provider: 'nous' | '9router'; models: CatalogModel[]; synced_at: string }[] = await raw.json();
    if (input.action === 'verify') {
      const catalog = catalogs.find(c => c.provider === input.provider);
      const model = catalog?.models.find(m => m.id === input.model && (m.vision || m.text));
      if (!catalog || !model) return reply(422, { error: 'incompatible_model' });
      if (catalog.synced_at !== input.snapshot) return reply(409, { error: 'config_changed' });
      const target = endpoint(catalog.provider, env);
      if (!target) return reply(422, { error: 'provider_unconfigured' });
      const result = await probe(catalog.provider, target, model, send);
      if (result.stop) return reply(200, result);
      const record = await db('rpc/record_ai_route_probe', { method: 'POST', body: JSON.stringify({
        p_provider: catalog.provider, p_synced_at: catalog.synced_at, p_model: model.id, p_passed: result.passed,
      }) });
      if (!record.ok) throw Error('probe_store_unavailable');
      if (await record.json() !== true) return reply(409, { error: 'config_changed' });
      return reply(200, result);
    }
    if (input.action === 'save') {
      if (!APPS.includes(input.app as App) || !routePair(input.routes) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) return reply(400, { error: 'invalid_route' });
      for (const route of input.routes) {
        const choice = catalogs.find(c => c.provider === route.provider)?.models.find(m => m.id === route.model);
        if (!inScope(route.provider, route.model) || !choice?.verified || input.app === 'quick_stt' || !choice.vision) return reply(422, { error: 'incompatible_model' });
        if (!endpoint(route.provider, env)) return reply(422, { error: 'provider_unconfigured' });
      }
      const revision = Number(input.revision);
      const update = await db('ai_application_routes?app=eq.' + input.app + '&revision=eq.' + revision, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ routes: input.routes, revision: revision + 1 }),
      });
      if (!update.ok) throw Error('route_store_unavailable');
      if ((await update.json()).length !== 1) return reply(409, { error: 'config_changed' });
    }
    const rows = await db('ai_application_routes?select=app,revision,routes&order=app');
    if (!rows.ok) throw Error('route_store_unavailable');
    return reply(200, { apps: await rows.json(), catalogs, syncErrors, enabled: env('AI_ROUTING_ENABLED') === 'true',
      ready: { nous: !!endpoint('nous', env), '9router': !!endpoint('9router', env) } });
  } catch { return reply(503, { error: 'ai_routing_unavailable' }); }
}

if (import.meta.main) Deno.serve(req => manage(req, name => Deno.env.get(name)));
