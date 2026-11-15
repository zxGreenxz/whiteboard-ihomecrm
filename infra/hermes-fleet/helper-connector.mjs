#!/usr/bin/env node
// Helper chạy bằng ĐÚNG user của connector (vd `setpriv --reuid ihome-hermes …`), do fleet.mjs (root) gọi. Chỉ user này đọc được
// connector.json, khoá mã hoá và thư mục handoff (0700/0600). Không bao giờ in mã kết nối ra terminal hay log:
//   list     danh sách bản ghi handoff, KHÔNG có mã
//   check    hỏi chính connector đang chạy xem mã của từng kết nối còn được nhận không (MCP `ping` qua loopback)
//   export   ghi {"version":1,"credential":"hc_…"} của ĐÚNG một kết nối ra stdout; từ chối khi stdout là terminal
//   binding  đọc liên kết Zalo từ SQL bằng lệnh đọc cố định readZaloBinding (không có lệnh ghi)
//   prune    CẤT bản ghi handoff của các kết nối đã thu hồi sang <stateRoot>/handoff-archive (mặc định chỉ xem)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnectionHandoff } from '../hermes-broker/connection-handoff.mjs';
import { createStorePool } from '../hermes-broker/store-pool.mjs';
import { createStoreTransport } from '../hermes-broker/store-transport.mjs';
import { loadHostConfiguration } from '../hermes-runtime/host-config.mjs';
import { pruneRevision, uuid } from './fleet-plan.mjs';

const fail = code => { throw new Error(code); };
const IDS = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const PUBLIC = /^fleet_[a-z_]+$/;

