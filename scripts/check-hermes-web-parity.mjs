#!/usr/bin/env node
// Chuông báo Hermes ↔ web (chủ chốt 17/10/2026, phương án A).
//
// Hermes đọc dữ liệu CRM theo hai kiểu:
//   rpc       gọi thẳng RPC mà trang web cũng gọi (occupancy_snapshot_v2, fa_monthly_pnl…).
//             Rủi ro: web chuyển sang RPC khác (vd. _v3) mà Hermes vẫn gọi bản cũ.
//   mirrored  SQL riêng chép bộ lọc/công thức của web (web đọc bảng qua PostgREST, hoặc
//             Hermes chép thân một hàm SQL/RLS của CRM). Rủi ro: web đổi, Hermes không đổi.
//
// Bản đồ infra/hermes-broker/web-parity.json ghi từng chỗ chép. Phía web được đánh dấu
// bằng chú thích bao quanh (chỉ chú thích, không đổi logic):
//   // hermes-parity:begin <vùng>
//   …mã web mà Hermes chép…
//   // hermes-parity:end <vùng>
// Một file có thể có nhiều khối cùng tên vùng; nội dung ghép theo thứ tự trong file.
//
// Gate ĐỎ khi: hash một vùng web hoặc nguồn SQL CRM lệch bản đồ; thiếu/hỏng marker; marker
// không thuộc mục nào; web không còn gọi RPC đã khai; bản định nghĩa CUỐI (theo tên file
// migration) của hàm Hermes không còn gọi RPC đã khai; CRM có bản _vN mới hơn hàm mà
// Hermes đang gọi (successorGuard).
//
// Chuẩn hoá trước khi băm: CRLF→LF, bỏ khoảng trắng đầu/cuối mỗi dòng, bỏ dòng trống,
// bỏ chính các dòng marker. SQL: bỏ chú thích (kể cả trong thân hàm) rồi chuẩn hoá như trên.
//
//   node scripts/check-hermes-web-parity.mjs           # kiểm
//   node scripts/check-hermes-web-parity.mjs --write   # ghi hash mới SAU KHI đã cập nhật Hermes
//
// Không cần credential, không gọi mạng. Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.
// Giới hạn: chỉ đọc câu lệnh SQL cấp cao nhất; policy/hàm dựng động trong DO … EXECUTE
// format(...) không thấy được. Hash chỉ nói "đã đổi", không nói đổi có ảnh hưởng Hermes
// hay không — người sửa web quyết định rồi ghi --write trong cùng thay đổi.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MAP_PATH = 'infra/hermes-broker/web-parity.json';
export const MIGRATIONS_DIR = 'supabase/migrations';
export const WEB_ROOT = 'src';
const WRITE_HINT = '`node scripts/check-hermes-web-parity.mjs --write`';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKER = /hermes-parity:(begin|end)(?:\s+([a-z0-9]+(?:-[a-z0-9]+)*))?/;
const COMMENT_LINE = /^(?:\/\/|\/\*|\{\s*\/\*|\*|--|#)/;
const IDENT = '"?[A-Za-z_][A-Za-z0-9_$]*"?';
const QUALIFIED = `(?:${IDENT}\\s*\\.\\s*)?${IDENT}`;
const FN_CREATE = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(${QUALIFIED})\\s*\\(`, 'i');
const FN_DROP = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]*)$/i;
const FN_RENAME = new RegExp(`^ALTER\\s+FUNCTION\\s+(${QUALIFIED})\\s*(?:\\([^)]*\\))?\\s+RENAME\\s+TO\\s`, 'i');
const POLICY = new RegExp(`^(CREATE|ALTER|DROP)\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(?:ONLY\\s+)?(${QUALIFIED})`, 'i');
const ENTRY_KEYS = new Set(['id', 'kind', 'description', 'rpc', 'web', 'webCalls', 'sql', 'hermes', 'successorGuard', 'notes']);

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** CRLF→LF, trim từng dòng, bỏ dòng trống: đổi khoảng trắng/xuống dòng không làm đỏ. */
export function normalizeLines(lines) {
  return lines.map((line) => line.replace(/\r$/, '').trim()).filter(Boolean).join('\n');
}

/** Tên SQL đã chuẩn: bỏ nháy kép, khoảng trắng, chữ thường; thiếu schema = public. */
export function qualify(name) {
  const clean = String(name).replace(/["\s]/g, '').toLowerCase();
  return clean.includes('.') ? clean : `public.${clean}`;
}
const bare = (name) => qualify(name).split('.').pop();

/**
 * Các vùng hermes-parity trong một file web. Trả nội dung ĐÃ chuẩn hoá theo tên vùng
 * và lỗi marker (begin lồng cùng tên, end thiếu begin, chưa đóng, marker chung dòng mã).
 */
export function extractRegions(text, path = 'file') {
  const regions = new Map();
  const open = new Map();
  const errors = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, index) => {
    const where = `${path}:${index + 1}`;
    if (!raw.includes('hermes-parity:')) {
      for (const id of open.keys()) regions.get(id).push(raw);
      return;
    }
    const match = raw.match(MARKER);
    if (!match || !match[2]) {
      errors.push(`${where}: marker hermes-parity hỏng — viết đúng "hermes-parity:begin <vùng>" / "hermes-parity:end <vùng>" (vùng dạng a-z0-9-).`);
      return;
    }
    if (!COMMENT_LINE.test(raw.trim())) {
      errors.push(`${where}: marker hermes-parity phải nằm trên dòng chú thích riêng, không chung dòng với mã.`);
      return;
    }
    const [, action, id] = match;
    if (action === 'begin') {
      if (open.has(id)) errors.push(`${where}: "hermes-parity:begin ${id}" lồng trong khối ${id} chưa đóng (mở ở dòng ${open.get(id)}).`);
      else {
        open.set(id, index + 1);
        if (!regions.has(id)) regions.set(id, []);
      }
    } else if (!open.has(id)) {
      errors.push(`${where}: "hermes-parity:end ${id}" không có begin tương ứng.`);
    } else open.delete(id);
  });
  for (const [id, line] of open) errors.push(`${path}:${line}: "hermes-parity:begin ${id}" chưa có "hermes-parity:end ${id}".`);
  return {
    regions: new Map([...regions].map(([id, body]) => [id, normalizeLines(body)])),
    errors,
  };
}

// ── SQL ────────────────────────────────────────────────────────────────────

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const identChar = (char) => char !== undefined && /[A-Za-z0-9_$]/.test(char);

/**
 * Bỏ chú thích SQL (-- và /* *\/ lồng nhau) mà không đụng chuỗi '…', "…" và chuỗi $tag$.
 * deep=true: bỏ cả chú thích bên trong thân $tag$…$tag$ (thân hàm plpgsql/sql).
 */
export function stripSqlComments(sql, { deep = false } = {}) {
  const s = String(sql).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '-' && n === '-') {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end;
      continue;
    }
    if (c === '/' && n === '*') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth += 1; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth -= 1; i += 2; } else i += 1;
      }
      out += ' ';
      continue;
    }
    if (c === "'") {
      const start = i;
      const escape = (s[i - 1] === 'E' || s[i - 1] === 'e') && !identChar(s[i - 2]);
      i += 1;
      while (i < s.length) {
        if (escape && s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out += s.slice(start, i);
      continue;
    }
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out += s.slice(start, i);
      continue;
    }
    if (c === '$' && !identChar(s[i - 1])) {
      const tag = s.slice(i, i + 80).match(DOLLAR_TAG)?.[0];
      if (tag) {
        const close = s.indexOf(tag, i + tag.length);
        const bodyEnd = close < 0 ? s.length : close;
        const body = s.slice(i + tag.length, bodyEnd);
        out += tag + (deep ? stripSqlComments(body, { deep }) : body) + (close < 0 ? '' : tag);
        i = close < 0 ? s.length : close + tag.length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Câu lệnh SQL cấp cao nhất (đã bỏ chú thích ngoài thân hàm), tách theo ; ngoài chuỗi. */
export function sqlStatements(sql) {
  const s = stripSqlComments(sql);
  const statements = [];
  let start = 0;
  let i = 0;
  const push = (end) => {
    const statement = s.slice(start, end).trim();
    if (statement) statements.push(statement);
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const escape = c === "'" && (s[i - 1] === 'E' || s[i - 1] === 'e') && !identChar(s[i - 2]);
      i += 1;
      while (i < s.length) {
        if (escape && s[i] === '\\') { i += 2; continue; }
        if (s[i] === c) {
          if (s[i + 1] === c) { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '$' && !identChar(s[i - 1])) {
      const tag = s.slice(i, i + 80).match(DOLLAR_TAG)?.[0];
      if (tag) {
        const close = s.indexOf(tag, i + tag.length);
        i = close < 0 ? s.length : close + tag.length;
        continue;
      }
    }
    if (c === ';') {
      push(i);
      start = i + 1;
    }
    i += 1;
  }
  push(s.length);
  return statements;
}

function dropTargets(rest) {
  let text = rest;
  // Bỏ danh sách tham số (có thể lồng: numeric(10,2)) rồi tách theo dấu phẩy.
  for (let guard = 0; guard < 10 && /\([^()]*\)/.test(text); guard += 1) text = text.replace(/\([^()]*\)/g, '');
  return text.replace(/\b(?:CASCADE|RESTRICT)\b/gi, '').split(',').map((part) => part.trim()).filter(Boolean).map(qualify);
}

/**
 * Lịch sử hàm/policy cần tra, theo thứ tự tên file migration (thứ tự áp lên production).
 * functions: tên đầy đủ → {action:'create'|'drop', file, statement}; policies: "name@schema.table" →
 * {action, file, statements[] từ CREATE cuối (kèm ALTER sau đó)}; successors: tên gốc → [{name, version, file}].
 */
export function buildSqlCatalog({ root = REPO_ROOT, functions = [], policies = [], successorBases = [], files } = {}) {
  const dir = join(root, MIGRATIONS_DIR);
  const list = files ?? (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : []);
  const fnTargets = new Set(functions.map(qualify));
  const policyTargets = new Set(policies);
  const bases = new Map(successorBases.map((name) => {
    const match = bare(name).match(/^(.*)_v(\d+)$/);
    return [match ? match[1] : bare(name), match ? Number(match[2]) : 0];
  }));
  const needles = [...new Set([...[...fnTargets].map(bare), ...[...policyTargets].map((key) => key.split('@')[0]), ...[...bases.keys()].map((base) => `${base}_v`)])];
  const fnState = new Map();
  const policyState = new Map();
  const successors = new Map([...bases.keys()].map((base) => [base, []]));
  for (const file of list) {
    const relative = `${MIGRATIONS_DIR}/${file}`;
    const text = readFileSync(join(dir, file), 'utf8');
    const lower = text.toLowerCase();
    if (!needles.some((needle) => lower.includes(needle))) continue;
    for (const statement of sqlStatements(text)) {
      const create = statement.match(FN_CREATE);
      if (create) {
        const name = qualify(create[1]);
        if (fnTargets.has(name)) fnState.set(name, { action: 'create', file: relative, statement });
        for (const [base, version] of bases) {
          const match = bare(name).match(/^(.*)_v(\d+)$/);
          if (match && match[1] === base && Number(match[2]) > version) successors.get(base).push({ name, version: Number(match[2]), file: relative, action: 'create' });
        }
        continue;
      }
      const drop = statement.match(FN_DROP);
      if (drop) {
        for (const name of dropTargets(drop[1])) {
          if (fnTargets.has(name)) fnState.set(name, { action: 'drop', file: relative, statement });
          for (const [base] of bases) for (const item of successors.get(base)) if (item.name === name) item.action = 'drop';
        }
        continue;
      }
      const rename = statement.match(FN_RENAME);
      if (rename) {
        const name = qualify(rename[1]);
        if (fnTargets.has(name)) fnState.set(name, { action: 'drop', file: relative, statement });
        continue;
      }
      const policy = statement.match(POLICY);
      if (policy) {
        const key = `${bare(policy[2])}@${qualify(policy[3])}`;
        if (!policyTargets.has(key)) continue;
        const action = policy[1].toLowerCase();
        const previous = policyState.get(key);
        if (action === 'create') policyState.set(key, { action, file: relative, statements: [statement] });
        else if (action === 'drop') policyState.set(key, { action, file: relative, statements: [] });
        else policyState.set(key, { action: previous?.action === 'drop' ? 'drop' : 'alter', file: relative, statements: [...(previous?.statements ?? []), statement] });
      }
    }
  }
  return {
    functions: fnState,
    policies: policyState,
    successors: new Map([...successors].map(([base, items]) => [base, items.filter((item) => item.action === 'create')])),
  };
}

export const sqlSourceHash = (statements) => sha256(normalizeLines(statements.map((s) => stripSqlComments(s, { deep: true })).join('\n').split('\n')));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Lời gọi `name(` thật trong thân hàm (đã bỏ chú thích), không khớp tên dài hơn. */
export function sqlCalls(statement, name) {
  return new RegExp(`(?<![A-Za-z0-9_$])"?${escapeRegex(bare(name))}"?\\s*\\(`, 'i').test(stripSqlComments(statement, { deep: true }));
}
/** Web gọi RPC bằng tên viết thẳng (`.rpc('name'`) ngoài chú thích. */
export function webCalls(text, rpc) {
  return new RegExp(`\\.rpc\\(\\s*(['"\`])${escapeRegex(rpc)}\\1`).test(boChuThichJs(String(text)));
}

// ── Bản đồ ─────────────────────────────────────────────────────────────────

function validateMap(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== 1 || !Array.isArray(doc.entries)) {
    return ['web-parity.json phải là {"schemaVersion": 1, "entries": [...]}.'];
  }
  if (doc.entries.length === 0) errors.push('web-parity.json không có mục nào — bản đồ rỗng không chứng minh gì.');
  const ids = new Set();
  const arr = (value) => value === undefined || Array.isArray(value);
  for (const [index, entry] of doc.entries.entries()) {
    const label = `entries[${index}]${entry?.id ? ` (${entry.id})` : ''}`;
    if (!entry || typeof entry !== 'object') { errors.push(`${label}: phải là object.`); continue; }
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) errors.push(`${label}: khoá lạ "${key}".`);
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) errors.push(`${label}: id phải dạng a-z0-9-.`);
    else if (ids.has(entry.id)) errors.push(`${label}: id trùng.`);
    else ids.add(entry.id);
    if (!['rpc', 'mirrored'].includes(entry.kind)) errors.push(`${label}: kind phải là "rpc" hoặc "mirrored".`);
    if (typeof entry.description !== 'string' || !entry.description.trim()) errors.push(`${label}: thiếu description.`);
    for (const key of ['rpc', 'web', 'webCalls', 'sql', 'hermes', 'successorGuard']) if (!arr(entry[key])) errors.push(`${label}: ${key} phải là mảng.`);
    if (entry.notes !== undefined && typeof entry.notes !== 'string') errors.push(`${label}: notes phải là chuỗi.`);
    for (const item of entry.web ?? []) {
      if (typeof item?.path !== 'string' || typeof item?.region !== 'string' || !ID.test(item.region)) errors.push(`${label}: web cần {path, region (a-z0-9-), sha256}.`);
      if (item?.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(item.sha256)) errors.push(`${label}: web ${item.path}#${item.region} sha256 không hợp lệ (chạy --write).`);
    }
    for (const item of entry.webCalls ?? []) if (typeof item?.path !== 'string' || typeof item?.rpc !== 'string') errors.push(`${label}: webCalls cần {path, rpc}.`);
    for (const item of entry.sql ?? []) {
      if ((typeof item?.function === 'string') === (typeof item?.policy === 'string')) errors.push(`${label}: sql cần đúng một trong {function} hoặc {policy, table}.`);
      if (typeof item?.policy === 'string' && typeof item?.table !== 'string') errors.push(`${label}: sql policy ${item.policy} thiếu table.`);
      if (item?.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(item.sha256)) errors.push(`${label}: sql sha256 không hợp lệ (chạy --write).`);
    }
    if (!(entry.hermes ?? []).length) errors.push(`${label}: thiếu hermes — phải chỉ nơi Hermes chép lại.`);
    for (const item of entry.hermes ?? []) {
      if ((typeof item?.sql === 'string') === (typeof item?.path === 'string')) errors.push(`${label}: hermes cần đúng một trong {sql: "schema.ham"} hoặc {path}.`);
      if (item?.calls !== undefined && (!Array.isArray(item.calls) || typeof item.sql !== 'string')) errors.push(`${label}: hermes.calls chỉ dùng với {sql} và phải là mảng.`);
      if (item?.contains !== undefined && (typeof item.contains !== 'string' || typeof item.path !== 'string')) errors.push(`${label}: hermes.contains chỉ dùng với {path} và phải là chuỗi.`);
    }
    if (entry.kind === 'rpc') {
      const rpcs = entry.rpc ?? [];
      if (!rpcs.length) errors.push(`${label}: kind rpc cần mảng rpc.`);
      const called = new Set((entry.hermes ?? []).flatMap((item) => item?.calls ?? []).map(bare));
      const webCalled = new Set((entry.webCalls ?? []).map((item) => item?.rpc));
      const guarded = new Set((entry.successorGuard ?? []).map(bare));
      for (const rpc of rpcs) {
        if (!called.has(bare(rpc))) errors.push(`${label}: rpc ${rpc} không có hàm Hermes nào khai calls.`);
        if (!webCalled.has(rpc) && !guarded.has(bare(rpc))) errors.push(`${label}: rpc ${rpc} cần webCalls (web gọi ở đâu) hoặc successorGuard.`);
      }
    } else if (!(entry.web ?? []).length && !(entry.sql ?? []).length) {
      errors.push(`${label}: kind mirrored cần web hoặc sql (Hermes chép từ đâu).`);
    }
  }
  return errors;
}

function walk(root, dir, out = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const rel = `${dir}/${name}`;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) walk(root, rel, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name)) out.push(rel);
  }
  return out;
}

function describeHermes(entry, catalog) {
  return (entry.hermes ?? []).map((item) => {
    if (item.path) return item.path;
    const state = catalog.functions.get(qualify(item.sql));
    return `${qualify(item.sql)}${state ? ` (${state.file})` : ''}${item.note ? ` [${item.note}]` : ''}`;
  }).join('; ');
}

/**
 * Kiểm toàn bộ bản đồ. Trả {errors, changes, doc, summary}; write=true ghi lại hash vào doc
 * (người gọi quyết định lưu file) — chỉ khi không có lỗi cấu trúc.
 */
export function checkParity({ root = REPO_ROOT, doc, write = false } = {}) {
  const errors = validateMap(doc);
  if (errors.length) return { errors, changes: [], doc, structural: true };
  const entries = doc.entries;
  const read = new Map();
  const load = (path) => {
    if (!read.has(path)) read.set(path, existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
    return read.get(path);
  };
  const regionsOf = new Map();
  const regions = (path) => {
    if (!regionsOf.has(path)) {
      const text = load(path);
      regionsOf.set(path, text === null ? null : extractRegions(text, path));
    }
    return regionsOf.get(path);
  };

  const catalog = buildSqlCatalog({
    root,
    functions: entries.flatMap((entry) => [
      ...(entry.hermes ?? []).filter((item) => item.sql).map((item) => item.sql),
      ...(entry.sql ?? []).filter((item) => item.function).map((item) => item.function),
    ]),
    policies: entries.flatMap((entry) => (entry.sql ?? []).filter((item) => item.policy).map((item) => `${bare(item.policy)}@${qualify(item.table)}`)),
    successorBases: entries.flatMap((entry) => entry.successorGuard ?? []),
  });

  const structural = [];
  const drift = [];
  const changes = [];
  for (const entry of entries) {
    const tag = `[${entry.id}]`;
    const hermes = describeHermes(entry, catalog);
    const changedWeb = [];
    for (const item of entry.web ?? []) {
      const found = regions(item.path);
      if (found === null) { structural.push(`${tag} Không thấy file web ${item.path} (vùng ${item.region}). Sửa path trong ${MAP_PATH}.`); continue; }
      const region = found.regions.get(item.region);
      if (region === undefined) {
        structural.push(`${tag} Thiếu marker "hermes-parity:begin ${item.region}" … "hermes-parity:end ${item.region}" trong ${item.path}. Đây là mã web Hermes chép (${hermes}); khôi phục marker quanh đúng đoạn đó.`);
        continue;
      }
      const hash = sha256(region);
      if (item.sha256 !== hash) {
        changedWeb.push(`${item.path}#${item.region}`);
        changes.push({ entry: entry.id, source: `${item.path}#${item.region}`, before: item.sha256 ?? null, after: hash });
        if (write) item.sha256 = hash;
      }
    }
    if (changedWeb.length) drift.push(`${tag} Web đã đổi ${changedWeb.join(', ')}; cập nhật Hermes ở ${hermes} rồi chạy ${WRITE_HINT} để ghi hash mới.`);

    for (const item of entry.webCalls ?? []) {
      const text = load(item.path);
      if (text === null) structural.push(`${tag} Không thấy file web ${item.path} (gọi ${item.rpc}). Sửa path trong ${MAP_PATH}.`);
      else if (!webCalls(text, item.rpc)) {
        structural.push(`${tag} Web không còn gọi RPC ${item.rpc} trong ${item.path}; Hermes (${hermes}) vẫn theo ${item.rpc}. Chuyển Hermes sang đúng RPC/bộ lọc web đang dùng, sửa ${MAP_PATH} rồi chạy ${WRITE_HINT}.`);
      }
    }

    const changedSql = [];
    for (const item of entry.sql ?? []) {
      let label;
      let statements;
      let file;
      if (item.function) {
        label = `hàm ${qualify(item.function)}`;
        const state = catalog.functions.get(qualify(item.function));
        if (!state || state.action !== 'create') {
          structural.push(`${tag} Nguồn SQL web ${label} ${state ? `đã bị DROP/đổi tên ở ${state.file}` : `không có trong ${MIGRATIONS_DIR}`}; Hermes (${hermes}) đang chép nó. Cập nhật Hermes và ${MAP_PATH}.`);
          continue;
        }
        statements = [state.statement];
        file = state.file;
      } else {
        const key = `${bare(item.policy)}@${qualify(item.table)}`;
        label = `policy ${bare(item.policy)} ON ${qualify(item.table)}`;
        const state = catalog.policies.get(key);
        if (!state || state.action === 'drop' || !state.statements.length) {
          structural.push(`${tag} Nguồn SQL web ${label} ${state ? `đã bị DROP ở ${state.file}` : `không có câu CREATE/ALTER POLICY nào trong ${MIGRATIONS_DIR}`}; Hermes (${hermes}) đang chép nó. Cập nhật Hermes và ${MAP_PATH}.`);
          continue;
        }
        statements = state.statements;
        file = state.file;
      }
      const hash = sqlSourceHash(statements);
      if (item.sha256 !== hash) {
        changedSql.push(`${label} (bản cuối ${file})`);
        changes.push({ entry: entry.id, source: label, before: item.sha256 ?? null, after: hash });
        if (write) item.sha256 = hash;
      }
    }
    if (changedSql.length) drift.push(`${tag} CRM đã đổi ${changedSql.join(', ')} mà Hermes chép lại; cập nhật Hermes ở ${hermes} rồi chạy ${WRITE_HINT} để ghi hash mới.`);

    for (const item of entry.hermes ?? []) {
      if (item.path) {
        const text = load(item.path);
        if (text === null) structural.push(`${tag} Không thấy nơi Hermes chép ${item.path}. Sửa ${MAP_PATH}.`);
        else if (item.contains && !text.includes(item.contains)) structural.push(`${tag} ${item.path} không còn chứa "${item.contains}" — bản đồ đã cũ hoặc Hermes đã đổi nguồn; sửa ${MAP_PATH}.`);
        continue;
      }
      const name = qualify(item.sql);
      const state = catalog.functions.get(name);
      if (!state || state.action !== 'create') {
        structural.push(`${tag} Hàm Hermes ${name} ${state ? `đã bị DROP/đổi tên ở ${state.file}` : `không có trong ${MIGRATIONS_DIR}`}. Trỏ ${MAP_PATH} sang hàm Hermes đang chép.`);
        continue;
      }
      for (const call of item.calls ?? []) {
        if (!sqlCalls(state.statement, call)) {
          structural.push(`${tag} Bản định nghĩa cuối của ${name} (${state.file}) không còn gọi ${bare(call)}. Nếu Hermes đã chuyển nguồn, sửa ${MAP_PATH} cho khớp web; nếu không, đây là lệch web.`);
        }
      }
    }

    for (const guard of entry.successorGuard ?? []) {
      const match = bare(guard).match(/^(.*)_v(\d+)$/);
      const base = match ? match[1] : bare(guard);
      for (const next of catalog.successors.get(base) ?? []) {
        structural.push(`${tag} CRM đã có ${next.name} (${next.file}) mới hơn ${qualify(guard)} mà Hermes (${hermes}) đang gọi. Chuyển Hermes sang bản mới (hoặc xác nhận bản cũ còn đúng), sửa ${MAP_PATH} rồi chạy ${WRITE_HINT}.`);
      }
    }
  }

  // Marker phía web phải thuộc một mục: marker mồ côi = ai đó đánh dấu mà bản đồ không kiểm.
  const declared = new Set(entries.flatMap((entry) => (entry.web ?? []).map((item) => `${item.path}#${item.region}`)));
  const webFiles = new Set([...walk(root, WEB_ROOT), ...entries.flatMap((entry) => (entry.web ?? []).map((item) => item.path))]);
  for (const path of [...webFiles].sort()) {
    const text = load(path);
    if (text === null || !text.includes('hermes-parity:')) continue;
    const found = regions(path);
    structural.push(...found.errors);
    for (const id of found.regions.keys()) {
      if (!declared.has(`${path}#${id}`)) structural.push(`${path}: marker hermes-parity "${id}" không thuộc mục nào trong ${MAP_PATH} — thêm mục (web + hermes) hoặc gỡ marker.`);
    }
  }

  const kinds = entries.reduce((acc, entry) => ({ ...acc, [entry.kind]: (acc[entry.kind] ?? 0) + 1 }), {});
  const summary = `${entries.length} mục (${kinds.rpc ?? 0} rpc, ${kinds.mirrored ?? 0} mirrored), ${declared.size} vùng web, ${entries.reduce((n, e) => n + (e.sql ?? []).length, 0)} nguồn SQL`;
  return { errors: write ? structural : [...structural, ...drift], structural: structural.length > 0, changes, doc, summary };
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT) {
  const write = argv.includes('--write');
  const mapFile = join(root, MAP_PATH);
  let doc;
  try {
    doc = JSON.parse(readFileSync(mapFile, 'utf8'));
  } catch (error) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: không đọc được ${MAP_PATH} — ${error.message}`);
    return 3;
  }
  const result = checkParity({ root, doc, write });
  if (result.errors.length && (result.structural || !write)) {
    const invalid = validateMap(doc).length > 0;
    console.error(`❌ Hermes lệch web (${result.errors.length} lỗi):\n`);
    for (const error of result.errors) console.error(`  - ${error}`);
    console.error(`\n  Chủ chốt 17/10/2026: không để Hermes lệch web âm thầm. Sửa Hermes trong CÙNG thay đổi;`);
    console.error(`  hướng dẫn: docs/plans/hermes-crm/BAN-GIAO.md (mục "Chuông báo Hermes ↔ web").`);
    if (write) console.error('\n  --write không ghi gì khi còn lỗi cấu trúc (marker/RPC/hàm Hermes).');
    return invalid ? 3 : 1;
  }
  if (write) {
    if (result.changes.length) {
      writeFileSync(mapFile, `${JSON.stringify(result.doc, null, 2)}\n`);
      console.log(`✍ Đã ghi ${result.changes.length} hash mới vào ${MAP_PATH}:`);
      for (const change of result.changes) console.log(`  - [${change.entry}] ${change.source}`);
      console.log('  Nhớ: chỉ ghi SAU KHI Hermes đã theo web; nêu lý do trong commit.');
    } else console.log(`✅ ${MAP_PATH} đã khớp, không có hash nào cần ghi.`);
    return 0;
  }
  console.log(`✅ Hermes khớp web: ${result.summary}.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
