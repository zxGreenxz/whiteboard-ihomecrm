import { DEMO, ACTION, UUID, DENIALS, requireThat } from './copilot-room-pass-live.mjs';

const TABLES = new Set(['buildings', 'rooms', 'room_pass_listings', 'ai_write_audit']);
const RPCS = new Set(['get_authorization_context_v1', 'get_my_copilot_availability_v1', 'get_copilot_action_policy_v1',
  'upsert_room_pass_listing', 'delete_room_pass_listing', 'set_room_pass_listing_active', 'set_copilot_feature_flag_v2',
  'copilot_preview_room_pass_active_v1', 'copilot_execute_room_pass_active_v1', 'copilot_plan_create_v1',
  'copilot_plan_get_v1', 'copilot_plan_approve_v1', 'copilot_plan_execute_step_v1', 'copilot_plan_cancel_v1',
  'update_member_authorization_v1']);

/** Credentials are explicit in-memory arguments supplied by the reviewed operator.
 * No env/file login bootstrap, logger, retries or raw response persistence. */
export function createRoomPassTransport({ baseUrl, apikey, jwt, actorId, fetchImpl = fetch, verifyTerminal, readFlag }) {
  const base = new URL(baseUrl);
  requireThat(base.protocol === 'https:' && !base.username && !base.password && base.pathname === '/'
    && !base.search && !base.hash && UUID.test(actorId), 'transport_config_invalid');
  const headers = { apikey, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json',
    'Accept-Profile': 'public', 'Content-Profile': 'public', Prefer: 'return=representation' };
  async function send(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchImpl(new URL(path, base), { headers, ...init, signal: controller.signal });
      const text = await response.text();
      requireThat(text.length <= 1_000_000, 'response_too_large');
      return { status: response.status, body: text ? JSON.parse(text) : null };
    } catch { throw new Error('transport_unknown'); }
    finally { clearTimeout(timer); }
  }
  function context(ctx) { requireThat(ctx.organizationId === DEMO && ctx.actorId === actorId && UUID.test(ctx.runId), 'transport_scope_invalid'); }
  return {
    verifyTerminal,
    async readFlag(ctx) { context(ctx); requireThat(typeof readFlag === 'function', 'flag_read_adapter_required'); return readFlag(ctx); },
    async identity(ctx) {
      context(ctx);
      const user = await send('/auth/v1/user');
      const auth = await send('/rest/v1/rpc/get_authorization_context_v1', { method: 'POST', body: JSON.stringify({ p_organization_id: DEMO }) });
      return { actorId: user.body?.id, organizationId: auth.body?.organizationId,
        authenticated: user.status === 200 && auth.status === 200 && user.body?.id === actorId };
    },
    async request(ctx, request) {
      context(ctx);
      if (request.rpc) {
        requireThat(RPCS.has(request.rpc), 'rpc_not_allowed');
        if ('p_organization_id' in request.args) requireThat(request.args.p_organization_id === DEMO, 'rpc_scope_invalid');
        if (request.rpc === 'set_copilot_feature_flag_v2') requireThat(request.args.p_scope === 'action'
          && request.args.p_contract_id === ACTION && (request.args.p_state === 'disabled'
            ? request.args.p_canary_org === null && request.args.p_expires_at === null
            : request.args.p_canary_org === DEMO && Date.parse(request.args.p_expires_at) > Date.now()), 'flag_scope_invalid');
        return send(`/rest/v1/rpc/${request.rpc}`, { method: 'POST', body: JSON.stringify(request.args) });
      }
      requireThat(TABLES.has(request.table) && ['GET', 'POST', 'PATCH'].includes(request.method), 'table_not_allowed');
      requireThat((request.method === 'POST' ? request.body?.organization_id : request.filters?.organization_id) === DEMO, 'table_scope_invalid');
      if (request.method !== 'GET') requireThat(['buildings', 'rooms'].includes(request.table), 'direct_write_forbidden');
      const params = new URLSearchParams();
      if (request.select) params.set('select', request.select);
      for (const [key, value] of Object.entries(request.filters ?? {})) {
        requireThat(/^[a-z_]+$/.test(key) && (value === null || typeof value === 'string' || typeof value === 'boolean'), 'filter_invalid');
        params.set(key, value === null ? 'is.null' : `eq.${value}`);
      }
      return send(`/rest/v1/${request.table}?${params}`, { method: request.method,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
    },
  };
}

// Only the actual wrapper's bounded HTTP failure envelope is diagnostic evidence.
// A request/network error, raw text, truncated JSON or a code quoted in CONTEXT
// cannot establish that the SQL transaction ended with a known denial.
function managementDenial(error) {
  const raw = typeof error?.message === 'string' ? error.message : '';
  const envelope = /^Supabase database query failed \(([45][0-9]{2})\): ([\s\S]+)$/.exec(raw);
  if (!envelope || envelope[2].length >= 4000) return undefined;
  try {
    const body = JSON.parse(envelope[2]);
    if (!body || Array.isArray(body) || typeof body.message !== 'string') return undefined;
    const firstLine = body.message.split(/\r?\n/, 1)[0];
    const diagnostic = /^ERROR:[ \t]+(?:42501|P0002):[ \t]+([a-z_]+)[ \t]*$/.exec(firstLine);
    return diagnostic && DENIALS.includes(diagnostic[1]) ? diagnostic[1] : undefined;
  } catch { return undefined; }
}

/** Management transport is supplied by root (executeManagementQuery precedent).
 * It is used for separate authenticated transactions and exact administrative
 * fixtures. HTTP failure is unknown unless a recognizable server SQL error is
 * received; statement_timeout still bounds server transactions. */
export function createRoomPassManagementTransport({ executeManagementQuery, config }) {
  return {
    async query(sql) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 70_000);
      try {
        const raw = await executeManagementQuery(sql, config, (url, init) => fetch(url, { ...init, signal: controller.signal }));
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        requireThat(Array.isArray(rows), 'management_response_invalid');
        return rows;
      } catch (error) {
        const code = managementDenial(error);
        const safe = new Error(code ?? 'management_unknown');
        if (code) safe.response = { status: 403, body: { message: code } };
        throw safe;
      } finally { clearTimeout(timer); }
    },
  };
}
