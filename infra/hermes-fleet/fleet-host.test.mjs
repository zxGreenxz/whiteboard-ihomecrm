import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { FLEET_LABELS, FleetError, connectionDigest, trialIdentity } from './fleet-plan.mjs';
import { SCRIPTS, applyAdd, applyRecreate, applyRemove, planFor, pruneHandoff } from './fleet-host.mjs';
import { loadFleetConfig, parseArguments, runFleet } from './fleet.mjs';
import { ACCOUNT_ID, BINDING_ID, CHANNEL_TOKEN, CONNECTION_ID, CREDENTIAL, IMAGE, IMAGE_CONFIG, NEW_WORKER_ID, PERSON, PROVIDER_KEY, config, id,
  realRequest, sidecarInspect, trialRequest, workerInspect } from './fixtures.mjs';

const SECRETS = [CREDENTIAL, CHANNEL_TOKEN, PROVIDER_KEY];
const ROOT = '/var/lib/ihome-hermes-profiles', OWNER = `${ROOT}/owner/.hermes/profiles/owner`;
const base = file => path.basename(file);

/** Máy chủ giả: docker, setpriv + helper, journalctl, systemctl và vài lệnh file, đủ để chạy trọn một lượt điều phối. */
function fakeServer({ containers = [sidecarInspect()], channels, alive = true, binding, evidence = true, connectorActive = true, failRun = null, gatewayState, routeUp = true } = {}) {
  const calls = [], logs = [], state = { containers: new Map([['ihome-zalo-worker', workerInspect()], ...containers.map(raw => [raw.Name.slice(1), raw])]),
    channels: channels ?? [{ profile: 'owner', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '200', unissued: false }], nativeMtime: Date.parse('2026-01-02T01:00:00Z'),
    files: new Map([[ROOT, { dir: true, uid: 0, mode: 0o711 }], [`${ROOT}/owner`, { dir: true, uid: 10003, mode: 0o700 }],
      [`${OWNER}/SOUL.md`, { text: '# SOUL giả\n', uid: 10003, mode: 0o644 }], [`${OWNER}/.env`, { text: `NINEROUTER_API_KEY=${PROVIDER_KEY}\nMCP_IHOMECRM_API_KEY=hc_khac\n`, uid: 10003, mode: 0o600 }],
      ['/etc/passwd', { text: 'root:x:0:0::/root:/bin/bash\nihome-hermes:x:10004:10004::/nonexistent:/usr/sbin/nologin\n', uid: 0, mode: 0o644 }],
      ['/proc/meminfo', { text: 'MemTotal: 2010000 kB\nMemAvailable:   650240 kB\n', uid: 0, mode: 0o444 }],
      [SCRIPTS.template, { text: readFileSync(SCRIPTS.template, 'utf8'), uid: 0, mode: 0o644 }]]) };
  const ok = (stdout = '') => ({ status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
  const bad = (stderr = 'lỗi giả') => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) });
  const flag = (args, name) => args[args.indexOf(name) + 1];
  let clock = Date.parse('2026-01-02T03:04:05Z');
  function dockerRun(args) {
    if (failRun && args.includes(failRun)) return bad('không tạo được');
    const image = args.findIndex(arg => arg === IMAGE || arg.startsWith('sha256:')), uid = Number(flag(args, '--user').split(':')[0]);
    const home = args.flatMap((arg, index) => arg === '--mount' ? [/source=([^,]+)/.exec(args[index + 1])[1]] : [])[0];
    if (args.includes('--rm')) {                                                   // hermes profile create
      const name = args[image + 3];
      state.files.set(`${home}/.hermes/profiles/${name}`, { dir: true, uid, mode: 0o755 });
      return ok(`Profile '${name}' created\n`);
    }
    const name = flag(args, '--name'), labels = Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
    const raw = sidecarInspect({ name, profile: args[args.indexOf('--profile', image) + 1], home, uid, workerId: flag(args, '--network').slice('container:'.length),
      labels, containerId: String(state.containers.size).repeat(64).slice(0, 64) });
    raw.State.StartedAt = new Date(clock).toISOString(); raw.Mounts = raw.Mounts.filter(mount => mount.Type === 'bind' || args.join(' ').includes('type=volume'));
    state.containers.set(name, raw);
    const isTrial = labels[FLEET_LABELS.trial] === 'true';
    state.files.set(`${home}/.hermes/profiles/${raw.Config.Cmd[1]}/gateway_state.json`, { text: JSON.stringify({ gateway_state: gatewayState ?? (isTrial ? 'degraded' : 'running'), active_agents: 0,
      updated_at: new Date(clock).toISOString(), platforms: { zalo_personal: { state: labels[FLEET_LABELS.trial] === 'true' ? 'retrying' : 'connected' } } }), uid, mode: 0o644 });
    return ok(raw.Id + '\n');
  }
  function docker(args) {
    const [command, ...rest] = args;
    if (command === 'ps') return ok([...state.containers.keys()].join('\n') + '\n');
    if (command === 'inspect') { const found = rest.map(name => state.containers.get(name)); return found.every(Boolean) ? ok(JSON.stringify(found)) : bad('No such container'); }
    if (command === 'image') return rest.includes('--format') ? ok(IMAGE + '\n') : ok(JSON.stringify([{ Config: IMAGE_CONFIG }]));
    if (command === 'run') return dockerRun(args);
    if (command === 'stop') { state.containers.get(rest.at(-1)).State.Running = false; return ok(); }
    if (command === 'rename') { const raw = state.containers.get(rest[0]); state.containers.delete(rest[0]); raw.Name = `/${rest[1]}`; state.containers.set(rest[1], raw); return ok(); }
    if (command === 'update') { state.containers.get(rest.at(-1)).HostConfig.RestartPolicy = { Name: 'no' }; return ok(); }
    if (command === 'rm') { state.containers.delete(rest.at(-1)); return ok(); }
    if (command === 'stats') return ok('hermes-owner|385.7MiB / 900MiB\n');
    return bad(`docker ${command}?`);
  }
  function helper(script, args, input) {
    const name = base(script), [command] = args;
    if (name === 'helper-channel.mjs' && command === 'list') return ok(JSON.stringify({ version: 1, present: true, listenPort: 8991, revision: `r${state.channels.length}`, configMtimeMs: state.nativeMtime, channels: state.channels }));
    if (name === 'helper-channel.mjs' && command === 'export') { const row = state.channels.find(entry => entry.profile === flag(args, '--profile'));
      return ok(JSON.stringify({ accountId: row.accountId, ownUid: row.ownUid, pairedUid: row.pairedUid, mainUid: row.pairedUid, profile: row.profile, generation: id('7'), token: CHANNEL_TOKEN, listenPort: 8991 })); }
    if (name === 'helper-connector.mjs' && command === 'binding') return ok(JSON.stringify({ version: 1, binding: binding === undefined ?
      { bindingId: BINDING_ID, bindingEpoch: 1, ...PERSON, accountId: ACCOUNT_ID, ownUid: '100', senderUid: '300', connectionId: CONNECTION_ID, status: 'active' } : binding }));
    if (name === 'helper-connector.mjs' && command === 'list') return ok(JSON.stringify({ version: 1, total: 1, records: [{ connectionId: CONNECTION_ID, ...PERSON }] }));
    if (name === 'helper-connector.mjs' && command === 'check') return ok(JSON.stringify({ version: 1, alive: Object.fromEntries(args.flatMap((arg, index) => arg === '--connection-id' ? [[args[index + 1], alive]] : [])) }));
    if (name === 'helper-connector.mjs' && command === 'export') return ok(JSON.stringify({ version: 1, credential: CREDENTIAL }));
    if (name === 'helper-connector.mjs' && command === 'prune') return ok(JSON.stringify({ version: 1, status: 'archived', moved: 1, remaining: 0 }));
    if (name === 'operator.mjs') {
      if (!args.includes('--apply')) return ok(JSON.stringify({ expectedRevision: 'a'.repeat(64), diskStatus: 'planned' }));
      const profile = flag(args, '--profile');
      if (command === 'create') state.channels.push({ profile, accountId: flag(args, '--account-id'), ownUid: flag(args, '--own-uid'), pairedUid: flag(args, '--paired-uid'), unissued: false });
      else state.channels.find(entry => entry.profile === profile).unissued = true;
      state.nativeMtime = clock;
      return ok(JSON.stringify({ diskStatus: 'updated' }));
    }
    if (name === 'profile-provisioning-cli.mjs') return args.includes('--apply') ? ok(JSON.stringify({ status: 'updated', changed: true })) : ok(JSON.stringify({ status: 'planned', expectedRevision: 'b'.repeat(64) }));
    if (name === 'helper-home.mjs') { JSON.parse(input); state.files.set(`${args[2]}/.ihome-fleet-seeded`, { text: '{}', uid: 1, mode: 0o600 }); state.files.set(`${args[2]}/.env`, { text: 'A=1\n', uid: 1, mode: 0o600 }); return ok('{"status":"seeded"}'); }
    return bad(`helper ${name} ${command}?`);
  }
  const sys = { node: '/opt/node', log: line => logs.push(line), now: () => new Date(clock), sleep: ms => { clock += ms; },
    stat: file => { const entry = state.files.get(file); return entry ? { uid: entry.uid, gid: entry.uid, mode: entry.mode, dir: entry.dir === true, link: false, mtimeMs: 0 } : null; },
    read: file => state.files.get(file)?.text ?? null,
    readdir: directory => [...state.files.keys()].filter(file => path.posix.dirname(file) === directory).map(file => path.posix.basename(file)),
    mkdir: (directory, mode, uid) => { state.files.set(directory, { dir: true, uid, mode }); },
    write: (file, text, mode) => { state.files.set(file, { text, uid: 0, mode }); },
    rename: (from, to) => { for (const [file, entry] of [...state.files]) if (file === from || file.startsWith(from + '/')) { state.files.delete(file); state.files.set(to + file.slice(from.length), entry); } },
    unlink: file => { state.files.delete(file); },
    exec(command, args, { input } = {}) {
      const text = input === undefined ? undefined : Buffer.from(input).toString('utf8');
      calls.push({ command, args: [...args], input: text });
      if (command === 'docker') return docker(args);
      if (command === 'setpriv') return helper(args[7], args.slice(8), text);
      if (command === 'bash' && base(args[0]) === 'deploy.sh') { state.files.set(`${args[args.indexOf('--root') + 1]}/ihome-official-skills/current`, { dir: true, uid: 0, mode: 0o755 }); return ok(); }
      if (command === 'bash') { const old = state.containers.get('ihome-zalo-worker'); state.containers.set('ihome-zalo-worker', { ...workerInspect(NEW_WORKER_ID), Image: old.Image, State: { Running: true, StartedAt: new Date(clock).toISOString() } }); return ok(); }
      if (command === 'journalctl') return ok(evidence ? JSON.stringify({ event: 'tool_call_timing', ts: new Date(clock).toISOString(), operation: 'tools/list', outcome: 'ok', connection: connectionDigest(CONNECTION_ID) }) + '\n' : '');
      if (command === 'systemctl') return args[0] === 'is-active' ? (connectorActive ? ok() : bad()) : ok();
      if (command === 'nsenter') return routeUp ? ok() : bad('Connection refused');
      return bad(`${command}?`);
    } };
  const step = call => call.command === 'setpriv' ? `${call.args[1]}:${base(call.args[7])}:${call.args[8]}${call.args.includes('--apply') ? ':apply' : ''}` :
    call.command === 'docker' ? `docker:${call.args[0]}${call.args.includes('--rm') ? ':rm' : ''}` : call.command === 'bash' ? `bash:${base(call.args[0])}` : call.command;
  return { sys, calls, logs, state, steps: () => calls.map(step), writes: () => calls.map(step).filter(entry => !/^docker:(ps|inspect|image|stats)$|:(list|binding|check)$|^journalctl$|^nsenter$/.test(entry)) };
}
const noSecretOutsideStdin = server => {
  for (const call of server.calls) for (const secret of SECRETS) assert(!call.args.join(' ').includes(secret), `bí mật trong đối số: ${call.command} ${call.args[0]}`);
  for (const secret of SECRETS) assert(!server.logs.join('\n').includes(secret));
};
const code = fn => { try { fn(); } catch (error) { assert(error instanceof FleetError, error.stack); return error.code; } return null; };

