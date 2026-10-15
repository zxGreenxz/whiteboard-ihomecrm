import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, opendir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const DOMAIN = 'ihomecrm/hermes/host-connection-handoff:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const IDS = ['connectionId', 'assistantId', 'userId', 'organizationId', 'operationId'];
const RECORD = [...IDS, 'token'];
const ENVELOPE = ['v', 'algorithm', 'keyVersion', 'binding', 'nonce', 'ciphertext', 'tag'];
const MAX_FILE_BYTES = 2048;
const OWNERS = new Map();
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;

export class ConnectionHandoffError extends Error {
  constructor(code) { super(code); this.name = 'ConnectionHandoffError'; this.code = code; }
}
const fail = code => { throw new ConnectionHandoffError(code); };
function snapshot(value, required, optional = [], code = 'handoff_record_invalid') {
  try {
    if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(code);
    const names = Reflect.ownKeys(value);
    if (names.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !names.includes(key))) fail(code);
    const result = {};
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
      result[key] = descriptor.value;
    }
    return result;
  } catch { fail(code); }
}
function record(value) {
  const data = snapshot(value, RECORD);
  if (IDS.some(key => typeof data[key] !== 'string' || !UUID.test(data[key])) || typeof data.token !== 'string' || !TOKEN.test(data.token)) fail('handoff_record_invalid');
  return Object.freeze(Object.fromEntries(RECORD.map(key => [key, data[key]])));
}
function binding(value) {
  const data = snapshot(value, IDS, [], 'handoff_ciphertext_invalid');
  if (IDS.some(key => typeof data[key] !== 'string' || !UUID.test(data[key]))) fail('handoff_ciphertext_invalid');
  return Object.freeze(Object.fromEntries(IDS.map(key => [key, data[key]])));
}
function signalFrom(options) {
  const { signal } = snapshot(options === undefined ? {} : options, [], ['signal'], 'handoff_options_invalid');
  try { if (signal !== undefined) aborted.call(signal); } catch { fail('handoff_options_invalid'); }
  return signal;
}
function decode(value, bytes) {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) fail('handoff_ciphertext_invalid');
  const result = Buffer.from(value, 'base64url');
  if (result.length !== bytes || result.toString('base64url') !== value) fail('handoff_ciphertext_invalid');
  return result;
}
function envelope(value) {
  const data = snapshot(value, ENVELOPE, [], 'handoff_ciphertext_invalid');
  if (data.v !== 1 || data.algorithm !== 'A256GCM' || typeof data.keyVersion !== 'string' || !VERSION.test(data.keyVersion)) fail('handoff_ciphertext_invalid');
  return Object.freeze({ v: 1, algorithm: 'A256GCM', keyVersion: data.keyVersion, binding: binding(data.binding),
    nonce: data.nonce, ciphertext: data.ciphertext, tag: data.tag });
}

/** Pure, host-only cryptography. Key material is injected, copied and domain
 * separated from session encryption; rotation keeps old versions readable.
 * Strings returned to the trusted host cannot be reliably zeroed by JavaScript.
 */
