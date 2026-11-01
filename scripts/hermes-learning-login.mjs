#!/usr/bin/env node
// Bật hoặc tắt đăng nhập của ĐÚNG MỘT vai: hermes_store_learning (job nạp đề xuất bài học Hermes). Vai do migration
// 20261101064441 tạo ở trạng thái NOLOGIN; mật khẩu không được vào migration vì repo công khai.
//
//   npm run with-cred -- node scripts/hermes-learning-login.mjs --enable --verifier-file <file>            # chỉ kiểm, không ghi
//   npm run with-cred -- node scripts/hermes-learning-login.mjs --enable --verifier-file <file> --apply    # ALTER ROLE … LOGIN PASSWORD
//   npm run with-cred -- node scripts/hermes-learning-login.mjs --disable --apply                          # ALTER ROLE … NOLOGIN
//   npm run with-cred -- node scripts/hermes-learning-login.mjs --disable --terminate-sessions --apply     # nghi lộ mật khẩu: ngắt thêm phiên đang mở
//
// Chỉ production. Mỗi lượt chạy tối đa một câu ALTER ROLE, còn lại là SELECT (ngắt phiên chỉ khi được yêu cầu). Tắt đăng nhập là đường lùi nên vẫn
// chạy khi vai lệch (chỉ cần vai tồn tại, in cảnh báo). Bật thì vai phải đúng như migration dựng. Không nhận tên vai nào khác, không nhận mật khẩu thô: file phải
// chứa verifier SCRAM-SHA-256 sinh trên VPS, mật khẩu gốc chỉ ở VPS. Không in verifier; lỗi chỉ in mã.
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLE = 'hermes_store_learning';
export const INGEST_GROUP = 'hermes_learning_ingest';
const VERIFIER = /^SCRAM-SHA-256\$([0-9]{4,7}):[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
const STATE_SQL = `SELECT r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
  r.rolconfig, ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=r.oid ORDER BY 1) AS groups
  FROM pg_roles r WHERE r.rolname='${ROLE}'`;
const TERMINATE_SQL = `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE usename='${ROLE}'`;

export class LoginError extends Error {
  constructor(code) { super(code); this.name = 'LoginError'; this.code = code; }
}
const fail = code => { throw new LoginError(code); };

export function parseArgs(argv) {
  const args = { mode: null, verifierFile: null, apply: false, terminateSessions: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--enable' || arg === '--disable') {
      if (args.mode) fail('args_invalid');
      args.mode = arg.slice(2);
    } else if (arg === '--apply') args.apply = true;
    else if (arg === '--terminate-sessions') args.terminateSessions = true;
    else if (arg === '--verifier-file' && argv[index + 1]) { args.verifierFile = argv[index + 1]; index += 1; }
    // Chỉ nhận đúng vai này: không có đường nào đổi mật khẩu vai khác bằng script này.
    else if (arg === '--role' && argv[index + 1] === ROLE) index += 1;
    else if (arg === '--role') fail('role_refused');
    else fail('args_invalid');
  }
  if (!args.mode || (args.mode === 'enable') !== (args.verifierFile !== null) || (args.terminateSessions && args.mode !== 'disable')) fail('args_invalid');
  return args;
}

export function parseVerifier(text) {
  const match = typeof text === 'string' ? VERIFIER.exec(text) : null;
  if (!match || Number(match[1]) < 4096) fail('verifier_invalid');
  return text;
}

/** File verifier: file thường, không symlink, không mở cho nhóm/người khác (bỏ kiểm quyền trên Windows). */
export function readVerifierFile(file, { lstat = lstatSync, read = readFileSync, platform = process.platform } = {}) {
  const info = lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024) fail('verifier_file_invalid');
  if (platform !== 'win32' && (info.mode & 0o077) !== 0) fail('verifier_file_too_open');
  return parseVerifier(read(file, 'utf8'));
}

/** Vai phải đúng như migration dựng trước khi được bật đăng nhập; thừa quyền hay thêm nhóm nào cũng dừng. */
export function checkRoleState(row) {
  if (!row) fail('role_missing');
  if (row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls || !row.rolinherit) fail('role_unsafe');
  if (!Array.isArray(row.groups) || row.groups.length !== 1 || row.groups[0] !== INGEST_GROUP) fail('role_groups_unsafe');
  const config = Array.isArray(row.rolconfig) ? row.rolconfig : [];
  for (const wanted of ['statement_timeout=8s', 'lock_timeout=3s', 'idle_in_transaction_session_timeout=10s']) {
    if (!config.includes(wanted)) fail('role_timeouts_missing');
  }
  return row;
}

export const enableSql = verifier => `ALTER ROLE ${ROLE} LOGIN PASSWORD '${parseVerifier(verifier)}'`;
export const disableSql = () => `ALTER ROLE ${ROLE} NOLOGIN`;

export async function run(args, { client, readVerifier = readVerifierFile, log = line => process.stdout.write(`${line}\n`) }) {
  const verifier = args.mode === 'enable' ? readVerifier(args.verifierFile) : null;
  const current = (await client.query(STATE_SQL)).rows[0];
  if (!current) fail('role_missing');
  let before = current;
  if (args.mode === 'enable') before = checkRoleState(current);
  else {
    // Đường lùi không được phụ thuộc trạng thái vai: vai lệch thì càng phải tắt được.
    try { checkRoleState(current); } catch (error) {
      if (!(error instanceof LoginError)) throw error;
      log(JSON.stringify({ event: 'hermes_learning_login_warning', code: error.code }));
    }
  }
  if (!args.apply) {
    log(JSON.stringify({ event: 'hermes_learning_login', mode: args.mode, applied: false, canLogin: before.rolcanlogin }));
    return 0;
  }
  await client.query(args.mode === 'enable' ? enableSql(verifier) : disableSql());
  const after = (await client.query(STATE_SQL)).rows[0];
  if (!after) fail('role_missing');
  if (args.mode === 'enable') checkRoleState(after);
  if (after.rolcanlogin !== (args.mode === 'enable')) fail('role_state_unexpected');
  const terminated = args.terminateSessions ? (await client.query(TERMINATE_SQL)).rows.length : undefined;
  log(JSON.stringify({ event: 'hermes_learning_login', mode: args.mode, applied: true, canLogin: after.rolcanlogin, terminated }));
  return 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  const { dichKetNoi } = await import('./db-query.mjs');
  const pg = createRequire(import.meta.url)('pg');
  const target = await dichKetNoi('prod');
  const client = new pg.Client({ host: target.host, port: target.port, user: target.user, password: target.password, database: 'postgres',
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000, application_name: 'hermes-learning-login' });
  await client.connect();
  try { return await run(args, { client }); } finally { await client.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    // Không in error.message: lỗi của PostgreSQL có thể mang nguyên câu lệnh chứa verifier.
    const code = error instanceof LoginError ? error.code : typeof error?.code === 'string' ? error.code : 'failed';
    process.stderr.write(`${JSON.stringify({ event: 'hermes_learning_login_failed', code })}\n`);
    process.exitCode = 1;
  });
}
