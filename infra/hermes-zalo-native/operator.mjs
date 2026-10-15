import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveNativeConfig } from '../../worker/lib/hermes-native-config.js';
import { nativeAbsolute, nativeDirectory, nativePrivateRead } from '../../worker/lib/hermes-native-files.js';
import { createNativeJournal, nativeDigest } from '../../worker/lib/hermes-native-journal.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const publicError = error => /^native_operator_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'native_operator_invalid';
const redact = value => JSON.stringify(value).replace(/hzn_[A-Za-z0-9_-]+/g, '[REDACTED]');
const configPath = value => nativeAbsolute(value ?? process.env.HERMES_ZALO_NATIVE_CONFIG);
const inside = (root, file) => { const relative = path.relative(root, file); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const STATE_OWNER = '.native-operator-owner.json', STATE_LOCK = '.native-operator-lock';
const readOnlyIo = { ...fs,
  mkdirSync() { fail('native_operator_read_only'); },
  renameSync() { fail('native_operator_read_only'); },
  writeFileSync() { fail('native_operator_read_only'); },
  openSync(file, flags, ...args) {
    if (typeof flags !== 'number' || (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))) fail('native_operator_read_only');
    return fs.openSync(file, flags, ...args);
  },
};

function absent(file) {
  try { fs.lstatSync(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function stateNamespace(document, file, bootstrap = false) {
  const root = nativeDirectory(document.stateRoot), ownerFile = path.join(root, STATE_OWNER);
  const entries = fs.readdirSync(root).filter(name => name !== STATE_LOCK);
  // An absent config has no authoritative generation map. Even a same-path
  // restore must not allocate new generations over any previous state.
  if (bootstrap && entries.length) fail('native_operator_state_namespace_conflict');
  let ownerRaw = null;
  if (entries.includes(STATE_OWNER)) {
    ownerRaw = nativePrivateRead(ownerFile, 8192);
    const owner = JSON.parse(ownerRaw);
    if (!owner || Object.keys(owner).length !== 2 || owner.version !== 1 || owner.configFile !== file) fail('native_operator_state_owner_conflict');
  }
  const journals = new Set(document.channels.map(channel => `${nativeDigest([channel.accountId, channel.profile, channel.generation])}.json`));
  // Legacy grants can be adopted only with their complete existing namespace.
  // A removed/rebound channel leaves an orphan journal: no create, rotate or
  // inspect may silently ignore it and present a fresh generation as safe.
  if (entries.some(name => name !== STATE_OWNER && !journals.has(name))) fail('native_operator_state_namespace_conflict');
  return { root, ownerFile, ownerRaw };
}
function snapshot(file, bootstrap) {
  nativeDirectory(path.dirname(file));
  if (absent(file)) {
    if (!bootstrap) fail('native_operator_config_missing');
    const document = { version: 1, stateRoot: bootstrap.stateRoot, listenPort: bootstrap.listenPort, channels: [] };
    const state = stateNamespace(document, file, true);
    return { raw: null, document, state, revision: hash('absent') };
  }
  const raw = nativePrivateRead(file, 65536);
  const document = JSON.parse(raw);
  const tokenBytes = new Map();
  const runtime = resolveNativeConfig(document, { createState: false, readToken(tokenFile) {
    const bytes = nativePrivateRead(tokenFile, 128); tokenBytes.set(tokenFile, bytes); return bytes.trim();
  } });
  const state = stateNamespace(document, file);
  // Detect replacement during the read. Tokens are high-entropy secrets; only
  // an opaque revision is exposed, never their bytes or individual hashes.
  if (nativePrivateRead(file, 65536) !== raw || [...tokenBytes].some(([name, bytes]) => nativePrivateRead(name, 128) !== bytes)) fail('native_operator_config_changed');
  return { raw, document, runtime, state, revision: hash(JSON.stringify([raw, [...tokenBytes], state.ownerRaw])) };
}
function validateOptions(options) {
  const common = ['action', 'configFile', 'profile', 'tokenFile', 'expect'];
  const create = ['accountId', 'ownUid', 'pairedUid', 'stateRoot', 'listenPort'];
  if (!['create', 'rotate', 'revoke'].includes(options.action) || Object.keys(options).some(key => !common.includes(key) && !(options.action === 'create' && create.includes(key)))) fail('native_operator_arguments');
  if (typeof options.profile !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(options.profile)) fail('native_operator_arguments');
  if (options.action !== 'revoke' && !options.tokenFile) fail('native_operator_token_file_required');
  if (options.action === 'revoke' && options.tokenFile) fail('native_operator_arguments');
}
function prepare(options) {
  validateOptions(options);
  const file = configPath(options.configFile);
  const bootstrap = options.action === 'create' && options.stateRoot && options.listenPort ?
    { stateRoot: nativeAbsolute(options.stateRoot), listenPort: options.listenPort } : undefined;
  const current = snapshot(file, bootstrap);
  if (current.raw !== null && (options.stateRoot !== undefined || options.listenPort !== undefined)) fail('native_operator_bootstrap_only');
  const existing = current.document.channels.find(c => c.profile === options.profile);
  if (options.action === 'create' ? !!existing : !existing) fail('native_operator_profile_conflict');
  const tokenFile = options.action === 'revoke' ? path.join(path.dirname(file), `${options.profile}.unissued.${randomUUID()}.token`) : nativeAbsolute(options.tokenFile);
  if (inside(nativeAbsolute(current.document.stateRoot), tokenFile) || inside(`${file}.operator-lock`, tokenFile)) fail('native_operator_reserved_path');
  nativeDirectory(path.dirname(tokenFile));
  if (tokenFile === file || !absent(tokenFile)) fail('native_operator_token_file_exists');
  const channel = options.action === 'create' ? {
    accountId: options.accountId, ownUid: options.ownUid, pairedUid: options.pairedUid, mainUid: options.pairedUid,
    profile: options.profile, generation: randomUUID(), tokenFile,
  } : { ...existing, tokenFile };
  const document = { ...current.document, channels: options.action === 'create' ? [...current.document.channels, channel] :
    current.document.channels.map(c => c.profile === options.profile ? channel : c) };
  const token = `hzn_${randomBytes(32).toString('hex')}`;
  resolveNativeConfig(document, { createState: false, readToken: name => name === tokenFile ? token : nativePrivateRead(name, 128).trim() });
  const encoded = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > 65536) fail('native_operator_config_capacity');
  return { file, current, document, channel, token, tokenFile, encoded, bootstrap };
}
function summary(prepared, action, applied) {
  const { file, current, channel } = prepared;
  return { version: 1, action, configFile: file, expectedRevision: current.revision,
    diskStatus: applied ? 'updated' : 'planned', runtimeStatus: 'unverified', activation: 'pending_controlled_worker_restart',
    channel: { ...channel, generation: action === 'create' && !applied ? 'generated_on_apply' : channel.generation,
      tokenFile: action === 'revoke' && !applied ? 'private_unissued_file_generated_on_apply' : channel.tokenFile },
    credential: action === 'revoke' ? 'replaced_with_unissued_secret' : 'private_token_file_only',
    journal: 'preserved', oldTokenFiles: 'preserved', restartPerformed: false,
    liveRevocationVerified: false,
  };
}

/** Preview has no filesystem mutation. The expected revision binds apply to
 * all current config/token bytes, and the same command must be used at apply. */
export function planNativeGrant(options) {
  return summary(prepare(options), options.action, false);
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function stagePrivate(file, contents) {
  const parent = nativeDirectory(path.dirname(file));
  const temp = path.join(parent, `.native-operator.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // Shared file guards prove owner/mode/link constraints before publication.
  if (nativePrivateRead(temp, Math.max(128, Buffer.byteLength(contents))) !== contents) fail('native_operator_staging_failed');
  return temp;
}
function cleanTemp(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function claimStateOwner(file, state) {
  if (state.ownerRaw !== null) return;
  const contents = `${JSON.stringify({ version: 1, configFile: file })}\n`;
  const temp = stagePrivate(state.ownerFile, contents);
  try {
    fs.linkSync(temp, state.ownerFile); fs.unlinkSync(temp);
    if (nativePrivateRead(state.ownerFile, 8192) !== contents) fail('native_operator_state_owner_conflict');
    syncDirectory(state.root);
  } finally { cleanTemp(temp); }
}

/** Only cooperative operator mutations take this lock. Do not edit config or
 * tokens by hand concurrently. A stale lock is never broken automatically.
 * Worker keeps its loaded config until its existing controlled restart path.
 * Crash leftovers remain private; no journal or old token is ever deleted. */
export function applyNativeGrant(options) {
  validateOptions(options);
  if (typeof options.expect !== 'string' || !/^[a-f0-9]{64}$/.test(options.expect)) fail('native_operator_expected_revision_required');
  const file = configPath(options.configFile), lock = `${file}.operator-lock`;
  nativeDirectory(path.dirname(file));
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('native_operator_locked'); throw error; }
  let tokenTemp, configTemp, stateLock, committing = false;
  try {
    nativeDirectory(lock);
    const initial = prepare(options);
    const nextStateLock = path.join(initial.current.state.root, STATE_LOCK);
    try { fs.mkdirSync(nextStateLock, { mode: 0o700 }); stateLock = nextStateLock; }
    catch (error) { if (error.code === 'EEXIST') fail('native_operator_state_locked'); throw error; }
    nativeDirectory(stateLock);
    const prepared = prepare(options);
    if (prepared.current.state.root !== initial.current.state.root) fail('native_operator_config_changed');
    if (prepared.current.revision !== options.expect) fail('native_operator_config_changed');
    tokenTemp = stagePrivate(prepared.tokenFile, `${prepared.token}\n`);
    if (!absent(prepared.tokenFile)) fail('native_operator_token_file_exists');
    // Token is complete/private before the atomic config pointer swap. A
    // failure may leave an unreferenced private token; never undo an effect.
    // Atomic no-clobber publication, including writers targeting the same token
    // from another config. The temporary second link is removed before config
    // can reference it; shared guards reject a crash-left multi-link file.
    fs.linkSync(tokenTemp, prepared.tokenFile);
    fs.unlinkSync(tokenTemp); tokenTemp = null;
    if (nativePrivateRead(prepared.tokenFile, 128) !== `${prepared.token}\n`) fail('native_operator_staging_failed');
    syncDirectory(path.dirname(prepared.tokenFile));
    configTemp = stagePrivate(file, prepared.encoded);
    resolveNativeConfig(JSON.parse(nativePrivateRead(configTemp, 65536)), { createState: false });
    if (snapshot(file, prepared.bootstrap).revision !== options.expect) fail('native_operator_config_changed');
    committing = true;
    // Bind this state directory before publishing a config. Crash after this
    // claim stays fail-closed; there is no reset/recovery command in this CLI.
    claimStateOwner(file, prepared.current.state);
    fs.renameSync(configTemp, file); configTemp = null;
    syncDirectory(path.dirname(file));
    const updated = snapshot(file);
    if (updated.raw !== prepared.encoded) fail('native_operator_commit_unknown');
    return { ...summary(prepared, options.action, true), revision: updated.revision };
  } catch (error) {
    if (committing) fail('native_operator_commit_unknown');
    throw error;
  } finally {
    try { cleanTemp(tokenTemp); cleanTemp(configTemp); }
    finally { try { if (stateLock) fs.rmdirSync(stateLock); } finally { fs.rmdirSync(lock); } }
  }
}

/** Disk snapshots only: no bridge request, provider call, journal write,
 * retry/recovery command, or claim of live worker authority. */
export function inspectNativeDelivery({ configFile, profile, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 100) fail('native_operator_arguments');
  const file = configPath(configFile), current = snapshot(file);
  const channels = current.runtime.channels.filter(c => !profile || c.profile === profile);
  if (profile && !channels.length) fail('native_operator_profile_conflict');
  const count = (records, statuses) => Object.fromEntries(statuses.map(status => [status, records.filter(r => r.status === status).length]));
  return { version: 1, source: 'disk_snapshot', configFile: file, revision: current.revision,
    runtimeStatus: 'unverified', observedAt: new Date().toISOString(), recoverySupported: false,
    channels: channels.map(channel => {
      const journalFile = path.join(current.runtime.stateRoot, `${nativeDigest([channel.accountId, channel.profile, channel.generation])}.json`);
      const present = !absent(journalFile);
      const journal = createNativeJournal(current.runtime.stateRoot, channel, { io: readOnlyIo });
      const inbound = journal.values('inbound'), outbound = journal.values('outbound');
      const outboundCounts = count(outbound, ['sent', 'outcome_unknown']);
      const fields = ['id', 'status', 'messageId', 'sentAt', 'startedAt', 'finishedAt', 'dispatchedAt', 'acknowledgedAt'];
      const records = values => (limit ? values.slice(-limit) : []).map(record =>
        Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])));
      return { profile: channel.profile, accountId: channel.accountId, generation: channel.generation,
        journalFile, journalPresent: present, quarantine: outboundCounts.outcome_unknown ? 'outcome_unknown' : 'none_observed',
        inbound: { counts: count(inbound, ['queued', 'dispatch_unknown', 'accepted', 'rejected']), records: records(inbound) },
        outbound: { counts: outboundCounts, records: records(outbound) },
        pendingMeaning: 'inbound_queued_only; outbound_outcome_unknown_may_be_in_flight_or_settled_without_receipt',
        truncated: inbound.length > limit || outbound.length > limit };
    }) };
}

const usage = { commands: ['create', 'rotate', 'revoke', 'inspect'],
  config: '--config <absolute-path> or HERMES_ZALO_NATIVE_CONFIG',
  preview: 'create/rotate/revoke default to dry-run; add --apply --expect <expectedRevision>',
  create: '--profile <name> --account-id <uuid> --own-uid <uid> --paired-uid <uid> --token-file <new-private-path>',
  bootstrap: 'For absent config only: --state-root <existing-private-directory> --listen-port <1024..65535>',
  rotate: '--profile <name> --token-file <new-private-path>', revoke: '--profile <name>', inspect: '[--profile <name>] [--limit <0..100>]',
  warning: 'Apply changes disk only. Restart the existing worker with its ownership controls; transfer issued tokens through the secret store. Do not start another session. Revoke retains binding/generation/journal with an unissued token. No unknown outcome recovery is supported.' };
export function runNativeOperator(argv, { write = line => process.stdout.write(line), error = line => process.stderr.write(line) } = {}) {
  try {
    if (argv.length === 1 && ['--help', 'help'].includes(argv[0])) { write(`${redact(usage)}\n`); return 0; }
    const [action, ...rest] = argv, options = { action };
    const names = { '--config': 'configFile', '--profile': 'profile', '--token-file': 'tokenFile', '--account-id': 'accountId',
      '--own-uid': 'ownUid', '--paired-uid': 'pairedUid', '--state-root': 'stateRoot', '--listen-port': 'listenPort', '--expect': 'expect', '--limit': 'limit' };
    let apply = false;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === '--apply' && !apply) { apply = true; continue; }
      const name = names[flag], value = rest[++i];
      if (!name || Object.hasOwn(options, name) || value === undefined || value.startsWith('--')) fail('native_operator_arguments');
      options[name] = ['listenPort', 'limit'].includes(name) ? (/^[0-9]+$/.test(value) ? Number(value) : NaN) : value;
    }
    let result;
    if (action === 'inspect') {
      if (apply || Object.keys(options).some(key => !['action', 'configFile', 'profile', 'limit'].includes(key))) fail('native_operator_arguments');
      const { action: _action, ...inspect } = options; result = inspectNativeDelivery(inspect);
    } else { result = apply ? applyNativeGrant(options) : planNativeGrant(options); }
    write(`${redact(result)}\n`); return 0;
  } catch (cause) { error(`${redact({ error: publicError(cause), runtimeStatus: 'unverified', instruction: 'Inspect disk state before retrying; never delete journals or change generation to retry an unknown send.' })}\n`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = runNativeOperator(process.argv.slice(2));
