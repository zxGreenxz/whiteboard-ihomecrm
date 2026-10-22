import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
import { salePolicyInput, salePolicyResult, mayUseSalePolicy } from './sale-policy-contract.mjs';
const key = 'sale_phong.edit', positive = v => Number.isSafeInteger(v) && v > 0;
const fail = code => { throw new BrokerError(code); };
const bindingKeys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
export function createSalePolicyReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_sale_policy_capabilities_v1', 'hermes_sale_policy_actions_v1'] });
  return { capabilities: ({ accessToken, organizationId }, callOptions) => rpc('hermes_sale_policy_capabilities_v1', accessToken,
    { p_organization_id: organizationId }, callOptions, { optional: true }),
  execute(operation, value, callOptions) {
    if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, bindingKeys) ||
        !domainId(value.binding.connectionId) || !domainId(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
        ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(k => !positive(value.binding[k])) ||
        !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) fail('invalid_request');
    let input; try { input = salePolicyInput(operation, value.input); } catch { fail('invalid_request'); }
    return rpc('hermes_sale_policy_actions_v1', value.accessToken, { p_binding: value.binding, p_operation: operation, p_input: input },
      callOptions, { write: ['save', 'cancel'].includes(operation) });
  } };
}
export function createSalePolicyAuth({ baseAuth, reads }) {
  return { verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const extended = await readWithBaseAuthorization(baseAuth, input, () => reads.capabilities(input, { signal: input.signal }));
    const current = extended.current, cap = extended.capability();
    if (current.permissions.action.includes(key) || current.companyCeilings.action.includes(key)) fail('context_changed');
    if (cap === null) return current;
    if (!domainExact(cap, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']) ||
        cap.organizationId !== input.organizationId || cap.userId !== input.userId || cap.membershipId !== current.membership.membershipId ||
        cap.authorizationVersion !== current.membership.authorizationVersion || cap.isSuperadmin !== current.isSuperadmin ||
        !(cap.policyVersion === 0 || positive(cap.policyVersion)) || !domainExact(cap.permissions, [key])) fail('context_changed');
    const p = cap.permissions[key];
    if (!domainExact(p, ['allowed', 'companyEnabled', 'buildingIds']) || typeof p.allowed !== 'boolean' || typeof p.companyEnabled !== 'boolean' ||
        p.allowed && !p.companyEnabled || !Array.isArray(p.buildingIds) || p.buildingIds.length > 256 || p.buildingIds.some(id => !domainId(id)) ||
        new Set(p.buildingIds).size !== p.buildingIds.length || !p.allowed && p.buildingIds.length) fail('context_changed');
    return { ...current, permissions: { ...current.permissions, action: [...current.permissions.action, ...(p.allowed ? [key] : [])] },
      companyCeilings: { ...current.companyCeilings, action: [...current.companyCeilings.action, ...(p.companyEnabled ? [key] : [])] },
      scopesByPermission: { ...current.scopesByPermission, ...(p.allowed ? { [key]: { buildingIds: [...p.buildingIds], cashbookIds: [] } } : {}) },
      epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, cap })).digest('hex') };
  } };
}
export function createSalePolicyService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now }) {
  const reads = createSalePolicyReads({ ...supabase, dependencyScope, fetch });
  const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads,
    mayUse: mayUseSalePolicy, validateInput: salePolicyInput, validateResult: salePolicyResult, clock });
  return Object.freeze({ prepareSalePolicy: service.prepare, finalizeSalePolicy: service.finalize });
}
