import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { checkRoleState, disableSql, enableSql, LoginError, parseArgs, parseVerifier, readVerifierFile, ROLE, run } from '../../scripts/hermes-learning-login.mjs';

// Verifier dựng lúc chạy theo đúng công thức của runbook (không có chuỗi dạng bí mật trong mã nguồn).
function verifier(iterations = 4096) {
  const salt = randomBytes(16), salted = pbkdf2Sync(randomBytes(48).toString('base64url'), salt, iterations, 32, 'sha256');
  const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
  const server = createHmac('sha256', salted).update('Server Key').digest();
  return ['SCRAM-SHA-256$', String(iterations), ':', salt.toString('base64'), '$', stored.toString('base64'), ':', server.toString('base64')].join('');
}
const safeRow = (extra = {}) => ({ rolcanlogin: false, rolinherit: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
  rolbypassrls: false, rolconfig: ['statement_timeout=8s', 'lock_timeout=3s', 'idle_in_transaction_session_timeout=10s'], groups: ['hermes_learning_ingest'], ...extra });
const code = expected => error => { assert.ok(error instanceof LoginError, String(error)); assert.equal(error.code, expected); return true; };
function fakeClient(rows) {
  const queries = [];
  return { queries, async query(sql) {
    queries.push(sql);
    return /^SELECT/.test(sql) ? { rows: rows.length ? [rows.shift()] : [] } : { rows: [] };
  } };
}
const writes = client => client.queries.filter(sql => !sql.startsWith('SELECT'));

test('chỉ nhận đúng vai này và đúng tham số', () => {
  assert.deepEqual(parseArgs(['--enable', '--verifier-file', '/x', '--apply']), { mode: 'enable', verifierFile: '/x', apply: true });
  assert.deepEqual(parseArgs(['--disable', '--role', ROLE]), { mode: 'disable', verifierFile: null, apply: false });
  assert.throws(() => parseArgs(['--enable', '--verifier-file', '/x', '--role', 'postgres']), code('role_refused'));
  assert.throws(() => parseArgs(['--disable', '--role', 'hermes_store_host', '--apply']), code('role_refused'));
  for (const argv of [[], ['--apply'], ['--enable'], ['--disable', '--verifier-file', '/x'], ['--enable', '--disable', '--verifier-file', '/x'], ['--sql', 'x']]) {
    assert.throws(() => parseArgs(argv), code('args_invalid'), argv.join(' '));
  }
});

test('chỉ nhận verifier SCRAM đúng khuôn, không nhận mật khẩu thô hay chuỗi chèn SQL', () => {
  const good = verifier();
  assert.equal(parseVerifier(good), good);
  assert.match(enableSql(good), /^ALTER ROLE hermes_store_learning LOGIN PASSWORD '[^']+'$/);
  for (const bad of ['mat-khau-tho-rat-dai-0123456789', '', null, `${good}\n`, `${good}'; DROP ROLE postgres; --`, good.replace('$4096', '$1000'), good.replace('SCRAM-SHA-256', 'md5')]) {
    assert.throws(() => parseVerifier(bad), code('verifier_invalid'), String(bad).slice(0, 20));
  }
});

test('file verifier: file thường, không symlink, không mở cho người khác', () => {
  const good = verifier();
  const info = (extra = {}) => ({ isSymbolicLink: () => false, isFile: () => true, size: good.length, mode: 0o100600, ...extra });
  const open = { platform: 'linux', read: () => good };
  assert.equal(readVerifierFile('/x', { ...open, lstat: () => info() }), good);
  assert.throws(() => readVerifierFile('/x', { ...open, lstat: () => info({ isSymbolicLink: () => true }) }), code('verifier_file_invalid'));
  assert.throws(() => readVerifierFile('/x', { ...open, lstat: () => info({ isFile: () => false }) }), code('verifier_file_invalid'));
  assert.throws(() => readVerifierFile('/x', { ...open, lstat: () => info({ mode: 0o100644 }) }), code('verifier_file_too_open'));
});

