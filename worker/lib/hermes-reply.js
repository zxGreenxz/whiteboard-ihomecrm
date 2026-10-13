import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ThreadType } from 'zca-js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UID = /^[1-9][0-9]{0,39}$/;
const SOURCE = ['accountId', 'organizationId', 'instanceId', 'generation', 'accountOwnerId', 'ownUid', 'loginRequestedAt'];
const SCOPE = ['deliveryId', 'commandId', 'accountId', 'organizationId', 'generation'];
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) {
  try {
    if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) return null;
    const snapshot = {};
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !Object.hasOwn(property, 'value')) return null;
      snapshot[key] = property.value;
    }
    return Object.freeze(snapshot);
  } catch { return null; }
}
function sourceSnapshot(value) {
  const source = exact(value, SOURCE);
  return source && SOURCE.slice(0, 5).every(key => matches(UUID, source[key])) && matches(UID, source.ownUid) &&
    (source.loginRequestedAt === null || typeof source.loginRequestedAt === 'string' && source.loginRequestedAt.length <= 40 &&
      Number.isFinite(Date.parse(source.loginRequestedAt))) ? source : null;
}
function envelope(value) {
  try {
    if (!plain(value)) return null;
    const fields = {};
    for (const key of ['data', 'error', 'status']) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property && !Object.hasOwn(property, 'value')) return null;
      fields[key] = property?.value;
    }
    if (fields.error != null) {
      const error = Object.getOwnPropertyDescriptor(fields.error, 'code');
      if (fields.data != null || !error || !Object.hasOwn(error, 'value')) return null;
      if (error.value === '42501' && fields.status === 403) return { status: 'denied' };
      if (error.value === 'PT409' && fields.status === 409) return { status: 'context_changed' };
      return null;
    }
    return fields.status === 200 ? { status: 'ok', data: fields.data } : null;
  } catch { return null; }
}
function scoped(ack, source, deliveryId, commandId) {
  return ack && ack.deliveryId === deliveryId && matches(UUID, ack.commandId) && (!commandId || ack.commandId === commandId) &&
    ['accountId', 'organizationId', 'generation'].every(key => ack[key] === source[key]);
}
function claimAck(data, source, deliveryId) {
  if (exact(data, ['status'])?.status === 'empty') return { status: 'empty' };
  const ack = exact(data, ['status', ...SCOPE, 'recipientUid', 'text', 'expiresAt']);
  if (!scoped(ack, source, deliveryId) || ack.status !== 'claimed' || !matches(UID, ack.recipientUid) || ack.recipientUid === source.ownUid ||
      typeof ack.text !== 'string' || !ack.text.length || ack.text.includes('\0') || Buffer.byteLength(ack.text, 'utf8') > 32768 ||
      !Number.isSafeInteger(ack.expiresAt) || ack.expiresAt <= Date.now() || ack.expiresAt > Date.now() + 900000) return null;
  return ack;
}

// zca-js 2.2.0: dist/apis/sendMessage.{js,d.ts} returns
// {message: {msgId: number}, attachment: []} for a single text request. Reject
// unsafe numbers rather than inventing an exact ID from a rounded JSON number.
// The pinned package has no smaller text limit; 32768 UTF-8 bytes is our bound.
export function privateReplyReceipt(value) {
  const result = exact(value, ['message', 'attachment']);
  const message = exact(result?.message, ['msgId']);
  try {
    if (!message || !Number.isSafeInteger(message.msgId) || message.msgId <= 0 || !Array.isArray(result.attachment) ||
        Reflect.ownKeys(result.attachment).length !== 1 || Object.getOwnPropertyDescriptor(result.attachment, 'length')?.value !== 0) return null;
    return String(message.msgId);
  } catch { return null; }
}

/** One runner belongs to exactly one existing provider session. Unknown
 * admission quarantines this runner until a fresh attachment; no write or send
 * is automatically replayed. Closing still permits metadata-only settlement. */
