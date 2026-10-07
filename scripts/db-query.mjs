#!/usr/bin/env node
// Đọc database bằng SQL CHỈ ĐỌC qua Supavisor session pooler.
//
//   npm run db:query -- --sql "select 1 as ok"
//   npm run db:query -- --file q.sql --json
//   npm run db:query -- --env test --sql "select count(*) from public.organizations"
//
// Mặc định là PRODUCTION; `--env test` là project TEST riêng (scripts/test-env/lib.mjs).
//
// VÌ SAO TỒN TẠI
//   Agent tra dữ liệu bằng script tạm tự đọc mật khẩu (19 phiên trong 14 ngày), mỗi cái
//   một kiểu chặn ghi — hoặc không chặn. Script này là đường đọc dùng chung.
//
// BA LỚP CHẶN GHI (Contract §2: org THẬT chỉ đọc; §4: không ghi schema ngoài lane)
//   1. Chặn chữ: đúng MỘT câu, mở đầu SELECT/WITH/TABLE/VALUES/SHOW/EXPLAIN, không có
//      từ khoá/hàm ghi (sau khi bỏ chú thích và chuỗi).
//   2. `BEGIN READ ONLY` + `SET LOCAL statement_timeout = '30s'`, luôn ROLLBACK.
//   3. Giao thức extended (queryMode 'extended'): server từ chối nhiều câu trong một lệnh.
//
// Không in credential. Thoát 0 xong · 1 lỗi truy vấn · 2 sai cách dùng/bị chặn ·
// 3 KHÔNG ĐO ĐƯỢC (thiếu credential, không kết nối được).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { POOLER_HOST, POOLER_PORT } from './backup-before-schema.mjs';
import { giaTriVault, layMatKhauDb } from './lib/vault.mjs';
import { PROD_REF, poolerHost } from './test-env/lib.mjs';

export const TIMEOUT_CAU_LENH = '30s';

const MO_DAU_DUOC_PHEP = new Set(['select', 'with', 'table', 'values', 'show', 'explain']);

/**
 * Từ khoá/hàm có thể GHI hay đổi trạng thái kể cả trong một câu SELECT/WITH.
 * Từ khoá câu lệnh khớp theo từ; HÀM chỉ khớp khi có `(` theo sau, để đọc view cùng họ
 * tên (`pg_replication_slots`) hay cột `lo_…` không bị chặn nhầm. Cột trùng từ khoá
 * (`do`, `set`, `rollback`…) thì bọc nháy kép.
 */
const TU_GHI = new RegExp(
  '\\b(' + [
    'insert', 'update', 'delete', 'merge', 'truncate', 'create', 'alter', 'drop',
    'grant', 'revoke', 'copy', 'vacuum', 'reindex', 'cluster', 'refresh', 'into', 'call',
    'do', 'lock', 'listen', 'notify', 'unlisten', 'prepare', 'execute', 'deallocate',
    'discard', 'checkpoint', 'reassign', 'commit', 'rollback', 'savepoint', 'begin', 'set',
    'reset',
  ].join('|') + ')\\b|\\bcomment\\s+on\\b|\\bsecurity\\s+label\\b|\\b(' + [
    'nextval', 'setval', 'set_config', 'pg_terminate_backend', 'pg_cancel_backend',
    'pg_reload_conf', 'pg_rotate_logfile', 'pg_switch_wal', 'pg_promote', 'pg_notify',
    'pg_stat_reset\\w*', 'pg_advisory_\\w+', 'pg_try_advisory_\\w+', 'pg_create_\\w+',
    'pg_drop_\\w+', 'pg_replication_\\w+', 'pg_logical_\\w+', 'pg_file_\\w+', 'lo_\\w+',
    'dblink\\w*',
  ].join('|') + ')\\s*\\(',
  'i',
);

/**
 * Thay chú thích bằng dấu cách và nội dung chuỗi/định danh có nháy bằng chỗ trống,
 * để phép chặn chữ không bị đánh lừa (và không báo nhầm từ khoá nằm trong chuỗi).
 * Hiểu: `--`, `/* *\/` lồng nhau, '…' ('' thoát), E'…' (\ thoát), $tag$…$tag$, "…".
 */
