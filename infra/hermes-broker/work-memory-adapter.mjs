import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { exact, id, positive, isMemoryWrite, workMemoryInput } from './work-memory-contract.mjs';
const fail = code => { throw new BrokerError(code); };
const bindingKeys = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const rpcNames = Object.freeze({ status: 'hermes_work_memory_status_v1', list: 'hermes_work_memory_list_v1',
  configure: 'hermes_work_memory_configure_v1', upsert: 'hermes_work_memory_upsert_v1', forget: 'hermes_work_memory_forget_v1' });
export function createSupabaseWorkMemoryReads(options = {}) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: [...Object.values(rpcNames), 'hermes_work_memory_capabilities_v1'] });
  return Object.freeze({
    async capabilities({ accessToken, organizationId }, options) {
      if (!id(organizationId)) fail('invalid_request');
      return rpc('hermes_work_memory_capabilities_v1', accessToken, { p_organization_id: organizationId }, options, { optional: true });
    },
    async execute(operation, value, options) {
      if (!Object.hasOwn(rpcNames, operation) || !exact(value, ['accessToken', 'binding', 'input']) || !exact(value.binding, bindingKeys) ||
        !id(value.binding.connectionId) || !id(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
        ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(k => !positive(value.binding[k])) ||
        !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) fail('invalid_request');
      let input; try { input = workMemoryInput(operation, value.input); } catch { fail('invalid_request'); }
      return rpc(rpcNames[operation], value.accessToken, { p: value.binding, ...(operation === 'status' ? {} : { p_input: input }) }, options, { write: isMemoryWrite(operation) });
    },
  });
}

// Composes over whatever CRM capabilities the host already resolves. No roles,
// permission grants or scope unions are generated from model input.
export function createWorkMemoryAuthAdapter({ baseAuth, reads } = {}) {
  if ([baseAuth?.verifySession, baseAuth?.readAuthorization, reads?.capabilities].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_memory_auth');
  return Object.freeze({ verifySession: input => baseAuth.verifySession(input), async readAuthorization(input) {
    const current = await baseAuth.readAuthorization(input);
    if (current.permissions.read.includes('assistant.memory.read') || current.permissions.action.includes('assistant.memory.write')) fail('context_changed');
    const memory = await reads.capabilities({ accessToken: input.accessToken, organizationId: input.organizationId }, { signal: input.signal });
    if (memory === null) return current;
    if (!exact(memory, ['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'readAllowed', 'writeAllowed']) ||
      memory.organizationId !== input.organizationId || memory.userId !== input.userId || memory.membershipId !== current.membership.membershipId ||
      memory.authorizationVersion !== current.membership.authorizationVersion || memory.isSuperadmin !== current.isSuperadmin ||
      !(memory.policyVersion === 0 || positive(memory.policyVersion)) || typeof memory.readAllowed !== 'boolean' || typeof memory.writeAllowed !== 'boolean') fail('context_changed');
    const read = memory.readAllowed ? ['assistant.memory.read'] : [], action = memory.writeAllowed ? ['assistant.memory.write'] : [];
    return { ...current, permissions: { read: [...current.permissions.read, ...read], action: [...current.permissions.action, ...action] },
      companyCeilings: { read: [...current.companyCeilings.read, ...read], action: [...current.companyCeilings.action, ...action] },
      scopesByPermission: { ...current.scopesByPermission, ...Object.fromEntries([...read, ...action].map(k => [k, { buildingIds: [], cashbookIds: [] }])) },
      epoch: createHash('sha256').update(JSON.stringify({ base: current.epoch, memory })).digest('hex') };
  } });
}
