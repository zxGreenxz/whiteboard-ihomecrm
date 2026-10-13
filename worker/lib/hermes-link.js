import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UID = /^[1-9][0-9]{0,39}$/;
const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
function readExact(value, keys) {
  try {
    if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) return null;
    const snapshot = {};
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !Object.hasOwn(property, 'value')) return null;
      snapshot[key] = property.value;
    }
    return snapshot;
  } catch { return null; }
}
export const HERMES_LINK_REDACTED = '[Hermes link - hidden]';

// Redact even in history, quotes, captions, malformed commands, or self echoes.
// Bounded descriptor traversal never executes provider/user-defined getters.
export function isHermesLinkMessage(event) {
  const pending = [own(event, 'data')];
  const seen = new Set();
  let visited = 0;
  while (pending.length) {
    if (++visited > 4096) return true;
    const value = pending.pop();
    if (typeof value === 'string' && /\/hermes-link|hz_[a-f0-9]{64}/i.test(value)) return true;
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length + pending.length > 4096) return true;
    for (const key of keys) pending.push(own(value, key));
  }
  return false;
}

export function redactHermesLinkMessage(event) {
  if (!isHermesLinkMessage(event)) return event;
  const data = own(event, 'data');
  const safe = {};
  // Preserve only provider identity needed for SQL proof; drop raw metadata.
  for (const key of ['uidFrom', 'idTo', 'msgId', 'cliMsgId', 'ts']) {
    const value = own(data, key);
    if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !/hz_/i.test(value)) safe[key] = value;
  }
  return { type: own(event, 'type'), isSelf: own(event, 'isSelf'), threadId: own(event, 'threadId'),
    data: { ...safe, msgType: 'webchat', content: HERMES_LINK_REDACTED } };
}

function liveLinkCandidate(event, ownUid) {
  try {
    const data = own(event, 'data');
    if (own(event, 'type') !== 0 || own(event, 'isSelf') !== false || !plain(data) ||
        own(data, 'msgType') !== 'webchat') return null;
    const senderUid = own(data, 'uidFrom');
    if (!matches(UID, senderUid) || senderUid === ownUid || own(event, 'threadId') !== senderUid || own(data, 'idTo') !== ownUid) return null;
    for (const value of [event, data]) {
      if (['quote', 'reference', 'decorLog', 'forward', 'isForward', 'fw'].some(key => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        return property && (!Object.hasOwn(property, 'value') || property.value != null && property.value !== false);
      })) return null;
    }
    const providerMessageId = own(data, 'msgId'), content = own(data, 'content');
    if (!matches(/^[A-Za-z0-9_-]{1,128}$/, providerMessageId) || !matches(/^\/hermes-link hz_[a-f0-9]{64}$/, content)) return null;
    return Object.freeze({ senderUid, providerMessageId,
      challengeDigest: createHash('sha256').update(content.slice('/hermes-link '.length)).digest('hex') });
  } catch { return null; }
}

function linkObservation(candidate, source) {
  return Object.freeze({ operation: 'observe', accountId: source.accountId, organizationId: source.organizationId,
    instanceId: source.instanceId, generation: source.generation, ...candidate });
}

/** Only a new live DM can propose a sender. SQL still requires fresh CRM
 * confirmation; absent forward metadata cannot prove text was not copied. */
export function prepareLiveLinkObservation({ event, source }) {
  const pinned = readExact(source, ['accountId', 'organizationId', 'instanceId', 'generation', 'ownUid', 'eventKind']);
  if (!pinned || !['accountId', 'organizationId', 'instanceId', 'generation'].every(key => matches(UUID, pinned[key])) ||
      !matches(UID, pinned.ownUid) || pinned.eventKind !== 'message') throw new Error('invalid_source');
  const candidate = liveLinkCandidate(event, pinned.ownUid);
  return candidate ? linkObservation(candidate, pinned) : null;
}

/** Only a definitively denied registration can be attempted again. A timeout
 * keeps its admission slot until the underlying RPC actually settles. */