async function withHandoff(configuration, run, { createHandoff = createConnectionHandoff } = {}) {
  const handoff = createHandoff({ directory: configuration.paths.handoffDirectory, ...configuration.encryption });
  try { return await run(await handoff.list()); } finally { await handoff.close(); }
}
/** Connector trả 200 cho `ping` khi mã còn được nhận, 401 khi hết hạn/thu hồi. Mọi kết quả khác là "không biết". */
export function pingConnector({ port, token, request = http.request, timeoutMs = 8000 }) {
  return new Promise(resolve => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` } }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size <= 4096) chunks.push(chunk); });
      response.on('end', () => {
        if (response.statusCode === 401) return resolve(false);
        if (response.statusCode !== 200) return resolve(null);
        try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(parsed?.result && !parsed.error ? true : null); }
        catch { resolve(null); }
      });
      response.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}
function parse(argv) {
  const [command, ...rest] = argv, options = { connectionIds: [] };
  const names = { '--config': 'config', '--assistant-id': 'assistantId', '--user-id': 'userId', '--organization-id': 'organizationId',
    '--binding-id': 'bindingId', '--expect': 'expect' };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--apply' && !options.apply) { options.apply = true; continue; }
    const value = rest[++index];
    if (typeof value !== 'string' || value.startsWith('--')) fail('fleet_arguments');
    if (flag === '--connection-id') { if (!uuid(value) || options.connectionIds.includes(value)) fail('fleet_arguments'); options.connectionIds.push(value); continue; }
    const name = names[flag];
    if (!name || Object.hasOwn(options, name)) fail('fleet_arguments');
    options[name] = value;
  }
  if (!['list', 'check', 'export', 'binding', 'prune'].includes(command) || typeof options.config !== 'string') fail('fleet_arguments');
  return { command, options };
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export async function runConnectorHelper(argv, { load = loadHostConfiguration, createHandoff, ping = pingConnector, connectStore,
  write = text => process.stdout.write(text), error = text => process.stderr.write(text), isTTY = () => process.stdout.isTTY === true,
  now = () => new Date() } = {}) {
  let configuration;
  try {
    const { command, options } = parse(argv);
    configuration = await load(options.config);
    if (command === 'binding') {
      if (!uuid(options.bindingId)) fail('fleet_arguments');
      const connect = connectStore ?? (store => { const pool = createStorePool(store);
        return { transport: createStoreTransport({ pool, expectedRole: store.role }), close: () => pool.end() }; });
      const connection = await connect(configuration.store);
      try {
        const row = await connection.transport.call('readZaloBinding', { bindingId: options.bindingId }, { signal: new AbortController().signal });
        write(JSON.stringify({ version: 1, binding: row ?? null }) + '\n');
      } finally { await connection.close(); }
      return 0;
    }
    if (command === 'list') {
      const records = await withHandoff(configuration, rows => rows.map(row => Object.fromEntries(IDS.map(key => [key, row[key]]))), { createHandoff });
      write(JSON.stringify({ version: 1, total: records.length, records }) + '\n');
      return 0;
    }
    if (command === 'check') {
      if (!options.connectionIds.length) fail('fleet_arguments');
      const alive = {};
      await withHandoff(configuration, async rows => {
        for (const id of options.connectionIds) {
          const row = rows.find(entry => entry.connectionId === id);
          alive[id] = row ? await ping({ port: configuration.listenPort, token: row.token }) : null;
        }
      }, { createHandoff });
      write(JSON.stringify({ version: 1, alive }) + '\n');
      return 0;
    }
    if (command === 'export') {
      // Mã chỉ đi qua ống tới tiến trình cha (root) rồi vào stdin của bộ ghi hồ sơ; không bao giờ ra màn hình.
      if (isTTY()) fail('fleet_refuse_terminal');
      if (options.connectionIds.length !== 1 || !IDS.slice(1).every(key => uuid(options[key]))) fail('fleet_arguments');
      const credential = await withHandoff(configuration, rows => {
        const matched = rows.filter(row => row.connectionId === options.connectionIds[0] && IDS.slice(1).every(key => row[key] === options[key]));
        if (matched.length !== 1) fail('fleet_credential_absent');
        return matched[0].token;
      }, { createHandoff });
      write(JSON.stringify({ version: 1, credential }));
      return 0;
    }
    // prune: một tiến trình ghi cho mỗi thư mục handoff ⇒ chỉ ghi khi connector đã dừng sạch (không còn khoá sở hữu).
    if (!options.connectionIds.length) fail('fleet_arguments');
    const directory = configuration.paths.handoffDirectory, stateRoot = configuration.paths.stateRoot;
    const known = await withHandoff(configuration, rows => rows.map(row => row.connectionId), { createHandoff });
    if (options.connectionIds.some(id => !known.includes(id))) fail('fleet_record_absent');
    const revision = pruneRevision(options.connectionIds, known);
    if (!options.apply) { write(JSON.stringify({ version: 1, status: 'planned', total: known.length, selected: options.connectionIds.length, expectedRevision: revision }) + '\n'); return 0; }
    if (options.expect !== revision) fail('fleet_revision_changed');
    if (fs.existsSync(path.join(stateRoot, '.hermes-host.lock'))) fail('fleet_connector_running');
    const archive = path.join(stateRoot, 'handoff-archive'), stamp = now().toISOString().replace(/[-:]|\.\d+/g, '');
    try { fs.mkdirSync(archive, { mode: 0o700 }); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const info = fs.lstatSync(archive);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700))) fail('fleet_archive_refused');
    let moved = 0;
    for (const id of options.connectionIds) {
      fs.renameSync(path.join(directory, `${id}.handoff.json`), path.join(archive, `${id}.handoff.json.${stamp}`));
      moved++;
    }
    syncDirectory(directory); syncDirectory(archive);
    write(JSON.stringify({ version: 1, status: 'archived', moved, remaining: known.length - moved }) + '\n');
    return 0;
  } catch (cause) {
    error(JSON.stringify({ error: PUBLIC.test(cause?.message ?? '') ? cause.message : 'fleet_connector_helper_failed' }) + '\n');
    return 1;
  } finally { configuration?.dispose?.(); }
}
const isMain = () => { try { return fs.realpathSync(path.resolve(process.argv[1] ?? '')) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) process.exitCode = await runConnectorHelper(process.argv.slice(2));
