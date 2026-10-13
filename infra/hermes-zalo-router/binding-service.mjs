export { prepareLiveLinkObservation } from '../../worker/lib/hermes-link.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UID = /^[1-9][0-9]{0,39}$/;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key =>
  Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const id = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const CODES = new Set(['invalid_request', 'forbidden', 'reauthentication_required', 'context_changed',
  'backend_unavailable', 'binding_outcome_unknown', 'cancelled', 'timeout', 'busy', 'backend_closed']);
export class ZaloBindingError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'backend_unavailable';
    super(safe); this.code = safe; this.outcomeUnknown = safe === 'binding_outcome_unknown';
  }
}
// Only a verified HTTP/SQL rejection from the fixed adapter can certify that
// a dispatched write did not succeed. Lookalike error codes are never trusted.
export class ZaloBindingRpcRejection extends ZaloBindingError {}
const fail = code => { throw new ZaloBindingError(code); };
const writes = operation => !['status', 'list', 'bots', 'manageBots'].includes(operation);

const inputs = {
  list: ['afterBindingId'],
  bots: ['afterAccountId'],
  manageBots: ['afterAccountId'],
  setBot: ['accountId', 'expectedVersion', 'enabled'],
  begin: ['connectionId', 'expectedConnectionEpoch', 'accountId'],
  status: ['challengeId'],
  confirm: ['challengeId', 'expectedCandidateVersion', 'expectedSenderUid'],
  unlink: ['bindingId', 'expectedEpoch'],
};
const common = ['userId', 'organizationId'];
function response(operation, value, input) {
  const binding = row => exact(row, ['bindingId','epoch','state','accountId','connectionId','senderUid']) &&
    ['bindingId','accountId','connectionId'].every(key => id(row[key])) && positive(row.epoch) &&
    ['active','revoked'].includes(row.state) && typeof row.senderUid === 'string' && UID.test(row.senderUid);
  let valid = false;
  if (operation === 'manageBots') valid = exact(value, [...common,'status','bots','nextCursor']) && value.status === 'listed' && Array.isArray(value.bots) &&
    value.bots.length <= 100 && value.bots.every(row => exact(row, ['accountId','name','zaloUid','connected','enabled','version']) && id(row.accountId) &&
      typeof row.name === 'string' && row.name.length <= 160 && (row.zaloUid === null || typeof row.zaloUid === 'string' && UID.test(row.zaloUid)) &&
      typeof row.connected === 'boolean' && (!row.connected || row.zaloUid !== null) && typeof row.enabled === 'boolean' &&
      (row.version === 0 && !row.enabled || positive(row.version))) &&
    value.bots.every((row, index) => index === 0 ? input.afterAccountId === null || row.accountId > input.afterAccountId : row.accountId > value.bots[index - 1].accountId) &&
    (value.nextCursor === null || value.bots.length === 100 && value.nextCursor === value.bots.at(-1).accountId);
  if (operation === 'setBot') valid = exact(value, [...common,'status','accountId','version','enabled']) && value.status === 'configured' &&
    value.accountId === input.accountId && value.version === input.expectedVersion + 1 && value.enabled === input.enabled;
  if (operation === 'bots') valid = exact(value, [...common,'status','bots','nextCursor']) && value.status === 'listed' && Array.isArray(value.bots) &&
    value.bots.length <= 100 && value.bots.every(row => exact(row, ['accountId','name','zaloUid']) && id(row.accountId) &&
      typeof row.name === 'string' && row.name.length <= 160 && typeof row.zaloUid === 'string' && UID.test(row.zaloUid)) &&
    value.bots.every((row, index) => index === 0 ? input.afterAccountId === null || row.accountId > input.afterAccountId : row.accountId > value.bots[index - 1].accountId) &&
    (value.nextCursor === null || value.bots.length === 100 && value.nextCursor === value.bots.at(-1).accountId);
  if (operation === 'begin') valid = exact(value, [...common,'status','challengeId','challenge','accountId','connectionId','expiresAt']) &&
    value.status === 'waiting' && id(value.challengeId) && /^hz_[a-f0-9]{64}$/.test(value.challenge) &&
    value.accountId === input.accountId && value.connectionId === input.connectionId && positive(value.expiresAt);
  if (operation === 'status') valid = exact(value, [...common,'status','challengeId','accountId','connectionId','candidateVersion','senderUid','expiresAt']) &&
    ['waiting','observed','confirmed'].includes(value.status) && value.challengeId === input.challengeId &&
    id(value.accountId) && id(value.connectionId) && positive(value.expiresAt) &&
    (value.status === 'waiting' ? value.candidateVersion === 0 && value.senderUid === null :
      value.candidateVersion === 1 && typeof value.senderUid === 'string' && UID.test(value.senderUid));
  if (operation === 'confirm') valid = exact(value, [...common,'status','bindingId','epoch','accountId','connectionId','senderUid']) &&
    value.status === 'active' && id(value.bindingId) && id(value.accountId) && id(value.connectionId) && positive(value.epoch) && value.senderUid === input.expectedSenderUid;
  if (operation === 'unlink') valid = exact(value, [...common,'status','bindingId','epoch']) && value.status === 'revoked' &&
    value.bindingId === input.bindingId && [input.expectedEpoch,input.expectedEpoch + 1].includes(value.epoch);
  if (operation === 'list') valid = exact(value, [...common,'status','bindings','nextCursor']) && value.status === 'listed' && Array.isArray(value.bindings) &&
    value.bindings.length <= 100 && value.bindings.every(binding) &&
    value.bindings.every((row, index) => index === 0 ? input.afterBindingId === null || row.bindingId > input.afterBindingId : row.bindingId > value.bindings[index - 1].bindingId) &&
    (value.nextCursor === null || value.bindings.length === 100 && value.nextCursor === value.bindings.at(-1).bindingId);
  if (!valid || Buffer.byteLength(JSON.stringify(value)) > 65536) fail('invalid_response');
  return structuredClone(value);
}
function request(operation, input, organizationId) {
  if (!Object.hasOwn(inputs, operation) || !exact(input, inputs[operation]) || !id(organizationId)) fail('invalid_request');
  for (const [key, value] of Object.entries(input)) {
    if (['afterBindingId', 'afterAccountId'].includes(key) && value === null) continue;
    if (key.endsWith('Id') && !id(value)) fail('invalid_request');
    if (key === 'expectedVersion') {
      if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1) fail('invalid_request');
    } else if ((key.endsWith('Epoch') || key.endsWith('Version')) && !positive(value)) fail('invalid_request');
    if (key === 'enabled' && typeof value !== 'boolean') fail('invalid_request');
    if (key === 'expectedSenderUid' && (typeof value !== 'string' || !UID.test(value))) fail('invalid_request');
  }
  return { operation, organizationId, ...input };
}

