import { canUseOwnerPlan, OWNER_NOUS_BASE } from './hermes-vps.ts';

export const APPS = ['quick_read', 'wallet_read', 'quick_stt', 'meter_vision'] as const;
export type App = typeof APPS[number];
export type Provider = 'nous' | '9router';
export interface Route { provider: Provider; model: string }
export interface CatalogModel { id: string; vision: boolean; text: boolean; tested?: boolean; verified?: boolean }
export type Env = (name: string) => string | undefined;
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 250 && /^[A-Za-z0-9][A-Za-z0-9._:/@()+~\[\]-]*$/.test(id);

export function isRoute(v: unknown): v is Route {
  return isObject(v) && (v.provider === 'nous' || v.provider === '9router') && validId(v.model) && inScope(v.provider, v.model) && Object.keys(v).length === 2;
}

export function routePair(value: unknown): value is Route[] {
  return Array.isArray(value) && (value.length === 0 || (value.length === 2 && value.every(isRoute) &&
    (value[0].provider !== value[1].provider || value[0].model !== value[1].model)));
}

export function inScope(provider: Provider, id: string) {
  return provider === 'nous' ? id.startsWith('openai/') : /^(ag|cx)\//.test(id);
}

export function catalogModels(provider: Provider, raw: unknown): CatalogModel[] {
  if (!isObject(raw) || !Array.isArray(raw.data) || !raw.data.length || raw.data.length > 20000) throw Error('invalid_catalog');
  const models = new Map<string, CatalogModel>();
  for (const m of raw.data) {
    if (!isObject(m) || typeof m.id !== 'string' || !inScope(provider, m.id)) continue;
    if (provider === 'nous' ? m.billing_mode !== 'subscription' : m.owned_by !== m.id.split('/')[0]) continue;
    if (!validId(m.id)) throw Error('invalid_model_id');
    const architecture = isObject(m.architecture) ? m.architecture : {};
    const caps = isObject(m.capabilities) ? m.capabilities : {};
    const vision = provider === 'nous'
      ? Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes('image') &&
        Array.isArray(architecture.output_modalities) && architecture.output_modalities.includes('text') &&
        Array.isArray(m.supported_parameters) && m.supported_parameters.includes('response_format')
      : caps.vision === true && caps.imageOutput !== true && caps.audioOutput !== true;
    const realtime = !m.id.endsWith(':batch');
    const text = provider === 'nous' ? Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes('text') &&
      Array.isArray(architecture.output_modalities) && architecture.output_modalities.includes('text') : caps.imageOutput !== true && caps.audioOutput !== true;
    models.set(m.id, { id: m.id, vision: vision && realtime, text: text && realtime });
  }
  return [...models.values()].sort((a,b) => a.id.localeCompare(b.id));
}

export async function loadCatalog(provider: Provider, target: { base: string; key: string }, send: typeof fetch, timeout = 8000) {
  const response = await send(target.base + '/models', { headers: { Authorization: 'Bearer ' + target.key },
    redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw Error('catalog_unavailable');
  return catalogModels(provider, await response.json());
}

// These are service credentials for the shared application, never a user's OAuth token.
export function endpoint(provider: Provider, env: Env, actor?: string) {
  if (provider === 'nous' && !env('AI_NOUS_API_KEY')?.trim() && canUseOwnerPlan(env, actor)) {
    const key = env('CRM_AI_OWNER_CONNECTOR_KEY')?.trim();
    if (key && env('CRM_AI_VPS_KEY')?.trim()) return { base: OWNER_NOUS_BASE, key };
  }
  const base = (provider === 'nous' ? env('AI_NOUS_BASE_URL') || 'https://inference-api.nousresearch.com/v1'
    : env('QUICK_ENTRY_NINEROUTER_BASE_URL') || env('NINEROUTER_BASE_URL') || '').trim().replace(/\/+$/, '');
  const key = (provider === 'nous' ? env('AI_NOUS_API_KEY') :
    env('QUICK_ENTRY_NINEROUTER_KEY') || env('NINEROUTER_API_KEY'))?.trim();
  if (!key) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  } catch { return null; }
  return { base, key };
}

// An absent rollout or an unavailable settings database preserves the caller's existing route.
export async function applicationRoutes(app: App, env: Env, fetcher: typeof fetch): Promise<Route[]> {
  if (app === 'quick_stt' || env('AI_ROUTING_ENABLED') !== 'true') return [];
  const base = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return [];
  try {
    const res = await fetcher(base + '/rest/v1/ai_application_routes?select=routes&app=eq.' + app, {
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Accept-Profile': 'public' }, redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw Error();
    const row = (await res.json())[0];
    if (row && routePair(row.routes)) return row.routes;
  } catch { /* handled below */ }
  console.warn('ai_route_read_unavailable', app);
  return [];
}