export function createHandoffCipher(options) {
  const { activeKeyVersion, keys } = snapshot(options, ['activeKeyVersion', 'keys'], [], 'handoff_config_invalid');
  const keyring = new Map();
  try {
    if (typeof activeKeyVersion !== 'string' || !VERSION.test(activeKeyVersion) || !(keys instanceof Map) ||
        mapSize.call(keys) < 1 || mapSize.call(keys) > 16 || !Map.prototype.has.call(keys, activeKeyVersion)) fail('handoff_config_invalid');
    for (const [version, supplied] of Map.prototype.entries.call(keys)) {
      if (typeof version !== 'string' || !VERSION.test(version) || !(supplied instanceof Uint8Array) || supplied.byteLength !== 32) fail('handoff_config_invalid');
      const copy = Buffer.from(supplied);
      try { keyring.set(version, Buffer.from(hkdfSync('sha256', copy, DOMAIN, `A256GCM:${version}`, 32))); }
      finally { copy.fill(0); }
    }
  } catch { for (const key of keyring.values()) key.fill(0); fail('handoff_config_invalid'); }
  let destroyed = false;
  const keyFor = version => {
    if (destroyed || !keyring.has(version)) fail('handoff_key_unavailable');
    return keyring.get(version);
  };
  const aad = (owner, version) => Buffer.from(JSON.stringify([DOMAIN, 1, 'A256GCM', version, ...IDS.map(key => owner[key])]));
  return Object.freeze({
    seal(raw) {
      const data = record(raw), owner = Object.freeze(Object.fromEntries(IDS.map(key => [key, data[key]])));
      const plaintext = Buffer.from(data.token, 'ascii');
      try {
        const cipherNonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor(activeKeyVersion), cipherNonce, { authTagLength: 16 });
        cipher.setAAD(aad(owner, activeKeyVersion));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return Object.freeze({ v: 1, algorithm: 'A256GCM', keyVersion: activeKeyVersion, binding: owner,
          nonce: cipherNonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
      } catch (error) {
        if (error instanceof ConnectionHandoffError) throw error;
        fail('handoff_ciphertext_invalid');
      } finally { plaintext.fill(0); }
    },
    open(raw) {
      const data = envelope(raw), key = keyFor(data.keyVersion);
      let plaintext;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, decode(data.nonce, 12), { authTagLength: 16 });
        decipher.setAAD(aad(data.binding, data.keyVersion)); decipher.setAuthTag(decode(data.tag, 16));
        plaintext = Buffer.concat([decipher.update(decode(data.ciphertext, 46)), decipher.final()]);
        return record({ ...data.binding, token: plaintext.toString('utf8') });
      } catch { fail('handoff_ciphertext_invalid'); }
      finally { plaintext?.fill(0); }
    },
    destroy() { destroyed = true; for (const key of keyring.values()) key.fill(0); keyring.clear(); },
  });
}

const serialize = value => JSON.stringify(value) + '\n';
const sameRecord = (a, b) => RECORD.every(key => a[key] === b[key]);
function privateInfo(info, directory) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (!directory && (info.size < 0 || info.size > MAX_FILE_BYTES)) ||
      (process.platform !== 'win32' && (info.uid !== process.getuid() || info.gid !== process.getgid() ||
        (info.mode & 0o777) !== (directory ? 0o700 : 0o600)))) fail('handoff_path_refused');
}

/** Immutable encrypted WAL on a dedicated, pre-existing trusted host directory.
 * Never mount it in a runtime. The factory is inert. Operations are serialized
 * and bounded inside this process; the deployment MUST provide one writer per
 * directory across processes. There is deliberately no PID/TTL lock takeover.
 * Native directory fsync is mandatory (unsupported platforms fail closed).
 * Unknown writes retain encrypted pending/final files for explicit recovery;
 * list never activates a connection, recovers partial files or deletes history.
 */
