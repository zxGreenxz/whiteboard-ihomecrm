import { randomUUID, createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { scheduleInput } from './schedule-contract.mjs';
const keys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const exact = (value, names) => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === names.length &&
  names.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
export function createSupabaseScheduleReads(options) {
  // manage_v2 keeps v1 validation/actor/grant semantics for mutations and adds
  // issues/reconcile; it requires the schedule health + reconcile migrations.
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_room_schedule_manage_v2', 'hermes_room_schedule_capabilities_v1'] });
  return Object.freeze({ async capabilities({ accessToken, organizationId }, callOptions) {
    if (!id(organizationId)) throw new BrokerError('invalid_request');
    return rpc('hermes_room_schedule_capabilities_v1', accessToken, { p_organization_id: organizationId }, callOptions, { optional: true });
  }, async execute(operation, value, callOptions) {
    if (!exact(value, ['accessToken', 'binding', 'input']) || !exact(value.binding, keys) ||
      !id(value.binding.connectionId) || !id(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
      ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
      !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) throw new BrokerError('invalid_request');
    let input; try { input = scheduleInput(operation, value.input); } catch { throw new BrokerError('invalid_request'); }
    const binding = { ...value.binding, requestId: input.requestId ?? randomUUID() };
    return rpc('hermes_room_schedule_manage_v2', value.accessToken, { p: { binding, operation, input } }, callOptions,
      { write: !['list', 'issues'].includes(operation) });
  } });
}

// Extend the same live CRM resolver. The SQL capability is current
// chat_zalo.manage_automation intersected with the optional org ceiling;
// DurableAuthority still intersects the persisted connection overlay.
export function createScheduleAuthAdapter({ baseAuth, reads } = {}) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_schedule_auth');
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const current = await baseAuth.readAuthorization(input);
    if (current.permissions.action.includes('chat_zalo.manage_automation') || current.companyCeilings.action.includes('chat_zalo.manage_automation')) throw new BrokerError('context_changed');
    const capability = await reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal });
    if (capability === null) return current;
    if (!exact(capability, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'allowed', 'companyEnabled']) ||
      capability.organizationId !== input.organizationId || capability.userId !== input.userId || capability.membershipId !== current.membership.membershipId ||
      capability.authorizationVersion !== current.membership.authorizationVersion || capability.isSuperadmin !== current.isSuperadmin ||
      !(capability.policyVersion === 0 || positive(capability.policyVersion)) || typeof capability.allowed !== 'boolean' || typeof capability.companyEnabled !== 'boolean' ||
      capability.allowed && !capability.companyEnabled) throw new BrokerError('context_changed');
    const action = capability.allowed ? ['chat_zalo.manage_automation'] : [];
    return { ...current, permissions: { ...current.permissions, action: [...current.permissions.action, ...action] },
      companyCeilings: { ...current.companyCeilings, action: [...current.companyCeilings.action, ...(capability.companyEnabled ? ['chat_zalo.manage_automation'] : [])] },
      scopesByPermission: { ...current.scopesByPermission, ...(capability.allowed ? { 'chat_zalo.manage_automation': { buildingIds: [], cashbookIds: [] } } : {}) },
      epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, capability })).digest('hex') };
  } });
}
