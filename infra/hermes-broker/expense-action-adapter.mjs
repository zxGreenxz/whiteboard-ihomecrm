import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
import { EXPENSE_ACTIONS, expenseActionInput, expenseActionResult, expenseSqlOperation, mayUseExpenseAction } from './expense-action-contract.mjs';
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const keys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const fail = code => { throw new BrokerError(code); };
export function createExpenseActionReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_expense_action_v1', 'hermes_expense_capabilities_v1'] });
  return Object.freeze({ async capabilities({ accessToken, organizationId }, callOptions) {
    if (!domainId(organizationId)) fail('invalid_request');
    return rpc('hermes_expense_capabilities_v1', accessToken, { p_organization_id: organizationId }, callOptions, { optional: true });
  }, async execute(operation, value, callOptions) {
    if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, keys) || !domainId(value.binding.connectionId) ||
      !domainId(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
      ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
      !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) fail('invalid_request');
    let input; try { input = expenseActionInput(operation, value.input); } catch { fail('invalid_request'); }
    // Only create is a mutation: its ACK loss is surfaced as uncertain, never retried.
    return rpc('hermes_expense_action_v1', value.accessToken, { p_binding: value.binding, p_operation: expenseSqlOperation(operation), p_input: input },
      callOptions, { write: operation === 'expense.create' });
  } });
}
export function createExpenseActionAuth({ baseAuth, reads } = {}) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_expense_action_auth');
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const extended = await readWithBaseAuthorization(baseAuth, input,
      () => reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal }));
    const current = extended.current;
    if (EXPENSE_ACTIONS.some(key => current.permissions.action.includes(key) || current.companyCeilings.action.includes(key))) fail('context_changed');
    const cap = extended.capability();
    if (cap === null) return current;
    if (!domainExact(cap, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']) ||
      cap.organizationId !== input.organizationId || cap.userId !== input.userId || cap.membershipId !== current.membership.membershipId ||
      cap.authorizationVersion !== current.membership.authorizationVersion || cap.isSuperadmin !== current.isSuperadmin ||
      !(cap.policyVersion === 0 || positive(cap.policyVersion)) || !domainExact(cap.permissions, EXPENSE_ACTIONS)) fail('context_changed');
    const granted = [], ceilings = [], scopes = {};
    for (const key of EXPENSE_ACTIONS) {
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
      scopesByPermission: { ...current.scopesByPermission, ...scopes }, epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, cap })).digest('hex') };
  } });
}
/** Broker port prepareExpenseAction/finalizeExpenseAction, same shape as
 * task/room-pass; server.mjs mounts it behind createExpenseActionAuth. */
export function createExpenseActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  const reads = createExpenseActionReads({ ...supabase, dependencyScope, fetch });
  const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, mayUse: mayUseExpenseAction,
    validateInput: expenseActionInput, validateResult: expenseActionResult, clock });
  return Object.freeze({ prepareExpenseAction: service.prepare, finalizeExpenseAction: service.finalize });
}
