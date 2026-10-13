import { Buffer } from 'node:buffer';
import { isHermesLinkMessage } from './hermes-link.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UID = /^[1-9][0-9]{0,39}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TIMESTAMP = /^[1-9][0-9]{0,15}$/;
const SOURCE_KEYS = ['accountId', 'organizationId', 'instanceId', 'generation', 'ownUid', 'eventKind'];
const REFERENCE_KEYS = ['quote', 'reference', 'decorLog', 'forward', 'isForward', 'fw'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const descriptor = (value, key) => object(value) ? Object.getOwnPropertyDescriptor(value, key) : undefined;
const own = (value, key) => {
  const property = descriptor(value, key);
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
};
// Full matches also exclude the trailing newline that JavaScript's $ can allow.
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

function pinSource(input) {
  try {
    const source = own(input, 'source');
    if (!object(source) || ![Object.prototype, null].includes(Object.getPrototypeOf(source)) ||
        Reflect.ownKeys(source).length !== SOURCE_KEYS.length) return null;
    const pinned = {};
    for (const key of SOURCE_KEYS) {
      const property = descriptor(source, key);
      if (!property || !Object.hasOwn(property, 'value')) return null;
      pinned[key] = property.value;
    }
    if (!['accountId', 'organizationId', 'instanceId', 'generation'].every(key => matches(UUID, pinned[key])) ||
        !matches(UID, pinned.ownUid) || pinned.eventKind !== 'message') return null;
    return pinned;
  } catch {
    return null;
  }
}

function hasReference(value) {
  return REFERENCE_KEYS.some(key => {
    const property = descriptor(value, key);
    // Empty provider placeholders are allowed; an accessor cannot prove absence.
    return property && (!Object.hasOwn(property, 'value') ||
      property.value != null && property.value !== false);
  });
}

/** Projection of untrusted text only. SQL must derive binding identity, check
 * timestamp/generation freshness, and enforce durable message/payload uniqueness. */
export function prepareLivePrivateCommand(input) {
  const source = pinSource(input);
  if (!source) throw new Error('invalid_source');
  try {
    const event = own(input, 'event');
    const data = own(event, 'data');
    if (!object(event) || !object(data) || own(event, 'type') !== 0 || own(event, 'isSelf') !== false ||
        own(data, 'msgType') !== 'webchat' || hasReference(event) || hasReference(data)) return null;

    const senderUid = own(data, 'uidFrom');
    if (!matches(UID, senderUid) || senderUid === source.ownUid || own(event, 'threadId') !== senderUid ||
        own(data, 'idTo') !== source.ownUid) return null;
    const providerMessageId = own(data, 'msgId');
    if (!matches(MESSAGE_ID, providerMessageId)) return null;

    const timestamp = own(data, 'ts');
    const sentAt = typeof timestamp === 'number' ? timestamp : matches(TIMESTAMP, timestamp) ? Number(timestamp) : NaN;
    if (!Number.isSafeInteger(sentAt) || sentAt <= 0) return null;

    const text = own(data, 'content');
    if (typeof text !== 'string' || text.length === 0 || text.length > 8192 || text.includes('\0') ||
        Buffer.byteLength(text, 'utf8') > 8192) return null;
    // Restrict the existing helper to text, without traversing provider metadata.
    if (isHermesLinkMessage({ data: { content: text } })) return null;

    return Object.freeze({
      operation: 'acceptPrivateCommand',
      accountId: source.accountId,
      organizationId: source.organizationId,
      instanceId: source.instanceId,
      generation: source.generation,
      senderUid,
      providerMessageId,
      sentAt,
      text,
    });
  } catch {
    // Provider reflection failures cannot expose raw text or credentials.
    return null;
  }
}
