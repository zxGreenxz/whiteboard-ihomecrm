import { StoreTransportError } from './store-transport.mjs';

// The trusted backend owns this adapter. It accepts only a digest of a genuine
// opaque connection token; neither a browser actor nor a plaintext token is an
// input. The caller must compare a claimed command with freshly resolved owner
// authority before passing it to a branded runtime handle.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CLAIM = ['tokenDigest', 'claimId'];
const COMMAND_IDS = ['commandId', 'connectionId', 'assistantId', 'userId', 'organizationId', 'bindingId'];
const COMMAND = [...COMMAND_IDS, 'bindingEpoch', 'text', 'expiresAt'];
const FAILURE_REASONS = ['runtime_failed', 'runtime_cancelled', 'runtime_unknown'];
const TRANSPORT_ERRORS = new Set(['store_outcome_unknown', 'store_denied', 'store_conflict', 'store_rejected',
  'store_cancelled', 'store_timeout', 'store_unavailable', 'store_principal_refused', 'store_request_too_large']);
const uuid = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const textWithin = (value, cap) => typeof value === 'string' && value.length > 0 &&
  value.length <= cap && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= cap;

export class PrivateCommandStoreError extends Error {
  constructor(code) { super(code); this.name = 'PrivateCommandStoreError'; this.code = code; }
}
const fail = code => { throw new PrivateCommandStoreError(code); };
const invalidRequest = () => fail('private_command_store_request_invalid');
// Every operation is a write. A malformed ACK cannot prove that SQL rolled
// back, so it must never authorize a provider call, compensation or write retry.
const invalidAck = () => fail('store_outcome_unknown');

function snapshot(value, keys, invalid) {
  try {
    if (!value || typeof value !== 'object') invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => !keys.includes(key))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copied = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
      copied[key] = descriptor.value;
    }
    return copied;
  } catch { invalid(); }
}

function claimInput(input, extra = []) {
  const copied = snapshot(input, [...CLAIM, ...extra], invalidRequest);
  if (typeof copied.tokenDigest !== 'string' || !DIGEST.test(copied.tokenDigest) || !uuid(copied.claimId)) invalidRequest();
  return copied;
}

function commandOutput(value) {
  const copied = snapshot(value, COMMAND, invalidAck);
  if (COMMAND_IDS.some(key => !uuid(copied[key])) || !positive(copied.bindingEpoch) ||
      !positive(copied.expiresAt) || !textWithin(copied.text, 8192)) invalidAck();
  return Object.freeze(copied);
}

/** Fixed ledger operations only; this object does not loop, poll, retry, invoke
 * a model or send a reply. A dispatched/already_dispatched result must be
 * distinguished by its caller: only the first definite dispatch ACK permits
 * runtime execution. SQL, followed by the supervisor, rechecks live authority.
 */
export function createPrivateCommandStore({ transport } = {}) {
  if (typeof transport?.call !== 'function') throw new TypeError('invalid_private_command_store_config');
  const transportCall = transport.call.bind(transport);
  async function call(operation, payload, options) {
    const { signal } = snapshot(options, ['signal'], invalidRequest);
    if (!(signal instanceof AbortSignal)) invalidRequest();
    if (signal.aborted) fail('private_command_store_cancelled');
    let result;
    try { result = await transportCall(operation, Object.freeze(payload), { signal }); }
    catch (error) {
      if (error instanceof StoreTransportError && TRANSPORT_ERRORS.has(error.code)) fail(error.code);
      // An unexpected transport failure after handing off a mutation supplies
      // no proof about whether it committed. Expose only a stable safe code.
      invalidAck();
    }
    if (signal.aborted) invalidAck();
    return result;
  }
  async function receipt(operation, payload, options, states) {
    const result = snapshot(await call(operation, payload, options), ['status', 'commandId', 'claimId'], invalidAck);
    if (!states.includes(result.status) || !uuid(result.commandId) || result.claimId !== payload.claimId) invalidAck();
    return Object.freeze(result);
  }
  return Object.freeze({
    async claimPrivateCommand(input, options) {
      const payload = claimInput(input);
      const result = await call('claimPrivateCommand', payload, options);
      // Inspect status without executing accessors, then validate the entire
      // selected shape. Extra fields on an empty response also fail closed.
      let status;
      try { status = Object.getOwnPropertyDescriptor(result, 'status')?.value; } catch { invalidAck(); }
      if (status === 'empty') {
        const copied = snapshot(result, ['status'], invalidAck);
        if (copied.status !== 'empty') invalidAck();
        return Object.freeze(copied);
      }
      const copied = snapshot(result, ['status', 'claimId', 'command'], invalidAck);
      if (copied.status !== 'claimed' || copied.claimId !== payload.claimId) invalidAck();
      return Object.freeze({ status: copied.status, claimId: copied.claimId, command: commandOutput(copied.command) });
    },
    async dispatchPrivateCommand(input, options) {
      return receipt('dispatchPrivateCommand', claimInput(input), options, ['dispatched', 'already_dispatched']);
    },
    async finishPrivateCommand(input, options) {
      const payload = claimInput(input, ['text']);
      if (!textWithin(payload.text, 32768)) invalidRequest();
      return receipt('finishPrivateCommand', payload, options, ['ready', 'already_ready']);
    },
    async failPrivateCommand(input, options) {
      const payload = claimInput(input, ['reason']);
      if (!FAILURE_REASONS.includes(payload.reason)) invalidRequest();
      return receipt('failPrivateCommand', payload, options, ['failed', 'unknown']);
    },
    async prunePrivateCommands(input, options) {
      const payload = snapshot(input, ['limit'], invalidRequest);
      if (!positive(payload.limit) || payload.limit > 256) invalidRequest();
      const copied = snapshot(await call('prunePrivateCommands', payload, options), ['status', 'count'], invalidAck);
      if (copied.status !== 'pruned' || !Number.isSafeInteger(copied.count) || copied.count < 0 || copied.count > payload.limit) invalidAck();
      return Object.freeze(copied);
    },
  });
}
