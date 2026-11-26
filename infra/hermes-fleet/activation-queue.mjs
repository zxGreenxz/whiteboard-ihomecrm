// Runs as the connector UID. Only metadata crosses the pipe back to the fleet supervisor.
import fs from 'node:fs';
import { createConnectionHandoff } from '../hermes-broker/connection-handoff.mjs';
import { createStorePool } from '../hermes-broker/store-pool.mjs';
import { createStoreTransport } from '../hermes-broker/store-transport.mjs';
import { loadHostConfiguration } from '../hermes-runtime/host-config.mjs';
import { uuid } from './fleet-plan.mjs';

const identity = ['organizationId', 'userId', 'assistantId', 'connectionId'];
const same = (a, b, fields) => fields.every(field => a[field] === b[field]);
const revision = n => Number.isSafeInteger(n) && n > 0;

export async function queuedEmployees({ organizationId, accountId, enrollments, read }) {
  if (![organizationId, accountId].every(uuid)) throw Error('invalid_scope');
  const local = enrollments.filter(member => member.organizationId === organizationId);
  const candidates = [];
  for (const assistantId of new Set(local.map(member => member.assistantId))) {
    if (!uuid(assistantId)) throw Error('invalid_assistant');
    const work = await read({ assistantId, accountId });
    if (work?.status === 'empty') continue;
    if (work?.status !== 'queued' || !revision(work.revision)) throw Error('invalid_queue');
    const b = work.binding;
    if (b?.status !== 'active' || work.provisioningState === 'synchronized') continue;
    if (!same(b, { organizationId, accountId, assistantId }, ['organizationId','accountId','assistantId']) ||
        ![...identity, 'bindingId'].every(k => uuid(b[k])) || !/^[1-9]\d{0,39}$/.test(b.senderUid)) continue;
    if (local.filter(member => same(member, b, identity)).length !== 1) continue;
    candidates.push({ organizationId, accountId, assistantId, userId: b.userId, connectionId: b.connectionId,
      bindingId: b.bindingId, senderUid: b.senderUid, revision: work.revision, state: work.provisioningState });
  }
  return candidates;
}

export async function acknowledge(transport, row, state) {
  if (!['restart_pending','unavailable','synchronized'].includes(state) || !revision(row.revision) ||
      ![...identity,'bindingId','accountId'].every(k => uuid(row[k]))) throw Error('invalid_receipt');
  const selector = { assistantId: row.assistantId, accountId: row.accountId };
  const current = await transport.call('readZaloProvisioningWork', selector);
  if (current?.revision !== row.revision || current?.binding?.status !== 'active' ||
      !same(current.binding, row, [...identity,'bindingId','accountId','senderUid'])) return false;
  const result = await transport.call('acknowledgeZaloProvisioning', { ...selector, bindingId: row.bindingId,
    expectedRevision: row.revision, state });
  return result?.status === 'recorded';
}

async function run([command, configFile, org, bot]) {
  const cfg = await loadHostConfiguration(configFile);
  const pool = createStorePool(cfg.store);
  try {
    const transport = createStoreTransport({ pool, expectedRole: cfg.store.role });
    if (command === 'ack') {
      const { row, state } = JSON.parse(fs.readFileSync(0, 'utf8'));
      if (row.organizationId !== org || row.accountId !== bot) throw Error('invalid_scope');
      return await acknowledge(transport, row, state);
    }
    if (command !== 'list') throw Error('invalid_command');
    const handoff = createConnectionHandoff({ directory: cfg.paths.handoffDirectory, ...cfg.encryption });
    try {
      return await queuedEmployees({ organizationId: org, accountId: bot, enrollments: await handoff.list(),
        read: selector => transport.call('readZaloProvisioningWork', selector) });
    } finally { await handoff.close(); }
  } finally { await pool.end(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await run(process.argv.slice(2)))); }
  catch { console.error('activation_queue_unavailable'); process.exitCode = 1; }
}