export function createHermesIngress({ source, rpc, isActive, timeoutMs = 8000, maxPending = 8 } = {}) {
  const pinned = readExact(source, ['accountId', 'organizationId', 'instanceId', 'accountOwnerId', 'ownUid', 'loginRequestedAt']);
  if (!pinned || !['accountId', 'organizationId', 'instanceId', 'accountOwnerId'].every(key => matches(UUID, pinned[key])) ||
      !matches(UID, pinned.ownUid) ||
      !(pinned.loginRequestedAt === null || typeof pinned.loginRequestedAt === 'string' && pinned.loginRequestedAt.length <= 40 && Number.isFinite(Date.parse(pinned.loginRequestedAt))) ||
      typeof rpc !== 'function' || typeof isActive !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32) throw new TypeError('invalid_ingress');
  Object.freeze(pinned);
  const calls = new Set(), tickets = new WeakMap();
  let state = 'new', generation = null, registration = null, privacyFlight = null;
  const active = () => { try { return state !== 'closed' && isActive() === true; } catch { return false; } };
  function startCall(payload) {
    const status = !active() ? 'inactive' : calls.size >= maxPending ? 'overloaded' : null;
    if (status) {
      const result = Promise.resolve({ status });
      return { result, settled: result };
    }
    const controller = new AbortController();
    calls.add(controller);
    let timer;
    const timeout = new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve({ status: 'outcome_unknown' }), { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted || !active()) return { data: null, error: { code: 'inactive' } };
      return rpc({ functionName: payload.operation === 'acceptPrivateCommand' ? 'hermes_zalo_private_command_v1' : 'hermes_zalo_ingress_v1',
        args: { p: payload }, signal: controller.signal });
    }).then(result => {
      if (!active() || controller.signal.aborted) return { status: 'outcome_unknown' };
      if (result?.error) {
        if (result.data != null) return { status: 'outcome_unknown' };
        if (result.error.code === '42501' && result.status === 403) return { status: 'denied' };
        if (result.error.code === 'PT409' && result.status === 409) return { status: 'context_changed' };
        if (payload.operation === 'acceptPrivateCommand' && result.error.code === 'PT429' && result.status === 429) return { status: 'overloaded' };
        return { status: 'outcome_unknown' };
      }
      if (result?.status != null && result.status !== 200) return { status: 'outcome_unknown' };
      if (payload.operation === 'register') {
        const data = readExact(result?.data, ['status','accountId','organizationId','generation']);
        if (data?.status === 'registered' && data.accountId === pinned.accountId && data.organizationId === pinned.organizationId && matches(UUID, data.generation)) return { status: 'registered', generation: data.generation };
      } else if (payload.operation === 'observe') {
        if (readExact(result?.data, ['status'])?.status === 'observed') return { status: 'observed' };
      } else if (payload.operation === 'privacy') {
        const data = readExact(result?.data, ['status','accountId','organizationId']);
        if (data && ['shared','private'].includes(data.status) && data.accountId === pinned.accountId && data.organizationId === pinned.organizationId) return { status: data.status };
      } else if (payload.operation === 'acceptPrivateCommand') {
        const data = readExact(result?.data, ['status','commandId','accountId','organizationId','providerMessageId']);
        if (data && ['queued','duplicate'].includes(data.status) && matches(UUID, data.commandId) &&
            data.accountId === pinned.accountId && data.organizationId === pinned.organizationId && data.providerMessageId === payload.providerMessageId) {
          return { status: data.status, commandId: data.commandId };
        }
      }
      return { status: 'outcome_unknown' };
    }).catch(() => ({ status: 'outcome_unknown' })).finally(() => { clearTimeout(timer); calls.delete(controller); });
    return { result: Promise.race([operation, timeout]), settled: operation };
  }
  function register() {
    if (!active()) return Promise.resolve({ status: 'inactive' });
    if (registration) return registration;
    if (!['new', 'denied'].includes(state)) return Promise.resolve({ status: 'inactive' });
    state = 'registering';
    registration = startCall({ operation: 'register', ...pinned }).result.then(result => {
      if (state !== 'registering') return { status: 'inactive' };
      if (result.status === 'registered' && active()) { generation = result.generation; state = 'ready'; }
      else state = result.status === 'denied' && active() ? 'denied' : 'unavailable';
      return { status: state === 'ready' ? 'registered' : result.status };
    }).finally(() => { registration = null; });
    return registration;
  }
  function captureCandidate(candidate, expiresAt = Date.now() + 30000) {
    if (!candidate || state !== 'ready' || !active() || Date.now() >= expiresAt) return null;
    const ticket = Object.freeze({});
    tickets.set(ticket, { payload: linkObservation(candidate, { ...pinned, generation }), expiresAt });
    return ticket;
  }
  return Object.freeze({
    // Query even when registration is unavailable: disabled/former bots retain
    // privacy. Only a scoped, current ACK may release a DM to the shared inbox.
    async privacy() {
      if (!active()) return { status: 'inactive' };
      if (!privacyFlight) {
        const flight = startCall({ operation: 'privacy', ...pinned });
        privacyFlight = flight;
        // Keep sharing the unknown result after timeout until the RPC settles;
        // a settled answer is never cached for the next burst.
        void flight.settled.then(() => { if (privacyFlight === flight) privacyFlight = null; });
      }
      const result = await privacyFlight.result;
      if (!active()) return { status: 'outcome_unknown' };
      if (result.status === 'context_changed') { state = 'unavailable'; generation = null; }
      return result;
    },
    register,
    // Trusted live listener snapshots this before any asynchronous work. These
    // IDs are provenance, not credentials or caller-selected user authority.
    privateCommandSource() {
      if (state !== 'ready' || !active()) return null;
      return Object.freeze({ accountId: pinned.accountId, organizationId: pinned.organizationId,
        instanceId: pinned.instanceId, generation, ownUid: pinned.ownUid, eventKind: 'message' });
    },
    privateReplySource() {
      if (state !== 'ready' || !active()) return null;
      return Object.freeze({ ...pinned, generation });
    },
    async acceptPrivateCommand(command) {
      const payload = readExact(command, ['operation','accountId','organizationId','instanceId','generation','senderUid','providerMessageId','sentAt','text']);
      if (state !== 'ready' || !active() || !payload || payload.operation !== 'acceptPrivateCommand' ||
          ['accountId','organizationId','instanceId'].some(key => payload[key] !== pinned[key]) || payload.generation !== generation ||
          !matches(UID, payload.senderUid) || payload.senderUid === pinned.ownUid || !matches(/^[A-Za-z0-9_-]{1,128}$/, payload.providerMessageId) ||
          !Number.isSafeInteger(payload.sentAt) || payload.sentAt <= 0 || typeof payload.text !== 'string' ||
          !payload.text.length || payload.text.includes('\0') || Buffer.byteLength(payload.text, 'utf8') > 8192) return { status: 'inactive' };
      // Never retry a write whose outcome is unknown. A duplicate provider
      // event is reconciled by the DB's payload-bound durable unique key.
      return startCall(Object.freeze(payload)).result;
    },
    capture(event) {
      if (state !== 'ready' || !active()) return null;
      return captureCandidate(liveLinkCandidate(event, pinned.ownUid));
    },
    async captureLive(event) {
      if (!active() || !['ready', 'denied', 'registering'].includes(state)) return null;
      // Validate and snapshot the live event before any recovery write, without
      // inventing a generation. Bind it only to the registration's actual ACK.
      const candidate = liveLinkCandidate(event, pinned.ownUid), expiresAt = Date.now() + 30000;
      if (!candidate) return null;
      if (state !== 'ready') await register();
      return captureCandidate(candidate, expiresAt);
    },
    async observe(ticket) {
      const captured = tickets.get(ticket);
      tickets.delete(ticket);
      if (!captured || state !== 'ready' || !active() || Date.now() >= captured.expiresAt) return { status: 'inactive' };
      // SQL rejects bad/expired challenges with the same errors as context
      // failures. Burn only this ticket; every new observation still calls SQL.
      return startCall(captured.payload).result;
    },
    close() { state = 'closed'; generation = null; for (const controller of calls) controller.abort(); },
  });
}
