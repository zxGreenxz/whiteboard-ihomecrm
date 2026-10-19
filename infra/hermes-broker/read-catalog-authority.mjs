import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new BrokerError(code); };

/** Read discovery only. The live business RPC decides current grants and output
 * scope. This cache never supplies writer/group/schedule authority. Each lookup
 * rereads the joined connection, preserving revoke, settings and credential CAS. */
export function createReadCatalogAuthority({ authority, connectionStore, clock = Date.now, ttlMs = 300000, maxEntries = 256 } = {}) {
  if ([authority?.resolve, authority?.identifyConnection, authority?.checkUnchanged, connectionStore?.readConnection, clock].some(fn => typeof fn !== 'function') ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024)
    throw new TypeError('invalid_read_catalog_authority');
  const cache = new Map();
  const check = signal => { if (!(signal instanceof AbortSignal) || signal.aborted) fail('timeout'); };
  const joined = async (token, signal) => {
    check(signal);
    if (typeof token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(token)) fail('unauthorized');
    const tokenDigest = hash(token);
    let snapshot;
    try { snapshot = await connectionStore.readConnection({ tokenDigest }, { signal }); }
    catch (error) {
      if (error instanceof DurableConnectionStoreError && error.code === 'store_denied') fail('forbidden');
      fail('backend_unavailable');
    }
    check(signal);
    if (snapshot === null || snapshot?.status !== 'active' || snapshot.connection?.state !== 'active' ||
        snapshot.connection.tokenDigest !== tokenDigest || snapshot.connection.expiresAt <= clock() || snapshot.session?.expiresAt <= clock()) {
      cache.delete(tokenDigest); fail('unauthorized');
    }
    // Include every persisted binding/projection field, not only epoch. Registry
    // projection may change without bumping a connection's settings epoch.
    const key = hash(JSON.stringify(snapshot));
    return { tokenDigest, snapshot, key };
  };
  return Object.freeze({
    identifyConnection: (token, options) => authority.identifyConnection(token, options),
    async resolve(token, { signal } = {}) {
      const { tokenDigest, snapshot, key } = await joined(token, signal), entry = cache.get(tokenDigest);
      if (entry?.key === key && entry.until > clock()) return entry.identity;
      cache.delete(tokenDigest);
      const identity = await authority.resolve(token, { signal }); check(signal);
      if (identity.row.id !== snapshot.connection.id || identity.row.userId !== snapshot.connection.userId ||
          identity.row.organizationId !== snapshot.connection.organizationId || identity.row.epoch !== snapshot.connection.epoch)
        fail('context_changed');
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(tokenDigest, { key, identity, until: Math.min(clock() + ttlMs, snapshot.connection.expiresAt, snapshot.session.expiresAt) });
      return identity;
    },
    // Required by the broker dependency contract; new read invocations explicitly
    // skip it. Calling this through any other path retains fresh authority.
    checkUnchanged: (token, receipt, options) => authority.checkUnchanged(token, receipt, options),
  });
}