test('thêm người thật: đúng thứ tự, đúng UID từng bước, bí mật chỉ đi qua stdin, worker khởi động lại rồi mới tạo lại sidecar', () => {
  const server = fakeServer(), cfg = config();
  const plan = planFor(server.sys, cfg, 'them-nguoi', realRequest());
  assert.equal(plan.status, 'ready');
  assert.deepEqual(server.writes(), []);                                           // xem trước không ghi gì
  const before = server.calls.length, result = applyAdd(server.sys, cfg, realRequest(), plan.expectedRevision);
  assert.deepEqual(result.done, ['home', 'profile', 'channel', 'seed', 'skills', 'credential', 'audit', 'worker-restart', 'sidecars', 'container']);
  server.calls.splice(0, before);
  assert.deepEqual(server.writes(), ['docker:run:rm',
    '10002:operator.mjs:create', '10002:operator.mjs:create:apply',               // kênh: UID worker, xem rồi mới ghi
    '10002:helper-channel.mjs:export', '10100:helper-home.mjs:seed',               // token kênh: worker → root → UID trợ lý
    'bash:deploy.sh',                                                              // kỹ năng chuẩn TRƯỚC khi config.yaml có mã CRM
    'ihome-hermes:helper-connector.mjs:export', '10100:profile-provisioning-cli.mjs:--home', '10100:profile-provisioning-cli.mjs:--home:apply',
    'systemctl', 'bash:zalo-worker.sh',                                            // đăng ký kiểm học tập, rồi khởi động lại worker
    'docker:stop', 'docker:rename', 'docker:run',                                  // tạo lại hermes-owner theo worker mới
    'docker:run']);                                                                // sau cùng mới dựng container của người mới
  noSecretOutsideStdin(server);
  const input = name => server.calls.filter(call => call.command === 'setpriv' && base(call.args[7]) === name).map(call => call.input);
  assert.deepEqual(input('profile-provisioning-cli.mjs'), [JSON.stringify({ version: 1, credential: CREDENTIAL }), JSON.stringify({ version: 1, credential: CREDENTIAL })]);
  const seed = JSON.parse(input('helper-home.mjs')[0]);
  assert.deepEqual(Object.keys(seed), ['version', 'configYaml', 'soul', 'env']);
  assert(seed.env.includes(`HERMES_ZALO_BRIDGE_TOKEN=${CHANNEL_TOKEN}`) && seed.env.includes(`NINEROUTER_API_KEY=${PROVIDER_KEY}`));
  assert(!seed.env.includes('MCP_IHOMECRM_API_KEY') && !seed.configYaml.includes('hc_'));  // không kéo mã CRM của hồ sơ khuôn sang người khác
  const provision = server.calls.find(call => call.command === 'setpriv' && base(call.args[7]) === 'profile-provisioning-cli.mjs').args;
  assert.deepEqual(provision.slice(0, 6), ['--reuid', '10100', '--regid', '10100', '--clear-groups', '--no-new-privs']);
  assert.deepEqual(provision.slice(8), ['--home', `${ROOT}/lan/.hermes/profiles/lan`, '--mcp-url', 'http://172.17.0.1:8740/mcp', '--profile', 'lan',
    '--account-id', ACCOUNT_ID, '--own-uid', '100', '--paired-uid', '300', '--preserve-existing-http-origin', 'http://172.17.0.1:8740']);
  assert.deepEqual(server.calls.find(call => call.command === 'bash' && base(call.args[0]) === 'zalo-worker.sh').args.slice(1), ['run', `sha256:${'9'.repeat(64)}`, '--native']);
  assert.deepEqual(server.calls.find(call => call.command === 'bash' && base(call.args[0]) === 'deploy.sh').args.slice(1),
    ['--root', `${ROOT}/lan/.hermes`, '--profiles', 'lan', '--release', SCRIPTS.release, '--hermes-uid', '10100']);
  // Sau lượt chạy: cả hai sidecar bám worker MỚI; bản cũ của owner còn để lùi.
  const names = [...server.state.containers.keys()];
  assert.deepEqual(names.filter(name => name.startsWith('hermes-')).sort(), ['hermes-lan', 'hermes-owner', 'hermes-owner-old-20260102T030405Z']);
  for (const name of ['hermes-lan', 'hermes-owner']) assert.equal(server.state.containers.get(name).HostConfig.NetworkMode, `container:${NEW_WORKER_ID}`);
  assert.equal(server.state.containers.get('hermes-lan').Config.Labels[FLEET_LABELS.connection], CONNECTION_ID);
  assert.deepEqual(result.verification.crmEvidence, { seen: true, operation: 'tools/list', at: result.verification.crmEvidence.at, calls: 1 });
  assert.equal(result.runtimeStatus, 'verified');
  assert(server.state.files.has('/etc/systemd/system/ihome-hermes-learning-audit.service.d/fleet-lan.conf'));
  assert.deepEqual(JSON.parse(server.state.files.get('/etc/ihome-hermes-fleet/learning-audit.json').text).realProfiles, ['owner', 'lan']);
  assert(!JSON.stringify(result).match(/hc_|hzn_/) && result.assistant.identity === undefined);
  // Chạy lại ngay: mọi bước đã xong, không còn gì chờ ngoài ghi lại mã (idempotent) và kiểm.
  assert.equal(planFor(server.sys, cfg, 'them-nguoi', realRequest()).pendingSteps, 0);
});

