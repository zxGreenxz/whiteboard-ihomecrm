import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { splitHermesFunctionStatements } from '../../scripts/hermes-task-function-contract.mjs';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';

// Gate (chủ chốt 17/10/2026): Hermes không phụ thuộc lúc chạy vào Copilot.
//  1. Bản định nghĩa CUỐI của mọi hàm hermes_* (public/app_private) trong migrations
//     không nhắc tới Copilot, và mọi hàm chúng gọi tới (bắc cầu, qua bản cuối của hàm
//     định nghĩa trong migrations) cũng vậy. Hạt giống còn gồm RPC mà connector gọi.
//  2. Mã nguồn infra/hermes-* (trừ test, fixture, tài liệu .md) không nhắc tới Copilot.
// Không thay bằng catalog live: đây là kiểm tĩnh, chạy trước khi migration lên production.
// Khoảng mù: hàm tạo ngoài migrations (sửa tay trên production) và SQL động (EXECUTE)
// không thấy được ở đây.
const root = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = join(root, 'supabase', 'migrations');
const INFRA = ['infra/hermes-broker', 'infra/hermes-runtime', 'infra/hermes-zalo-router', 'infra/hermes-zalo-native'];
const COPILOT = /copilot/i;

// SQL: allowlist RỖNG. Một hàm Hermes cần dữ liệu Copilot đang có thì gọi thẳng hàm web
// dùng cho dữ liệu đó hoặc bộ giải chung mà hàm Copilot bọc, không thêm dòng vào đây.
const SQL_ALLOWLIST = new Map();
// infra: chỉ còn relay model của chế độ host v1 (prototype quản lý model, chưa từng
// deploy; production chạy connector-only, createRuntimeGateway ném tool_not_available).
// Relay đi qua Edge llm-proxy của Copilot và ánh xạ mã lỗi của nó. CONNECTOR.md giữ relay
// làm phương án tuỳ chọn chờ tách admission: việc gỡ là quyết định của chủ. Số dòng là
// chính xác: gỡ/đổi dòng nào thì phải sửa allowlist này (không để mục thừa).
const INFRA_ALLOWLIST = new Map([
  ['infra/hermes-broker/model-relay.mjs', { lines: 2, reason: 'host v1 relay: llm-proxy error code copilot_disabled + header x-copilot-feature' }],
  ['infra/hermes-broker/runtime-model-service.mjs', { lines: 1, reason: 'host v1 relay: definite llm-proxy error copilot_disabled' }],
]);

const stripSql = sql => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
/** Latest CREATE per schema.name in file order (a later CREATE OR REPLACE wins, DROP removes). */
function finalFunctions() {
  const finals = new Map();
  for (const file of readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    if (!/\bFUNCTION\b/i.test(sql)) continue;
    for (const raw of /hermes_/i.test(sql) ? splitHermesFunctionStatements(sql) : splitSqlStatements(sql)) {
      const statement = stripSql(raw).trim();
      const created = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(/i.exec(statement);
      if (created) finals.set(`${(created[1] ?? 'public').toLowerCase()}.${created[2].toLowerCase()}`, { file, statement });
      const dropped = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(statement);
      if (dropped) finals.delete(`${(dropped[1] ?? 'public').toLowerCase()}.${dropped[2].toLowerCase()}`);
    }
  }
  return finals;
}
function walk(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return ['node_modules', '__pycache__', '.venv'].includes(name) ? [] : walk(path);
    return [path];
  });
}
const infraSources = () => INFRA.flatMap(directory => walk(join(root, directory)))
  .map(path => relative(root, path).split(sep).join('/'))
  .filter(path => !/\.test\.|fixture|\.md$/i.test(path));

const finals = finalFunctions();
const byName = new Map();
for (const key of finals.keys()) { const name = key.split('.')[1]; byName.set(name, [...byName.get(name) ?? [], key]); }
const hermes = [...finals.keys()].filter(key => /^(?:public|app_private)\.\w*hermes_/.test(key));

test('the scan sees the Hermes SQL surface and the connector source (not an empty pass)', () => {
  assert(finals.size > 1000, `function definitions parsed: ${finals.size}`);
  assert(hermes.length > 200, `hermes_* final definitions: ${hermes.length}`);
  for (const key of ['public.hermes_scope_buildings_v1', 'public.hermes_room_scope_map_v1', 'public.hermes_sale_listing_rooms_v1',
    'app_private.authorized_scope_v3']) assert(finals.has(key), key);
  // Every scanned definition has a complete body: dollar-quoted, or SQL-standard joined with END.
  for (const name of hermes) {
    const { statement } = finals.get(name);
    assert(/\bAS\s+(\$\w*\$)[\s\S]*\1\s*$/i.test(statement) || /\bBEGIN\s+ATOMIC\b[\s\S]*\bEND\s*$/i.test(statement), `${name}: body`);
  }
  assert(infraSources().length > 60);
});

test('final hermes_* SQL definitions do not reference Copilot (allowlist empty)', () => {
  const offenders = hermes.filter(key => COPILOT.test(finals.get(key).statement)).map(key => `${key} [${finals.get(key).file}]`);
  assert.deepEqual(offenders.filter(entry => !SQL_ALLOWLIST.has(entry.split(' ')[0])), []);
  assert.equal(SQL_ALLOWLIST.size, 0);
});

test('nothing reachable from Hermes SQL or the connector RPCs references Copilot', () => {
  const rpcSeeds = new Set();
  for (const path of infraSources()) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const match of text.matchAll(/\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)/g)) rpcSeeds.add(match[1]);
    for (const match of text.matchAll(/\b(?:public|app_private)\.([a-z_][a-z0-9_]*)\s*\(/g)) rpcSeeds.add(match[1]);
  }
  for (const name of ['get_authorization_context_v1', 'get_my_organizations', 'hermes_scope_buildings_v1']) assert(rpcSeeds.has(name), `connector seed ${name}`);
  // Calls resolve by name to every schema's latest definition (search_path is not modelled).
  const from = new Map([...hermes, ...[...rpcSeeds].flatMap(name => byName.get(name) ?? [])].map(key => [key, null]));
  const queue = [...from.keys()];
  while (queue.length) {
    const key = queue.shift(), { statement } = finals.get(key);
    const body = statement.slice(statement.indexOf('(') + 1);
    for (const call of body.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
      for (const callee of byName.get(call[1].toLowerCase()) ?? []) {
        if (callee !== key && !from.has(callee)) { from.set(callee, key); queue.push(callee); }
      }
    }
  }
  const path = key => { const chain = []; for (let at = key; at; at = from.get(at)) chain.unshift(at); return chain.join(' -> '); };
  const reached = [...from.keys()].filter(key => COPILOT.test(finals.get(key).statement) || COPILOT.test(key));
  assert.deepEqual(reached.map(path), []);
  assert(from.has('app_private.authorized_scope_v3') && from.has('public.get_public_available_rooms'), 'shared resolver and sale page reader are reached');
});

test('infra/hermes-* source does not reference Copilot except the exact host v1 relay lines', () => {
  const found = new Map();
  for (const path of infraSources()) {
    const lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/).filter(line => COPILOT.test(line)).length;
    if (lines) found.set(path, lines);
  }
  assert.deepEqual(Object.fromEntries(found), Object.fromEntries([...INFRA_ALLOWLIST].map(([path, { lines }]) => [path, lines])));
  for (const { reason } of INFRA_ALLOWLIST.values()) assert.match(reason, /host v1/);
});
