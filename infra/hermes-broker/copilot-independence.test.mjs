import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { splitHermesFunctionStatements } from '../../scripts/hermes-task-function-contract.mjs';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';
import ts from 'typescript';

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
// infra: allowlist RỖNG (chủ chốt 17/10/2026: gỡ chế độ host v1 cùng relay model qua
// Edge llm-proxy của Copilot; connector-only không gọi model). Không thêm mục vào đây.
const INFRA_ALLOWLIST = new Map();

// Comments are prose, not dependencies: they are blanked (newlines kept) before any
// match. String/identifier literals are kept, so `--`, `//` or `#` inside them never
// hides code. Dollar-quoted text is scanned as code on purpose: it is the function body.
// A misread can only keep text (a false red), never drop a literal.
function stripSql(sql) {
  let out = '', i = 0;
  const blank = text => text.replace(/[^\n]/g, ' ');
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') { const end = sql.indexOf('\n', i); const stop = end < 0 ? sql.length : end; out += blank(sql.slice(i, stop)); i = stop; continue; }
    if (two === '/*') { // PostgreSQL block comments nest.
      let depth = 0, j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) { depth++; j += 2; } else if (sql.startsWith('*/', j)) { depth--; j += 2; if (!depth) break; } else j++;
      }
      out += blank(sql.slice(i, j)); i = j; continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i], escapes = quote === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === quote) { if (sql[j + 1] === quote) { j += 2; continue; } j++; break; }
        j++;
      }
      out += sql.slice(i, j); i = j; continue;
    }
    out += sql[i++];
  }
  return out;
}
// JavaScript/TypeScript: the TypeScript parser owns the grammar (strings, templates,
// regular expressions), so only real comment trivia is blanked.
function stripJs(text, path) {
  const kind = /\.(?:ts|mts|cts)$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map();
  const visit = node => {
    // Trivia before each token: same-line comments are "trailing" of the previous token,
    // later lines are "leading"; together they are every comment in the file.
    if (node.kind !== ts.SyntaxKind.SyntaxList && node.getChildCount(source) === 0) {
      for (const range of [...ts.getTrailingCommentRanges(text, node.pos) ?? [], ...ts.getLeadingCommentRanges(text, node.pos) ?? []]) {
        ranges.set(range.pos, range.end);
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  let out = '', at = 0;
  for (const [pos, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (pos < at) continue;
    out += text.slice(at, pos) + text.slice(pos, end).replace(/[^\n]/g, ' '); at = end;
  }
  return out + text.slice(at);
}
// Python `#` outside single/double/triple-quoted strings; shell/systemd/YAML whole-line `#`.
function stripPython(text) {
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '#') { const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end; out += ' '.repeat(stop - i); i = stop; continue; }
    if (text[i] === "'" || text[i] === '"') {
      const quote = text.startsWith(text[i].repeat(3), i) ? text[i].repeat(3) : text[i];
      let j = i + quote.length;
      while (j < text.length && !text.startsWith(quote, j) && !(quote.length === 1 && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      j = Math.min(text.length, j + (text.startsWith(quote, j) ? quote.length : 0));
      out += text.slice(i, j); i = j; continue;
    }
    out += text[i++];
  }
  return out;
}
const stripHash = text => text.split(/\r?\n/).map(line => /^\s*#/.test(line) ? '' : line).join('\n');
function codeOnly(text, path) {
  if (/\.(?:mjs|cjs|js|ts|mts|cts)$/.test(path)) return stripJs(text, path);
  if (/\.py$/.test(path)) return stripPython(text);
  if (/\.(?:sh|service|socket|ya?ml|toml|conf)$/.test(path)) return stripHash(text);
  return text; // JSON, lock files, certificates: no comment syntax.
}
const copilotLines = (text, path) => codeOnly(text, path).split(/\r?\n/).filter(line => COPILOT.test(line)).length;
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
    const text = codeOnly(readFileSync(join(root, path), 'utf8'), path);
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

test('comment stripping keeps code and literals, drops only comments', () => {
  const js = [
    '// note copilot_comment_line',
    "const a = 1; /* copilot_block",
    '   still copilot_block */ const u = \'https://h.example/x\'; // copilot_after_url',
    'const r = /\\/\\//; call(copilot_real_call);',
    'const s = "// copilot_in_string";',
    'const t = `${a} // copilot_in_template ${u /* copilot_in_substitution */}`;',
    "fetch('/rest/v1/rpc/copilot_org_scope_buildings_v1');",
  ].join('\n');
  assert.deepEqual(codeOnly(js, 'x.mjs').split('\n').map(line => COPILOT.test(line)), [false, false, false, true, true, true, true]);
  assert.equal(copilotLines(js, 'x.mjs'), 4);
  assert.equal(codeOnly(js, 'x.mjs').split('\n').length, js.split('\n').length, 'line structure kept');
  assert.equal(copilotLines('type A = { x: string }; // copilot_note\nexport type B = "copilot_kind";', 'x.d.mts'), 1);
  const py = "# copilot_comment\nx = 'copilot_in_str'  # copilot_trailing\ny = \"\"\"a # copilot_in_doc\"\"\"\nimport copilot_module";
  assert.deepEqual(codeOnly(py, 'x.py').split('\n').map(line => COPILOT.test(line)), [false, true, true, true]);
  assert.equal(copilotLines('# copilot\nExecStart=/bin/copilot_x', 'x.service'), 1);
  const sql = "SELECT 'a -- copilot_in_string' AS v -- copilot_comment\n/* copilot /* nested */ still */ SELECT public.copilot_call(E'it\\'s -- x');";
  assert.deepEqual(stripSql(sql).split('\n').map(line => COPILOT.test(line)), [true, true]);
  assert.doesNotMatch(stripSql(sql), /copilot_comment|nested|still/);
  assert.match(stripSql(sql), /'a -- copilot_in_string'/);
});

test('infra/hermes-* source does not reference Copilot (allowlist empty)', () => {
  const found = new Map();
  for (const path of infraSources()) {
    const lines = copilotLines(readFileSync(join(root, path), 'utf8'), path);
    if (lines) found.set(path, lines);
  }
  assert.deepEqual(Object.fromEntries(found), Object.fromEntries(INFRA_ALLOWLIST));
  assert.equal(INFRA_ALLOWLIST.size, 0);
});
