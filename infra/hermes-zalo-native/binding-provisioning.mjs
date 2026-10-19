import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
import { nativePrivateRead } from '../../worker/lib/hermes-native-files.js';
import { planNativeGrant, applyNativeGrant } from './operator.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const uid = value => typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value);
const fail = () => { throw new Error('native_binding_provisioning_denied'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Host-only bridge from canonical SQL identity to the EXISTING native operator.
 * profileBinding belongs to host configuration, never provider text/model args.
 * Read-only by default; apply binds both the SQL snapshot and operator revision.
 * Disk update still requires the normal controlled worker restart/secret delivery.
 * Credential changes leave the native token/generation/journal untouched.
 */
export async function provisionNativeBinding({ transport, bindingId, profileBinding, configFile, tokenFile,
  stateRoot, listenPort, apply = false, expect, signal } = {}) {
  if (typeof transport?.call !== 'function' || !uuid(bindingId) || !(signal instanceof AbortSignal) || signal.aborted ||
      !profileBinding || !['assistantId','userId','organizationId'].every(key => uuid(profileBinding[key])) ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(profileBinding.profile ?? '') || typeof configFile !== 'string') fail();
  const read = async () => {
    const row = await transport.call('readZaloBinding', { bindingId }, { signal });
    const keys = ['bindingId','bindingEpoch','assistantId','userId','organizationId','accountId','ownUid','senderUid','connectionId','status'];
    if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row,key)) ||
        row.bindingId !== bindingId || !Number.isSafeInteger(row.bindingEpoch) || row.bindingEpoch < 1 ||
        !['assistantId','userId','organizationId'].every(key => row[key] === profileBinding[key]) ||
        !uuid(row.accountId) || !uid(row.senderUid) || !['active','revoked','unavailable'].includes(row.status) ||
        !(row.connectionId === null || uuid(row.connectionId)) || !(row.ownUid === null || uid(row.ownUid)) ||
        row.status === 'active' && (!uuid(row.connectionId) || !uid(row.ownUid) || row.ownUid === row.senderUid)) fail();
    return row;
  };
  const row = await read();
  if (signal.aborted) fail();
  let document = null;
  try { document = JSON.parse(nativePrivateRead(configFile,65536)); }
  catch (error) { if (!error || !fs.existsSync(configFile)) { /* Bootstrap uses operator safeguards. */ } else throw error; }
  if (document) readNativeConfig(configFile); // Validate the existing channel, private token, and state directory.
  const channel = document?.channels?.find(value => value.profile === profileBinding.profile);
  const identity = { assistantId: row.assistantId, bindingId: row.bindingId, connectionId: row.connectionId };
  if (row.status === 'unavailable') return { ...identity, status: 'unavailable', runtimeStatus: 'unverified', changed: false };
  if (channel && (channel.accountId !== row.accountId || channel.pairedUid !== row.senderUid ||
      row.ownUid !== null && channel.ownUid !== row.ownUid)) fail();
  const unissued = channel && path.basename(channel.tokenFile).startsWith(profileBinding.profile+'.unissued.');
  if (row.status === 'active' && channel && !unissued || row.status === 'revoked' && (!channel || unissued)) {
    return { ...identity, status: row.status === 'active' || channel ? 'unchanged' : 'absent', changed: false,
      runtimeStatus: 'unverified', credentialSelection: 'explicit_connection', journal: 'preserved' };
  }
  const options = row.status === 'revoked' ? { action: 'revoke', configFile, profile: profileBinding.profile } :
    channel ? { action: 'rotate', configFile, profile: profileBinding.profile, tokenFile } :
    { action: 'create', configFile, profile: profileBinding.profile, accountId: row.accountId,
      ownUid: row.ownUid, pairedUid: row.senderUid, tokenFile,
      ...(document === null && stateRoot !== undefined ? { stateRoot } : {}),
      ...(document === null && listenPort !== undefined ? { listenPort } : {}) };
  const planned = planNativeGrant(options), expectedRevision = digest([row,profileBinding,planned.expectedRevision]);
  if (!apply) return { ...identity, status: 'planned', changed: false, expectedRevision, operator: planned };
  if (expect !== expectedRevision || digest(await read()) !== digest(row) || signal.aborted) fail();
  const result = applyNativeGrant({ ...options, expect: planned.expectedRevision });
  return { ...identity, status: 'updated', changed: true, expectedRevision, operator: result };
}
