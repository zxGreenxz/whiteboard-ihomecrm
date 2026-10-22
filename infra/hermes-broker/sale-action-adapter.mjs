import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
import { SALE_ACTIONS, saleActionInput, saleActionResult, saleActionIsMutation, mayUseSaleAction } from './sale-action-contract.mjs';
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const keys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const fail = code => { throw new BrokerError(code); };
export function createSaleActionReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_sale_actions_v1', 'hermes_sale_capabilities_v1'] });
  return Object.freeze({ async capabilities({ accessToken, organizationId }, callOptions) {
    if (!domainId(organizationId)) fail('invalid_request');
    return rpc('hermes_sale_capabilities_v1', accessToken, { p_organization_id: organizationId }, callOptions, { optional: true });
  }, async execute(operation, value, callOptions) {
    if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, keys) || !domainId(value.binding.connectionId) ||
      !domainId(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
      ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(k => !positive(value.binding[k])) ||
      !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) fail('invalid_request');
    let input; try { input = saleActionInput(operation, value.input); } catch { fail('invalid_request'); }
    return rpc('hermes_sale_actions_v1', value.accessToken, { p_binding: value.binding, p_operation: operation, p_input: input },
      callOptions, { write: saleActionIsMutation(operation) });
  } });
}
export function createSaleActionAuth({ baseAuth, reads } = {}) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_sale_action_auth');
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const extended = await readWithBaseAuthorization(baseAuth, input,
      () => reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal }));
    const current = extended.current;
    if (SALE_ACTIONS.some(key => current.permissions.action.includes(key) || current.companyCeilings.action.includes(key))) fail('context_changed');
    const cap = extended.capability();
    if (cap === null) return current;
    if (!domainExact(cap, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']) ||
      cap.organizationId !== input.organizationId || cap.userId !== input.userId || cap.membershipId !== current.membership.membershipId ||
      cap.authorizationVersion !== current.membership.authorizationVersion || cap.isSuperadmin !== current.isSuperadmin ||
      !(cap.policyVersion === 0 || positive(cap.policyVersion)) || !domainExact(cap.permissions, SALE_ACTIONS)) fail('context_changed');
    const granted = [], ceilings = [], scopes = {};
    for (const key of SALE_ACTIONS) {
      const permission = cap.permissions[key];
      if (!domainExact(permission, ['allowed', 'companyEnabled', 'buildingIds']) || typeof permission.allowed !== 'boolean' || typeof permission.companyEnabled !== 'boolean' ||
        permission.allowed && !permission.companyEnabled || !Array.isArray(permission.buildingIds) || permission.buildingIds.length > 256 ||
        permission.buildingIds.some(id => !domainId(id)) || new Set(permission.buildingIds).size !== permission.buildingIds.length ||
        !permission.allowed && permission.buildingIds.length) fail('context_changed');
      if (permission.companyEnabled) ceilings.push(key);
      if (permission.allowed) { granted.push(key); scopes[key] = { buildingIds: [...permission.buildingIds], cashbookIds: [] }; }
    }
    return { ...current, permissions: { ...current.permissions, action: [...current.permissions.action, ...granted] },
      companyCeilings: { ...current.companyCeilings, action: [...current.companyCeilings.action, ...ceilings] },
      scopesByPermission: { ...current.scopesByPermission, ...scopes },
      epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, cap })).digest('hex') };
  } });
}
export function createSaleActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  const reads = createSaleActionReads({ ...supabase, dependencyScope, fetch });
  const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, mayUse: mayUseSaleAction,
    validateInput: saleActionInput, validateResult: saleActionResult, clock });
  return Object.freeze({ prepareSaleAction: service.prepare, finalizeSaleAction: service.finalize });
}
