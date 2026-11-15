import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { applyNativeProfileUpdate, planNativeProfileUpdate } from '../hermes-zalo-native/profile-provisioning.mjs';
import { SEED_MARKER, SEEDING_MARKER, mcpRoute, profileEnv, pruneRevision, renderProfileConfig, trialIdentity } from './fleet-plan.mjs';
import { PLUGINS, SEED_INPUT_MAX_BYTES, runHomeHelper, seedProfile } from './helper-home.mjs';
import { listChannels, runChannelHelper } from './helper-channel.mjs';
import { pingConnector, runConnectorHelper } from './helper-connector.mjs';
import { ACCOUNT_ID, CHANNEL_TOKEN, CREDENTIAL, PERSON, PROVIDER_KEY, id } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = t => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-helper-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const template = () => fs.readFileSync(path.join(HERE, 'khuon', 'config.yaml'), 'utf8');
const channel = (change = {}) => ({ accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', mainUid: '300', profile: 'lan', generation: id('7'), token: CHANNEL_TOKEN, listenPort: 8991, ...change });
const seedRequest = (route, projection = channel()) => ({ version: 1, configYaml: renderProfileConfig(template(), { route }), soul: '# SOUL giả cho test\n',
  env: profileEnv({ shared: { NINEROUTER_API_KEY: PROVIDER_KEY }, channel: projection }) });
function capture() { let stdout = '', stderr = ''; return { io: { write: text => { stdout += text; }, error: text => { stderr += text; } }, out: () => stdout, err: () => stderr }; }

test('gieo hồ sơ từ khuôn: ghi config/.env/SOUL/plugin một lần, không ghi đè hồ sơ sống, từ chối hồ sơ không mới', t => {
  const profileDir = path.join(temp(t), 'lan');
  fs.mkdirSync(profileDir, { mode: 0o755 });
  fs.writeFileSync(path.join(profileDir, 'config.yaml'), 'model: {}\n');           // mặc định do `hermes profile create` để lại
  const route = mcpRoute('http://172.17.0.1:8740/mcp');
  const first = seedProfile({ profileDir, request: seedRequest(route) });
  assert.deepEqual(first, { version: 1, status: 'seeded', changed: true, plugins: Object.keys(PLUGINS) });
  assert(!fs.existsSync(path.join(profileDir, SEEDING_MARKER)));                 // dấu "đang gieo" chỉ tồn tại trong lúc gieo
  assert.equal(fs.readFileSync(path.join(profileDir, 'config.yaml.upstream-default'), 'utf8'), 'model: {}\n');
  assert.equal(fs.readFileSync(path.join(profileDir, 'SOUL.md'), 'utf8'), '# SOUL giả cho test\n');
  for (const [name, source] of Object.entries(PLUGINS)) for (const file of source.files)
    assert.deepEqual(fs.readFileSync(path.join(profileDir, 'plugins', name, file)), fs.readFileSync(path.join(HERE, '..', source.from, file)));
  assert(fs.existsSync(path.join(profileDir, SEED_MARKER)));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(profileDir).mode & 0o777, 0o700);
    for (const file of ['config.yaml', '.env']) assert.equal(fs.statSync(path.join(profileDir, file)).mode & 0o777, 0o600);
  }
  // Chạy lại: không đổi gì, kể cả khi đầu vào khác (hồ sơ sống đang giữ mã CRM).
  const before = fs.readFileSync(path.join(profileDir, 'config.yaml'), 'utf8');
  assert.deepEqual(seedProfile({ profileDir, request: { ...seedRequest(route), soul: 'khác' } }), { version: 1, status: 'already_seeded', changed: false });
  assert.equal(fs.readFileSync(path.join(profileDir, 'config.yaml'), 'utf8'), before);
  // Thư mục đã có .env mang biến mà không có dấu gieo ⇒ không phải khung mới.
  const foreign = path.join(temp(t), 'khac'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, '.env'), 'MCP_IHOMECRM_API_KEY=x\n');
  assert.throws(() => seedProfile({ profileDir: foreign, request: seedRequest(route) }), /fleet_profile_not_fresh/);
  assert.equal(fs.readFileSync(path.join(foreign, '.env'), 'utf8'), 'MCP_IHOMECRM_API_KEY=x\n');
  // Lần gieo trước chết sau khi đã ghi .env (còn dấu "đang gieo", chưa có dấu xong): gieo lại được, không phải xoá tay.
  const crashed = path.join(temp(t), 'dang-do'); fs.mkdirSync(crashed);
  fs.writeFileSync(path.join(crashed, SEEDING_MARKER), '{}'); fs.writeFileSync(path.join(crashed, '.env'), 'HERMES_ZALO_PROFILE=cu\n'); fs.writeFileSync(path.join(crashed, 'config.yaml'), 'cu: true\n');
  assert.equal(seedProfile({ profileDir: crashed, request: seedRequest(route) }).status, 'seeded');
  assert(fs.readFileSync(path.join(crashed, '.env'), 'utf8').includes('HERMES_ZALO_PROFILE=lan\n') && !fs.existsSync(path.join(crashed, SEEDING_MARKER)));
  for (const request of [{ ...seedRequest(route), extra: 1 }, { ...seedRequest(route), version: 2 }, { ...seedRequest(route), env: '' }, null])
    assert.throws(() => seedProfile({ profileDir: path.join(temp(t)), request }), /fleet_seed_input/);
  assert.throws(() => seedProfile({ profileDir: 'tuong/doi', request: seedRequest(route) }), /fleet_arguments/);
});