test('thêm người thử trên connector TEST: không đụng worker, kênh Zalo hay sidecar khác', () => {
  const server = fakeServer(), cfg = config();
  const plan = planFor(server.sys, cfg, 'them-nguoi', trialRequest());
  const before = server.calls.length, result = applyAdd(server.sys, cfg, trialRequest(), plan.expectedRevision);
  server.calls.splice(0, before);
  assert.deepEqual(server.writes(), ['docker:run:rm', '10100:helper-home.mjs:seed', 'bash:deploy.sh', 'ihome-hermes-test:helper-connector.mjs:export',
    '10100:profile-provisioning-cli.mjs:--home', '10100:profile-provisioning-cli.mjs:--home:apply', 'docker:run']);
  noSecretOutsideStdin(server);
  const seed = JSON.parse(server.calls.find(call => call.command === 'setpriv' && base(call.args[7]) === 'helper-home.mjs').input);
  assert(seed.env.includes('HERMES_ZALO_BRIDGE_URL=http://127.0.0.1:8999\n'));     // cổng không ai nghe, không phải cầu thật 8991
  assert(!seed.env.includes(CHANNEL_TOKEN));
  const identity = trialIdentity('thu1'), provision = server.calls.find(call => call.command === 'setpriv' && base(call.args[7]) === 'profile-provisioning-cli.mjs').args;
  assert.deepEqual(provision.slice(10, 21), ['--mcp-url', 'http://172.17.0.1:8741/mcp', '--profile', 'thu1', '--account-id', identity.accountId, '--own-uid', '1', '--paired-uid', '2', '--preserve-existing-http-origin']);
  assert.equal(server.state.containers.get('ihome-zalo-worker').Id, workerInspect().Id);                    // worker không bị thay
  assert.equal(server.state.containers.get('hermes-owner').Id, sidecarInspect().Id);                        // hermes-owner không bị đụng
  assert.equal(server.state.channels.length, 1);
  assert.equal(server.state.containers.get('hermes-thu1').Config.Labels[FLEET_LABELS.trial], 'true');
  assert.equal(result.runtimeStatus, 'verified'); assert.equal(result.verification.zalo, 'retrying'); assert.equal(result.verification.gateway, 'degraded');
  assert(!server.state.files.has('/etc/systemd/system/ihome-hermes-learning-audit.service.d/fleet-thu1.conf'));
});