export function createConnectionHandoff(options) {
  const config = snapshot(options, ['directory', 'activeKeyVersion', 'keys'], ['maxRecords'], 'handoff_config_invalid');
  const { directory, activeKeyVersion, keys, maxRecords = 64 } = config;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory) ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 256) fail('handoff_config_invalid');
  const root = path.resolve(directory), cipher = createHandoffCipher({ activeKeyVersion, keys }), identity = {};
  let tail = Promise.resolve(), count = 0, closing = false, closed, owned = false;

  function enqueue(operation) {
    if (closing) return Promise.reject(new ConnectionHandoffError('handoff_closed'));
    if (count >= 16) return Promise.reject(new ConnectionHandoffError('handoff_busy'));
    count++;
    const result = tail.then(operation);
    tail = result.then(() => { count--; }, () => { count--; });
    return result;
  }
  async function withDirectory(signal, operation) {
    let handle, mutated = false;
    const live = () => { if (signal !== undefined && aborted.call(signal)) fail(mutated ? 'handoff_outcome_unknown' : 'handoff_cancelled'); };
    try {
      live();
      if (!['linux', 'darwin', 'win32'].includes(process.platform)) fail('handoff_platform_unsupported');
      const info = await lstat(root); privateInfo(info, true); live();
      if (await realpath(root) !== root) fail('handoff_path_refused'); live();
      if (OWNERS.has(root) && OWNERS.get(root) !== identity) fail('handoff_directory_in_use');
      OWNERS.set(root, identity); owned = true;
      handle = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat(); privateInfo(opened, true);
      if (opened.dev !== info.dev || opened.ino !== info.ino) fail('handoff_path_refused');
      const checkRoot = async () => {
        const current = await lstat(root); privateInfo(current, true);
        if (current.dev !== opened.dev || current.ino !== opened.ino || await realpath(root) !== root) fail('handoff_path_refused');
        live();
      };
      live();
      return await operation({ handle, live, checkRoot, markMutation() { mutated = true; } });
    } catch (error) {
      if (mutated) fail('handoff_outcome_unknown');
      if (error instanceof ConnectionHandoffError) throw error;
      fail('handoff_unavailable');
    } finally {
      try { await handle?.close(); } catch { fail(mutated ? 'handoff_outcome_unknown' : 'handoff_unavailable'); }
    }
  }
  async function readFile(name, live) {
    const filename = path.join(root, name);
    const info = await lstat(filename); privateInfo(info, false); live();
    if (await realpath(filename) !== filename) fail('handoff_path_refused');
    let handle;
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    try {
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat(); privateInfo(opened, false);
      if (opened.dev !== info.dev || opened.ino !== info.ino) fail('handoff_path_refused'); live();
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); live();
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) fail('handoff_ciphertext_invalid');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      let parsed;
      try { parsed = envelope(JSON.parse(text)); } catch { fail('handoff_ciphertext_invalid'); }
      // Canonical bytes reject duplicated JSON keys and partially written records.
      if (serialize(parsed) !== text) fail('handoff_ciphertext_invalid');
      return cipher.open(parsed);
    } finally { bytes.fill(0); await handle?.close(); }
  }
  async function inventory(live) {
    const entries = [], committed = [], operations = new Set();
    const dir = await opendir(root);
    try {
      for await (const entry of dir) {
        live(); if (entries.length >= maxRecords * 2) fail('handoff_capacity');
        const final = entry.name.endsWith('.handoff.json') && UUID.test(entry.name.slice(0, -13));
        const pending = entry.name.startsWith('.handoff-') && entry.name.endsWith('.pending') && UUID.test(entry.name.slice(9, -8));
        if ((!final && !pending) || !entry.isFile()) fail('handoff_path_refused');
        entries.push(entry.name);
        if (final) {
          const data = await readFile(entry.name, live);
          if (data.connectionId !== entry.name.slice(0, -13) || operations.has(data.operationId)) fail('handoff_conflict');
          operations.add(data.operationId); committed.push(data);
          if (committed.length > maxRecords) fail('handoff_capacity');
        } else {
          privateInfo(await lstat(path.join(root, entry.name)), false); live();
        }
      }
    } finally { if (!dir.closed) { try { await dir.close(); } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error; } } }
    return { entries, committed };
  }

  return Object.freeze({
    async stage(raw, options) {
      const data = record(raw), signal = signalFrom(options);
      return enqueue(() => withDirectory(signal, async ({ handle, live, checkRoot, markMutation }) => {
        // Refuse unsupported durability before creating any file.
        await handle.sync(); live();
        const { entries, committed } = await inventory(live); await checkRoot();
        const existing = committed.find(item => item.connectionId === data.connectionId || item.operationId === data.operationId);
        if (existing) {
          if (!sameRecord(existing, data)) fail('handoff_conflict');
          const file = await open(path.join(root, `${data.connectionId}.handoff.json`), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
          try { privateInfo(await file.stat(), false); await file.sync(); } finally { await file.close(); }
          live(); await checkRoot(); await handle.sync(); live();
          return Object.freeze({ status: 'stored', connectionId: data.connectionId, operationId: data.operationId });
        }
        if (entries.length >= maxRecords) fail('handoff_capacity');
        const bytes = Buffer.from(serialize(cipher.seal(data)));
        const pending = path.join(root, `.handoff-${randomUUID()}.pending`), final = path.join(root, `${data.connectionId}.handoff.json`);
        let file;
        try {
          live(); markMutation();
          file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
          privateInfo(await file.stat(), false); live();
          await file.writeFile(bytes); live(); await file.sync(); live();
        } finally { bytes.fill(0); await file?.close(); }
        await checkRoot();
        // Hard-link publication is atomic and cannot overwrite an existing record.
        await link(pending, final); live(); await handle.sync(); live();
        await checkRoot(); await unlink(pending); live(); await handle.sync(); live();
        return Object.freeze({ status: 'stored', connectionId: data.connectionId, operationId: data.operationId });
      }));
    },
    async list(options) {
      const signal = signalFrom(options);
      return enqueue(() => withDirectory(signal, async ({ live, checkRoot }) => {
        const { committed } = await inventory(live); await checkRoot();
        return Object.freeze(committed.sort((a, b) => a.connectionId.localeCompare(b.connectionId)));
      }));
    },
    close() {
      if (!closed) {
        closing = true;
        closed = tail.then(() => { cipher.destroy(); if (owned && OWNERS.get(root) === identity) OWNERS.delete(root); });
      }
      return closed;
    },
  });
}
