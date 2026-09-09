import { DEMO, digest } from './copilot-g1-acceptance.mjs';
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
  can_flex_cancel_v1: ['p_ids'], can_cancel_income_voucher_v1: ['p_ids'], list_cashbook_closings_v1: ['p_cashbook'],
};
// Only buckets rendered by the canonical route/list and shared layout. Dialog-only
// meter/job attachments and all upload/list/delete endpoints remain unadmitted.
const STORAGE_READ_BUCKETS = new Set(['income-expense-attachments', 'payment-receipts', 'avatars', 'zalo-media']);
const mediaResource = r => ['image', 'media'].includes(r.resourceType);
const zaloCdn = u => u.protocol === 'https:' && !u.port && /^(?:[a-z0-9-]+\.)+zdn\.vn$/.test(u.hostname);
function objectPath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 1024) return false;
  // Reject traversal hidden by URL encoding as well as raw traversal. These are
  // existing object keys, never absolute URLs or server endpoint overrides.
  let decoded; try { decoded = decodeURIComponent(value); } catch { return false; }
  return !/[\u0000-\u001f\u007f\\:%?#]/.test(decoded)
    && decoded.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}
export function safeG1RequestEndpoint(request) {
  const u = new URL(request.url);
  if (u.pathname.startsWith('/storage/v1/')) {
    const bucket = /^\/storage\/v1\/object\/(?:upload\/sign|sign|public|authenticated|list)\/([a-z0-9-]+)(?:\/|$)/.exec(u.pathname);
    return `${request.method} ${u.origin}${bucket ? bucket[0].replace(/\/$/, '') : '/storage/v1'}`;
  }
  return `${request.method} ${u.origin}${zaloCdn(u) ? '' : u.pathname}`;
}
// Serialized by Playwright; use browser globals only, with no module closure.
// Reuse the application's existing local throttles to defer unrelated writers.
export function initializeG1Browser({ actorId, organizationId }) {
  localStorage.setItem('ihomecrm.selectedOrganizationId', organizationId);
  localStorage.setItem(`schedNotif:lastRun:${actorId}`, String(Date.now()));
  sessionStorage.setItem('invoices:overdue-checked-at', String(Date.now()));
}
const NET_FAILURE_CODES = new Set(['net::ERR_ABORTED', 'net::ERR_FAILED', 'net::ERR_TIMED_OUT',
  'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_ABORTED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NETWORK_CHANGED', 'net::ERR_HTTP2_PROTOCOL_ERROR', 'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_BLOCKED_BY_RESPONSE', 'net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID',
  'net::ERR_SSL_PROTOCOL_ERROR', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_ADDRESS_UNREACHABLE']);
export function safeG1RequestFailure(request, errorText) {
  return `${safeG1RequestEndpoint(request)} ${NET_FAILURE_CODES.has(errorText) ? errorText : 'g1_network_failure_unknown'}`;
}
function validNumericContentRange(value) {
  const match = typeof value === 'string' && /^(\*|(\d+)-(\d+))\/(\d+)$/.exec(value);
  if (!match) return false;
  const total = Number(match[4]);
  if (!Number.isSafeInteger(total) || total < 0) return false;
  if (match[1] === '*') return true;
  const first = Number(match[2]), last = Number(match[3]);
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last && last < total;
}
export function createG1Guard({ actorId, organizationId, supabaseOrigin, baseUrl }) {
  if (organizationId !== DEMO || !uuid.test(actorId)) throw new Error('g1_guard_identity_invalid');
  const threads = new Set();
  const pendingChatWrites = new Set();
  const headCounts = new Map(), headerCompleteCountReads = [];
  let headRequestOrdinal = 0;
  let chatWrites = 0;
  const blocked = [];
  function threadCreation(r) {
    return r.method === 'POST' && new URL(r.url).origin === supabaseOrigin && new URL(r.url).pathname === '/rest/v1/ai_chat_threads'
      && keysOnly(r.body, ['user_id', 'organization_id', 'title']) && r.body.user_id === actorId && r.body.organization_id === DEMO && typeof r.body.title === 'string';
  }
  function safe(r) {
    const u = new URL(r.url), method = r.method, data = r.body;
    if (u.origin !== supabaseOrigin) {
      // CSP and useSignedMediaUrl/ZaloAvatar admit this CDN for rendered media;
      // arbitrary fetches, scripts, documents and other methods remain blocked.
      if (zaloCdn(u)) return method === 'GET' && mediaResource(r);
      // index.html's four font families and ollama.ts's local discovery endpoint.
      // No completion/model-management endpoint on localhost is admitted.
      const readEndpoint = (u.origin === 'https://fonts.googleapis.com' && u.pathname === '/css2')
        || (u.origin === 'https://fonts.gstatic.com' && /^\/s\/(baloo2|bevietnampro|lora|spacemono)\/v\d+\/[A-Za-z0-9_-]+\.(woff2|woff|ttf)$/.test(u.pathname))
        || (u.origin === 'http://localhost:11434' && u.pathname === '/api/tags');
      if (readEndpoint) return method === 'GET'
        || (method === 'OPTIONS' && r.headers?.['access-control-request-method'] === 'GET');
      return u.origin === baseUrl && ['GET', 'HEAD', 'OPTIONS'].includes(method);
    }
    if (method === 'OPTIONS') return true;
    if (u.pathname.startsWith('/auth/v1/')) return ['GET', 'HEAD'].includes(method)
      || (method === 'POST' && u.pathname === '/auth/v1/token' && ['password', 'refresh_token'].includes(u.searchParams.get('grant_type')));
    if (u.pathname === '/functions/v1/llm-proxy/chat/completions') return method === 'POST' && r.headers?.['x-organization-id'] === DEMO;
    const storageSign = /^\/storage\/v1\/object\/sign\/([a-z0-9-]+)$/.exec(u.pathname);
    if (storageSign) return method === 'POST' && STORAGE_READ_BUCKETS.has(storageSign[1])
      && keysOnly(data, ['expiresIn', 'paths']) && data.expiresIn === 3600
      && Array.isArray(data.paths) && data.paths.length > 0 && data.paths.length <= 100 && data.paths.every(objectPath);
    const storageObject = /^\/storage\/v1\/object\/(?:sign|public)\/([a-z0-9-]+)\/(.+)$/.exec(u.pathname);
    if (storageObject) return method === 'GET' && mediaResource(r) && STORAGE_READ_BUCKETS.has(storageObject[1]) && objectPath(storageObject[2]);
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(u.pathname)?.[1];
    if (rpc) {
      if (method !== 'POST' || !Object.hasOwn(G1_READ_RPCS, rpc) || !keysOnly(data, G1_READ_RPCS[rpc])) return false;
      if (['can_flex_cancel_v1', 'can_cancel_income_voucher_v1'].includes(rpc))
        return Array.isArray(data.p_ids) && data.p_ids.length > 0 && data.p_ids.length <= 20 && data.p_ids.every(id => typeof id === 'string' && uuid.test(id));
      if (rpc === 'list_cashbook_closings_v1') return data.p_cashbook == null || (typeof data.p_cashbook === 'string' && uuid.test(data.p_cashbook));
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
    allow(r, requestKey) {
      const ok = safe(r), u = new URL(r.url);
      if (!ok) blocked.push(safeG1RequestEndpoint(r));
      else if (requestKey !== undefined && u.origin === supabaseOrigin && r.method === 'POST'
        && ['/rest/v1/ai_chat_threads', '/rest/v1/ai_chat_messages'].includes(u.pathname)) pendingChatWrites.add(requestKey);
      if (ok && requestKey !== undefined && u.origin === supabaseOrigin && r.method === 'HEAD'
        && /^\/rest\/v1\/[a-z0-9_]+$/.test(u.pathname)
        && typeof r.headers?.prefer === 'string' && r.headers.prefer.split(',').some(v => v.trim() === 'count=exact'))
        headCounts.set(requestKey, { requestOrdinal: ++headRequestOrdinal, method: 'HEAD', origin: u.origin, pathname: u.pathname });
      return ok;
    },
    finished(requestKey) { pendingChatWrites.delete(requestKey); headCounts.delete(requestKey); },
    observeHeadCount(requestKey, status, contentRange) {
      const read = headCounts.get(requestKey);
      if (!read) return;
      // An HTTP HEAD count payload is entirely in these successful headers.
      // Same Request identity is required; a later request cannot repair it.
      read.contentRangeDigest = status === 200 && validNumericContentRange(contentRange) ? digest(contentRange) : undefined;
    },
    classifyHeadCountAbort(requestKey, code) {
      const read = headCounts.get(requestKey);
      if (code !== 'net::ERR_ABORTED' || !read?.contentRangeDigest) return false;
      headerCompleteCountReads.push({ ...read, status: 200, code });
      headCounts.delete(requestKey);
      return true;
    },
    observeThread(r, body, status) { if (status >= 200 && status < 300 && threadCreation(r) && uuid.test(body?.id)) threads.add(body.id); },
    counters: () => ({ chatWrites, pendingChatWrites: pendingChatWrites.size, blockedWrites: blocked.length, blocked: [...new Set(blocked)], ownedThreadIds: [...threads],
      headerCompleteCountReadAborts: headerCompleteCountReads.length, headerCompleteCountReads: headerCompleteCountReads.map(r => ({ ...r })) }),
  };
}
