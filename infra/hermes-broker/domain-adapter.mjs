import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { DOMAIN_READ_CAPABILITIES, domainId, domainExact, domainInput } from './domain-contract.mjs';
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new BrokerError(code); };
const bindingKeys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
export function createSupabaseDomainReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_domain_read_v1', 'hermes_domain_capabilities_v1'] });
  return Object.freeze({
    async capabilities({ accessToken, organizationId }, callOptions) {
      if (!domainId(organizationId)) fail('invalid_request');
      return rpc('hermes_domain_capabilities_v1', accessToken, { p_organization_id: organizationId }, callOptions, { optional: true });
    },
    async execute(operation, value, callOptions) {
      if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, bindingKeys) ||
          !domainId(value.binding.connectionId) || !domainId(value.binding.expectedMembershipId) ||
          !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
          ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
          !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) fail('invalid_request');
      let input; try { input = domainInput(operation, value.input); } catch { fail('invalid_request'); }
      return rpc('hermes_domain_read_v1', value.accessToken, { p_binding: value.binding, p_domain: operation, p_input: input }, callOptions);
    },
  });
}
export function createDomainAuthAdapter({ baseAuth, reads } = {}) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_domain_auth');
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const current = await baseAuth.readAuthorization(input);
    if (DOMAIN_READ_CAPABILITIES.some(key => current.permissions.read.includes(key) || current.companyCeilings.read.includes(key))) fail('context_changed');
    const capabilities = await reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal });
    if (capabilities === null) return current;
    if (!domainExact(capabilities, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']) ||
        capabilities.organizationId !== input.organizationId || capabilities.userId !== input.userId ||
        capabilities.membershipId !== current.membership.membershipId || capabilities.authorizationVersion !== current.membership.authorizationVersion ||
        capabilities.isSuperadmin !== current.isSuperadmin || !(capabilities.policyVersion === 0 || positive(capabilities.policyVersion)) ||
        !domainExact(capabilities.permissions, DOMAIN_READ_CAPABILITIES)) fail('context_changed');
    const granted = [], ceilings = [], scopes = {};
    for (const key of DOMAIN_READ_CAPABILITIES) {
      const cap = capabilities.permissions[key];
      if (!domainExact(cap, ['allowed', 'companyEnabled', 'buildingIds']) || typeof cap.allowed !== 'boolean' || typeof cap.companyEnabled !== 'boolean' ||
          cap.allowed && !cap.companyEnabled || !Array.isArray(cap.buildingIds) || cap.buildingIds.length > 256 ||
          cap.buildingIds.some(id => !domainId(id)) || new Set(cap.buildingIds).size !== cap.buildingIds.length || !cap.allowed && cap.buildingIds.length) fail('context_changed');
      if (cap.companyEnabled) ceilings.push(key);
      if (cap.allowed) { granted.push(key); scopes[key] = { buildingIds: [...cap.buildingIds], cashbookIds: [] }; }
    }
    return { ...current, permissions: { ...current.permissions, read: [...current.permissions.read, ...granted] },
      companyCeilings: { ...current.companyCeilings, read: [...current.companyCeilings.read, ...ceilings] },
      scopesByPermission: { ...current.scopesByPermission, ...scopes },
      epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, capabilities })).digest('hex') };
  } });
}
