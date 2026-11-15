import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { FLEET_LABELS, FleetError, allocateUid, assistantName, auditDropIn, auditScanConfig, channelProjection, connectionDigest, lockViolations, listRows,
  mcpRoute, memoryGate, planAdd, routeEndpoint, planPrune, planRecreate, planRemove, profileCreateArgs, profileEnv, pruneRevision, recreateArgs, redactArgs,
  renderProfileConfig, retiredContainer, sharedEnvFrom, sidecarArgs, sidecarView, trialIdentity, validateFleetConfig } from './fleet-plan.mjs';
import { ACCOUNT_ID, BINDING_ID, CHANNEL_TOKEN, CONNECTION_ID, IMAGE, IMAGE_CONFIG, NEW_WORKER_ID, PERSON, WORKER_ID, addFacts, config, exampleConfig, id,
  realRequest, sidecarInspect, trialRequest } from './fixtures.mjs';

const code = fn => { try { fn(); } catch (error) { assert(error instanceof FleetError, String(error)); return error.code; } return null; };
const states = plan => Object.fromEntries(plan.steps.map(step => [step.id, step.state]));
const template = () => readFileSync(new URL('./khuon/config.yaml', import.meta.url), 'utf8');
const fleetSidecar = (name, change = {}) => sidecarInspect({ name: `hermes-${name}`, profile: name, home: `/var/lib/ihome-hermes-profiles/${name}`, uid: 10100,
  labels: { [FLEET_LABELS.name]: name, [FLEET_LABELS.connector]: 'prod', [FLEET_LABELS.connection]: CONNECTION_ID, [FLEET_LABELS.trial]: 'false' }, ...change });

test('tên trợ lý: chữ thường/số/gạch nối; cấm default và hậu tố container đã thay hoặc đã gỡ', () => {
  for (const name of ['lan', 'quan-ly-2', 'a1']) assert.equal(assistantName(name), name);
  for (const name of ['', 'a', 'Lan', 'lan_1', '-lan', 'lan-', 'lan--b', 'default', 'old', 'lan-old-x', 'lan-da-go-1', '1lan', 'x'.repeat(32), 'lan/../x', 'lan x'])
    assert.equal(code(() => assistantName(name)), 'ten_khong_hop_le', name);
  assert.equal(retiredContainer('hermes-lan-old-20260102T030405Z'), true);
  assert.equal(retiredContainer('hermes-lan-da-go-20260102T030405Z'), true);
  assert.equal(retiredContainer('hermes-lan'), false);
});

test('cấu hình mẫu trong repo hợp lệ; cấu hình lỏng bị từ chối', () => {
  const valid = config();
  assert.equal(valid.connectors.prod.trial, false);
  assert.equal(valid.connectors.test.route.preserveOrigin, 'http://172.17.0.1:8741');
  const bad = change => code(() => validateFleetConfig({ ...exampleConfig(), image: IMAGE, ...change }));
  const base = exampleConfig();
  assert.equal(bad({ image: 'nousresearch/hermes-agent:latest' }), 'cau_hinh_sai');             // image phải ghim digest
  assert.equal(bad({ archiveRoot: base.profilesRoot + '/archive' }), 'cau_hinh_sai');           // kho cất không nằm trong gốc home
  assert.equal(bad({ uidRange: [0, 10] }), 'cau_hinh_sai');
  assert.equal(bad({ connectors: { prod: { ...base.connectors.prod, user: 'root' } } }), 'cau_hinh_sai');
  assert.equal(bad({ connectors: { test: { ...base.connectors.test, trialBridgePort: undefined } } }), 'cau_hinh_sai');
  assert.equal(bad({ connectors: { prod: { ...base.connectors.prod, trialBridgePort: 8999 } } }), 'cau_hinh_sai'); // cổng thử chỉ đi với trial
  assert.equal(bad({ template: { ...base.template, sharedEnvKeys: ['HERMES_ZALO_BRIDGE_TOKEN'] } }), 'cau_hinh_sai'); // không sao token kênh của người khác
  assert.equal(bad({ template: { ...base.template, sharedEnvKeys: ['MCP_IHOMECRM_API_KEY'] } }), 'cau_hinh_sai');     // không sao mã CRM của người khác
  assert.equal(bad({ extra: true }), 'cau_hinh_sai');
  // Launcher worker ghi cứng tên container, UID và file cấu hình kênh: cấu hình khác đi thì bước khởi động lại sẽ thay một container khác.
  for (const change of [{ container: 'worker-khac' }, { uid: 10009 }, { nativeConfig: '/srv/khac/config.json' }])
    assert.equal(bad({ worker: { ...base.worker, ...change } }), 'cau_hinh_sai');
  assert.equal(bad({ uidRange: [10000, 10199] }), 'cau_hinh_sai');                              // khoảng UID của công cụ không được chứa UID worker
});

test('mcpUrl: https/loopback đi đường thường, IP nội bộ đi đường giữ origin, còn lại bị từ chối', () => {
  assert.equal(mcpRoute('https://crm-hermes.example.test/mcp').preserveOrigin, null);
  assert.equal(mcpRoute('http://127.0.0.1:8740/mcp').preserveOrigin, null);
  assert.equal(mcpRoute('http://172.17.0.1:8740/mcp').preserveOrigin, 'http://172.17.0.1:8740');
  assert.deepEqual(routeEndpoint(mcpRoute('http://172.17.0.1:8741/mcp')), { host: '172.17.0.1', port: 8741 });
  assert.deepEqual(routeEndpoint(mcpRoute('https://crm-hermes.example.test/mcp')), { host: 'crm-hermes.example.test', port: 443 });
  for (const url of ['http://8.8.8.8:8740/mcp', 'http://example.test/mcp', 'https://x.test/other', 'https://u:p@x.test/mcp', 'https://x.test/mcp?k=1', 'ftp://x/mcp', 'x'])
    assert.equal(code(() => mcpRoute(url)), 'cau_hinh_sai', url);
});