test('vai phải đúng như migration dựng: thừa quyền, thêm nhóm, thiếu trần thời gian đều dừng', () => {
  assert.throws(() => checkRoleState(undefined), code('role_missing'));
  for (const flag of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) {
    assert.throws(() => checkRoleState(safeRow({ [flag]: true })), code('role_unsafe'), flag);
  }
  assert.throws(() => checkRoleState(safeRow({ rolinherit: false })), code('role_unsafe'));
  assert.throws(() => checkRoleState(safeRow({ groups: ['hermes_learning_ingest', 'hermes_store_executor'] })), code('role_groups_unsafe'));
  assert.throws(() => checkRoleState(safeRow({ groups: [] })), code('role_groups_unsafe'));
  assert.throws(() => checkRoleState(safeRow({ rolconfig: null })), code('role_timeouts_missing'));
});

test('mặc định không ghi; --apply chạy đúng một câu ghi và không in verifier', async () => {
  const good = verifier(), lines = [];
  const dry = fakeClient([safeRow()]);
  await run({ mode: 'enable', verifierFile: '/x', apply: false }, { client: dry, readVerifier: () => good, log: line => lines.push(line) });
  assert.deepEqual(writes(dry), []);
  const real = fakeClient([safeRow(), safeRow({ rolcanlogin: true })]);
  await run({ mode: 'enable', verifierFile: '/x', apply: true }, { client: real, readVerifier: () => good, log: line => lines.push(line) });
  assert.deepEqual(writes(real), [enableSql(good)]);
  assert.ok(!lines.join('\n').includes(good.slice(20)));
  assert.equal(JSON.parse(lines[1]).canLogin, true);
  const off = fakeClient([safeRow({ rolcanlogin: true }), safeRow()]);
  await run({ mode: 'disable', verifierFile: null, apply: true }, { client: off, log: () => {} });
  assert.deepEqual(writes(off), [disableSql()]);
  // Vai lệch thì không ghi; ghi xong đọc lại không đúng thì báo.
  const unsafe = fakeClient([safeRow({ rolsuper: true })]);
  await assert.rejects(run({ mode: 'enable', verifierFile: '/x', apply: true }, { client: unsafe, readVerifier: () => good, log: () => {} }), code('role_unsafe'));
  assert.deepEqual(writes(unsafe), []);
  const stuck = fakeClient([safeRow(), safeRow()]);
  await assert.rejects(run({ mode: 'enable', verifierFile: '/x', apply: true }, { client: stuck, readVerifier: () => good, log: () => {} }), code('role_state_unexpected'));
});

test('migration tạo vai trên PostgreSQL thật: chạy độc lập được, NOLOGIN, đúng một nhóm, chạy lại không đụng đăng nhập đã bật, thừa nhóm thì dừng', async t => {
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  const name = readdirSync(directory).find(file => /_hermes_store_learning_role\.sql$/.test(file));
  const sql = readFileSync(new URL(name, directory), 'utf8');
  assert.doesNotMatch(sql, /PASSWORD|SCRAM/i, 'file công khai không được chứa mật khẩu hay verifier');
  const db = new PGlite();
  t.after(() => db.close());
  // Chưa có migration kho đề xuất: vẫn chạy được (cửa idempotent dán từng file riêng lên production).
  await db.exec(sql);
  const read = async () => (await db.query(`SELECT r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolconfig,
    ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=r.oid ORDER BY 1) AS groups
    FROM pg_roles r WHERE r.rolname='${ROLE}'`)).rows[0];
  const created = await read();
  assert.equal(created.rolcanlogin, false);
  checkRoleState(created);
  await db.exec(`ALTER ROLE ${ROLE} LOGIN`);
  await db.exec(sql); // chạy lại sau khi đã bật đăng nhập
  assert.equal((await read()).rolcanlogin, true);
  checkRoleState(await read());
  await db.exec(`CREATE ROLE them_nhom NOLOGIN; GRANT them_nhom TO ${ROLE};`);
  await assert.rejects(db.exec(sql), /hermes_store_learning_groups_unsafe/);
});