test('hồ sơ vừa gieo qua được bộ ghi mã có sẵn: chỉ thêm Authorization, .env giữ nguyên từng byte, K1 đạt', t => {
  for (const [url, serverKey] of [['http://172.17.0.1:8740/mcp', 'ihomecrm'], ['https://crm-hermes.example.test/mcp', 'crm']]) {
    const profileDir = path.join(temp(t), 'lan'); fs.mkdirSync(profileDir, { mode: 0o700 });
    const route = mcpRoute(url);
    seedProfile({ profileDir, request: seedRequest(route) });
    const env = fs.readFileSync(path.join(profileDir, '.env'), 'utf8');
    const options = { home: profileDir, mcpUrl: url, profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300',
      ...(route.preserveOrigin ? { preserveExistingHttpOrigin: route.preserveOrigin } : {}) };
    const request = { version: 1, credential: CREDENTIAL };
    const plan = planNativeProfileUpdate(options, request);
    assert.equal(applyNativeProfileUpdate(options, request, plan.expectedRevision).changed, true);
    const config = yaml.load(fs.readFileSync(path.join(profileDir, 'config.yaml'), 'utf8'));
    assert.deepEqual(Object.keys(config.mcp_servers), [serverKey]);
    assert.equal(config.mcp_servers[serverKey].url, url);
    assert.equal(config.mcp_servers[serverKey].headers.Authorization, `Bearer ${CREDENTIAL}`);
    assert.deepEqual(config.platforms, { zalo_personal: { enabled: true } });
    assert.equal(fs.readFileSync(path.join(profileDir, '.env'), 'utf8'), env);
    assert(!env.includes(CREDENTIAL) && env.includes(CHANNEL_TOKEN) && env.includes(PROVIDER_KEY));
    // Sai nick ghép so với .env đã gieo ⇒ bộ ghi mã từ chối (công cụ không tự "sửa" danh tính kênh).
    assert.throws(() => planNativeProfileUpdate({ ...options, pairedUid: '999' }, request), /native_profile_provisioning_failed/);
  }
  // Kênh thử (cổng không ai nghe) đi cùng đường đó.
  const trialDir = path.join(temp(t), 'thu1'); fs.mkdirSync(trialDir, { mode: 0o700 });
  const identity = trialIdentity('thu1'), route = mcpRoute('http://172.17.0.1:8741/mcp');
  seedProfile({ profileDir: trialDir, request: seedRequest(route, channel({ ...identity, mainUid: identity.pairedUid, profile: 'thu1', listenPort: 8999 })) });
  const options = { home: trialDir, mcpUrl: route.url, profile: 'thu1', ...identity, preserveExistingHttpOrigin: route.preserveOrigin };
  assert.equal(planNativeProfileUpdate(options, { version: 1, credential: CREDENTIAL }).status, 'planned');
  assert(fs.readFileSync(path.join(trialDir, '.env'), 'utf8').includes('HERMES_ZALO_BRIDGE_URL=http://127.0.0.1:8999\n'));
});

