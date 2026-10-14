import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { nativeDirectory, nativePrivateRead } from './hermes-native-files.js';
import { nativeId, nativeUid } from './hermes-native-config.js';

export const nativeDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_BYTES = 16 * 1024 * 1024, MAX_RECORDS = 100000;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('native_journal_invalid'); };
function validateRecord(kind, id, record, channel) {
  if (!plain(record) || !nativeId(id) || record.id !== id || !digest(record.digest)) fail();
  let required, optional;
  if (kind === 'outbound') {
    required = ['id', 'digest', 'status', 'startedAt'];
    optional = record.status === 'sent' ? ['messageId', 'finishedAt'] : [];
    if (!['sent', 'outcome_unknown'].includes(record.status) || !time(record.startedAt) ||
        record.status === 'sent' && (!/^[1-9][0-9]{0,15}$/.test(record.messageId) || !time(record.finishedAt))) fail();
  } else {
    required = ['id', 'digest', 'status', 'messageId', 'sentAt', 'senderUid'];
    optional = ['text', 'dispatchedAt', 'acknowledgedAt'];
    if (!digest(id) || !nativeId(record.messageId) || !time(record.sentAt) ||
        !nativeUid(record.senderUid) || record.senderUid !== channel.pairedUid ||
        !['queued', 'dispatch_unknown', 'accepted', 'rejected'].includes(record.status) ||
        id !== nativeDigest([channel.accountId, channel.generation, channel.pairedUid, record.messageId])) fail();
    if (record.status === 'queued' && !Object.hasOwn(record, 'text')) fail();
    if (Object.hasOwn(record, 'text') && (typeof record.text !== 'string' || !record.text.trim() ||
        record.text.includes('\0') || Buffer.byteLength(record.text) > 8192 ||
        record.digest !== nativeDigest([record.messageId, record.sentAt, record.text]))) fail();
    for (const field of ['dispatchedAt', 'acknowledgedAt']) if (Object.hasOwn(record, field) && !time(record[field])) fail();
    if (record.status !== 'queued' && !time(record.dispatchedAt)) fail();
  }
  if (required.some(key => !Object.hasOwn(record, key)) ||
      Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) fail();
}

/** Each atomic snapshot is fsynced before rename. Single worker ownership is
 * required; pending provider/dispatch work is deliberately never replayed. */
export function createNativeJournal(root, channel, { io = fs } = {}) {
  root = nativeDirectory(root, { create: true, io });
  const file = path.join(root, `${nativeDigest([channel.accountId, channel.profile, channel.generation])}.json`);
  let state = { version: 1, inbound: {}, outbound: {} };
  try { state = JSON.parse(nativePrivateRead(file, MAX_BYTES, { io })); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('native_journal_unreadable'); }
  if (!plain(state) || Object.keys(state).length !== 3 || state.version !== 1 || !plain(state.inbound) || !plain(state.outbound)) fail();
  for (const kind of ['inbound', 'outbound']) {
    if (Object.keys(state[kind]).length > MAX_RECORDS) fail();
    for (const [id, record] of Object.entries(state[kind])) validateRecord(kind, id, record, channel);
  }
  let failed = false;
  function ready(kind) { if (failed) throw new Error('native_journal_unavailable'); if (!['inbound', 'outbound'].includes(kind)) fail(); }
  function save(next) {
    const temp = `${file}.${randomUUID()}.tmp`;
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('native_journal_capacity');
    try {
      nativeDirectory(root, { io });
      const fd = io.openSync(temp, 'wx', 0o600);
      try { io.writeFileSync(fd, encoded); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      io.renameSync(temp, file);
      // Windows tests do not prove directory fsync durability.
      if (process.platform !== 'win32') {
        const dir = io.openSync(root, 'r'); try { io.fsyncSync(dir); } finally { io.closeSync(dir); }
      }
      state = next;
    } catch {
      // Rename/fsync errors can happen after effect. Never consult stale RAM or
      // retry a provider action in this process; restart must read durable state.
      failed = true;
      throw new Error('native_journal_unavailable');
    }
  }
  function update(kind, id, record) {
    ready(kind); validateRecord(kind, id, record, channel);
    if (!Object.hasOwn(state[kind], id) && Object.keys(state[kind]).length >= MAX_RECORDS) throw new Error('native_journal_capacity');
    const next = { ...state, [kind]: { ...state[kind], [id]: { ...record } } };
    save(next); return { ...record };
  }
  return {
    get: (kind, id) => { ready(kind); return Object.hasOwn(state[kind], id) ? { ...state[kind][id] } : null; },
    values: kind => { ready(kind); return Object.values(state[kind]).map(record => ({ ...record })); },
    update,
    // Storage exhaustion fails closed instead of evicting dedup tombstones.
    admit(id, record) {
      ready('inbound');
      const existing = Object.hasOwn(state.inbound, id) ? state.inbound[id] : null;
      if (existing) return existing.digest === record.digest ? 'duplicate' : 'conflict';
      if (Object.keys(state.inbound).length >= 100000) throw new Error('native_journal_capacity');
      update('inbound', id, record); return 'queued';
    },
  };
}
