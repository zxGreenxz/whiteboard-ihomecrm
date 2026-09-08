import type { Request, Route } from '@playwright/test';

type Proposal = { canonical: Record<string, unknown>; nonce: string };
type RequestShape = Pick<Request, 'url' | 'method' | 'postDataJSON'>;
const DEMO = 'dddd0000-0000-4000-8000-000000000001';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identityReads = new Set(['list_my_copilot_organizations_v1', 'is_org_owner_self_v1', 'is_company_owner_self_v1', 'get_copilot_action_policy_v1']);
const scopedReads = new Set(['get_authorization_context_v1', 'get_my_copilot_availability_v1']);
const keysOnly = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).every(key => keys.includes(key));

/** Fail closed for every mutating REST request, including new domain RPCs.
 * Only this test's fresh chat persistence and exact consent executor are writes.
 * Fallback composes with the earlier profile-model pin; continue would bypass it. */
export function createRoomPassBrowserGuard({ actorId, listingId, organizationId }: { actorId: string; listingId: string; organizationId: string }) {
  if (organizationId !== DEMO || !uuid.test(actorId) || !uuid.test(listingId)) throw new Error('browser_guard_scope_invalid');
  let clicked = false, writes = 0, illegalWrites = 0, acceptedExecutions = 0;
  let proposal: Proposal | undefined;
  const threads = new Set<string>();
  function threadCreation(req: RequestShape) {
    if (req.method() !== 'POST' || new URL(req.url()).pathname !== '/rest/v1/ai_chat_threads') return false;
    const data = req.postDataJSON();
    return data && !Array.isArray(data) && keysOnly(data, ['user_id', 'organization_id', 'title'])
      && data.user_id === actorId && data.organization_id === DEMO && typeof data.title === 'string';
  }
  return {
    counters: () => ({ writes, illegalWrites, acceptedExecutions }),
    click: () => { clicked = true; },
    setProposal: (value: Proposal) => { proposal = value; },
    observeThread(req: RequestShape, body: { id?: unknown }) {
      if (threadCreation(req) && typeof body.id === 'string' && uuid.test(body.id)) threads.add(body.id);
    },
    async route(route: Pick<Route, 'request' | 'fallback' | 'abort'>) {
      const req = route.request(), method = req.method(), url = new URL(req.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.fallback();
      let safe = false, execute = false;
      try {
        const data = req.postDataJSON(), rpc = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.slice('/rest/v1/rpc/'.length) : '';
        if (method === 'POST' && data && !Array.isArray(data)) {
          if (identityReads.has(rpc)) safe = Object.keys(data).length === 0;
          if (scopedReads.has(rpc)) safe = data.p_organization_id === DEMO && keysOnly(data, ['p_organization_id']);
          if (rpc === 'copilot_preview_room_pass_active_v1') safe = data.p_organization_id === DEMO
            && data.p_payload?.listing_id === listingId && data.p_payload?.active === true
            && keysOnly(data, ['p_organization_id', 'p_payload']) && keysOnly(data.p_payload, ['listing_id', 'active']);
          if (threadCreation(req)) safe = true;
          if (rpc === 'copilot_execute_room_pass_active_v1') execute = clicked && acceptedExecutions === 0 && Boolean(proposal)
            && data.p_payload?.organization_id === DEMO && data.p_payload?.listing_id === listingId && data.p_payload?.active === true
            && JSON.stringify(data.p_payload) === JSON.stringify(proposal?.canonical)
            && data.p_confirmation_nonce === proposal?.nonce && keysOnly(data, ['p_payload', 'p_confirmation_nonce']);
        }
        if (method === 'POST' && url.pathname === '/rest/v1/ai_chat_messages' && Array.isArray(data) && data.length > 0) {
          safe = data.every(row => row && row.user_id === actorId && row.organization_id === DEMO && threads.has(row.thread_id)
            && ['user', 'assistant', 'tool', 'system'].includes(row.role)
            && keysOnly(row, ['thread_id', 'user_id', 'organization_id', 'role', 'content', 'tool_calls', 'tool_call_id', 'model']));
        }
      } catch { /* malformed body is an unexpected write */ }
      if (safe) return route.fallback();
      writes += 1;
      if (execute) { acceptedExecutions += 1; return route.fallback(); }
      illegalWrites += 1; return route.abort();
    },
  };
}
