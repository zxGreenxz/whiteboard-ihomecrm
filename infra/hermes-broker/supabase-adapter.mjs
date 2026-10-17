import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const deny = () => { throw new BrokerError('forbidden'); };
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read-only P1 adapter. All requests use the user's bearer and a publishable key.
 * Existing own-membership table RLS is not sufficient for ordinary users.
 * The strict scope RPC is therefore the membership authority, including revocation.
 * Only self-context plus the informational rooms.view bit are exposed; no business
 * rows, actions, passwords, refresh, arbitrary RPC names or service-role keys.
 */
export function createSupabaseAuthAdapter({ url, publishableKey, fetch: request = globalThis.fetch,
  clock = Date.now } = {}) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || typeof publishableKey !== 'string' || !publishableKey ||
      publishableKey.startsWith('sb_secret_')) throw new TypeError('invalid_supabase_configuration');
  if (publishableKey.split('.').length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url').toString());
      if (claims.role !== 'anon') throw new Error();
    } catch { throw new TypeError('publishable_key_required'); }
  } else if (!publishableKey.startsWith('sb_publishable_')) throw new TypeError('publishable_key_required');

  async function read(path, accessToken, signal, args) {
    const response = await request(new URL(path, origin), {
      method: args === undefined ? 'GET' : 'POST',
      headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
        ...(path.startsWith('/rest/') ? { 'content-profile': 'public', 'accept-profile': 'public' } : {}) },
      ...(args === undefined ? {} : { body: JSON.stringify(args) }), signal,
      redirect: 'error',
    });
    let data;
    try { data = await response.json(); } catch { throw new BrokerError('backend_unavailable'); }
    if (!response.ok) {
      if (response.status === 401) throw new BrokerError('unauthorized');
      if (response.status === 403 || data?.code === '42501') deny();
      throw new BrokerError('backend_unavailable');
    }
    return data;
  }
  // Private fixed-name calls. The caller/model never controls an RPC path or permission key.
  const membershipScope = (accessToken, organizationId, signal) => read(
    '/rest/v1/rpc/hermes_scope_buildings_v1', accessToken, signal,
    { p_permission_key: 'rooms.view', p_organization_id: organizationId });

  return Object.freeze({
    async verifySession({ accessToken, signal }) {
      const user = await read('/auth/v1/user', accessToken, signal);
      let claims;
      try { claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()); }
      catch { throw new BrokerError('unauthorized'); }
      // JWT claims are inspected ONLY after Auth validates the bearer. They are not
      // used as a substitute for current DB membership/permissions below.
      if (!object(user) || !UUID.test(user.id ?? '') || claims.sub !== user.id || claims.role !== 'authenticated' ||
          !UUID.test(claims.session_id ?? '') || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= clock()) {
        throw new BrokerError('unauthorized');
      }
      return { userId: user.id, sessionId: claims.session_id, expiresAt: claims.exp * 1000 };
    },
    async readAuthorization({ accessToken, userId, organizationId, signal }) {
      if (!UUID.test(userId ?? '') || !UUID.test(organizationId ?? '')) deny();
      // The three reads are independent bearer-bound snapshots; issue them in one
      // network wave. Results are still evaluated in the original order, so the
      // first failing step decides the error exactly as the sequential version.
      const settled = await Promise.allSettled([
        read('/rest/v1/rpc/get_authorization_context_v1', accessToken, signal, { p_organization_id: organizationId }),
        read('/rest/v1/rpc/get_my_organizations', accessToken, signal, {}),
        membershipScope(accessToken, organizationId, signal),
      ]);
      const value = item => { if (item.status === 'rejected') throw item.reason; return item.value; };
      const context = value(settled[0]), directory = value(settled[1]);
      if (!object(context) || context.organizationId !== organizationId || !UUID.test(context.membershipId ?? '') ||
          typeof context.isPlatformAdmin !== 'boolean' || context.isOffboarded !== false ||
          !object(context.permissions) || !object(directory) || directory.user_id !== userId ||
          !Array.isArray(directory.organizations)) deny();
      const selectedScope = value(settled[2]);
      if (!Array.isArray(selectedScope) || selectedScope.some((id) => !UUID.test(id))) deny();
      const candidates = [...new Set(directory.organizations.map((org) => org?.id))];
      if (candidates.some((id) => !UUID.test(id ?? ''))) deny();
      let activeOrganizationIds;
      if (context.isPlatformAdmin) {
        activeOrganizationIds = candidates;
      } else {
        // The directory includes stale ACTIVE memberships; probe candidates with
        // the strict membership gate instead of trusting directory visibility.
        if (candidates.length > 16) deny();
        const others = candidates.filter(candidate => candidate !== organizationId);
        const probes = await Promise.allSettled(others.map(candidate => membershipScope(accessToken, candidate, signal)));
        const admitted = new Set([organizationId].filter(candidate => candidates.includes(candidate)));
        probes.forEach((probe, index) => {
          if (probe.status === 'fulfilled') { admitted.add(others[index]); return; }
          if (!(probe.reason instanceof BrokerError) || probe.reason.code !== 'forbidden') throw probe.reason;
        });
        activeOrganizationIds = candidates.filter(candidate => admitted.has(candidate));
      }
      const readPermissions = ['assistant.context.read'];
      if (context.permissions['rooms.view'] === true && selectedScope.length > 0) readPermissions.push('rooms.view');
      return {
        userId, isSuperadmin: context.isPlatformAdmin, activeOrganizationIds,
        // This is a gate attestation, not invented membership timestamps: the
        // scope RPC just checked actual ACTIVE/revoked_at/valid_from/valid_to.
        membership: { organizationId, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null },
        epoch: fingerprint({ membershipId: context.membershipId, version: context.authorizationVersion,
          superadmin: context.isPlatformAdmin, scope: [...selectedScope].sort(), readPermissions,
          activeOrganizationIds: [...activeOrganizationIds].sort() }),
        permissions: { read: readPermissions, action: [] },
        // P1 fixed ceiling. It grants no action or business-data tool; P2 replaces
        // this with persisted company assistant policy checked on every request.
        companyCeilings: { read: ['assistant.context.read', 'rooms.view'], action: [] },
      };
    },
  });
}
