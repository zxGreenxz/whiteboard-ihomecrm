import { DEMO } from './copilot-g1-acceptance.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keysOnly = (row, keys) => row && !Array.isArray(row) && typeof row === 'object' && Object.keys(row).every(k => keys.includes(k));
// Reviewed read RPC signatures. Never infer safety from get/list/copilot names.
// Sources and intentionally unsupported route reads are documented in the runbook.
export const G1_READ_RPCS = {
  get_my_permissions: [], is_super_admin: [], business_performance_organizations_v1: [],
  list_my_copilot_organizations_v1: [], is_org_owner_self_v1: [], is_company_owner_self_v1: [], get_copilot_action_policy_v1: [],
  get_my_context: [], get_my_assignments: [], is_admin: [], my_org_ids: [],
  get_authorization_context_v1: ['p_organization_id'], get_my_copilot_availability_v1: ['p_organization_id'], copilot_memory_list_v1: ['p_organization_id'],
  get_dashboard_summary: ['p_building_id'], get_contract_stats: ['p_building_ids', 'p_today', 'p_in30'],
  get_income_expense_layer_stats: ['p_building_ids', 'p_room_ids', 'p_account_id', 'p_type', 'p_start_date', 'p_end_date', 'p_approval', 'p_creator_id', 'p_amount', 'p_amount_tol', 'p_verified', 'p_item_type_ids', 'p_voucher_ids', 'p_sources', 'p_source_manual', 'p_internal_sources', 'p_kqkd_only', 'p_posting'],
  get_invoice_statistics_v2: ['p_building_id', 'p_room_id', 'p_status', 'p_start_date', 'p_end_date', 'p_billing_month', 'p_payment_status', 'p_building_ids'],
  invoice_active_payment_methods: ['p_invoice_ids'], revenue_by_month: ['p_start', 'p_end', 'p_building_id'],
  get_customer_stats: ['p_status', 'p_search', 'p_building_id', 'p_room_id'],
  get_reservation_deposit_summary: ['p_building_ids'], get_held_deposit_summary: ['p_building_ids', 'p_threshold'], get_refund_forfeit_summary: ['p_building_ids'],
  get_meter_reading_stats: ['p_building_id', 'p_month'], get_meters_without_readings_v2: ['p_building_id', 'p_room_id', 'p_meter_type', 'p_month'],
  ie_form_buildings: [], get_acceptance_geofence_config: [], list_my_cashbook_access_v2: [], list_cashbook_visibility_v2: [], get_finance_v2_client_flags_v1: [],
  zalo_get_crm_summary: ['p_conversation_id'],
};
// Serialized by Playwright; use browser globals only, with no module closure.
// Reuse the application's existing local throttles to defer unrelated writers.
export function initializeG1Browser({ actorId, organizationId }) {
  localStorage.setItem('ihomecrm.selectedOrganizationId', organizationId);
  localStorage.setItem(`schedNotif:lastRun:${actorId}`, String(Date.now()));
  sessionStorage.setItem('invoices:overdue-checked-at', String(Date.now()));
}
export function createG1Guard({ actorId, organizationId, supabaseOrigin, baseUrl }) {
  if (organizationId !== DEMO || !uuid.test(actorId)) throw new Error('g1_guard_identity_invalid');
  const threads = new Set();
  let chatWrites = 0;
  const blocked = [];
  function threadCreation(r) {
    return r.method === 'POST' && new URL(r.url).origin === supabaseOrigin && new URL(r.url).pathname === '/rest/v1/ai_chat_threads'
      && keysOnly(r.body, ['user_id', 'organization_id', 'title']) && r.body.user_id === actorId && r.body.organization_id === DEMO && typeof r.body.title === 'string';
  }
  function safe(r) {
    const u = new URL(r.url), method = r.method, data = r.body;
    if (u.origin !== supabaseOrigin) return u.origin === baseUrl && ['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (method === 'OPTIONS') return true;
    if (u.pathname.startsWith('/auth/v1/')) return ['GET', 'HEAD'].includes(method)
      || (method === 'POST' && u.pathname === '/auth/v1/token' && ['password', 'refresh_token'].includes(u.searchParams.get('grant_type')));
    if (u.pathname === '/functions/v1/llm-proxy') return method === 'POST' && r.headers?.['x-organization-id'] === DEMO;
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(u.pathname)?.[1];
    if (rpc) {
      if (method !== 'POST' || !Object.hasOwn(G1_READ_RPCS, rpc) || !keysOnly(data, G1_READ_RPCS[rpc])) return false;
      return !G1_READ_RPCS[rpc].includes('p_organization_id') || data.p_organization_id === DEMO;
    }
    if (/^\/rest\/v1\/[a-z0-9_]+$/.test(u.pathname) && ['GET', 'HEAD'].includes(method)) return true;
    if (threadCreation(r)) { chatWrites += 1; return true; }
    if (method === 'POST' && u.pathname === '/rest/v1/ai_chat_messages' && Array.isArray(data) && data.length > 0
      && data.every(row => keysOnly(row, ['thread_id', 'user_id', 'organization_id', 'role', 'content', 'tool_calls', 'tool_call_id', 'model'])
        && row.user_id === actorId && row.organization_id === DEMO && threads.has(row.thread_id)
        && ['user', 'assistant', 'tool', 'system'].includes(row.role))) { chatWrites += 1; return true; }
    return false;
  }
  return {
    allow(r) { const ok = safe(r); if (!ok) blocked.push(`${r.method} ${new URL(r.url).pathname}`); return ok; },
    observeThread(r, body, status) { if (status >= 200 && status < 300 && threadCreation(r) && uuid.test(body?.id)) threads.add(body.id); },
    counters: () => ({ chatWrites, blockedWrites: blocked.length, blocked: [...new Set(blocked)], ownedThreadIds: [...threads] }),
  };
}
