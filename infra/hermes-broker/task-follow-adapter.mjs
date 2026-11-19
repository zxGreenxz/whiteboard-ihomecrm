import { createHash } from 'node:crypto';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { BrokerError } from './broker.mjs';
import { taskFollowInput, taskFollowResult, bindTaskFollowCompany, mayUseTaskFollow, TASK_PROGRESS_ACTION, TASK_CANCEL_ACTION } from './task-follow-contract.mjs';
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
      // The RPC boundary always carries the connection's company (bound in prepareFollow).
      if (!domainId(input.organizationId)) throw new BrokerError('invalid_request');
      if (operation === 'list') return rpc('hermes_task_follow_read_v1', value.accessToken, { p_binding: value.binding, p_input: input }, callOptions);
      return rpc('hermes_task_follow_action_v1', value.accessToken, { p_binding: value.binding, p_operation: operation, p_input: input }, callOptions, { write: true });
    },
  });
}

/** Merge the follow capability observation into an already resolved CRM
 * authorization. A malformed or mismatched observation is a context change,
 * never a silent grant; absence (null) keeps the input authorization. */
// skip (Công việc Mốc 3): khoá mà lớp khung chung đã là nguồn (task.update ⇒ tasks.edit, task.cancel ⇒ tasks.delete SỐNG phía SQL) —
// vẫn kiểm khuôn, không cấp lại và không tính là trùng nguồn.
export function extendTaskFollowAuthorization(current, cap, input, { skip = [] } = {}) {
  if (cap === null) return current;
  if (!Array.isArray(skip) || skip.some(key => !KEYS.some(([known, mode]) => known === key && mode === 'action'))) throw new TypeError('invalid_task_follow_skip');
  if (KEYS.some(([key, mode]) => !skip.includes(key) && (current.permissions[mode].includes(key) || current.companyCeilings[mode].includes(key)))) throw new BrokerError('context_changed');
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
    if (skip.includes(key)) continue;
    if (value.companyEnabled) ceilings[mode].push(key);
    if (value.allowed) { permissions[mode].push(key); scopes[key] = { buildingIds: [...value.buildingIds], cashbookIds: [] }; }
  }
  return { ...current, permissions, companyCeilings: ceilings, scopesByPermission: scopes,
    epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, follow: cap })).digest('hex') };
}

/** B5b (20/10/2026): the company of every follow call is the connection's, not
 * the model's. The operation service (bound-user-operation) validates its input
 * before it resolves the authority receipt and takes no identity, while the
 * broker hands its own resolve result to exactly one following resolve of the
 * checkpoint (authority-request-scope). This adapter is that resolve: it binds
 * the company into the input, then serves the very same receipt to a per-call
 * operation service through a one-call authority port (checkUnchanged stays the
 * real authority's), so no Auth/SQL read is added. Outside a broker invocation
 * the resolve here is the fresh one the operation service would have made. */
export function createTaskFollowService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  if (typeof authority?.resolve !== 'function' || typeof authority?.checkUnchanged !== 'function') throw new TypeError('invalid_bound_user_operation_service');
  const reads = createTaskFollowReads({ ...supabase, dependencyScope, fetch });
  const operationService = (token, identity) => createBoundUserOperationService({
    authority: { async resolve(presented) { if (presented !== token) throw new BrokerError('context_changed'); return identity; },
      checkUnchanged: (presented, before, options) => authority.checkUnchanged(presented, before, options) },
    connectionStore, crypto, auth, reads, mayUse: mayUseTaskFollow, validateInput: taskFollowInput, validateResult: taskFollowResult, clock });
  const issued = new WeakMap();
  return Object.freeze({
    async prepareFollow(token, operation, suppliedInput, { signal } = {}) {
      if (!(signal instanceof AbortSignal)) throw new BrokerError('invalid_request');
      if (signal.aborted) throw new BrokerError('timeout');
      if (typeof token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(token)) throw new BrokerError('unauthorized');
      let input; try { input = taskFollowInput(operation, suppliedInput); } catch { throw new BrokerError('invalid_request'); }
      const identity = await authority.resolve(token, { signal });
      let bound; try { bound = bindTaskFollowCompany(input, identity?.row?.organizationId); } catch { throw new BrokerError('forbidden'); }
      const service = operationService(token, identity);
      const receipt = await service.prepare(token, operation, bound, { signal });
      issued.set(receipt, service);
      return receipt;
    },
    async finalizeFollow(token, receipt, callOptions) {
      const service = issued.get(receipt); issued.delete(receipt);
      if (!service) throw new BrokerError('context_changed');
      return service.finalize(token, receipt, callOptions);
    },
  });
}