/** Trusted browser-auth service seam for public.hermes_zalo_binding_v1.
 * rpc receives the caller JWT, never a service-role or runtime credential.
 * verifyCaller must freshly verify Auth and selected-org membership; SQL repeats
 * membership/ownership/epoch checks at mutation time. Normal user has one org;
 * superadmin still selects an explicit company and its own company bot. Same-org
 * is mandatory: a central cross-company inbox requires a separate privacy design.
 * Writes never retry. Unknown ACK requires status/readback, not a second begin.
 */
export function createZaloBindingService({ verifyCaller, rpc, timeoutMs = 30000, maxConcurrent = 16 } = {}) {
  if (typeof verifyCaller !== 'function' || typeof rpc !== 'function' || !positive(timeoutMs) || timeoutMs > 30000 ||
      !positive(maxConcurrent) || maxConcurrent > 64) throw new TypeError('invalid_binding_service');
  const pending = new Map(); let closing = false;
  return Object.freeze({ async invoke(operation, input, { accessToken, organizationId, signal } = {}) {
    const payload = request(operation, input, organizationId);
    if (typeof accessToken !== 'string' || accessToken.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken) || !(signal instanceof AbortSignal)) fail('invalid_request');
    if (closing) fail('backend_closed');
    if (signal.aborted) fail('cancelled');
    if (pending.size >= maxConcurrent) fail('busy');
    let dispatched = false;
    const controller = new AbortController(); let rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => {
      rejectStop(new ZaloBindingError(dispatched && writes(operation) ? 'binding_outcome_unknown' : code));
      controller.abort();
    };
    const cancel = () => stop('cancelled');
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const check = () => { if (controller.signal.aborted || signal.aborted || closing) fail('cancelled'); };
    const work = Promise.resolve().then(async () => {
      check(); const before = await verifyCaller({ accessToken, organizationId, signal: controller.signal }); check();
      if (!exact(before, ['userId', 'organizationId', 'membershipId', 'authorizationVersion', 'sessionId']) ||
          !['userId', 'organizationId', 'membershipId', 'sessionId'].every(key => id(before[key])) ||
          before.organizationId !== organizationId || !positive(before.authorizationVersion)) fail('forbidden');
      const pinned = JSON.stringify(before);
      dispatched = true;
      let result;
      try { result = await rpc({ accessToken, functionName: 'hermes_zalo_binding_v1', args: { p: payload }, signal: controller.signal }); }
      catch (error) {
        if (error instanceof ZaloBindingRpcRejection && !controller.signal.aborted && !closing) { dispatched = false; throw error; }
        throw error;
      }
      check();
      const after = await verifyCaller({ accessToken, organizationId, signal: controller.signal }); check();
      if (JSON.stringify(after) !== pinned) fail('context_changed');
      if (!plain(result) || result.userId !== before.userId || result.organizationId !== organizationId) fail('invalid_response');
      return response(operation, result, payload);
    });
    pending.set(work, () => stop('backend_closed'));
    void work.then(() => pending.delete(work), () => pending.delete(work));
    try { return await Promise.race([work, stopped]); }
    catch (error) {
      if (dispatched && writes(operation)) fail('binding_outcome_unknown');
      if (error instanceof ZaloBindingError) throw error;
      fail('backend_unavailable');
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.abort();
    }
  }, async close() {
    closing = true;
    for (const stop of pending.values()) stop();
    await Promise.allSettled([...pending.keys()]);
  } });
}