test('sidecar mới mang đủ bộ cờ khoá, chỉ bind đúng home của người đó, không mở cổng hay gắn bí mật của worker', () => {
  const args = sidecarArgs({ name: 'lan', uid: 10100, home: '/var/lib/ihome-hermes-profiles/lan', image: IMAGE, workerId: WORKER_ID, memoryMb: 700,
    connector: 'prod', connectionId: CONNECTION_ID });
  const flag = name => args[args.indexOf(name) + 1], all = name => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : []);
  assert.equal(flag('--name'), 'hermes-lan');
  assert.equal(flag('--network'), `container:${WORKER_ID}`);
  assert.equal(flag('--user'), '10100:10100');
  assert.equal(flag('--memory'), '700m'); assert.equal(flag('--memory-swap'), '1400m');
  assert.equal(flag('--cap-drop'), 'ALL'); assert.equal(flag('--security-opt'), 'no-new-privileges:true');
  assert(args.includes('--read-only') && args.includes('--init'));
  assert.deepEqual(all('--mount'), ['type=bind,source=/var/lib/ihome-hermes-profiles/lan,target=/home/hermes']);
  assert.deepEqual(all('--tmpfs').map(value => value.split(':')[0]), ['/tmp', '/opt/data']);
  assert(all('--tmpfs').every(value => value.includes('uid=10100,gid=10100,mode=0700')));
  assert.deepEqual(all('--env'), ['HOME=/home/hermes', 'HERMES_HOME=/home/hermes/.hermes', 'HERMES_WRITE_SAFE_ROOT=/home/hermes/.hermes']);
  for (const forbidden of ['-p', '--publish', '--privileged', '--cap-add', '--device', '--volume', '-v', '--pid', '--env-file'])
    assert(!args.includes(forbidden), forbidden);
  assert(!args.join(' ').match(/docker\.sock|native-config|native-state|worker\.env|sessions|--network host/));
  assert.deepEqual(args.slice(args.indexOf('--entrypoint')), ['--entrypoint', 'hermes', IMAGE, '--profile', 'lan', 'gateway', 'run']);
  assert.equal(code(() => sidecarArgs({ name: 'lan', uid: 0, home: '/h/lan', image: IMAGE, workerId: WORKER_ID, memoryMb: 700, connector: 'prod', connectionId: CONNECTION_ID })), 'tham_so_sai');
  assert.equal(code(() => sidecarArgs({ name: 'lan', uid: 10100, home: '/h/lan', image: 'hermes:latest', workerId: WORKER_ID, memoryMb: 700, connector: 'prod', connectionId: CONNECTION_ID })), 'tham_so_sai');
  // Container tạo khung hồ sơ: không mạng, cùng cờ khoá, đúng lệnh upstream.
  const create = profileCreateArgs({ name: 'lan', uid: 10100, home: '/var/lib/ihome-hermes-profiles/lan', image: IMAGE });
  assert.equal(create[create.indexOf('--network') + 1], 'none');
  assert(create.includes('--rm') && create.includes('--read-only'));
  assert.deepEqual(create.slice(-6), [IMAGE, 'profile', 'create', 'lan', '--no-alias', '--no-skills']);
});

test('sidecar dựng tay đúng khoá thì đạt; mỗi kiểu nới lỏng đều bị phát hiện', () => {
  const cfg = config(), clean = () => sidecarInspect();
  assert.deepEqual(lockViolations(sidecarView(clean()), cfg), []);
  const mutate = (apply, expected) => { const raw = clean(); apply(raw); assert.deepEqual(lockViolations(sidecarView(raw), cfg), [expected]); };
  mutate(raw => { raw.Config.User = '0:0'; }, 'user');
  mutate(raw => { raw.Config.User = ''; }, 'user');
  mutate(raw => { raw.HostConfig.ReadonlyRootfs = false; }, 'read_only');
  mutate(raw => { raw.HostConfig.CapDrop = []; }, 'capabilities');
  mutate(raw => { raw.HostConfig.CapAdd = ['SYS_ADMIN']; }, 'capabilities');
  mutate(raw => { raw.HostConfig.SecurityOpt = []; }, 'no_new_privileges');
  mutate(raw => { raw.HostConfig.Privileged = true; }, 'privileged_surface');
  mutate(raw => { raw.HostConfig.PortBindings = { '8080/tcp': [{}] }; }, 'privileged_surface');
  mutate(raw => { raw.HostConfig.NetworkMode = 'host'; }, 'network');
  mutate(raw => { raw.HostConfig.PidMode = 'host'; }, 'namespaces');
  mutate(raw => { raw.Mounts[0].Source = '/opt/ihome-zalo-worker/native-config'; }, 'home_mount');
  mutate(raw => { raw.Mounts[0].Source = '/var/lib/ihome-hermes-profiles/owner/../x'; }, 'home_mount');
  mutate(raw => { raw.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }); }, 'home_mount');
  mutate(raw => { raw.Mounts.push({ Type: 'volume', Name: 'x', Destination: '/secrets', RW: true }); }, 'extra_mount');
  // Tạo lại chép nguyên security-opt và namespace: mọi nới lỏng ngoài no-new-privileges đều bị bắt.
  mutate(raw => { raw.HostConfig.SecurityOpt.push('seccomp=unconfined'); }, 'security_opt');
  mutate(raw => { raw.HostConfig.SecurityOpt.push('apparmor=unconfined'); }, 'security_opt');
  mutate(raw => { raw.HostConfig.UsernsMode = 'host'; }, 'host_namespaces');
  mutate(raw => { raw.HostConfig.UTSMode = 'host'; }, 'host_namespaces');
  // Host cgroup v1: Docker ghi CgroupnsMode "host" cho mọi container, kể cả container do công cụ dựng ⇒ không phải nới lỏng.
  const cgroupV1 = clean(); cgroupV1.HostConfig.CgroupnsMode = 'host';
  assert.deepEqual(lockViolations(sidecarView(cgroupV1), cfg), []);
  mutate(raw => { raw.HostConfig.GroupAdd = ['docker']; }, 'host_namespaces');
});

test('tạo lại sidecar giữ nguyên cấu hình đang chạy, chỉ đổi network; lệnh in ra không lộ giá trị env', () => {
  const raw = sidecarInspect(); raw.Config.Env.push('EXTRA_SECRET=value-not-in-image');
  const args = recreateArgs(raw, IMAGE_CONFIG, NEW_WORKER_ID);
  assert.equal(args[args.indexOf('--network') + 1], `container:${NEW_WORKER_ID}`);
  assert.equal(args[args.indexOf('--memory') + 1], '943718400');
  assert(args.includes('type=bind,source=/var/lib/ihome-hermes-profiles/owner,target=/home/hermes'));
  assert(args.includes(`type=volume,source=${'f'.repeat(64)},target=/opt/data`));
  assert(!args.includes('PATH=/opt/hermes/bin:/usr/bin'));                       // env trùng image không truyền lại
  assert(args.includes('EXTRA_SECRET=value-not-in-image') && args.includes('HOME=/home/hermes'));
  assert.deepEqual(args.slice(-6), ['hermes', IMAGE, '--profile', 'owner', 'gateway', 'run']);
  assert(!redactArgs(args).join(' ').includes('value-not-in-image'));
  assert(redactArgs(args).includes('EXTRA_SECRET=<ẩn>'));
  const odd = sidecarInspect(); odd.Mounts.push({ Type: 'npipe', Destination: '/x' });
  assert.equal(code(() => recreateArgs(odd, IMAGE_CONFIG, NEW_WORKER_ID)), 'sidecar_mount_la');
  assert.equal(code(() => recreateArgs(raw, IMAGE_CONFIG, 'short')), 'tham_so_sai');
});