test('helper home: đầu vào chỉ qua stdin có giới hạn; lỗi không lộ nội dung', async t => {
  const profileDir = path.join(temp(t), 'lan'); fs.mkdirSync(profileDir, { mode: 0o700 });
  const request = seedRequest(mcpRoute('http://172.17.0.1:8740/mcp')), good = capture();
  assert.equal(await runHomeHelper(['seed', '--profile-dir', profileDir], { input: Readable.from([JSON.stringify(request)]), ...good.io }), 0);
  assert.equal(JSON.parse(good.out()).status, 'seeded');
  assert(!good.out().includes(CHANNEL_TOKEN) && !good.out().includes(PROVIDER_KEY));
  for (const [argv, input] of [[['seed'], '{}'], [['seed', '--profile-dir', profileDir, 'x'], '{}'], [['other', '--profile-dir', profileDir], '{}'],
    [['seed', '--profile-dir', path.join(temp(t))], `{"env":"${CHANNEL_TOKEN}"`], [['seed', '--profile-dir', path.join(temp(t))], 'x'.repeat(SEED_INPUT_MAX_BYTES + 1)]]) {
    const bad = capture();
    assert.equal(await runHomeHelper(argv, { input: Readable.from([input]), ...bad.io }), 1);
    assert.equal(bad.out(), ''); assert.match(JSON.parse(bad.err()).error, /^fleet_[a-z_]+$/); assert(!bad.err().includes(CHANNEL_TOKEN));
  }
});

test('helper kênh: liệt kê không có token, đánh dấu kênh đã thu hồi; xuất bản chiếu từ chối terminal', t => {
  const root = temp(t), stateRoot = path.join(root, 'state'), configFile = path.join(root, 'config.json'), tokenFile = path.join(root, 'lan.token');
  fs.mkdirSync(stateRoot, { mode: 0o700 }); if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  fs.writeFileSync(tokenFile, CHANNEL_TOKEN + '\n', { mode: 0o600 });
  const revoked = path.join(root, `cu.unissued.${id('8')}.token`); fs.writeFileSync(revoked, `hzn_${'0'.repeat(64)}\n`, { mode: 0o600 });
  const { token: _token, listenPort: _port, ...disk } = channel();
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, listenPort: 8991, stateRoot, channels: [{ ...disk, tokenFile },
    { ...disk, profile: 'cu', pairedUid: '301', mainUid: '301', generation: id('9'), tokenFile: revoked }] }), { mode: 0o600 });
  const listed = listChannels(configFile);
  assert.equal(listed.present, true); assert.equal(listed.listenPort, 8991); assert.match(listed.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(listed.channels, [{ profile: 'lan', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '300', unissued: false },
    { profile: 'cu', accountId: ACCOUNT_ID, ownUid: '100', pairedUid: '301', unissued: true }]);
  assert(!JSON.stringify(listed).includes('hzn_'));
  assert.deepEqual(listChannels(path.join(root, 'khong-co.json')), { version: 1, present: false, channels: [] });
  const piped = capture();
  assert.equal(runChannelHelper(['export', '--config', configFile, '--profile', 'lan'], { ...piped.io, isTTY: () => false }), 0);
  assert.deepEqual(JSON.parse(piped.out()), channel());
  const terminal = capture();
  assert.equal(runChannelHelper(['export', '--config', configFile, '--profile', 'lan'], { ...terminal.io, isTTY: () => true }), 1);
  assert.equal(terminal.out(), ''); assert.equal(JSON.parse(terminal.err()).error, 'fleet_refuse_terminal');
  for (const argv of [['export', '--config', configFile], ['list', '--config', configFile, '--profile', 'lan'], ['export', '--config', configFile, '--profile', 'khong-co'], ['x']]) {
    const bad = capture();
    assert.equal(runChannelHelper(argv, { ...bad.io, isTTY: () => false }), 1); assert.equal(bad.out(), '');
  }
});

function connectorFixture(t, { lock = false } = {}) {
  const stateRoot = temp(t), handoffDirectory = path.join(stateRoot, 'handoff'); fs.mkdirSync(handoffDirectory, { mode: 0o700 });
  const rows = [{ connectionId: id('a'), ...PERSON, operationId: id('d'), token: CREDENTIAL },
    { connectionId: id('b'), ...PERSON, userId: id('9'), operationId: id('e'), token: `hc_${'T'.repeat(43)}` }];
  for (const row of rows) fs.writeFileSync(path.join(handoffDirectory, `${row.connectionId}.handoff.json`), 'mã hoá giả', { mode: 0o600 });
  if (lock) fs.writeFileSync(path.join(stateRoot, '.hermes-host.lock'), '{}');
  let disposed = 0, closed = 0;
  const deps = { load: async () => ({ paths: { stateRoot, handoffDirectory }, encryption: {}, listenPort: 8740, store: { role: 'hermes_store_host' }, dispose() { disposed++; } }),
    createHandoff: () => ({ list: async () => rows.filter(row => fs.existsSync(path.join(handoffDirectory, `${row.connectionId}.handoff.json`))), close: async () => { closed++; } }),
    now: () => new Date('2026-01-02T03:04:05Z') };
  return { stateRoot, handoffDirectory, rows, deps, counts: () => ({ disposed, closed }) };
}
const person = ['--assistant-id', PERSON.assistantId, '--user-id', PERSON.userId, '--organization-id', PERSON.organizationId];

