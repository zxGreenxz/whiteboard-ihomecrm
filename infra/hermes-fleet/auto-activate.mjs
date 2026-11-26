import { bindingFromProfile } from './binding-guard.mjs';
import { fileURLToPath } from 'node:url';
import { loadFleetConfig, runFleet } from './fleet.mjs';
import { realSystem, SCRIPTS } from './fleet-host.mjs';
import { uuid } from './fleet-plan.mjs';

const QUEUE = fileURLToPath(new URL('./activation-queue.mjs', import.meta.url));
export function employeeProfile(bindingId) {
  if (!uuid(bindingId)) throw Error('invalid_binding');
  // All 128 bits fit in a legal Hermes profile name. An employee's display name can change.
  return 'nv-' + BigInt('0x' + bindingId.replaceAll('-', '')).toString(36);
}

export function activate(row, scope, io, preview = false) {
  if (row.organizationId !== scope.organizationId || row.accountId !== scope.accountId ||
      ![row.assistantId, row.userId, row.bindingId, row.connectionId].every(uuid) ||
      !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.senderUid !== 'string' ||
      !/^[1-9]\d{0,39}$/.test(row.senderUid)) throw Error('invalid_work');
  let name = employeeProfile(row.bindingId);
  const channels = io.channels();
  const paired = channels.find(channel => channel.accountId === row.accountId && channel.pairedUid === row.senderUid);
  if (paired?.unissued) return 'existing_channel';
  if (paired && paired.profile !== name) {
    const originalId = bindingFromProfile(paired.profile);
    if (!originalId) return 'existing_channel';
    const original = io.binding(originalId);
    if (!original || original.bindingId !== originalId ||
        !['assistantId','userId','organizationId','accountId','senderUid'].every(k => original[k] === row[k])) return 'existing_channel';
    name = paired.profile;
  }
  const existing = io.container(name);
  if (existing && (!existing.managed || existing.parked)) return 'operator_managed';
  if (preview) return 'eligible';
  // Reserve the visible "activating" state before the plan pings the CRM credential.
  if (!io.ack(row, 'restart_pending')) return 'superseded';
  const plan = io.plan(row, name);
  if (plan.status !== 'ready' || plan.assistant?.connectionId !== row.connectionId ||
      plan.assistant.identity?.accountId !== row.accountId || plan.assistant.identity?.pairedUid !== row.senderUid ||
      plan.assistant.channelAction === 'rotate') {
    return io.ack(row, 'unavailable') ? 'blocked' : 'superseded';
  }
  if (!io.ack(row, 'restart_pending')) return 'superseded';
  const result = io.apply(row, name, plan.expectedRevision);
  if (result.runtimeStatus !== 'verified' || result.assistant?.connectionId !== row.connectionId || !io.verifyGuard(row, name)) {
    return io.ack(row, 'unavailable') ? 'unverified' : 'superseded';
  }
  return io.ack(row, 'synchronized') ? 'activated' : 'superseded';
}

export function runActivation([mode, configFile, connectorName, organizationId, accountId]) {
  if (!['--check','--run'].includes(mode) || ![organizationId, accountId].every(uuid) ||
      process.getuid() !== 0) throw Error('invalid_activation_configuration');
  const sys = realSystem(), cfg = loadFleetConfig(configFile);
  const connector = cfg.connectors[connectorName];
  if (!Object.hasOwn(cfg.connectors, connectorName) || connector.trial) throw Error('invalid_activation_connector');
  function helper(user, file, args, input) {
    const result = sys.exec('setpriv', ['--reuid',String(user),'--regid',String(user),'--clear-groups','--no-new-privs',
      sys.node,file,...args], { input });
    if (result.status !== 0) throw Error('activation_helper_failed');
    return JSON.parse(result.stdout.toString());
  }
  const queue = (operation, input) => helper(connector.user, QUEUE, [operation,connector.config,organizationId,accountId], input);
  function fleet(args) {
    let data;
    const code = runFleet(args, { sys, write: text => { data=JSON.parse(text); }, error: () => {} });
    if (![0,3,4].includes(code) || !data) throw Error('fleet_operation_failed');
    return data;
  }
  const addArgs = (row, name) => ['them-nguoi','--config',configFile,'--connector',connectorName,'--ten',name,
    '--assistant-id',row.assistantId,'--organization-id',organizationId,'--user-id',row.userId,'--binding-id',row.bindingId];
  const guardImage = sys.exec('docker', ['inspect','-f','{{index .Config.Labels "io.ihomecrm.hermes.binding-guard"}}',cfg.worker.container]);
  if (guardImage.status !== 0 || guardImage.stdout.toString().trim() !== '1' ||
      sys.exec('systemctl',['is-active','--quiet','ihome-hermes-binding-guard.socket']).status !== 0) {
    throw Error('binding_guard_required');
  }
  const io = {
    verifyGuard: (row, name) => sys.exec('docker', ['exec', '--user', String(cfg.worker.uid), cfg.worker.container,
      'node', '/app/lib/hermes-binding-guard.js', name, row.bindingId, row.connectionId, String(row.revision)]).status === 0,
    binding: id => helper(connector.user,SCRIPTS.connector,['binding','--config',connector.config,'--binding-id',id]).binding,
    channels() {
      const data = helper(cfg.worker.uid, SCRIPTS.channel, ['list','--config',cfg.worker.nativeConfig]);
      if (!data.present || !Array.isArray(data.channels)) throw Error('native_config_missing');
      return data.channels;
    },
    container(name) {
      return fleet(['liet-ke','--config',configFile]).assistants.find(view => view.container === 'hermes-'+name);
    },
    plan: (row,name) => fleet(addArgs(row,name)),
    apply: (row,name,expect) => fleet([...addArgs(row,name),'--apply','--expect',expect]),
    ack: (row,state) => queue('ack', Buffer.from(JSON.stringify({row,state}))),
  };
  const counts = {};
  for (const row of queue('list')) {
    let outcome;
    try { outcome = activate(row,{organizationId,accountId},io,mode === '--check'); }
    catch {
      outcome = 'error';
      if (mode === '--run') {
        try { io.ack(row, 'unavailable'); } catch { /* A later tick rereads the queue. */ }
      }
    }
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

if (import.meta.main) {
  try {
    const counts = runActivation(process.argv.slice(2));
    console.log(JSON.stringify({activation:counts}));
    if (counts.error || counts.unverified || counts.blocked) process.exitCode=1;
  } catch { console.error('activation_cycle_failed'); process.exitCode=1; }
}