export function lamSachSql(sql) {
  let ra = '';
  let i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i];
    const tiep = s[i + 1];
    if (c === '-' && tiep === '-') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
      ra += ' ';
      continue;
    }
    if (c === '/' && tiep === '*') {
      let sau = 1;
      i += 2;
      while (i < s.length && sau > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { sau += 1; i += 2; continue; }
        if (s[i] === '*' && s[i + 1] === '/') { sau -= 1; i += 2; continue; }
        i += 1;
      }
      if (sau > 0) throw new Error('Chú thích /* chưa đóng');
      ra += ' ';
      continue;
    }
    if (c === "'") {
      const thoatXuoc = /[eE]$/.test(s.slice(0, i)) && !/[A-Za-z0-9_][eE]$/.test(s.slice(0, i));
      i += 1;
      let dong = false;
      while (i < s.length) {
        if (thoatXuoc && s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          dong = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!dong) throw new Error('Chuỗi \'…\' chưa đóng');
      ra += "''";
      continue;
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) throw new Error('Định danh "…" chưa đóng');
      ra += '""';
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m && !/[A-Za-z0-9_]$/.test(s.slice(0, i))) {
        const the = m[0];
        const j = s.indexOf(the, i + the.length);
        if (j < 0) throw new Error(`Chuỗi ${the}…${the} chưa đóng`);
        ra += "''";
        i = j + the.length;
        continue;
      }
    }
    ra += c;
    i += 1;
  }
  return ra;
}