test('ghi bị từ chối khi kế hoạch bị chặn, mã lệch, hoặc không có bằng chứng CRM thì không báo đã kiểm', () => {
  const cfg = config();
  const dead = fakeServer({ alive: false });
  assert.equal(code(() => applyAdd(dead.sys, cfg, realRequest(), 'x'.repeat(64))), 'ke_hoach_bi_chan');
  assert.deepEqual(dead.writes(), []);
  // Cửa nội bộ của connector không nghe (đúng tình huống gặp trên máy thật): chặn TRƯỚC khi dựng gì, phép dò đi từ netns của worker.
  const noRoute = fakeServer({ routeUp: false }), routePlan = planFor(noRoute.sys, cfg, 'them-nguoi', trialRequest());
  assert.deepEqual(routePlan.blocks, ['khong_toi_duoc_connector']);
  assert.deepEqual(noRoute.calls.find(call => call.command === 'nsenter').args, ['-t', '4321', '-n', '--', 'bash', '-c', 'exec 3<>"/dev/tcp/$0/$1"', '172.17.0.1', '8741']);
  assert.equal(code(() => applyAdd(noRoute.sys, cfg, trialRequest(), routePlan.expectedRevision)), 'ke_hoach_bi_chan');
  assert.deepEqual(noRoute.writes(), []);
  const drift = fakeServer(), plan = planFor(drift.sys, cfg, 'them-nguoi', realRequest());
  drift.state.containers.set('hermes-moi', sidecarInspect({ name: 'hermes-moi', profile: 'moi', home: `${ROOT}/moi`, containerId: '7'.repeat(64) }));   // máy chủ đổi sau khi xem
  assert.equal(code(() => applyAdd(drift.sys, cfg, realRequest(), plan.expectedRevision)), 'ke_hoach_da_doi');
  assert.deepEqual(drift.writes(), []);
  const silent = fakeServer({ evidence: false }), trialPlan = planFor(silent.sys, cfg, 'them-nguoi', trialRequest());
  const result = applyAdd(silent.sys, cfg, trialRequest(), trialPlan.expectedRevision);
  assert.deepEqual(result.verification.crmEvidence, { seen: false });
  assert.equal(result.runtimeStatus, 'unverified');                               // container chạy mà connector chưa thấy gọi ⇒ chưa xác minh
  // Người thật mà gateway chỉ `degraded` (Zalo chưa nối) thì KHÔNG được báo đã kiểm, dù connector đã thấy gọi.
  const degraded = fakeServer({ gatewayState: 'degraded' }), realPlan = planFor(degraded.sys, cfg, 'them-nguoi', realRequest());
  const half = applyAdd(degraded.sys, cfg, realRequest(), realPlan.expectedRevision);
  assert.equal(half.verification.crmEvidence.seen, true); assert.equal(half.runtimeStatus, 'unverified');
  // Tạo container mới hỏng: tên cũ được trả lại, lỗi nêu rõ container.
  const broken = fakeServer({ containers: [sidecarInspect(), sidecarInspect({ name: 'hermes-thu1', profile: 'thu1', home: `${ROOT}/thu1`, uid: 10100, running: false, containerId: '8'.repeat(64),
    labels: { [FLEET_LABELS.name]: 'thu1', [FLEET_LABELS.trial]: 'true' } })], failRun: 'hermes-thu1' });
  broken.state.files.set(`${ROOT}/thu1`, { dir: true, uid: 10100, mode: 0o700 });
  const retry = planFor(broken.sys, cfg, 'them-nguoi', trialRequest());
  assert.equal(code(() => applyAdd(broken.sys, cfg, trialRequest(), retry.expectedRevision)), 'tao_sidecar_loi');
  assert(broken.state.containers.has('hermes-thu1') && ![...broken.state.containers.keys()].some(name => name.includes('-old-')));
});

