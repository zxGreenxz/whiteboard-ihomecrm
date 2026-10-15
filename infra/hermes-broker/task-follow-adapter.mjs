import { createHash } from 'node:crypto';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { BrokerError } from './broker.mjs';
import { taskFollowInput, taskFollowResult, mayUseTaskFollow, TASK_PROGRESS_ACTION, TASK_CANCEL_ACTION } from './task-follow-contract.mjs';
import { MEMORY_SUPERVISE } from './work-memory-contract.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const BINDING = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
// CRM permissions this adapter may add. Each comes from the follow capability
// RPC (current CRM grant ∩ registry ∩ company ceiling); the connection overlay
// still intersects them in the durable authority.
const KEYS = Object.freeze([[TASK_PROGRESS_ACTION, 'action'], [TASK_CANCEL_ACTION, 'action'], [MEMORY_SUPERVISE, 'read']]);

export function createTaskFollowReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_task_follow_read_v1', 'hermes_task_follow_action_v1', 'hermes_task_follow_capabilities_v1'] });
  return Object.freeze({
    async capabilities({ accessToken, organizationId }, callOptions) {
      if (!domainId(organizationId)) throw new BrokerError('invalid_request');
      return rpc('hermes_task_follow_capabilities_v1', accessToken, { p_organization_id: organizationId }, callOptions, { optional: true });
    },
    async execute(operation, value, callOptions) {
      if (!domainExact(value, ['accessToken', 'binding', 'input']) || !domainExact(value.binding, BINDING) || !domainId(value.binding.connectionId) ||
        !domainId(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
        ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
        !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) throw new BrokerError('invalid_request');
      let input; try { input = taskFollowInput(operation, value.input); } catch { throw new BrokerError('invalid_request'); }
      if (operation === 'list') return rpc('hermes_task_follow_read_v1', value.accessToken, { p_binding: value.binding, p_input: input }, callOptions);
      return rpc('hermes_task_follow_action_v1', value.accessToken, { p_binding: value.binding, p_operation: operation, p_input: input }, callOptions, { write: true });
    },
  });
}

/** Merge the follow capability observation into an already resolved CRM
 * authorization. A malformed or mismatched observation is a context change,
 * never a silent grant; absence (null) keeps the input authorization. */
export function extendTaskFollowAuthorization(current, cap, input) {
  if (cap === null) return current;
  if (KEYS.some(([key, mode]) => current.permissions[mode].includes(key) || current.companyCeilings[mode].includes(key))) throw new BrokerError('context_changed');
  if (!domainExact(cap, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']) ||
    cap.organizationId !== input.organizationId || cap.userId !== input.userId || cap.membershipId !== current.membership.membershipId ||
    cap.authorizationVersion !== current.membership.authorizationVersion || cap.isSuperadmin !== current.isSuperadmin ||
    !(cap.policyVersion === 0 || positive(cap.policyVersion)) || !domainExact(cap.permissions, KEYS.map(([key]) => key))) throw new BrokerError('context_changed');
  const permissions = { read: [...current.permissions.read], action: [...current.permissions.action] };
  const ceilings = { read: [...current.companyCeilings.read], action: [...current.companyCeilings.action] };
  const scopes = { ...current.scopesByPermission };
  for (const [key, mode] of KEYS) {
    const value = cap.permissions[key];
    if (!domainExact(value, ['allowed', 'companyEnabled', 'buildingIds']) || typeof value.allowed !== 'boolean' || typeof value.companyEnabled !== 'boolean' ||
      (value.allowed && !value.companyEnabled) || !Array.isArray(value.buildingIds) || value.buildingIds.length > 256 ||
      value.buildingIds.some(id => !domainId(id)) || new Set(value.buildingIds).size !== value.buildingIds.length ||
      (!value.allowed && value.buildingIds.length) || (mode === 'read' && value.buildingIds.length) ||
      (mode === 'action' && value.allowed && !value.buildingIds.length)) throw new BrokerError('context_changed');
    if (value.companyEnabled) ceilings[mode].push(key);
    if (value.allowed) { permissions[mode].push(key); scopes[key] = { buildingIds: [...value.buildingIds], cashbookIds: [] }; }
  }
  return { ...current, permissions, companyCeilings: ceilings, scopesByPermission: scopes,
    epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, follow: cap })).digest('hex') };
}

export function createTaskFollowService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  const reads = createTaskFollowReads({ ...supabase, dependencyScope, fetch });
  const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, mayUse: mayUseTaskFollow,
    validateInput: taskFollowInput, validateResult: taskFollowResult, clock });
  return Object.freeze({ prepareFollow: service.prepare, finalizeFollow: service.finalize });
}
