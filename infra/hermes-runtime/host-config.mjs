import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateNativeProvisioningConfiguration } from '../hermes-zalo-native/profile-provisioning.mjs';

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fail = () => { throw new Error('host_config_invalid'); };
const exact = (value, names, optional = []) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(name => !names.includes(name) && !optional.includes(name)) || names.some(name => !Object.hasOwn(value, name))) fail();
};
const inside = (root, file) => { const relative = path.relative(root, file); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) fail();
  return path.resolve(value);
}
function privateInfo(info, directory) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail();
  // Connector service requires Linux. Windows parsing tests do not prove ACLs.
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.gid !== process.getgid?.() ||
      (info.mode & 0o777) !== (directory ? 0o700 : 0o600))) fail();
}
async function privateDirectory(directory, optional = false) {
  let info;
  try { info = await lstat(directory); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  privateInfo(info, true); if (await realpath(directory) !== directory) fail();
}
async function privateRead(rawPath, maxBytes) {
  const filename = absolute(rawPath), storage = Buffer.alloc(maxBytes + 1);
  let handle, result;
  try {
    const before = await lstat(filename); privateInfo(before, false);
    if (before.size > maxBytes || await realpath(filename) !== filename) fail();
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const held = await handle.stat(); privateInfo(held, false);
    if (held.dev !== before.dev || held.ino !== before.ino || held.size > maxBytes) fail();
    let length = 0;
    while (length < storage.length) {
      const { bytesRead } = await handle.read(storage, length, storage.length - length, length);
      if (bytesRead === 0) break; length += bytesRead;
    }
    if (length > maxBytes) fail();
    const after = await lstat(filename); privateInfo(after, false);
    if (after.dev !== held.dev || after.ino !== held.ino || await realpath(filename) !== filename) fail();
    result = Buffer.from(storage.subarray(0, length)); return result;
  } catch { result?.fill(0); fail(); }
  finally {
    storage.fill(0);
    try { await handle?.close(); } catch { result?.fill(0); fail(); }
  }
}
// Decoded-key scanner; JSON.parse verifies grammar.
// Bounded private config accepts human-readable JSON but never duplicate keys.
function parse(buffer) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); let i = 0;
  const space = () => { while (/\s/.test(source[i] ?? '') && i < source.length) i++; };
  const string = () => {
    if (source[i] !== '"') fail(); const start = i++;
    while (i < source.length) { const c = source[i++]; if (c === '\\') i++; else if (c === '"') return JSON.parse(source.slice(start, i)); }
    fail();
  };
  const value = depth => {
    if (depth > 16) fail(); space();
    if (source[i] === '"') { string(); return; }
    if (source[i] === '{') {
      i++; space(); const names = new Set(); if (source[i] === '}') { i++; return; }
      for (;;) { space(); const key = string(); if (names.has(key)) fail(); names.add(key); space();
        if (source[i++] !== ':') fail(); value(depth + 1); space();
        const c = source[i++]; if (c === '}') return; if (c !== ',') fail(); }
    }
    if (source[i] === '[') { i++; space(); if (source[i] === ']') { i++; return; }
      for (;;) { value(depth + 1); space(); const c = source[i++]; if (c === ']') return; if (c !== ',') fail(); } }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
    if (!match) fail(); i += match[0].length;
  };
  value(0); space(); if (i !== source.length) fail(); return JSON.parse(source);
}
function httpList(values, origin) {
  if (!Array.isArray(values) || values.length > 64 || (!origin && values.length === 0) || new Set(values).size !== values.length) fail();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 512) fail();
    const parsed = new URL(origin ? value : `http://${value}`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
        (origin ? parsed.origin !== value : parsed.host !== value)) fail();
  }
  return Object.freeze([...values]);
}
// Safe connector defaults: per-connection sliding windows, a whole-invocation
// deadline with headroom for slow whole-company CRM reads yet below the Hermes
// MCP client timeout (30 s documented profile), and a short maintenance wait.
// The separately opted-in private read lane uses a bounded discovery catalog
// and current business SQL; all other operations retain their admission checks.
const CONNECTOR_LIMITS = Object.freeze({ requestsPerMinute: 60, toolCallsPerMinute: 30, callTimeoutMs: 20_000, maintenanceWaitMs: 5000 });
function connectorLimits(value) {
  if (value === undefined) return CONNECTOR_LIMITS;
  exact(value, [], Object.keys(CONNECTOR_LIMITS));
  const limits = { ...CONNECTOR_LIMITS, ...value };
  const within = (key, min, max) => Number.isSafeInteger(limits[key]) && limits[key] >= min && limits[key] <= max;
  if (!within('requestsPerMinute', 1, 600) || !within('toolCallsPerMinute', 1, limits.requestsPerMinute) ||
      !within('callTimeoutMs', 1000, 30_000) || !within('maintenanceWaitMs', 0, 10_000) ||
      // Wait + deadline must end before the 30 s MCP client timeout and 35 s idle cut-off.
      limits.callTimeoutMs + limits.maintenanceWaitMs > 25_000) fail();
  return Object.freeze(limits);
}

/** Private connector config only (`version: 2`, `mode: "connector"`): no env
 * fallback, provisioning, network or listener.
 * This read-only loader obtains stateRoot before the host acquires its durable
 * ownership marker. The host must hold that marker before any state mutation.
 * Caller creates absent fixed subdirectories privately after validation, copies
 * keys into backend + WAL, then disposes this original ring even on setup error.
 * JavaScript password strings cannot be guaranteed zeroed; never log config.
 */
