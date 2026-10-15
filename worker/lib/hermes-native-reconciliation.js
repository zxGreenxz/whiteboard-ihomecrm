import fs from 'node:fs';
import { nativeAbsolute, nativePrivateRead } from './hermes-native-files.js';
import { nativeId } from './hermes-native-config.js';

// Human reconciliation ledger: a private append-only file beside the config,
// written only by the local operator CLI. The worker mounts the config
// directory read-only and only reads it; one validator serves both sides.
export const NATIVE_RECONCILIATION_MAX_BYTES = 1024 * 1024;
export const NATIVE_RECONCILIATION_MAX_ENTRIES = 100000;
export const NATIVE_RECONCILIATION_ENTRY_KEYS = Object.freeze(['profile', 'accountId', 'generation', 'requestId',
  'recordDigest', 'startedAt', 'decision', 'note', 'decidedAt']);
export const nativeReconciliationFile = configFile => `${nativeAbsolute(configFile)}.reconciliations.json`;

const full = (re, value) => typeof value === 'string' && re.exec(value)?.[0] === value;
const uuid = value => full(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/, value);
const plainObject = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const fail = () => { throw new Error('native_reconciliation_invalid'); };
// eslint-disable-next-line no-control-regex
export const validNativeNote = value => typeof value === 'string' && value.length >= 1 && value.length <= 500 && value.trim() !== '' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

/** Reads the ledger file itself (nativeReconciliationFile of the config).
 * Synchronous so a caller can check and admit without an await between.
 * Absent ledger is empty; unsafe file guards throw their own error; any parse
 * or schema problem throws native_reconciliation_invalid. Never repairs. */
export function readNativeReconciliations(ledgerFile, { io = fs } = {}) {
  const file = nativeAbsolute(ledgerFile);
  try { io.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { file, raw: null, entries: [] }; throw error; }
  const raw = nativePrivateRead(file, NATIVE_RECONCILIATION_MAX_BYTES, { io });
  let value;
  try { value = JSON.parse(raw); } catch { fail(); }
  if (!plainObject(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.entries) ||
      value.entries.length > NATIVE_RECONCILIATION_MAX_ENTRIES) fail();
  const seen = new Set();
  for (const entry of value.entries) {
    if (!plainObject(entry) || Object.keys(entry).length !== NATIVE_RECONCILIATION_ENTRY_KEYS.length ||
        NATIVE_RECONCILIATION_ENTRY_KEYS.some(key => !Object.hasOwn(entry, key)) ||
        !full(/[a-z][a-z0-9_-]{0,63}/, entry.profile) || !uuid(entry.accountId) || !uuid(entry.generation) ||
        !nativeId(entry.requestId) || !full(/[a-f0-9]{64}/, entry.recordDigest) ||
        !Number.isSafeInteger(entry.startedAt) || entry.startedAt < 0 ||
        !['sent', 'not_sent'].includes(entry.decision) || !validNativeNote(entry.note) ||
        typeof entry.decidedAt !== 'string' || !Number.isFinite(Date.parse(entry.decidedAt))) fail();
    const key = JSON.stringify([entry.profile, entry.generation, entry.requestId]);
    if (seen.has(key)) fail();
    seen.add(key);
  }
  return { file, raw, entries: value.entries };
}

/** A decision is evidence only for the exact unknown record it was made about:
 * same channel binding and generation, same request ID, digest and start time. */
export function nativeReconciliationFor(entries, channel, record) {
  if (record?.status !== 'outcome_unknown') return null;
  return entries.find(entry => entry.profile === channel.profile && entry.accountId === channel.accountId &&
    entry.generation === channel.generation && entry.requestId === record.id &&
    entry.recordDigest === record.digest && entry.startedAt === record.startedAt) ?? null;
}
