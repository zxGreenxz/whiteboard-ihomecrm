// The HTTPS destination is fixed because the caller is forwarding provider credentials.
export const CRM_AI_VPS = 'https://crm-hermes.chillhome.io.vn/ai-gateway';
export const OWNER_NOUS_BASE = CRM_AI_VPS + '/nous-owner';
type Env = (name: string) => string | undefined;
const paths = ['/chat/completions', '/models'];
const upstreams: Record<string, readonly string[]> = {
  '9router': ['https://ai.chillhome.io.vn/v1', 'https://cli.chillhome.io.vn/v1'],
  nous: [OWNER_NOUS_BASE, 'https://inference-api.nousresearch.com/v1'],

};

export function canUseOwnerPlan(env: Env, actor: string | undefined) {
  const owner = env('CRM_AI_OWNER_ID');
  return !!owner && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(owner) && owner === actor;
}

// Call only at provider I/O boundaries. Supabase Auth, database and Storage use their original fetch.
export function viaHermesVps(provider: string, env: Env, send: typeof fetch): typeof fetch {
  const key = env('CRM_AI_VPS_KEY')?.trim();
  if (!key) return send;
  return async (input, init) => {
    const url = new URL(String(input));
    const suffix = paths.find(p => url.pathname.endsWith(p));
    if (!suffix || url.search || url.hash || url.username || url.password ||
        !upstreams[provider]?.some(base => url.href === base + suffix)) {
      throw Error('invalid_ai_destination');
    }
    const route = provider === 'nous' && url.origin + url.pathname === OWNER_NOUS_BASE + suffix
      ? 'nous-owner' : provider;
    const headers = new Headers(init?.headers);
    headers.set('X-CRM-AI-Key', key);
    return send(CRM_AI_VPS + '/' + route + suffix, { ...init, headers, redirect: 'error' });
  };
}
