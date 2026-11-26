// Runs as the connector UID. The worker receives only an authorization decision.
import http from 'node:http';
import { loadHostConfiguration } from '../hermes-runtime/host-config.mjs';
import { createStorePool } from '../hermes-broker/store-pool.mjs';
import { createStoreTransport } from '../hermes-broker/store-transport.mjs';
import { uuid } from './fleet-plan.mjs';

export function bindingFromProfile(profile) {
  if (typeof profile !== 'string' || !/^nv-[0-9a-z]{1,25}$/.test(profile)) return null;
  let value = 0n;
  for (const digit of profile.slice(3)) value = value * 36n + BigInt(parseInt(digit, 36));
  if ('nv-' + value.toString(36) !== profile) return null;
  const hex = value.toString(16).padStart(32, '0');
  const match = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/.exec(hex);
  const id = match?.slice(1).join('-');
  return uuid(id) ? id : null;
}

export async function authorizedPeer(call, scope, channel, expected = null) {
  const bindingId = bindingFromProfile(channel?.profile);
  if (!bindingId || !uuid(scope.organizationId) || !uuid(scope.accountId) || channel.accountId !== scope.accountId) return false;
  const origin = await call('readZaloBinding', { bindingId });
  if (origin?.bindingId !== bindingId || !['active', 'revoked'].includes(origin.status) ||
      origin.organizationId !== scope.organizationId || origin.accountId !== scope.accountId ||
      !uuid(origin.userId) || !uuid(origin.assistantId) || ![channel.ownUid,channel.pairedUid].every(uid => typeof uid === 'string' && /^[1-9]\d{0,39}$/.test(uid)) ||
      origin.senderUid !== channel.pairedUid || origin.ownUid !== channel.ownUid) return false;
  const work = await call('readZaloProvisioningWork', { assistantId: origin.assistantId, accountId: scope.accountId });
  const current = work?.binding;
  // A fresh pairing of the same nick can reuse the home only after verification.
  if (work?.status !== 'queued' || !Number.isSafeInteger(work.revision) || work.revision < 1 ||
      current?.status !== 'active' || !uuid(current.bindingId) || !uuid(current.connectionId) ||
      !['userId', 'assistantId', 'organizationId', 'accountId', 'senderUid', 'ownUid'].every(key => origin[key] === current[key])) return false;
  if (!expected) return work.provisioningState === 'synchronized';
  return work.provisioningState === 'restart_pending' && work.revision === expected.revision &&
    current.bindingId === expected.bindingId && current.connectionId === expected.connectionId;
}

async function serve() {
  if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') throw Error('socket_required');
  const [file, organizationId, accountId] = process.argv.slice(2);
  if (![organizationId, accountId].every(uuid)) throw Error('invalid_scope');
  const config = await loadHostConfiguration(file);
  const pool = createStorePool(config.store);
  const transport = createStoreTransport({ pool, expectedRole: config.store.role });
  const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 2048 }, async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/authorize', '/verify'].includes(req.url)) { res.writeHead(400).end(); return; }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 512) throw Error('oversize');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const allowed = await authorizedPeer((op, input) => transport.call(op, input), { organizationId, accountId },
        body, req.url === '/verify' ? (body.expected ?? {}) : null);
      res.writeHead(allowed ? 204 : 403).end();
    } catch { res.writeHead(503).end(); }
  });
  server.maxConnections = 32;
  server.listen({ fd: 3 });
  process.once('SIGTERM', () => server.close(() => void pool.end()));
}
if (import.meta.main) serve().catch(() => { console.error('binding_guard_unavailable'); process.exitCode = 1; });