export function createHermesReplyRunner({ getSource, rpc, isActive, sendMessage, intervalMs = 5000,
  rpcTimeoutMs = 8000, providerTimeoutMs = 60000, uuid = randomUUID } = {}) {
  if (![getSource, rpc, isActive, sendMessage, uuid].every(value => typeof value === 'function') ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000 ||
      !Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1 || rpcTimeoutMs > 30000 ||
      !Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 1 || providerTimeoutMs > 60000) throw new TypeError('invalid_reply_runner');
  let closed = false, blocked = false, flight = null, timer = null;
  const controllers = new Map();
  const active = () => { try { return !closed && isActive() === true; } catch { return false; } };
  const currentSource = () => { try { return active() ? sourceSnapshot(getSource()) : null; } catch { return null; } };
  const current = source => {
    const latest = currentSource();
    return latest && SOURCE.every(key => latest[key] === source[key]);
  };
  function call(payload, held) {
    const controller = new AbortController(), isAck = payload.operation === 'ack';
    controllers.set(controller, isAck);
    let deadline;
    const timeout = new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve({ status: 'outcome_unknown' }), { once: true });
      deadline = setTimeout(() => controller.abort(), rpcTimeoutMs);
    });
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted || !isAck && !active()) return null;
      return rpc({ functionName: 'hermes_zalo_private_reply_v1', args: Object.freeze({ p: Object.freeze(payload) }), signal: controller.signal });
    }).then(result => controller.signal.aborted ? { status: 'outcome_unknown' } : envelope(result) || { status: 'outcome_unknown' })
      .catch(() => ({ status: 'outcome_unknown' }))
      .finally(() => { clearTimeout(deadline); controllers.delete(controller); });
    held.push(operation);
    return Promise.race([operation, timeout]);
  }
  async function acknowledge(source, claimed, outcome, providerMessageId, held) {
    const response = await call({ operation: 'ack', ...source, deliveryId: claimed.deliveryId, outcome, providerMessageId }, held);
    const ack = response.status === 'ok' ? exact(response.data, ['status', ...SCOPE]) : null;
    if (!scoped(ack, source, claimed.deliveryId, claimed.commandId) || ack.status !== outcome) {
      blocked = true; return { status: 'outcome_unknown' };
    }
    return { status: outcome };
  }
  async function run(source, held) {
    const deliveryId = uuid();
    if (!matches(UUID, deliveryId)) { blocked = true; return { status: 'outcome_unknown' }; }
    const response = await call({ operation: 'claim', ...source, deliveryId }, held);
    if (response.status !== 'ok') {
      if (response.status === 'outcome_unknown') blocked = true;
      return { status: response.status };
    }
    const claimed = claimAck(response.data, source, deliveryId);
    if (!claimed) { blocked = true; return { status: 'outcome_unknown' }; }
    if (claimed.status === 'empty') return { status: 'empty' };
    if (!current(source) || Date.now() >= claimed.expiresAt) return acknowledge(source, claimed, 'cancelled', null, held);
    const dispatch = await call({ operation: 'dispatch', ...source, deliveryId }, held);
    if (['denied', 'context_changed'].includes(dispatch.status)) return acknowledge(source, claimed, 'cancelled', null, held);
    const ack = dispatch.status === 'ok' ? exact(dispatch.data, ['status', ...SCOPE]) : null;
    if (!scoped(ack, source, deliveryId, claimed.commandId) || !['dispatched', 'already_dispatched'].includes(ack.status)) {
      blocked = true; return { status: 'outcome_unknown' };
    }
    if (ack.status === 'already_dispatched') return { status: 'already_dispatched' };
    if (!current(source) || Date.now() >= claimed.expiresAt) return acknowledge(source, claimed, 'unknown', null, held);
    let deadline, transport;
    // No await between the final local fence and the only provider invocation.
    try { transport = Promise.resolve(sendMessage(Object.freeze({ msg: claimed.text }), claimed.recipientUid, ThreadType.User)); }
    catch { return acknowledge(source, claimed, 'unknown', null, held); }
    const settled = transport.then(privateReplyReceipt, () => null).catch(() => null).finally(() => clearTimeout(deadline));
    held.push(settled);
    const providerMessageId = await Promise.race([settled, new Promise(resolve => { deadline = setTimeout(() => resolve(null), providerTimeoutMs); })]);
    // A stopped/replaced session may record the old delivery's provider receipt;
    // this path has no permission to start another send or read another reply.
    return acknowledge(source, claimed, providerMessageId ? 'sent' : 'unknown', providerMessageId, held);
  }
  function tick() {
    if (flight) return Promise.resolve({ status: 'busy' });
    if (blocked) return Promise.resolve({ status: 'outcome_unknown' });
    const source = currentSource();
    if (!source) return Promise.resolve({ status: 'inactive' });
    const held = [], token = {};
    flight = token;
    const result = run(source, held).catch(() => { blocked = true; return { status: 'outcome_unknown' }; });
    // Timeouts return promptly, but ignored aborts/provider work retain the
    // admission slot until the actual operations settle.
    void result.finally(async () => { await Promise.allSettled(held); if (flight === token) flight = null; });
    return result;
  }
  return Object.freeze({
    tick,
    start() {
      if (closed || timer !== null) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    close() {
      closed = true; clearInterval(timer); timer = null;
      for (const [controller, isAck] of controllers) if (!isAck) controller.abort();
    },
  });
}