export async function loadHostConfiguration(configPath) {
  const owned = [], keys = new Map();
  try {
    const configFile = absolute(configPath), bytes = await privateRead(configFile, 32768);
    let input;
    try { input = parse(bytes); } finally { bytes.fill(0); }
    if (input?.version !== 2 || input?.mode !== 'connector') fail();
    exact(input, ['version', 'mode', 'supabase', 'store', 'encryption', 'http', 'stateRoot', 'listenPort'], ['limits', 'zaloProvisioning', 'readFastPath', 'roomRead']);
    if (Object.hasOwn(input, 'readFastPath') && typeof input.readFastPath !== 'boolean') fail();
    // Direct room tool source: 'legacy' (default) or 'page' (B3 hermes_available_rooms_page_v1).
    if (Object.hasOwn(input, 'roomRead') && !['legacy', 'page'].includes(input.roomRead)) fail();
    const limits = connectorLimits(input.limits);
    exact(input.supabase, ['url', 'publishableKey']); exact(input.store, ['projectRef', 'host', 'role', 'passwordFile'], ['caFile']);
    exact(input.encryption, ['activeKeyVersion', 'keys']); exact(input.http, ['allowedHosts', 'allowedOrigins']);
    if (!Number.isSafeInteger(input.listenPort) || input.listenPort < 1 || input.listenPort > 65535) fail();
    const { projectRef, host, role } = input.store;
    if (typeof projectRef !== 'string' || !/^[a-z0-9]{20}$/.test(projectRef) ||
        (host !== `db.${projectRef}.supabase.co` && (typeof host !== 'string' || !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host))) ||
        typeof role !== 'string' || !/^hermes_store_[a-z0-9_]{1,40}$/.test(role) || role === 'hermes_store_executor') fail();
    const url = new URL(input.supabase.url);
    if (url.origin !== `https://${projectRef}.supabase.co` || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        typeof input.supabase.publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(input.supabase.publishableKey)) fail();
    const http = Object.freeze({ allowedHosts: httpList(input.http.allowedHosts, false), allowedOrigins: httpList(input.http.allowedOrigins, true) });
    const stateRoot = absolute(input.stateRoot); await privateDirectory(stateRoot);
    const paths = Object.freeze({ stateRoot, handoffDirectory: path.join(stateRoot, 'handoff') });
    await privateDirectory(paths.handoffDirectory, true);
    const refs = input.encryption.keys, { activeKeyVersion } = input.encryption;
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 16 || typeof activeKeyVersion !== 'string' || !VERSION.test(activeKeyVersion)) fail();
    const versions = new Set(), secretFiles = [input.store.passwordFile, ...(input.store.caFile === undefined ? [] : [input.store.caFile])];
    for (const ref of refs) {
      exact(ref, ['version', 'file']);
      if (typeof ref.version !== 'string' || !VERSION.test(ref.version) || versions.has(ref.version)) fail();
      versions.add(ref.version); secretFiles.push(ref.file);
    }
    if (!versions.has(activeKeyVersion)) fail();
    for (const file of [configFile, ...secretFiles]) {
      const target = absolute(file);
      // Secrets never live inside the encrypted WAL directory.
      if (inside(paths.handoffDirectory, target)) fail();
    }
    let password, ca;
    const passwordBytes = await privateRead(input.store.passwordFile, 4096);
    try { password = new TextDecoder('utf-8', { fatal: true }).decode(passwordBytes); } finally { passwordBytes.fill(0); }
    if (password.length < 16 || password.length > 4096 || /[\r\n\0]/.test(password)) fail();
    if (input.store.caFile !== undefined) {
      const caBytes = await privateRead(input.store.caFile, 65536);
      try { ca = new TextDecoder('utf-8', { fatal: true }).decode(caBytes); } finally { caBytes.fill(0); }
      if (!ca.includes('-----BEGIN CERTIFICATE-----')) fail();
    }
    for (const ref of refs) {
      const material = await privateRead(ref.file, 32); owned.push(material);
      if (material.length !== 32) fail(); keys.set(ref.version, material);
    }
    const zaloProvisioning=input.zaloProvisioning===undefined?undefined:validateNativeProvisioningConfiguration(input.zaloProvisioning);
    if(zaloProvisioning) for(const target of [zaloProvisioning.configFile,zaloProvisioning.stateRoot,...zaloProvisioning.profiles.map(row=>row.home)]) {
      if(inside(paths.handoffDirectory,target)||inside(target,paths.handoffDirectory))fail();
    }
    let disposed = false;
    return Object.freeze({ supabase: Object.freeze({ url: url.origin, publishableKey: input.supabase.publishableKey }),
      store: Object.freeze({ projectRef, host, role, password, ...(ca === undefined ? {} : { ca }) }),
      encryption: Object.freeze({ activeKeyVersion, keys }), http, paths, ...(zaloProvisioning===undefined?{}:{zaloProvisioning}),
      ...(input.readFastPath === undefined ? {} : { readFastPath: input.readFastPath }),
      ...(input.roomRead === undefined ? {} : { roomRead: input.roomRead }), mode: 'connector', limits, listenPort: input.listenPort,
      dispose() { if (disposed) return; disposed = true; for (const material of owned) material.fill(0); keys.clear(); },
    });
  } catch { for (const material of owned) material.fill(0); keys.clear(); fail(); }
}
