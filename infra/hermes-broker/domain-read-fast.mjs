import { BrokerError } from './broker.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { domainExact, domainId, domainInput, domainResult, DOMAIN_READS, FAST_READ_OPERATIONS } from './domain-contract.mjs';

// The allowlist lives in the contract (broker.mjs imports it without a cycle).
export { FAST_READ_OPERATIONS };
const fail = code => { throw new BrokerError(code); };
const ids = value => Array.isArray(value) && value.length <= 256 && value.every(domainId) && new Set(value).size === value.length;
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
export function createSupabaseDomainFastReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_domain_read_fast_v1'] });
  return Object.freeze({ async execute(operation, value, callOptions) {
    const binding = value?.binding;
    if (!FAST_READ_OPERATIONS.includes(operation) || !domainExact(value, ['accessToken', 'binding', 'input']) ||
        !domainExact(binding, ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedSessionRevision']) ||
        !domainId(binding.connectionId) || !/^[a-f0-9]{64}$/.test(binding.tokenDigest) ||
        !positive(binding.expectedEpoch) || !positive(binding.expectedSessionRevision)) fail('invalid_request');
    let input; try { input = domainInput(operation, value.input); } catch { fail('invalid_request'); }
    return rpc('hermes_domain_read_fast_v1', value.accessToken, { p_binding: binding, p_domain: operation, p_input: input }, callOptions);
  } });
}

/** Scope comes from this same business statement, never the discovery cache. */
export function domainFastResult(operation, envelope, identity, input) {
  if (!FAST_READ_OPERATIONS.includes(operation) || !domainExact(envelope, ['authority', 'result'])) fail('backend_unavailable');
  const live = envelope.authority, permission = DOMAIN_READS[operation].permission;
  if (!domainExact(live, ['organizationId', 'userId', 'connectionId', 'permission', 'buildingIds', 'cashbookIds']) ||
      live.organizationId !== identity.row.organizationId || live.userId !== identity.row.userId || live.connectionId !== identity.row.id ||
      live.permission !== permission || !ids(live.buildingIds) || !ids(live.cashbookIds) || live.cashbookIds.length) fail('backend_unavailable');
  return domainResult(operation, envelope.result, { ...identity,
    scopesByPermission: { [permission]: { buildingIds: live.buildingIds, cashbookIds: live.cashbookIds } } }, input);
}