test('khuôn trong repo: cửa nội bộ được đặt sẵn server không mã; K1 chỉ bật zalo_personal; khuôn mang bí mật bị từ chối', () => {
  const internal = yaml.load(renderProfileConfig(template(), { route: mcpRoute('http://172.17.0.1:8740/mcp') }));
  assert.deepEqual(Object.keys(internal.mcp_servers), ['ihomecrm']);
  assert.equal(internal.mcp_servers.ihomecrm.url, 'http://172.17.0.1:8740/mcp');
  assert.equal(internal.mcp_servers.ihomecrm.headers, undefined);
  assert.equal(internal.mcp_servers.ihomecrm.strict_redirect_headers, true);
  assert.deepEqual(internal.platforms, { zalo_personal: { enabled: true } });
  assert.equal(internal.gateway.standalone, true);
  assert.deepEqual(internal.plugins.enabled, ['ihome-session-reset', 'ihome-zalo-native']);
  assert.equal(internal.skills, undefined);                                        // khối skills do deploy.sh nối
  const external = yaml.load(renderProfileConfig(template(), { route: mcpRoute('https://crm-hermes.example.test/mcp') }));
  assert.equal(external.mcp_servers, undefined);                                   // đường https: bộ ghi mã tự tạo server `crm`
  const route = mcpRoute('http://172.17.0.1:8740/mcp');
  for (const text of ['mcp_servers: {}\n', 'platforms:\n  telegram:\n    enabled: true\n', `a:\n  Authorization: x\n`, `a: hc_${'x'.repeat(43)}\n`,
    'providers:\n  x:\n    api_key: abc\n', `k: ${'A'.repeat(48)}\n`, '- list\n', ': : :'])
    assert.equal(code(() => renderProfileConfig(text, { route })), 'khuon_sai', text);
});