/** Chặn chữ (lớp 1). Trả câu SQL đã bỏ `;` cuối; ném khi không chắc là chỉ đọc. */
export function kiemSqlChiDoc(sql) {
  const goc = String(sql ?? '').trim();
  if (!goc) throw new Error('SQL rỗng.');
  const sach = lamSachSql(goc).trim().replace(/;\s*$/, '').trim();
  if (sach.includes(';')) throw new Error('Chỉ nhận MỘT câu lệnh (có `;` ở giữa).');
  const dau = sach.match(/^[\s(]*([A-Za-z_]+)/)?.[1]?.toLowerCase();
  if (!dau || !MO_DAU_DUOC_PHEP.has(dau)) {
    throw new Error(`Câu lệnh phải mở đầu bằng ${[...MO_DAU_DUOC_PHEP].join('/').toUpperCase()} (gặp: ${dau ?? 'không rõ'}).`);
  }
  const ghi = sach.match(TU_GHI);
  if (ghi) throw new Error(`Có từ khoá có thể ghi/đổi trạng thái: "${ghi[0]}". db:query chỉ đọc.`);
  return goc.replace(/;\s*$/, '');
}

export function docThamSo(argv) {
  const ra = { sql: null, file: null, json: false, env: 'prod' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sql') ra.sql = argv[++i] ?? null;
    else if (a.startsWith('--sql=')) ra.sql = a.slice(6);
    else if (a === '--file') ra.file = argv[++i] ?? null;
    else if (a.startsWith('--file=')) ra.file = a.slice(7);
    else if (a === '--json') ra.json = true;
    else if (a === '--env') ra.env = argv[++i] ?? null;
    else if (a.startsWith('--env=')) ra.env = a.slice(6);
    else throw new Error(`Không hiểu tham số: ${a}`);
  }
  if ((ra.sql === null) === (ra.file === null)) throw new Error('Cần đúng một trong --sql "<select…>" hoặc --file q.sql.');
  if (!['prod', 'production', 'test'].includes(ra.env)) throw new Error('--env chỉ nhận prod hoặc test.');
  ra.env = ra.env === 'test' ? 'test' : 'prod';
  return ra;
}

/** Đích kết nối. Không trả gì ra ngoài ngoài cấu hình cho pg.Client. */
export async function dichKetNoi(moiTruong, { env = process.env } = {}) {
  if (moiTruong === 'prod') {
    const password = layMatKhauDb({ env });
    if (!password) throw Object.assign(new Error('Thiếu SUPABASE_DB_PASSWORD (env hoặc vault).'), { khongDoDuoc: true });
    return { ref: PROD_REF, host: POOLER_HOST, port: POOLER_PORT, user: `postgres.${PROD_REF}`, password };
  }
  const tu = (ten) => env[ten]?.trim() || giaTriVault(ten, { env });
  const ref = tu('TEST_SUPABASE_REF');
  const password = tu('TEST_SUPABASE_DB_PASSWORD');
  if (!ref || !/^[a-z0-9]{20}$/.test(ref)) throw Object.assign(new Error('Thiếu/sai TEST_SUPABASE_REF (env hoặc vault).'), { khongDoDuoc: true });
  if (ref === PROD_REF) throw new Error('TEST_SUPABASE_REF trùng production — từ chối.');
  if (!password) throw Object.assign(new Error('Thiếu TEST_SUPABASE_DB_PASSWORD (env hoặc vault).'), { khongDoDuoc: true });
  let host = tu('TEST_SUPABASE_POOLER_HOST');
  if (!host) {
    // Chỉ PAT của TEST: PAT production nhận 403 với project TEST (scripts/test-env/lib.mjs).
    const pat = tu('TEST_SUPABASE_PAT');
    if (!pat) throw Object.assign(new Error('Thiếu TEST_SUPABASE_POOLER_HOST và TEST_SUPABASE_PAT để tra host.'), { khongDoDuoc: true });
    try {
      host = await poolerHost(pat, ref);
    } catch (e) {
      throw Object.assign(new Error(`Không tra được host pooler TEST: ${e.message}`), { khongDoDuoc: true });
    }
  }
  return { ref, host, port: 5432, user: `postgres.${ref}`, password };
}

function oChu(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Bảng chữ kiểu psql cho kết quả rowMode 'array'. */
export function inBang(cot, dong) {
  const chu = dong.map((r) => r.map((v) => oChu(v).replace(/\r?\n/g, '↵')));
  const rong = cot.map((c, i) => Math.max(c.length, ...chu.map((r) => r[i].length)));
  const ke = (r) => ' ' + r.map((v, i) => v.padEnd(rong[i])).join(' | ') + ' ';
  const out = [ke(cot), rong.map((w) => '-'.repeat(w + 2)).join('+'), ...chu.map(ke)];
  out.push(`(${dong.length} dòng)`);
  return out.join('\n');
}

export function thanhDoiTuong(cot, dong) {
  return dong.map((r) => Object.fromEntries(cot.map((c, i) => [c, r[i]])));
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  let thamSo;
  let sql;
  try {
    thamSo = docThamSo(argv);
    sql = kiemSqlChiDoc(thamSo.sql ?? readFileSync(resolve(env.INIT_CWD && env.npm_lifecycle_event === 'db:query' ? env.INIT_CWD : process.cwd(), thamSo.file), 'utf8'));
  } catch (e) {
    console.error(`db:query: ${e.message}`);
    console.error('Cách dùng: npm run db:query -- (--sql "<select…>" | --file q.sql) [--json] [--env test]');
    return 2;
  }

  let dich;
  try {
    dich = await dichKetNoi(thamSo.env, { env });
  } catch (e) {
    console.error(`db:query: KHÔNG ĐO ĐƯỢC — ${e.message}`);
    return e.khongDoDuoc ? 3 : 2;
  }
  const anMatKhau = (s) => String(s).split(dich.password).join('[REDACTED]');

  pg.types.setTypeParser(1082, (s) => s); // DATE giữ nguyên chuỗi, không lệch múi giờ
  const client = new pg.Client({
    host: dich.host, port: dich.port, user: dich.user, password: dich.password, database: 'postgres',
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000, keepAlive: true,
    application_name: 'db-query-readonly',
  });
  try {
    await client.connect();
  } catch (e) {
    console.error(`db:query: KHÔNG ĐO ĐƯỢC — không kết nối được ${thamSo.env}: ${anMatKhau(e.message)}`);
    return 3;
  }
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT_CAU_LENH}'`);
    await client.query("SET LOCAL lock_timeout = '5s'");
    const kq = await client.query({ text: sql, rowMode: 'array', queryMode: 'extended' });
    const cot = (kq.fields ?? []).map((f) => f.name);
    const dong = kq.rows ?? [];
    if (thamSo.json) console.log(JSON.stringify(thanhDoiTuong(cot, dong), null, 2));
    else console.log(cot.length ? inBang(cot, dong) : `(${kq.command ?? 'OK'})`);
    return 0;
  } catch (e) {
    const ma = e.code ? ` [${e.code}]` : '';
    console.error(`db:query: lỗi truy vấn${ma}: ${anMatKhau(e.message)}`);
    return 1;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
