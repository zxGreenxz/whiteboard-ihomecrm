import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
import { DOMAIN_FAMILIES, ALL_DOMAIN_READ_CAPABILITIES, domainFamily, domainId, domainExact, domainInput } from './domain-contract.mjs';
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new BrokerError(code); };
const bindingKeys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const FAMILY_NAMES = Object.freeze(Object.keys(DOMAIN_FAMILIES));
export function createSupabaseDomainReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: Object.values(DOMAIN_FAMILIES).flatMap(family => [family.readRpc, family.capabilitiesRpc]) });
  return Object.freeze({
    // One fixed capability RPC per reviewed SQL family. A family not yet
    // deployed (PGRST202) is null: its tools stay unavailable, others continue.
    async capabilities({ accessToken, organizationId }, callOptions) {
      if (!domainId(organizationId)) fail('invalid_request');
      // Independent fixed reads: one network wave. The first failing family in
      // catalog order decides the error, exactly as the sequential loop did.
      const settled = await Promise.allSettled(FAMILY_NAMES.map(name =>
        rpc(DOMAIN_FAMILIES[name].capabilitiesRpc, accessToken, { p_organization_id: organizationId }, callOptions, { optional: true })));
      const result = {};
      FAMILY_NAMES.forEach((name, index) => {
        if (settled[index].status === 'rejected') throw settled[index].reason;
        result[name] = settled[index].value;
      });
      return result;
    },
    async execute(operation, value, callOptions) {
      if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, bindingKeys) ||
          !domainId(value.binding.connectionId) || !domainId(value.binding.expectedMembershipId) ||
          !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
          ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
          !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) fail('invalid_request');
      let input; try { input = domainInput(operation, value.input); } catch { fail('invalid_request'); }
      return rpc(domainFamily(operation).readRpc, value.accessToken, { p_binding: value.binding, p_domain: operation, p_input: input }, callOptions);
    },
  });
}
export function createDomainAuthAdapter({ baseAuth, reads } = {}) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_domain_auth');
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const { current, capability } = await readWithBaseAuthorization(baseAuth, input,
      () => reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal }));
    if (ALL_DOMAIN_READ_CAPABILITIES.some(key => current.permissions.read.includes(key) || current.companyCeilings.read.includes(key))) fail('context_changed');
    const families = capability();
    if (!domainExact(families, FAMILY_NAMES)) fail('context_changed');
    if (FAMILY_NAMES.every(name => families[name] === null)) return current;
    const granted = [], ceilings = [], scopes = {};
    for (const name of FAMILY_NAMES) {
      const capabilities = families[name], keys = DOMAIN_FAMILIES[name].capabilities;
      if (capabilities === null) continue;
      if (!domainExact(capabilities, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']) ||
          capabilities.organizationId !== input.organizationId || capabilities.userId !== input.userId ||
          capabilities.membershipId !== current.membership.membershipId || capabilities.authorizationVersion !== current.membership.authorizationVersion ||
          capabilities.isSuperadmin !== current.isSuperadmin || !(capabilities.policyVersion === 0 || positive(capabilities.policyVersion)) ||
          !domainExact(capabilities.permissions, keys)) fail('context_changed');
      for (const key of keys) {
        const cap = capabilities.permissions[key];
        if (!domainExact(cap, ['allowed', 'companyEnabled', 'buildingIds']) || typeof cap.allowed !== 'boolean' || typeof cap.companyEnabled !== 'boolean' ||
            cap.allowed && !cap.companyEnabled || !Array.isArray(cap.buildingIds) || cap.buildingIds.length > 256 ||
            cap.buildingIds.some(id => !domainId(id)) || new Set(cap.buildingIds).size !== cap.buildingIds.length || !cap.allowed && cap.buildingIds.length) fail('context_changed');
        if (cap.companyEnabled) ceilings.push(key);
        if (cap.allowed) { granted.push(key); scopes[key] = { buildingIds: [...cap.buildingIds], cashbookIds: [] }; }
      }
    }
    // Families are separate snapshots; a policy change between them is a race.
    const versions = new Set(FAMILY_NAMES.filter(name => families[name] !== null).map(name => families[name].policyVersion));
    if (versions.size !== 1) fail('context_changed');
    return { ...current, permissions: { ...current.permissions, read: [...current.permissions.read, ...granted] },
      companyCeilings: { ...current.companyCeilings, read: [...current.companyCeilings.read, ...ceilings] },
      scopesByPermission: { ...current.scopesByPermission, ...scopes },
      epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, capabilities: families })).digest('hex') };
  } });
}
