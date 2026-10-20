import { createHash } from 'node:crypto';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createSupabaseDomainReads } from './domain-adapter.mjs';
import { CACHED_READ_OPERATIONS, domainExact, domainId, domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
import { createSupabaseDomainFastReads, domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';
import { createReadNameResolver, DIRECTORY_RPCS } from './read-name-resolution.mjs';
import { validateSessionMaterial } from './session-crypto.mjs';
import { BrokerError } from './broker.mjs';
const fail = code => { throw new BrokerError(code); };
const CONTEXT_PERMISSION = 'assistant.context.read';
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const ids = value => Array.isArray(value) && value.length <= 256 && value.every(domainId) && new Set(value).size === value.length;
const digest = value => createHash('sha256').update(value).digest('hex');
// crm_auth_context (B5d): tên công ty + danh bạ toà của phạm vi đọc rộng nhất, qua JWT người hỏi (RLS quyết định).
const contextInput = input => {
  if (!domainExact(input, ['organizationId', 'buildingIds', 'contextVersion']) || !domainId(input.organizationId) || !ids(input.buildingIds) ||
      typeof input.contextVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.contextVersion)) fail('invalid_request');
  return { organizationId: input.organizationId, buildingIds: [...input.buildingIds], contextVersion: input.contextVersion };
};
/** The broker has already resolved and will re-check this connection's identity for the very call; this port only opens
 * the bound session of the same token for its JWT (one store read) and reads the directory with it (one HTTP wave, both
 * RPCs under the asker's RLS, only the buildings the broker passed). null = directory RPC not deployed yet (PGRST202);
 * never an empty list standing in for "no buildings". */
function createContextDirectory({ connectionStore, crypto, resolver, clock }) {
  const issued = new WeakMap();
  const check = signal => { if (!(signal instanceof AbortSignal)) fail('invalid_request'); if (signal.aborted) fail('timeout'); };
  return Object.freeze({
    async prepareContext(token, suppliedInput, { signal } = {}) {
      check(signal);
      if (typeof token !== 'string' || !TOKEN.test(token)) fail('unauthorized');
      const input = contextInput(suppliedInput), tokenDigest = digest(token);
      const joined = await connectionStore.readConnection({ tokenDigest }, { signal }); check(signal);
      const c = joined?.connection, s = joined?.session;
      if (joined?.status !== 'active' || !c || !s || c.state !== 'active' || c.tokenDigest !== tokenDigest || c.organizationId !== input.organizationId ||
          s.credentialRef !== c.credentialRef || !domainExact(s.binding, ['assistantId', 'userId', 'organizationId', 'sessionId']) ||
          ['assistantId', 'userId', 'organizationId'].some(key => s.binding[key] !== c[key])) fail('context_changed');
      const material = validateSessionMaterial(crypto.open(s.envelope, s.binding)); material.refreshToken = undefined;
      if (material.expiresAt !== s.expiresAt || material.expiresAt <= clock() || c.expiresAt <= clock()) fail('unauthorized');
      const receipt = Object.freeze({});
      issued.set(receipt, { tokenDigest, accessToken: material.accessToken, expiresAt: material.expiresAt, input, deadline: clock() + 30000 });
      return receipt;
    },
    async finalizeContext(token, receipt, { signal } = {}) {
      check(signal);
      const value = issued.get(receipt); issued.delete(receipt);
      if (!value || typeof token !== 'string' || digest(token) !== value.tokenDigest) fail('context_changed');
      if (value.expiresAt <= clock()) fail('unauthorized');
      if (value.deadline <= clock()) fail('timeout');
      const { organizationId, buildingIds, contextVersion } = value.input, { accessToken, tokenDigest } = value;
      const [organizationName, buildings] = await Promise.all([
        resolver.organizationName({ accessToken, organizationId, tokenDigest, contextVersion, signal, optional: true }),
        buildingIds.length ? resolver.directory({ accessToken, organizationId, buildingIds, tokenDigest, contextVersion, label: CONTEXT_PERMISSION, signal, optional: true }) : []]);
      check(signal);
      return { organizationName, buildings: buildings === null ? null : structuredClone(buildings) };
    },
  });
}
export function createDomainMount({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now, readAuthority } = {}) {
  const reads = createSupabaseDomainReads({ ...supabase, dependencyScope, fetch });
  const resolver = createReadNameResolver({ rpc: createBoundUserRpcTransport({ ...supabase, dependencyScope, fetch, allowedNames: [...DIRECTORY_RPCS] }), clock });
  const resolveFor = lane => request => resolver.resolve({ ...request, lane });
  return Object.freeze({ authority, createService() {
    const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads,
      mayUse: mayUseDomain, validateInput: domainInput, validateResult: domainResult, clock, resolveInput: resolveFor('legacy') });
    const contextPort = createContextDirectory({ connectionStore, crypto, resolver, clock });
    if (!readAuthority) return Object.freeze({ prepareDomain: service.prepare, finalizeDomain: service.finalize, ...contextPort });
    const fast = createBoundUserOperationService({ authority: readAuthority, connectionStore, crypto, auth,
      reads: createSupabaseDomainFastReads({ ...supabase, dependencyScope, fetch }),
      mayUse: mayUseDomain, validateInput: domainInput, validateResult: domainFastResult, clock, admission: 'initialRead', resolveInput: resolveFor('fast') });
    // B2-2: the reviewed RPC and seven-key live binding of every other eligible domain, admitted through the
    // bounded read catalog; the SQL statement is the one live check. Domains whose key the read catalog cannot
    // grant (zalo_conversations) keep the full service, exactly as without the opt-in.
    const cached = createBoundUserOperationService({ authority: readAuthority, connectionStore, crypto, auth, reads,
      mayUse: mayUseDomain, validateInput: domainInput, validateResult: domainResult, clock, admission: 'cachedBinding', resolveInput: resolveFor('legacy') });
    const issued = new WeakMap();
    return Object.freeze({ readAuthority, fastReadOperations: FAST_READ_OPERATIONS, cachedReadOperations: CACHED_READ_OPERATIONS, ...contextPort,
      async prepareDomain(token, operation, input, options) {
        const selected = FAST_READ_OPERATIONS.includes(operation) ? fast : CACHED_READ_OPERATIONS.includes(operation) ? cached : service;
        const receipt = await selected.prepare(token, operation, input, options); issued.set(receipt, selected); return receipt;
      },
      async finalizeDomain(token, receipt, options) {
        const selected = issued.get(receipt); issued.delete(receipt);
        if (!selected) throw new TypeError('invalid_domain_receipt');
        return selected.finalize(token, receipt, options);
      } });
  } });
}
