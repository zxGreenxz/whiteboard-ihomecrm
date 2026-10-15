import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
import { CUSTOMER_ACTIONS, customerActionKind, customerActionInput, customerActionResult, mayUseCustomerAction } from './customer-action-contract.mjs';
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const keys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
export function createCustomerActionReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_customer_create_action_v1', 'hermes_customer_create_capabilities_v1'] });
  return Object.freeze({ async capabilities({ accessToken, organizationId }, callOptions) {
    if (!domainId(organizationId)) throw new BrokerError('invalid_request');
    return rpc('hermes_customer_create_capabilities_v1', accessToken, { p_organization_id: organizationId }, callOptions, { optional: true });
  }, async execute(operation, value, callOptions) {
    if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, keys) || !domainId(value.binding.connectionId) ||
      !domainId(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
      ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
      !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) throw new BrokerError('invalid_request');
    let input; try { input = customerActionInput(operation, value.input); } catch { throw new BrokerError('invalid_request'); }
    return rpc('hermes_customer_create_action_v1', value.accessToken, { p_binding: value.binding, p_kind: customerActionKind(operation),
      p_operation: operation.split('.')[1], p_input: input }, callOptions, { write: operation.endsWith('.create') });
  } });
}
export function createCustomerActionAuth({ baseAuth, reads }) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_customer_action_auth');
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const extended = await readWithBaseAuthorization(baseAuth, input,
      () => reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal }));
    const current = extended.current;
    if (CUSTOMER_ACTIONS.some(key => current.permissions.action.includes(key) || current.companyCeilings.action.includes(key))) throw new BrokerError('context_changed');
    const cap = extended.capability(); if (cap === null) return current;
    if (!domainExact(cap, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']) ||
      cap.organizationId !== input.organizationId || cap.userId !== input.userId || cap.membershipId !== current.membership.membershipId ||
      cap.authorizationVersion !== current.membership.authorizationVersion || cap.isSuperadmin !== current.isSuperadmin ||
      !(cap.policyVersion === 0 || positive(cap.policyVersion)) || !domainExact(cap.permissions, CUSTOMER_ACTIONS)) throw new BrokerError('context_changed');
    const granted = [], ceilings = [], scopes = {};
    for (const key of CUSTOMER_ACTIONS) {
      const permission = cap.permissions[key];
      if (!domainExact(permission, ['allowed', 'companyEnabled']) || typeof permission.allowed !== 'boolean' || typeof permission.companyEnabled !== 'boolean' ||
        permission.allowed && !permission.companyEnabled) throw new BrokerError('context_changed');
      if (permission.companyEnabled) ceilings.push(key);
      if (permission.allowed) { granted.push(key); scopes[key] = { buildingIds: [], cashbookIds: [] }; }
    }
    return { ...current, permissions: { ...current.permissions, action: [...current.permissions.action, ...granted] },
      companyCeilings: { ...current.companyCeilings, action: [...current.companyCeilings.action, ...ceilings] },
      scopesByPermission: { ...current.scopesByPermission, ...scopes }, epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, cap })).digest('hex') };
  } });
}
export function createCustomerActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  const reads = createCustomerActionReads({ ...supabase, dependencyScope, fetch });
  const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, mayUse: mayUseCustomerAction,
    validateInput: customerActionInput, validateResult: customerActionResult, clock });
  return Object.freeze({ prepareCustomerAction: service.prepare, finalizeCustomerAction: service.finalize });
}
