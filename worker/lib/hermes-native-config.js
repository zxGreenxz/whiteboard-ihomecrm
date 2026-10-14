import { nativeAbsolute, nativeDirectory, nativePrivateRead } from './hermes-native-files.js';

const full = (re, value) => typeof value === 'string' && re.exec(value)?.[0] === value;
export const nativeUid = value => full(/[1-9][0-9]{0,39}/, value);
export const nativeId = value => full(/[A-Za-z0-9_-]{1,128}/, value);
const uuid = value => full(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/, value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Local operator grant. CRM connection tokens, JWTs and availability are not
 * channel authority. The file belongs to the worker operator, not the model. */
export function readNativeConfig(filename = process.env.HERMES_ZALO_NATIVE_CONFIG) {
  if (!filename) return null;
  let value;
  try { value = JSON.parse(nativePrivateRead(filename, 65536)); }
  catch { throw new Error('invalid_native_config'); }
  return resolveNativeConfig(value);
}

/** Shared validation for the worker and local operator. Read-only callers must
 * require an existing state directory; a preview may supply its unissued token. */
export function resolveNativeConfig(value, {
  createState = true, readToken = file => nativePrivateRead(file, 128).trim(),
} = {}) {
  if (!exact(value, ['version', 'stateRoot', 'listenPort', 'channels']) || value.version !== 1 ||
      !Number.isInteger(value.listenPort) || value.listenPort < 1024 || value.listenPort > 65535 ||
      !Array.isArray(value.channels) || !value.channels.length || value.channels.length > 100) throw new Error('invalid_native_config');
  const profiles = new Set(), peers = new Set(), tokens = new Set();
  const channels = value.channels.map(input => {
    if (!exact(input, ['accountId', 'ownUid', 'pairedUid', 'mainUid', 'profile', 'generation', 'tokenFile'])) throw new Error('invalid_native_channel');
    const { accountId, ownUid, pairedUid, mainUid, profile, generation, tokenFile } = input;
    if (!uuid(accountId) || !uuid(generation) || !nativeUid(ownUid) || !nativeUid(pairedUid) ||
        ownUid === pairedUid || mainUid !== pairedUid || !full(/[a-z][a-z0-9_-]{0,63}/, profile) ||
        profiles.has(profile) || peers.has(`${accountId}:${pairedUid}`)) throw new Error('invalid_native_channel');
    const token = readToken(tokenFile);
    if (!full(/hzn_[a-f0-9]{64}/, token) || tokens.has(token)) throw new Error('invalid_native_channel_token');
    profiles.add(profile); peers.add(`${accountId}:${pairedUid}`); tokens.add(token);
    return Object.freeze({ accountId, ownUid, pairedUid, mainUid, profile, generation, token });
  });
  for (const channel of channels) {
    if (channels.some(other => other.accountId === channel.accountId && other.ownUid !== channel.ownUid)) throw new Error('native_account_identity_conflict');
  }
  const stateRoot = nativeAbsolute(value.stateRoot);
  nativeDirectory(stateRoot, { create: createState });
  return Object.freeze({ stateRoot, listenPort: value.listenPort, channels: Object.freeze(channels) });
}
