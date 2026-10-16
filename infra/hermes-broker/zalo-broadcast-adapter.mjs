import { randomUUID } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { mayUseZaloBroadcast, zaloBroadcastInput, zaloBroadcastResult, ZALO_BROADCAST_WRITES } from './zalo-broadcast-contract.mjs';

const KEYS = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const exact = (value, names) => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === names.length &&
  names.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;

// One fixed caller-JWT RPC. Capabilities come from the existing chat_zalo.view /
// chat_zalo.send (group adapter) and chat_zalo.manage_automation (schedule
// adapter) keys; no capability RPC of its own. A PGRST202 (migration not applied)
// is a definite refusal reported as backend_unavailable, never an unknown write.
export function createZaloBroadcastReads(options) {
  const rpc = createBoundUserRpcTransport({ ...options, allowedNames: ['hermes_zalo_broadcast_v1'] });
  return Object.freeze({ async execute(operation, value, callOptions) {
    if (!exact(value, ['accessToken', 'binding', 'input']) || !exact(value.binding, KEYS) ||
      !id(value.binding.connectionId) || !id(value.binding.expectedMembershipId) || !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest) ||
      ['expectedEpoch', 'expectedAuthorizationVersion', 'expectedSessionRevision'].some(key => !positive(value.binding[key])) ||
      !(value.binding.expectedPolicyVersion === 0 || positive(value.binding.expectedPolicyVersion))) throw new BrokerError('invalid_request');
    let input; try { input = zaloBroadcastInput(operation, value.input); } catch { throw new BrokerError('invalid_request'); }
    // The shared SQL actor binds every call to a request id; reads get a fresh one.
    const binding = { ...value.binding, requestId: input.requestId ?? randomUUID() };
    return rpc('hermes_zalo_broadcast_v1', value.accessToken, { p: { binding, operation, input } }, callOptions,
      { write: ZALO_BROADCAST_WRITES.includes(operation) });
  } });
}

export function createZaloBroadcastService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  const reads = createZaloBroadcastReads({ ...supabase, dependencyScope, fetch });
  const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, mayUse: mayUseZaloBroadcast,
    validateInput: zaloBroadcastInput, validateResult: zaloBroadcastResult, clock });
  return Object.freeze({ prepareZaloBroadcast: service.prepare, finalizeZaloBroadcast: service.finalize });
}
