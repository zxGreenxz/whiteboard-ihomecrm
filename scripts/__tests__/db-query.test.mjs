// Test cho scripts/db-query.mjs — đường đọc database CHỈ ĐỌC.
//
// Không ca nào kết nối database: chỉ kiểm lớp chặn chữ, tham số, đích kết nối và cách
// in. Ca "thiếu credential" trỏ IHOMECRM_VAULT vào file rỗng nên không đọc vault thật.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { dichKetNoi, docThamSo, inBang, kiemSqlChiDoc, lamSachSql, main, thanhDoiTuong } from '../db-query.mjs';
import { PROD_REF } from '../test-env/lib.mjs';

const tam = [];
function vaultRong() {
  const d = mkdtempSync(join(tmpdir(), 'db-query-'));
  tam.push(d);
  const p = join(d, 'vault.md');
  writeFileSync(p, '');
  return p;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tam.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('db:query — chặn chữ (lớp 1)', () => {
  it('nhận câu đọc thường gặp', () => {
    for (const sql of [
      'select 1 as ok',
      'select 1 as ok;',
      '  SELECT count(*) FROM public.organizations  ',
      'with x as (select 1) select * from x',
      '(select 1) union (select 2)',
      'table public.organizations',
      'values (1), (2)',
      'show timezone',
      'explain select 1',
      'select updated_at, deleted_at, created_by, last_update from t',
      "select 'delete from t; drop table x' as chu",
      'select "update", "insert" from t',
      "select E'it\\'s; delete'",
      'select $$insert into t$$, $q$drop$q$',
      '-- delete from t\nselect 1',
      '/* drop table t; /* lồng */ */ select 1',
      'select 1 -- ; commit',
    ]) expect(() => kiemSqlChiDoc(sql), sql).not.toThrow();
  });

  it('ĐỘT BIẾN: chặn mọi đường ghi/đổi trạng thái', () => {
    for (const sql of [
      'delete from t',
      'update t set a = 1',
      'insert into t values (1)',
      'select 1; delete from t',
      'select 1; commit',
      'select 1; select 2', // chỉ phép "một câu" chặn được ca này
      "select 1; end",
      'with d as (delete from t returning *) select * from d',
      'select * into bang_moi from t',
      'select * from t for update',
      "select nextval('s')",
      'select pg_terminate_backend(1)',
      "select set_config('transaction_read_only', 'off', true)",
      'select pg_advisory_lock(1)',
      "select dblink_exec('x', 'drop table t')",
      'begin',
      'commit',
      'set role postgres',
      'vacuum t',
      'analyze t', // chỉ phép "mở đầu bằng câu đọc" chặn được hai ca này
      "load 'auto_explain'",
      'explain analyze delete from t',
      'create table t (a int)',
      'comment on table t is $$x$$',
      'call p()',
      'do $$ begin perform 1; end $$',
    ]) expect(() => kiemSqlChiDoc(sql), sql).toThrow();
  });

  it('SQL hỏng hoặc rỗng bị từ chối thay vì đoán', () => {
    for (const sql of ['', '   ', "select 'chưa đóng", 'select 1 /* chưa đóng', 'select "x', 'select $a$ x']) {
      expect(() => kiemSqlChiDoc(sql), sql).toThrow();
    }
  });

  it('làm sạch: chú thích thành dấu cách, chuỗi thành rỗng', () => {
    expect(lamSachSql("select 'a;b' -- c\n, \"d\"")).toBe("select ''  \n, \"\"");
  });
});

describe('db:query — tham số', () => {
  it('cần đúng một nguồn SQL', () => {
    expect(() => docThamSo([])).toThrow();
    expect(() => docThamSo(['--sql', 'select 1', '--file', 'q.sql'])).toThrow();
    expect(docThamSo(['--sql', 'select 1'])).toEqual({ sql: 'select 1', file: null, json: false, env: 'prod' });
    expect(docThamSo(['--file=q.sql', '--json', '--env=test'])).toEqual({ sql: null, file: 'q.sql', json: true, env: 'test' });
  });

  it('môi trường lạ và tham số lạ bị từ chối', () => {
    expect(() => docThamSo(['--sql', 'select 1', '--env', 'staging'])).toThrow();
    expect(() => docThamSo(['--sql', 'select 1', '--write'])).toThrow();
  });
});

describe('db:query — đích kết nối', () => {
  it('production: thiếu mật khẩu ⇒ KHÔNG ĐO ĐƯỢC', async () => {
    await expect(dichKetNoi('prod', { env: { IHOMECRM_VAULT: vaultRong() } })).rejects.toMatchObject({ khongDoDuoc: true });
  });

  it('production: env SUPABASE_DB_PASSWORD đủ để dựng đích pooler', async () => {
    const d = await dichKetNoi('prod', { env: { IHOMECRM_VAULT: vaultRong(), SUPABASE_DB_PASSWORD: 'mk-thu' } });
    expect(d).toMatchObject({ ref: PROD_REF, port: 5432, user: `postgres.${PROD_REF}`, password: 'mk-thu' });
    expect(d.host).toMatch(/pooler\.supabase\.com$/);
  });

  it('TEST: từ chối ref trùng production', async () => {
    const env = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: PROD_REF, TEST_SUPABASE_DB_PASSWORD: 'x', TEST_SUPABASE_POOLER_HOST: 'h' };
    await expect(dichKetNoi('test', { env })).rejects.toThrow(/trùng production/);
  });

  it('TEST: đủ env thì không cần gọi mạng', async () => {
    const ref = 'a'.repeat(20);
    const env = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: ref, TEST_SUPABASE_DB_PASSWORD: 'x', TEST_SUPABASE_POOLER_HOST: 'h.example' };
    expect(await dichKetNoi('test', { env })).toEqual({ ref, host: 'h.example', port: 5432, user: `postgres.${ref}`, password: 'x' });
  });
});

describe('db:query — chạy', () => {
  it('SQL ghi bị chặn trước khi kết nối (thoát 2)', async () => {
    const loi = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--sql', 'delete from t'], { env: { IHOMECRM_VAULT: vaultRong(), SUPABASE_DB_PASSWORD: 'mk' } })).toBe(2);
    expect(loi.mock.calls.flat().join('\n')).toMatch(/delete/);
  });

  it('thiếu credential ⇒ thoát 3, không lộ gì', async () => {
    const loi = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--sql', 'select 1'], { env: { IHOMECRM_VAULT: vaultRong() } })).toBe(3);
    expect(loi.mock.calls.flat().join('\n')).toMatch(/KHÔNG ĐO ĐƯỢC/);
  });
});

describe('db:query — in kết quả', () => {
  it('bảng kiểu psql, NULL và JSON hiện rõ', () => {
    expect(inBang(['ok', 'ghi_chu'], [[1, null], [22, { a: 1 }]])).toBe([
      ' ok | ghi_chu ',
      '----+---------',
      ' 1  | NULL    ',
      ' 22 | {"a":1} ',
      '(2 dòng)',
    ].join('\n'));
  });

  it('JSON giữ cả cột trùng tên theo thứ tự cột', () => {
    expect(thanhDoiTuong(['a', 'b'], [[1, '2026-10-07']])).toEqual([{ a: 1, b: '2026-10-07' }]);
  });
});