test('.env hồ sơ mới: đủ năm biến kênh + kênh nhà + khoá dùng chung; thiếu khoá khuôn thì dừng', () => {
  const channel = { accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', mainUid: '300', profile: 'lan', generation: id('7'), token: CHANNEL_TOKEN, listenPort: 8991 };
  const shared = sharedEnvFrom('# c\nexport NINEROUTER_API_KEY="k1"\nMCP_IHOMECRM_API_KEY=hc_other\nHERMES_ZALO_BRIDGE_TOKEN=hzn_other\n', ['NINEROUTER_API_KEY']);
  assert.deepEqual(shared, { NINEROUTER_API_KEY: 'k1' });                          // chỉ khoá được phép, không kéo theo mã CRM/token của hồ sơ khuôn
  assert.equal(profileEnv({ shared, channel }), ['NINEROUTER_API_KEY=k1', 'HERMES_ZALO_BRIDGE_URL=http://127.0.0.1:8991',
    `HERMES_ZALO_BRIDGE_TOKEN=${CHANNEL_TOKEN}`, 'HERMES_ZALO_PROFILE=lan', 'HERMES_ZALO_PAIRED_UID=300', `HERMES_ZALO_GENERATION=${id('7')}`,
    'ZALO_PERSONAL_HOME_CHANNEL=300', ''].join('\n'));
  assert.equal(code(() => sharedEnvFrom('OTHER=1\n', ['NINEROUTER_API_KEY'])), 'khuon_thieu_khoa');
  assert.equal(code(() => sharedEnvFrom('NINEROUTER_API_KEY=a\nNINEROUTER_API_KEY=b\n', ['NINEROUTER_API_KEY'])), 'khuon_sai');
  assert.equal(code(() => profileEnv({ shared: { K: 'has space' }, channel })), 'khuon_sai');
  assert.equal(code(() => profileEnv({ shared: { NINEROUTER_API_KEY: 'a\nINJECT=1' }, channel })), 'khuon_sai');
  for (const change of [{ token: 'hzn_short' }, { mainUid: '999' }, { ownUid: '300' }, { listenPort: 80 }, { extra: 1 }])
    assert.equal(code(() => channelProjection({ ...channel, ...change })), 'kenh_sai');
});

test('cửa RAM: còn đúng ngưỡng thì cho, dưới ngưỡng hoặc không đo được thì từ chối', () => {
  const ram = { expectedMb: 450, keepFreeMb: 150 };
  assert.deepEqual(memoryGate({ memAvailableMb: 600, ...ram }), { ok: true, afterMb: 150 });
  assert.equal(memoryGate({ memAvailableMb: 150, ...ram }).code, 'ram_khong_du');
  assert.equal(memoryGate({ memAvailableMb: 599.9, ...ram }).code, 'ram_khong_du');
  assert.equal(memoryGate({ memAvailableMb: NaN, ...ram }).code, 'ram_khong_do_duoc');
  assert.equal(allocateUid({ range: [10100, 10102], used: [10100, 10101] }), 10102);
  assert.equal(allocateUid({ range: [10100, 10101], used: [10100, 10101] }), null);
});

test('them-nguoi (người thật): đủ mười một bước theo đúng thứ tự, mỗi bước đúng UID', () => {
  const plan = planAdd(addFacts(), realRequest(), config());
  assert.equal(plan.status, 'ready'); assert.deepEqual(plan.blocks, []);
  assert.deepEqual(plan.steps.map(step => [step.id, step.as, step.state]), [
    ['home', 'root', 'pending'], ['profile', 'assistant', 'pending'], ['channel', 'worker', 'pending'], ['seed', 'assistant', 'pending'],
    ['skills', 'root', 'pending'], ['credential', 'assistant', 'pending'], ['audit', 'root', 'pending'], ['worker-restart', 'root', 'pending'], ['sidecars', 'root', 'pending'],
    ['container', 'root', 'pending'], ['verify', 'root', 'pending']]);
  assert.deepEqual({ ...plan.assistant }, { name: 'lan', uid: 10100, home: '/var/lib/ihome-hermes-profiles/lan',
    profileDir: '/var/lib/ihome-hermes-profiles/lan/.hermes/profiles/lan', container: 'hermes-lan', memoryMb: 700, connector: 'prod', trial: false,
    connectionId: CONNECTION_ID, connectionTail: CONNECTION_ID.slice(-8), identity: { accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300' }, channelAction: 'create' });
  assert.deepEqual(plan.others, ['hermes-owner']);
  assert.match(plan.expectedRevision, /^[a-f0-9]{64}$/);
  assert.equal(plan.runtimeStatus, 'unverified');
  // Kế hoạch không mang mã hay token.
  assert(!JSON.stringify(plan).match(/hc_|hzn_/));
});

test('them-nguoi: mã ghi đổi khi máy chủ đổi giữa lúc xem và lúc ghi', () => {
  const cfg = config(), base = planAdd(addFacts(), realRequest(), cfg).expectedRevision;
  assert.equal(planAdd(addFacts(), realRequest(), cfg).expectedRevision, base);
  const changed = [
    addFacts({ worker: { ...addFacts().worker, id: NEW_WORKER_ID } }),
    addFacts({ native: { ...addFacts().native, revision: 'r2' } }),
    addFacts({ home: { exists: true, uid: 10100, private: true, profileDir: false, seeded: false, hasEnv: false } }),
    addFacts({ containers: [sidecarView(sidecarInspect({ containerId: 'e'.repeat(64) }))] }),
  ];
  for (const facts of changed) assert.notEqual(planAdd(facts, realRequest(), cfg).expectedRevision, base);
  assert.notEqual(planAdd(addFacts(), realRequest({ memoryMb: 800 }), cfg).expectedRevision, base);
});

test('them-nguoi: từng điều kiện kiểm trước chặn đúng mã', () => {
  const cfg = config(), blocked = (facts, request = realRequest()) => planAdd(facts, request, cfg);
  const expect = (facts, block, request) => { const plan = blocked(facts, request); assert.equal(plan.status, 'blocked'); assert(plan.blocks.includes(block), `${block} ∉ ${plan.blocks}`); };
  expect(addFacts({ memAvailableMb: 500 }), 'ram_khong_du');
  expect(addFacts({ imagePresent: false }), 'anh_chua_co');
  expect(addFacts({ worker: { running: false, id: null } }), 'worker_khong_chay');
  expect(addFacts({ worker: { ...addFacts().worker, native: false } }), 'worker_khong_native');
  expect(addFacts({ route: { reachable: false } }), 'khong_toi_duoc_connector');                           // cửa nội bộ của connector chưa bật
  expect(addFacts({ route: { reachable: null } }), 'khong_kiem_duoc_duong_toi_connector');
  expect(addFacts({ route: undefined }), 'khong_kiem_duoc_duong_toi_connector');                           // thiếu dữ kiện ⇒ chặn, không coi là tới được
  expect(addFacts({ template: { soul: false, envKeys: ['NINEROUTER_API_KEY'] } }), 'khuon_thieu_soul');
  expect(addFacts({ template: { soul: true, envKeys: [] } }), 'khuon_thieu_khoa');
  expect(addFacts({ binding: null }), 'khong_doc_duoc_lien_ket');
  expect(addFacts({ binding: { ...addFacts().binding, status: 'revoked' } }), 'lien_ket_khong_hoat_dong');
  expect(addFacts({ binding: { ...addFacts().binding, userId: id('9') } }), 'lien_ket_lech_danh_tinh');      // liên kết của người khác
  expect(addFacts({ binding: { ...addFacts().binding, bindingId: id('8') } }), 'lien_ket_lech_danh_tinh');
  expect(addFacts({ handoff: { ok: true, records: [] } }), 'chua_co_ma_ket_noi');
  expect(addFacts({ handoff: { ok: true, records: [{ connectionId: CONNECTION_ID, ...PERSON, userId: id('9') }] } }), 'chua_co_ma_ket_noi'); // mã của người khác không thế được
  expect(addFacts({ handoff: { ok: false } }), 'khong_doc_duoc_handoff');
  expect(addFacts({ connectionAlive: false }), 'ket_noi_khong_song');
  expect(addFacts({ connectionAlive: null }), 'khong_kiem_duoc_ket_noi');
  expect(addFacts({ native: { ok: false } }), 'khong_doc_duoc_cau_hinh_kenh');
  expect(addFacts({ native: { ...addFacts().native, channels: [{ profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '999', unissued: false }] } }), 'kenh_lech_danh_tinh');
  expect(addFacts({ profileNames: ['tkt', 'lan'] }), 'ten_trung_ho_so_khac');                              // trùng một hồ sơ ở home khác
  expect(addFacts({ home: { exists: true, uid: 10120, private: true, profileDir: true, seeded: true, hasEnv: true } }), 'home_cua_nguoi_thu');   // đã gieo mà chưa có kênh
  expect(addFacts({ containers: [sidecarView(sidecarInspect()), sidecarView(sidecarInspect({ name: 'tro-ly-dung-tay', labels: { 'com.ihomecrm.component': 'khac' } }))] }), 'sidecar_khong_nhan');
  expect(addFacts({ containers: [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('lan', { labels: { [FLEET_LABELS.name]: 'lan', [FLEET_LABELS.trial]: 'true' } }))],
    home: { exists: true, uid: 10100, private: true, profileDir: true, seeded: true, hasEnv: true },
    native: { ...addFacts().native, channels: [...addFacts().native.channels, { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] } }), 'container_khac_che_do');
  // Container của chính người này đang dừng: dựng lại là thêm một container chạy ⇒ vẫn qua cửa RAM.
  expect(addFacts({ memAvailableMb: 500, home: { exists: true, uid: 10100, private: true, profileDir: true, seeded: true, skills: true, hasEnv: true },
    containers: [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('lan', { running: false }))],
    native: { ...addFacts().native, channels: [...addFacts().native.channels, { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] } }), 'ram_khong_du');
  // Lần gieo trước chết giữa chừng (còn dấu "đang gieo"): không bị coi là hồ sơ lạ.
  assert.equal(blocked(addFacts({ home: { exists: true, uid: 10120, private: true, profileDir: true, seeded: false, seeding: true, hasEnv: true },
    native: { ...addFacts().native, channels: [...addFacts().native.channels, { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] } })).status, 'ready');
  expect(addFacts({ native: { ...addFacts().native, channels: [{ profile: 'khac', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] } }), 'nick_zalo_da_co_kenh');
  expect(addFacts({ native: { ...addFacts().native, channels: Array.from({ length: 100 }, (_, n) => ({ profile: `p${n}`, accountId: ACCOUNT_ID, ownUid: '100', pairedUid: String(1000 + n), unissued: false })) } }), 'kenh_day');
  expect(addFacts({ passwdUids: Array.from({ length: 100 }, (_, n) => 10100 + n) }), 'het_uid');
  expect(addFacts({ passwdUids: [10150] }), 'uid_da_dung', realRequest({ uid: 10150 }));
  expect(addFacts({ home: { exists: true, uid: 10120, private: true, profileDir: false, seeded: false, hasEnv: false } }), 'home_khac_uid', realRequest({ uid: 10150 }));
  expect(addFacts({ home: { exists: true, uid: 10120, private: false, profileDir: false, seeded: false, hasEnv: false } }), 'home_sai_quyen');
  expect(addFacts({ home: { exists: true, uid: 10120, private: true, profileDir: true, seeded: false, hasEnv: true } }), 'ho_so_la');
  expect(addFacts({ containers: [sidecarView(sidecarInspect()), sidecarView(sidecarInspect({ name: 'hermes-lan', profile: 'lan' }))] }), 'container_trung_ten');
  const loose = sidecarInspect(); loose.HostConfig.Privileged = true;
  expect(addFacts({ containers: [sidecarView(loose)] }), 'sidecar_lech_khoa');   // không nhân bản sidecar lỏng khi tạo lại
  // Tham số sai là lỗi, không phải "bị chặn".
  assert.equal(code(() => planAdd(addFacts(), realRequest({ connector: 'khac' }), cfg)), 'connector_khong_co');
  assert.equal(code(() => planAdd(addFacts(), realRequest({ name: 'Lan' }), cfg)), 'ten_khong_hop_le');
  assert.equal(code(() => planAdd(addFacts(), realRequest({ connectionId: CONNECTION_ID }), cfg)), 'tham_so_sai');
  assert.equal(code(() => planAdd(addFacts(), realRequest({ uid: 10003 }), cfg)), 'tham_so_sai');
  assert.equal(code(() => planAdd(addFacts(), { ...realRequest(), bindingId: undefined }, cfg)), 'tham_so_sai');
});

test('thêm lại người đã gỡ: đúng tên cũ thì cấp token mới cho kênh đã thu hồi; mã ghi ràng cả cấu hình môi trường', () => {
  const cfg = config(), revoked = { ...addFacts().native, channels: [...addFacts().native.channels, { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: true }] };
  const plan = planAdd(addFacts({ native: revoked }), realRequest(), cfg);
  assert.equal(plan.status, 'ready'); assert.equal(plan.assistant.channelAction, 'rotate');
  assert.equal(states(plan).channel, 'pending'); assert.equal(states(plan)['worker-restart'], 'pending');
  assert.match(plan.steps.find(step => step.id === 'channel').summary, /operator\.mjs rotate/);
  // Kênh đã thu hồi mà home cũ còn (gỡ dở, hoặc thu hồi tay): cấp token mới thì .env đã gieo vẫn giữ token cũ ⇒ chặn, phải cất home trước.
  for (const home of [{ exists: true, uid: 10100, private: true, profileDir: true, seeded: true, hasEnv: true }, { exists: true, uid: 10100, private: true, profileDir: false, seeded: false, hasEnv: false }])
    assert(planAdd(addFacts({ native: revoked, home }), realRequest(), cfg).blocks.includes('kenh_da_thu_hoi_con_home'));
  // Tên khác cho cùng nick Zalo vẫn bị chặn (kênh thu hồi giữ cặp nick bot–nick người dùng).
  assert(planAdd(addFacts({ native: revoked }), realRequest({ name: 'lan-moi' }), cfg).blocks.includes('nick_zalo_da_co_kenh'));
  // Sidecar không chạy mà bám worker CŨ là chết vì worker đã bị thay (không phải dừng tay): vẫn nằm trong danh sách tạo lại.
  const dead = planAdd(addFacts({ containers: [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('thu1', { running: false, workerId: NEW_WORKER_ID }))] }), realRequest(), cfg);
  assert.deepEqual(dead.others, ['hermes-owner', 'hermes-thu1']); assert.equal(states(dead).sidecars, 'pending');
  // Sidecar đã dừng tay không bị dựng lại và không tính vào số sidecar tạo lại.
  const stopped = planAdd(addFacts({ containers: [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('thu1', { running: false }))] }), realRequest(), cfg);
  assert.deepEqual(stopped.others, ['hermes-owner']); assert.match(stopped.notes.join(' '), /Sidecar đang dừng, không đụng tới: hermes-thu1/);
  // Đổi cấu hình môi trường giữa lúc xem và lúc ghi ⇒ mã lệch.
  const base = planAdd(addFacts(), realRequest(), cfg).expectedRevision;
  assert.notEqual(planAdd(addFacts(), realRequest(), config({ image: `sha256:${'d'.repeat(64)}` })).expectedRevision, base);
  assert.notEqual(planAdd(addFacts(), realRequest(), config({ template: { ...exampleConfig().template, sourceProfile: 'khac' } })).expectedRevision, base);
  // UID không cấp lại số của home đã cất hay của container đang có.
  assert.equal(planAdd(addFacts({ homeUids: [10003, 10100] }), realRequest(), cfg).assistant.uid, 10101);
  assert.equal(planAdd(addFacts({ containers: [sidecarView(sidecarInspect({ uid: 10100 }))] }), realRequest(), cfg).assistant.uid, 10101);
});

test('them-nguoi (người thử): chỉ connector TEST, không tạo kênh, không khởi động lại worker, không đụng sidecar khác', () => {
  const cfg = config(), plan = planAdd(addFacts({ binding: undefined }), trialRequest(), cfg);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(states(plan), { home: 'pending', profile: 'pending', channel: 'skipped', seed: 'pending', skills: 'pending', credential: 'pending', audit: 'skipped',
    'worker-restart': 'skipped', sidecars: 'skipped', container: 'pending', verify: 'pending' });
  assert.deepEqual(plan.assistant.identity, trialIdentity('thu1'));
  assert.match(plan.assistant.identity.accountId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(trialIdentity('thu1'), trialIdentity('thu1')); assert.notEqual(trialIdentity('thu1').accountId, trialIdentity('thu2').accountId);
  assert.equal(code(() => planAdd(addFacts(), trialRequest({ connector: 'prod' }), cfg)), 'thu_khong_duoc_phep');   // production không có chế độ thử
  assert.equal(code(() => planAdd(addFacts(), trialRequest({ connectionId: undefined }), cfg)), 'tham_so_sai');
  assert.equal(code(() => planAdd(addFacts(), { ...trialRequest(), bindingId: BINDING_ID }, cfg)), 'tham_so_sai');
  const samePort = planAdd(addFacts({ native: { ...addFacts().native, listenPort: 8999 } }), trialRequest(), cfg);
  assert(samePort.blocks.includes('cong_thu_trung_cau_that'));                     // kênh thử không được trỏ vào cầu thật
  // Người thử trùng tên một kênh thật: lúc gỡ sẽ thu hồi nhầm kênh của người khác ⇒ chặn ngay lúc thêm.
  assert(planAdd(addFacts(), trialRequest({ name: 'owner' }), cfg).blocks.includes('ten_trung_kenh_that'));
  // Sidecar lỏng của người khác không chặn người thử (người thử không tạo lại ai).
  const loose = sidecarInspect(); loose.HostConfig.Privileged = true;
  assert.equal(planAdd(addFacts({ containers: [sidecarView(loose)] }), trialRequest(), cfg).status, 'ready');
  // Người thử cũng không bị chặn bởi container không nhãn hay danh sách kiểm học tập hỏng (nó không tạo lại ai, không đăng ký).
  assert.equal(planAdd(addFacts({ audit: { broken: true }, containers: [sidecarView(sidecarInspect()), sidecarView(sidecarInspect({ name: 'khong-nhan', labels: { 'com.ihomecrm.component': 'khac' } }))] }), trialRequest(), cfg).status, 'ready');
  assert(planAdd(addFacts({ audit: { broken: true } }), realRequest(), cfg).blocks.includes('audit_cau_hinh_hong'));
});

test('them-nguoi chạy lại sau khi hỏng giữa chừng: bước đã xong được nhận ra, UID theo home đã có', () => {
  const cfg = config();
  const afterChannel = addFacts({ home: { exists: true, uid: 10107, private: true, profileDir: true, seeded: false, hasEnv: false },
    native: { ...addFacts().native, newerThanWorker: true, channels: [...addFacts().native.channels, { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] } });
  const resumed = planAdd(afterChannel, realRequest(), cfg);
  assert.equal(resumed.status, 'ready'); assert.equal(resumed.assistant.uid, 10107);
  assert.deepEqual(states(resumed), { home: 'done', profile: 'done', channel: 'done', seed: 'pending', skills: 'pending', credential: 'pending', audit: 'pending',
    'worker-restart': 'pending', sidecars: 'pending', container: 'pending', verify: 'pending' });   // cấu hình kênh mới hơn worker ⇒ vẫn phải khởi động lại
  const finished = addFacts({ home: { exists: true, uid: 10107, private: true, profileDir: true, seeded: true, skills: true, hasEnv: true }, audit: { dropIn: true, listed: true, registered: true }, memAvailableMb: 100,
    native: { ...addFacts().native, channels: [...addFacts().native.channels, { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] },
    containers: [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('lan'))] });
  const done = planAdd(finished, realRequest(), cfg);
  assert.equal(done.status, 'ready'); assert.equal(done.pendingSteps, 0);            // RAM thấp không chặn khi container đã chạy
  assert.deepEqual(states(done), { home: 'done', profile: 'done', channel: 'done', seed: 'done', skills: 'done', credential: 'pending', audit: 'done',
    'worker-restart': 'done', sidecars: 'done', container: 'done', verify: 'pending' });
  // Sidecar của chính người này bám worker cũ ⇒ bước container làm lại; sidecar khác bám worker cũ ⇒ bước sidecars làm lại.
  const stale = planAdd({ ...finished, memAvailableMb: 800, containers: [sidecarView(sidecarInspect({ workerId: NEW_WORKER_ID })), sidecarView(fleetSidecar('lan', { workerId: NEW_WORKER_ID }))] }, realRequest(), cfg);
  assert.equal(states(stale).container, 'pending'); assert.equal(states(stale).sidecars, 'pending');
});

test('go-nguoi: chỉ gỡ thứ do công cụ dựng; cất home, giữ container, không xoá', () => {
  const cfg = config(), home = { exists: true, uid: 10100, private: true, profileDir: true, seeded: true, hasEnv: true };
  const native = { ...addFacts().native, channels: [...addFacts().native.channels, { profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false }] };
  const facts = { containers: [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('lan'))], home, native, audit: { dropIn: true, listed: true, registered: true }, worker: addFacts().worker };
  const plan = planRemove(facts, { name: 'lan' }, cfg);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(states(plan), { stop: 'pending', 'revoke-channel': 'pending', audit: 'pending', 'archive-home': 'pending' });
  assert(plan.steps.find(step => step.id === 'archive-home').summary.includes('/var/lib/ihome-hermes-profiles-archive/lan-'));
  assert(plan.followUp.join(' ').includes('/settings/hermes'));
  // hermes-owner (dựng tay, không nhãn fleet, home không có dấu gieo) không bao giờ bị công cụ gỡ.
  // Mã ghi của go-nguoi ràng cấu hình môi trường; danh sách kiểm học tập hỏng thì chặn từ đầu (người thử thì không: chưa từng đăng ký).
  assert.notEqual(planRemove(facts, { name: 'lan' }, config({ archiveRoot: '/var/lib/kho-khac' })).expectedRevision, plan.expectedRevision);
  assert.deepEqual(planRemove({ ...facts, audit: { dropIn: false, listed: true, registered: false, broken: true } }, { name: 'lan' }, cfg).blocks, ['audit_cau_hinh_hong']);
  // Đăng ký kiểm học tập còn MỘT nửa (hỏng giữa hai lần ghi) vẫn phải gỡ nốt.
  for (const half of [{ dropIn: true, listed: false, registered: false }, { dropIn: false, listed: true, registered: false }])
    assert.equal(states(planRemove({ ...facts, audit: half }, { name: 'lan' }, cfg)).audit, 'pending');
  // Lượt thêm dở (chưa có container, hồ sơ chưa gieo) vẫn gỡ được: dấu sở hữu là UID của home do root đặt, không phải file trong home.
  const halfDone = planRemove({ ...facts, containers: [sidecarView(sidecarInspect())], home: { exists: true, uid: 10150, private: true, profileDir: false, seeded: false, hasEnv: false }, audit: {} }, { name: 'lan' }, cfg);
  assert.equal(halfDone.status, 'ready'); assert.equal(states(halfDone)['archive-home'], 'pending');
  // Home thuộc UID ngoài khoảng công cụ cấp (dựng tay) mà không có container mang nhãn ⇒ không gỡ, kể cả khi trong home có dấu gieo.
  assert.deepEqual(planRemove({ ...facts, containers: [], home: { exists: true, uid: 10003, private: true, profileDir: true, seeded: true, hasEnv: true } }, { name: 'lan' }, cfg).blocks, ['khong_phai_cua_cong_cu']);
  const owner = planRemove({ ...facts, home: { ...home, uid: 10003, seeded: false } }, { name: 'owner' }, cfg);
  assert.equal(owner.status, 'blocked'); assert.deepEqual(owner.blocks, ['khong_phai_cua_cong_cu']);
  assert.deepEqual(planRemove({ ...facts, containers: [], home: { exists: false } }, { name: 'khong-co' }, cfg).blocks, ['khong_tim_thay']);
  // Người thử: không có kênh thật để thu hồi; không đọc được cấu hình kênh cũng không chặn.
  const trial = planRemove({ containers: [sidecarView(fleetSidecar('thu1', { labels: { [FLEET_LABELS.name]: 'thu1', [FLEET_LABELS.trial]: 'true' } }))], home, native: { ok: false }, audit: { registered: false } }, { name: 'thu1' }, cfg);
  assert.equal(trial.status, 'ready'); assert.equal(states(trial)['revoke-channel'], 'skipped'); assert.equal(states(trial).audit, 'skipped');
  // Người thử trùng tên một kênh thật: gỡ người thử KHÔNG thu hồi kênh thật đó.
  const sameName = planRemove({ containers: [sidecarView(fleetSidecar('thu1', { labels: { [FLEET_LABELS.name]: 'thu1', [FLEET_LABELS.trial]: 'true' } }))], home,
    native: { ...native, channels: [{ profile: 'thu1', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '400', unissued: false }] }, audit: {} }, { name: 'thu1' }, cfg);
  assert.equal(states(sameName)['revoke-channel'], 'skipped');
  const trialBroken = planRemove({ containers: [sidecarView(fleetSidecar('thu1', { labels: { [FLEET_LABELS.name]: 'thu1', [FLEET_LABELS.trial]: 'true' } }))], home, native,
    audit: { dropIn: false, listed: true, registered: false, broken: true } }, { name: 'thu1' }, cfg);
  assert.equal(trialBroken.status, 'ready'); assert.equal(states(trialBroken).audit, 'skipped');
  assert.deepEqual(planRemove({ ...facts, native: { ok: false } }, { name: 'lan' }, cfg).blocks, ['khong_doc_duoc_cau_hinh_kenh']);
  // Đã gỡ xong (kênh đã thu hồi, không còn container/home đăng ký) ⇒ done.
  const again = planRemove({ containers: [], home: { exists: true, uid: 10100, private: true, profileDir: true, seeded: true, hasEnv: true },
    native: { ...native, channels: [{ profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: true }] }, audit: { registered: false } }, { name: 'lan' }, cfg);
  assert.deepEqual(states(again), { stop: 'skipped', 'revoke-channel': 'skipped', audit: 'skipped', 'archive-home': 'pending' });
});

test('tao-lai-sidecar: chỉ sidecar bám worker cũ hoặc đã dừng; bỏ qua container đã thay/đã gỡ; --chi giới hạn phạm vi', () => {
  const cfg = config(), worker = { running: true, id: NEW_WORKER_ID };
  const containers = [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('lan', { workerId: NEW_WORKER_ID })),
    sidecarView(sidecarInspect({ name: 'hermes-owner-old-20260102T030405Z', running: false })), sidecarView(fleetSidecar('thu1', { running: false, workerId: NEW_WORKER_ID }))];
  const mem = { memAvailableMb: 800 };
  const plan = planRecreate({ containers, worker, ...mem }, {}, cfg);
  assert.equal(plan.status, 'ready');
  // Sidecar đang dừng không bị làm sống lại trừ khi được nêu đích danh.
  assert.deepEqual(plan.sidecars.map(row => [row.container, row.state]), [['hermes-lan', 'ok'], ['hermes-owner', 'recreate'], ['hermes-thu1', 'stopped']]);
  assert.deepEqual(planRecreate({ containers: [containers[1], containers[3]], worker }, {}, cfg).status, 'done');
  // Container chung network namespace với worker mà không mang nhãn: chạy cho mọi sidecar thì dừng, không báo xong mà bỏ sót nó.
  const unlabelled = sidecarView(sidecarInspect({ name: 'tro-ly-dung-tay', workerId: NEW_WORKER_ID, labels: { 'com.ihomecrm.component': 'khac' } }));
  assert.deepEqual(planRecreate({ containers: [containers[1], unlabelled], worker }, {}, cfg).blocks, ['sidecar_khong_nhan']);
  assert.equal(planRecreate({ containers: [containers[1], containers[3], unlabelled], worker, ...mem }, { only: ['hermes-thu1'] }, cfg).status, 'ready');
  // Container không nhãn đang chạy, bám một worker ĐÃ BỊ THAY (ID không còn tồn tại): nằm ở namespace mồ côi ⇒ cũng dừng.
  const orphan = sidecarView(sidecarInspect({ name: 'tro-ly-mo-coi', workerId: 'e'.repeat(64), labels: { 'com.ihomecrm.component': 'khac' } }));
  assert.deepEqual(planRecreate({ containers: [containers[1], orphan], worker }, {}, cfg).blocks, ['sidecar_khong_nhan']);
  // Container không nhãn đã dừng, hoặc bám một container còn tồn tại (vd bảng điều khiển bám sidecar) thì không tính.
  const stoppedOrphan = sidecarView(sidecarInspect({ name: 'bang-dieu-khien', workerId: 'e'.repeat(64), running: false, labels: { 'com.ihomecrm.component': 'khac' } }));
  const attached = sidecarView(sidecarInspect({ name: 'bam-sidecar', workerId: containers[1].id, labels: { 'com.ihomecrm.component': 'khac' } }));
  assert.equal(planRecreate({ containers: [containers[1], stoppedOrphan, attached], worker }, {}, cfg).status, 'done');
  assert.notEqual(planRecreate({ containers, worker }, {}, config({ image: `sha256:${'d'.repeat(64)}` })).expectedRevision, plan.expectedRevision);
  const only = planRecreate({ containers, worker, ...mem }, { only: ['hermes-thu1'] }, cfg);
  // Dựng lại một sidecar đang dừng là thêm một container chạy: RAM thấp thì từ chối, kể cả khi nêu đích danh.
  assert.deepEqual(planRecreate({ containers, worker, memAvailableMb: 300 }, { only: ['hermes-thu1'] }, cfg).blocks, ['ram_khong_du']);
  assert.deepEqual(planRecreate({ containers, worker }, { only: ['hermes-thu1'] }, cfg).blocks, ['ram_khong_do_duoc']);
  // Sidecar KHÔNG chạy mà bám worker cũ = chết vì worker đã bị thay ⇒ được tạo lại dù không nêu tên (không báo "xong" mà bỏ nó nằm chết).
  const deadStale = sidecarView(fleetSidecar('ha', { running: false }));
  assert.deepEqual(planRecreate({ containers: [containers[1], deadStale], worker, ...mem }, {}, cfg).sidecars.map(row => [row.container, row.state]), [['hermes-ha', 'recreate'], ['hermes-lan', 'ok']]);
  assert.deepEqual(planRecreate({ containers: [containers[1], deadStale], worker, memAvailableMb: 300 }, {}, cfg).blocks, ['ram_khong_du']);
  assert.deepEqual(only.sidecars.map(row => row.container), ['hermes-thu1']);       // thử trên VPS mà không đụng hermes-owner
  assert.notEqual(only.expectedRevision, plan.expectedRevision);
  assert.equal(planRecreate({ containers: [containers[1]], worker }, {}, cfg).status, 'done');
  assert.deepEqual(planRecreate({ containers, worker }, { only: ['hermes-la'] }, cfg).blocks, ['khong_tim_thay']);
  assert.deepEqual(planRecreate({ containers, worker: { running: false, id: null } }, {}, cfg).blocks.slice(0, 1), ['worker_khong_chay']);
  const loose = sidecarInspect(); loose.HostConfig.CapAdd = ['NET_ADMIN'];
  const blocked = planRecreate({ containers: [sidecarView(loose)], worker }, {}, cfg);
  assert.equal(blocked.status, 'blocked'); assert.deepEqual(blocked.sidecars[0].violations, ['capabilities']);
  assert.equal(code(() => planRecreate({ containers, worker }, { only: ['x; rm -rf /'] }, cfg)), 'tham_so_sai');
});

test('liet-ke: mỗi trợ lý một dòng; container dựng tay hiện là "không do công cụ"', () => {
  const digest = connectionDigest(CONNECTION_ID);
  assert.match(digest, /^[a-f0-9]{8}$/);
  const rows = listRows({ containers: [sidecarView(sidecarInspect()), sidecarView(fleetSidecar('lan')), sidecarView(sidecarInspect({ name: 'hermes-owner-old-20260102T030405Z' }))],
    worker: { id: WORKER_ID }, native: { ok: true, channels: [{ profile: 'owner', unissued: false }, { profile: 'lan', unissued: true }] },
    usage: { 'hermes-lan': { usedMb: 412 } }, gateways: { 'hermes-lan': { state: 'running', zalo: 'connected' } },
    lastCalls: { [digest]: { any: '2026-01-02T03:04:05.000Z', tool: null } } });
  assert.deepEqual(rows.map(row => row.container), ['hermes-lan', 'hermes-owner']);
  assert.deepEqual(rows[0], { name: 'lan', container: 'hermes-lan', managed: true, trial: false, running: true, currentNetwork: true, ramMb: 412, ramLimitMb: 900,
    channel: 'đã thu hồi', gateway: 'running', zalo: 'connected', connection: `…${CONNECTION_ID.slice(-8)}`, lastCrmCall: { any: '2026-01-02T03:04:05.000Z', tool: null } });
  assert.equal(rows[1].managed, false); assert.equal(rows[1].name, 'owner'); assert.equal(rows[1].channel, 'có'); assert.equal(rows[1].lastCrmCall, null);
});

test('don-handoff: chỉ ID quản trị nêu, phải có trong kho, và connector không còn nhận mã đó', () => {
  const records = [{ connectionId: id('a') }, { connectionId: id('b') }, { connectionId: id('c') }];
  const ok = planPrune({ handoff: { ok: true, records }, alive: { [id('a')]: false } }, { connectionIds: [id('a')] });
  assert.equal(ok.status, 'ready'); assert.equal(ok.total, 3);
  assert.equal(ok.expectedRevision, pruneRevision([id('a')], records.map(row => row.connectionId)));
  assert.notEqual(ok.expectedRevision, pruneRevision([id('a')], [id('a'), id('b')]));                       // kho đổi ⇒ mã đổi
  const alive = planPrune({ handoff: { ok: true, records }, alive: { [id('a')]: true } }, { connectionIds: [id('a')] });
  assert.deepEqual(alive.blocks, ['ket_noi_con_song']);
  assert.equal(alive.expectedRevision, null);                                                                // kế hoạch bị chặn không phát mã ghi
  assert.equal(planPrune({ handoff: { ok: true, records }, alive: {} }, { connectionIds: [id('a')] }).expectedRevision, null);
  assert.match(ok.note, /SQL báo ĐÃ THU HỒI/);
  assert.deepEqual(planPrune({ handoff: { ok: true, records }, alive: {} }, { connectionIds: [id('a')] }).blocks, ['khong_kiem_duoc_ket_noi']);
  assert.deepEqual(planPrune({ handoff: { ok: true, records }, alive: {} }, { connectionIds: [id('d')] }).blocks, ['khong_co_trong_handoff']);
  assert.equal(code(() => planPrune({ handoff: { ok: true, records } }, { connectionIds: [] })), 'tham_so_sai');
  assert.equal(code(() => planPrune({ handoff: { ok: true, records } }, { connectionIds: [id('a'), id('a')] })), 'tham_so_sai');
  assert(!JSON.stringify(ok).includes(id('a')));                                                              // chỉ in 8 ký tự cuối
});

test('đăng ký kiểm học tập: drop-in gắn đúng sáu đường chỉ đọc; danh sách gốc thêm rồi bớt về như cũ', () => {
  const cfg = config(), dropIn = auditDropIn(cfg, 'lan'), base = '/var/lib/ihome-hermes-profiles/lan/.hermes/profiles/lan';
  assert.match(dropIn, /^# Sinh bởi infra\/hermes-fleet/);
  const line = dropIn.split('\n').find(row => row.startsWith('BindReadOnlyPaths='));
  assert.deepEqual(line.slice('BindReadOnlyPaths='.length).split(' '), ['skills', 'memories', '.curator_backups', 'state.db', 'state.db-wal', 'state.db-shm'].map(entry => `-${base}/${entry}`));
  assert(!dropIn.match(/\.env|config\.yaml|BindPaths=/));                             // không gắn bí mật, không gắn ghi được
  const added = auditScanConfig(null, cfg, 'lan');
  assert.deepEqual(added, { profilesRoots: ['/var/lib/ihome-hermes-profiles/owner/.hermes/profiles', '/var/lib/ihome-hermes-profiles/lan/.hermes/profiles'], realProfiles: ['owner', 'lan'] });
  assert.deepEqual(auditScanConfig(added, cfg, 'lan'), added);                         // chạy lại không nhân đôi
  assert.deepEqual(auditScanConfig({ ...added, windowHours: 24 }, cfg, 'lan', { remove: true }),
    { profilesRoots: ['/var/lib/ihome-hermes-profiles/owner/.hermes/profiles'], realProfiles: ['owner'], windowHours: 24 });
});