test('gỡ người: dừng và giữ container, thu hồi kênh bằng UID worker, cất home; không gỡ thứ dựng tay', () => {
  const fleet = sidecarInspect({ name: 'hermes-lan', profile: 'lan', home: `${ROOT}/lan`, uid: 10100, containerId: '6'.repeat(64),
    labels: { [FLEET_LABELS.name]: 'lan', [FLEET_LABELS.trial]: 'false', [FLEET_LABELS.connection]: CONNECTION_ID } });
  const server = fakeServer({ containers: [sidecarInspect(), fleet], channels: [{ profile: 'owner', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '200', unissued: false },
    { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] }), cfg = config();
  server.state.files.set(`${ROOT}/lan`, { dir: true, uid: 10100, mode: 0o700 });
  server.state.files.set(`${ROOT}/lan/.hermes/profiles/lan/.ihome-fleet-seeded`, { text: '{}', uid: 10100, mode: 0o600 });
  server.state.files.set('/etc/systemd/system/ihome-hermes-learning-audit.service.d/fleet-lan.conf', { text: 'x', uid: 0, mode: 0o644 });
  server.state.files.set('/etc/ihome-hermes-fleet/learning-audit.json', { text: JSON.stringify({ profilesRoots: [`${ROOT}/owner/.hermes/profiles`, `${ROOT}/lan/.hermes/profiles`], realProfiles: ['owner', 'lan'] }), uid: 0, mode: 0o644 });
  const plan = planFor(server.sys, cfg, 'go-nguoi', { name: 'lan' });
  assert.equal(plan.status, 'ready');
  const before = server.calls.length, result = applyRemove(server.sys, cfg, 'lan', plan.expectedRevision);
  server.calls.splice(0, before);
  assert.deepEqual(server.writes(), ['docker:update', 'docker:stop', 'docker:rename', '10002:operator.mjs:revoke', '10002:operator.mjs:revoke:apply', 'systemctl']);
  assert(!server.steps().includes('docker:rm'));                                   // không xoá container
  assert.deepEqual(result.done, ['stop', 'revoke-channel', 'audit', 'archive-home']);
  assert.equal(result.keptContainer, 'hermes-lan-da-go-20260102T030405Z');
  assert.equal(server.state.containers.get(result.keptContainer).HostConfig.RestartPolicy.Name, 'no');
  assert.equal(result.archivedHome, '/var/lib/ihome-hermes-profiles-archive/lan-20260102T030405Z');
  assert(server.state.files.has(`${result.archivedHome}/.hermes/profiles/lan/.ihome-fleet-seeded`) && !server.state.files.has(`${ROOT}/lan`));
  assert.deepEqual(JSON.parse(server.state.files.get('/etc/ihome-hermes-fleet/learning-audit.json').text).realProfiles, ['owner']);
  assert.equal(server.state.channels.find(entry => entry.profile === 'lan').unissued, true);
  assert.equal(server.state.containers.get('hermes-owner').State.Running, true);
  const ownerPlan = planFor(server.sys, cfg, 'go-nguoi', { name: 'owner' });
  assert.deepEqual(ownerPlan.blocks, ['khong_phai_cua_cong_cu']);
  assert.equal(code(() => applyRemove(server.sys, cfg, 'owner', ownerPlan.expectedRevision)), 'ke_hoach_bi_chan');
  assert.equal(server.state.containers.get('hermes-owner').State.Running, true);
});

test('tạo lại sidecar: --chi chỉ đụng đúng container nêu tên, đúng cấu hình cũ trừ network', () => {
  const trial = sidecarInspect({ name: 'hermes-thu1', profile: 'thu1', home: `${ROOT}/thu1`, uid: 10100, workerId: 'e'.repeat(64), containerId: '5'.repeat(64),
    labels: { [FLEET_LABELS.name]: 'thu1', [FLEET_LABELS.trial]: 'true' } });
  const server = fakeServer({ containers: [sidecarInspect({ workerId: 'e'.repeat(64) }), trial] }), cfg = config();
  const plan = planFor(server.sys, cfg, 'tao-lai-sidecar', { only: ['hermes-thu1'] });
  assert.deepEqual(plan.sidecars.map(row => [row.container, row.state]), [['hermes-thu1', 'recreate']]);
  const result = applyRecreate(server.sys, cfg, { only: ['hermes-thu1'] }, plan.expectedRevision);
  assert.deepEqual(result.sidecars, [{ container: 'hermes-thu1', running: true, currentNetwork: true }]);
  assert.equal(result.replaced[0].replaced, 'hermes-thu1-old-20260102T030405Z');
  assert.equal(server.state.containers.get('hermes-owner').Id, sidecarInspect().Id);                        // hermes-owner không bị đụng dù cũng bám worker cũ
  assert.equal(server.state.containers.get('hermes-owner').HostConfig.NetworkMode, `container:${'e'.repeat(64)}`);
  const run = server.calls.find(call => call.command === 'docker' && call.args[0] === 'run').args;
  assert.equal(run[run.indexOf('--user') + 1], '10100:10100'); assert(run.includes(`type=bind,source=${ROOT}/thu1,target=/home/hermes`));
  assert.equal(code(() => applyRecreate(server.sys, cfg, { only: ['hermes-thu1'] }, plan.expectedRevision)), 'khong_can_tao_lai');
});

test('liệt kê và dọn handoff qua tầng máy chủ', () => {
  const fleet = sidecarInspect({ name: 'hermes-lan', profile: 'lan', home: `${ROOT}/lan`, uid: 10100, containerId: '6'.repeat(64), labels: { [FLEET_LABELS.name]: 'lan', [FLEET_LABELS.connection]: CONNECTION_ID } });
  const server = fakeServer({ containers: [sidecarInspect(), fleet] }), cfg = config();
  const listed = planFor(server.sys, cfg, 'liet-ke', {});
  assert.equal(listed.memAvailableMb, 635);
  assert.deepEqual(listed.assistants.map(row => [row.container, row.managed, row.ramMb, row.connection]), [['hermes-lan', true, null, `…${CONNECTION_ID.slice(-8)}`], ['hermes-owner', false, 386, null]]);
  assert.equal(typeof listed.assistants[0].lastCrmCall.any, 'string');
  assert.deepEqual(server.writes(), []);
  // Xem trước lúc connector chạy; mã còn sống thì chặn.
  assert.deepEqual(pruneHandoff(server.sys, cfg, { connector: 'test', connectionIds: [CONNECTION_ID] }).blocks, ['ket_noi_con_song']);
  const dead = fakeServer({ alive: false });
  const plan = pruneHandoff(dead.sys, cfg, { connector: 'test', connectionIds: [CONNECTION_ID] });
  assert.equal(plan.status, 'ready');
  assert.equal(code(() => pruneHandoff(dead.sys, cfg, { connector: 'test', connectionIds: [CONNECTION_ID], apply: true, expect: plan.expectedRevision })), 'connector_dang_chay');
  const stopped = fakeServer({ connectorActive: false });
  assert.equal(code(() => pruneHandoff(stopped.sys, cfg, { connector: 'test', connectionIds: [CONNECTION_ID] })), 'connector_khong_chay');
  assert.equal(pruneHandoff(stopped.sys, cfg, { connector: 'test', connectionIds: [CONNECTION_ID], apply: true, expect: plan.expectedRevision }).status, 'archived');
  assert.deepEqual(stopped.calls.at(-1).args.slice(8), ['prune', '--config', '/etc/ihome-hermes-test/connector.json', '--connection-id', CONNECTION_ID, '--apply', '--expect', plan.expectedRevision]);
  assert.equal(code(() => pruneHandoff(stopped.sys, cfg, { connector: 'la', connectionIds: [CONNECTION_ID] })), 'connector_khong_co');
});

test('CLI: mặc định chỉ xem; --apply phải kèm --expect; cần root; cấu hình phải của root 0600', () => {
  const common = ['--config', '/etc/ihome-hermes-fleet/fleet.json'];
  const person = ['--assistant-id', PERSON.assistantId, '--user-id', PERSON.userId, '--organization-id', PERSON.organizationId];
  assert.deepEqual(parseArguments(['them-nguoi', ...common, '--ten', 'lan', '--connector', 'prod', ...person, '--binding-id', BINDING_ID, '--ram-mb', '800']),
    { action: 'them-nguoi', input: { name: 'lan', connector: 'prod', ...PERSON, bindingId: BINDING_ID, memoryMb: 800 }, config: common[1], apply: false, expect: undefined });
  assert.deepEqual(parseArguments(['them-nguoi', ...common, '--ten', 'thu1', '--connector', 'test', ...person, '--thu-khong-kenh', '--connection-id', CONNECTION_ID, '--apply', '--expect', 'abc']).input,
    { name: 'thu1', connector: 'test', ...PERSON, connectionId: CONNECTION_ID, trial: true });
  assert.deepEqual(parseArguments(['tao-lai-sidecar', ...common, '--chi', 'hermes-thu1']).input, { only: ['hermes-thu1'] });
  for (const argv of [['xoa-het', ...common], ['liet-ke'], ['liet-ke', '--config', 'tuong/doi'], ['go-nguoi', ...common, '--ten', 'lan', '--apply'], ['go-nguoi', ...common, '--ten', 'lan', '--expect', 'x'],
    ['liet-ke', ...common, '--apply', '--expect', 'x'], ['go-nguoi', ...common, '--ten', 'lan', '--connector', 'prod'], ['liet-ke', ...common, '--ten', 'lan'],
    ['go-nguoi', ...common, '--ten'], ['go-nguoi', ...common, '--ten', 'a', '--ten', 'b'], ['them-nguoi', ...common, '--ram-mb', 'nhieu']])
    assert.notEqual(code(() => parseArguments(argv)), null, argv.join(' '));
  const server = fakeServer(), outputs = [], errors = [], io = { mkdirSync() {}, rmdirSync() {} };
  const run = (argv, options = {}) => runFleet(argv, { sys: server.sys, loadConfig: () => config(), write: text => outputs.push(text), error: text => errors.push(text), isRoot: () => true, io, ...options });
  assert.equal(run(['liet-ke', ...common], { isRoot: () => false }), 1);
  assert.equal(JSON.parse(errors.pop()).error, 'can_root');
  assert.equal(run(['them-nguoi', ...common, '--ten', 'thu1', '--connector', 'test', ...person, '--thu-khong-kenh', '--connection-id', CONNECTION_ID]), 0);
  const plan = JSON.parse(outputs.pop());
  assert.equal(plan.status, 'ready'); assert.deepEqual(server.writes(), []);
  // Bị chặn: mã thoát 3 kèm lời giải thích; không ghi gì.
  const blocked = fakeServer({ alive: false });
  assert.equal(run(['them-nguoi', ...common, '--ten', 'thu1', '--connector', 'test', ...person, '--thu-khong-kenh', '--connection-id', CONNECTION_ID], { sys: blocked.sys }), 3);
  assert.match(JSON.parse(outputs.pop()).blocksText[0], /^ket_noi_khong_song: Connector từ chối mã/);
  // Hai lệnh ghi không chạy song song: khoá còn đó thì dừng trước mọi bước.
  assert.equal(run(['go-nguoi', ...common, '--ten', 'lan', '--apply', '--expect', 'x'], { io: { mkdirSync() { throw Object.assign(new Error('có rồi'), { code: 'EEXIST' }); }, rmdirSync() { throw new Error('không được gỡ khoá của lệnh khác'); } } }), 1);
  assert.equal(JSON.parse(errors.pop()).error, 'dang_co_lenh_ghi_khac');
  assert.equal(run([...['them-nguoi', ...common, '--ten', 'thu1', '--connector', 'test', ...person, '--thu-khong-kenh', '--connection-id', CONNECTION_ID], '--apply', '--expect', plan.expectedRevision]), 0);
  assert.equal(JSON.parse(outputs.pop()).runtimeStatus, 'verified');
  // Cấu hình không phải của root / không 0600 / là symlink ⇒ từ chối trên Linux.
  const stat = change => ({ isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100600, size: 10, ...change });
  const load = change => code(() => loadFleetConfig('/etc/x.json', { platform: 'linux', io: { lstatSync: () => stat(change), realpathSync: () => '/etc/x.json', readFileSync: () => JSON.stringify(JSON.parse(readFileSync(new URL('./fleet-config.example.json', import.meta.url), 'utf8'))) } }));
  assert.equal(load({}), null);
  for (const change of [{ uid: 1000 }, { mode: 0o100644 }, { isSymbolicLink: () => true }, { isFile: () => false }, { size: 70000 }]) assert.equal(load(change), 'cau_hinh_sai');
});