test('helper connector: liệt kê không có mã; xuất đúng MỘT mã của đúng người, chỉ qua ống', async t => {
  const f = connectorFixture(t), listed = capture();
  assert.equal(await runConnectorHelper(['list', '--config', '/c.json'], { ...f.deps, ...listed.io }), 0);
  assert.deepEqual(JSON.parse(listed.out()).records.map(row => Object.keys(row)), [['connectionId', 'assistantId', 'userId', 'organizationId'], ['connectionId', 'assistantId', 'userId', 'organizationId']]);
  assert(!listed.out().includes('hc_'));
  const piped = capture();
  assert.equal(await runConnectorHelper(['export', '--config', '/c.json', '--connection-id', id('a'), ...person], { ...f.deps, ...piped.io, isTTY: () => false }), 0);
  assert.deepEqual(JSON.parse(piped.out()), { version: 1, credential: CREDENTIAL });      // đúng khuôn stdin của profile-provisioning-cli
  assert.deepEqual(f.counts(), { disposed: 2, closed: 2 });                                // khoá và kho được đóng sau mỗi lần
  const refused = [
    [['export', '--config', '/c.json', '--connection-id', id('a'), ...person], true, 'fleet_refuse_terminal'],                  // terminal
    [['export', '--config', '/c.json', '--connection-id', id('b'), ...person], false, 'fleet_credential_absent'],               // kết nối của người khác
    [['export', '--config', '/c.json', '--connection-id', id('c'), ...person], false, 'fleet_credential_absent'],               // không có
    [['export', '--config', '/c.json', '--connection-id', id('a')], false, 'fleet_arguments'],                                   // thiếu danh tính
    [['export', '--config', '/c.json', '--connection-id', id('a'), '--connection-id', id('b'), ...person], false, 'fleet_arguments'],
    [['dump', '--config', '/c.json'], false, 'fleet_arguments'],
  ];
  for (const [argv, tty, expected] of refused) {
    const bad = capture();
    assert.equal(await runConnectorHelper(argv, { ...f.deps, ...bad.io, isTTY: () => tty }), 1);
    assert.equal(bad.out(), ''); assert.equal(JSON.parse(bad.err()).error, expected); assert(!bad.err().includes('hc_'));
  }
  // Lỗi lạ của tầng dưới không bị in ra (có thể mang đường dẫn/khoá).
  const broken = capture();
  assert.equal(await runConnectorHelper(['list', '--config', '/c.json'], { ...f.deps, ...broken.io, load: async () => { throw new Error(`đọc ${CREDENTIAL} lỗi`); } }), 1);
  assert.equal(JSON.parse(broken.err()).error, 'fleet_connector_helper_failed'); assert(!broken.err().includes('hc_'));
});

test('helper connector: hỏi connector từng mã còn sống không; đọc liên kết bằng đúng lệnh đọc cố định', async t => {
  const f = connectorFixture(t), asked = [], checked = capture();
  const ping = async ({ port, token }) => { asked.push([port, token]); return token === CREDENTIAL; };
  assert.equal(await runConnectorHelper(['check', '--config', '/c.json', '--connection-id', id('a'), '--connection-id', id('b'), '--connection-id', id('c')], { ...f.deps, ...checked.io, ping }), 0);
  assert.deepEqual(JSON.parse(checked.out()).alive, { [id('a')]: true, [id('b')]: false, [id('c')]: null });
  assert.deepEqual(asked.map(row => row[0]), [8740, 8740]); assert(!checked.out().includes('hc_'));
  const calls = [], read = capture();
  const connectStore = async store => { calls.push(['connect', store.role]); return { transport: { call: async (operation, input) => { calls.push([operation, input]); return { bindingId: input.bindingId, status: 'active' }; } }, close: async () => { calls.push(['close']); } }; };
  assert.equal(await runConnectorHelper(['binding', '--config', '/c.json', '--binding-id', id('4')], { ...f.deps, ...read.io, connectStore }), 0);
  assert.deepEqual(calls, [['connect', 'hermes_store_host'], ['readZaloBinding', { bindingId: id('4') }], ['close']]);
  assert.deepEqual(JSON.parse(read.out()), { version: 1, binding: { bindingId: id('4'), status: 'active' } });
});

test('ping connector thật qua HTTP: 200 là sống, 401 là chết, còn lại là không biết', async t => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }).on('end', () => {
      seen.push([request.method, request.url, request.headers['content-type'], JSON.parse(body).method]);
      const token = request.headers.authorization;
      if (token === 'Bearer live') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"jsonrpc":"2.0","id":1,"result":{}}'); }
      else if (token === 'Bearer dead') { response.writeHead(401); response.end('{"error":"unauthorized"}'); }
      else if (token === 'Bearer odd') { response.writeHead(200); response.end('{"jsonrpc":"2.0","id":1,"error":{"code":-1}}'); }
      else { response.writeHead(503); response.end('{}'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(await pingConnector({ port, token: 'live' }), true);
  assert.equal(await pingConnector({ port, token: 'dead' }), false);
  assert.equal(await pingConnector({ port, token: 'odd' }), null);
  assert.equal(await pingConnector({ port, token: 'busy' }), null);
  assert.deepEqual(seen[0], ['POST', '/mcp', 'application/json', 'ping']);
  server.close(); await new Promise(resolve => server.once('close', resolve));
  assert.equal(await pingConnector({ port, token: 'live', timeoutMs: 500 }), null);       // connector tắt ⇒ không biết, không coi là chết
});

test('dọn handoff: mặc định chỉ xem; ghi cần đúng mã và connector đã dừng; bản ghi được CẤT, không xoá', async t => {
  const f = connectorFixture(t), planned = capture(), args = ['prune', '--config', '/c.json', '--connection-id', id('b')];
  // Helper không có chế độ xem trước và không bao giờ in mã ghi: mã chỉ do fleet.mjs phát sau khi hỏi connector từng mã còn sống không.
  assert.equal(await runConnectorHelper(args, { ...f.deps, ...planned.io }), 1);
  assert.equal(planned.out(), ''); assert.equal(JSON.parse(planned.err()).error, 'fleet_arguments');
  assert.deepEqual(fs.readdirSync(f.stateRoot), ['handoff']);
  const plan = { expectedRevision: pruneRevision([id('b')], [id('a'), id('b')]) };
  const wrong = capture();
  assert.equal(await runConnectorHelper([...args, '--apply', '--expect', '0'.repeat(64)], { ...f.deps, ...wrong.io }), 1);
  assert.equal(JSON.parse(wrong.err()).error, 'fleet_revision_changed');
  const missing = capture();
  assert.equal(await runConnectorHelper(['prune', '--config', '/c.json', '--connection-id', id('c'), '--apply', '--expect', plan.expectedRevision], { ...f.deps, ...missing.io }), 1);
  assert.equal(JSON.parse(missing.err()).error, 'fleet_record_absent');
  const running = connectorFixture(t, { lock: true }), busy = capture();
  assert.equal(await runConnectorHelper([...args, '--apply', '--expect', plan.expectedRevision], { ...running.deps, ...busy.io }), 1);
  assert.equal(JSON.parse(busy.err()).error, 'fleet_connector_running');
  assert.equal(fs.readdirSync(running.handoffDirectory).length, 2);
  const applied = capture();
  assert.equal(await runConnectorHelper([...args, '--apply', '--expect', plan.expectedRevision], { ...f.deps, ...applied.io }), 0);
  assert.deepEqual(JSON.parse(applied.out()), { version: 1, status: 'archived', moved: 1, remaining: 1 });
  assert.deepEqual(fs.readdirSync(f.handoffDirectory), [`${id('a')}.handoff.json`]);
  assert.deepEqual(fs.readdirSync(path.join(f.stateRoot, 'handoff-archive')), [`${id('b')}.handoff.json.20260102T030405Z`]);
  assert.equal(fs.readFileSync(path.join(f.stateRoot, 'handoff-archive', `${id('b')}.handoff.json.20260102T030405Z`), 'utf8'), 'mã hoá giả');
});
