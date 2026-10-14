// Test cho scripts/db-query.mjs — đường đọc database CHỈ ĐỌC.
//
// Không ca nào kết nối database hay gọi mạng: chỉ kiểm lớp chặn chữ, tham số, đích kết nối,
// đường HTTPS (fetch giả) và cách in. Ca "thiếu credential" trỏ IHOMECRM_VAULT vào file rỗng
// nên không đọc vault thật.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CAU_MO_DAU_HTTPS, ENDPOINT_HTTPS, chayHttps, chonDuong, dichHttps, dichKetNoi, docLoiHttps, docThamSo, inBang, kiemSqlChiDoc,
  lamSachSql, main, thanhDoiTuong,
} from '../db-query.mjs';
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
      'select slot_name from pg_replication_slots',
      'select lo_owner from t',
      'select "rollback", "do" from t',
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
      'select pg_stat_reset()',
      "select pg_replication_slot_advance('s', '0/0')",
      "select lo_unlink (1)",
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
    expect(docThamSo(['--sql', 'select 1'])).toEqual({ sql: 'select 1', file: null, json: false, env: 'prod', via: null });
    expect(docThamSo(['--file=q.sql', '--json', '--env=test'])).toEqual({ sql: null, file: 'q.sql', json: true, env: 'test', via: null });
  });

  it('môi trường lạ và tham số lạ bị từ chối', () => {
    expect(() => docThamSo(['--sql', 'select 1', '--env', 'staging'])).toThrow();
    expect(() => docThamSo(['--sql', 'select 1', '--write'])).toThrow();
  });

  it('--via: pg/https/auto; tham số thắng env DB_QUERY_VIA; mặc định auto', () => {
    expect(docThamSo(['--sql', 'select 1', '--via', 'https']).via).toBe('https');
    expect(docThamSo(['--sql', 'select 1', '--via=pg']).via).toBe('pg');
    expect(() => docThamSo(['--sql', 'select 1', '--via', 'ssh'])).toThrow(/--via/);
    expect(() => docThamSo(['--sql', 'select 1', '--via'])).toThrow(/--via/);
    expect(chonDuong(null, {})).toBe('auto');
    expect(chonDuong(null, { DB_QUERY_VIA: ' HTTPS ' })).toBe('https');
    expect(chonDuong('pg', { DB_QUERY_VIA: 'https' })).toBe('pg');
    expect(() => chonDuong(null, { DB_QUERY_VIA: 'ssh' })).toThrow(/DB_QUERY_VIA/);
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

  it('TEST: thiếu host và PAT riêng của TEST ⇒ KHÔNG ĐO ĐƯỢC (không mượn PAT production)', async () => {
    const env = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: 'b'.repeat(20), TEST_SUPABASE_DB_PASSWORD: 'x', SUPABASE_PAT: 'sbp_' + '1'.repeat(40) };
    await expect(dichKetNoi('test', { env })).rejects.toMatchObject({ khongDoDuoc: true });
  });

  it('TEST: đủ env thì không cần gọi mạng', async () => {
    const ref = 'a'.repeat(20);
    const env = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: ref, TEST_SUPABASE_DB_PASSWORD: 'x', TEST_SUPABASE_POOLER_HOST: 'h.example' };
    expect(await dichKetNoi('test', { env })).toEqual({ ref, host: 'h.example', port: 5432, user: `postgres.${ref}`, password: 'x' });
  });
});

const PAT = 'sbp_' + 'a'.repeat(40);

/** fetch giả: ghi lại lượt gọi, trả status/body cho sẵn. */
function fetchGia(status, body) {
  const goi = [];
  const fn = vi.fn(async (url, init) => {
    goi.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  });
  return Object.assign(fn, { goi });
}

describe('db:query — đường HTTPS', () => {
  it('đích production: cần SUPABASE_PAT, ref luôn là production', () => {
    expect(() => dichHttps('prod', { env: { IHOMECRM_VAULT: vaultRong() } })).toThrow(expect.objectContaining({ khongDoDuoc: true }));
    expect(dichHttps('prod', { env: { IHOMECRM_VAULT: vaultRong(), SUPABASE_PAT: PAT } })).toEqual({ ref: PROD_REF, pat: PAT });
  });

  it('đích TEST: từ chối ref production, không mượn PAT production', () => {
    const env = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: PROD_REF, TEST_SUPABASE_PAT: PAT };
    expect(() => dichHttps('test', { env })).toThrow(/trùng production/);
    const muon = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: 'b'.repeat(20), SUPABASE_PAT: PAT };
    expect(() => dichHttps('test', { env: muon })).toThrow(expect.objectContaining({ khongDoDuoc: true }));
    const du = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: 'b'.repeat(20), TEST_SUPABASE_PAT: PAT };
    expect(dichHttps('test', { env: du })).toEqual({ ref: 'b'.repeat(20), pat: PAT });
  });

  it('ĐỘT BIẾN: gọi endpoint read-only, câu người dùng đứng SAU lệnh khoá chỉ đọc + timeout', async () => {
    const f = fetchGia(201, [{ a: 1, b: null }, { a: 2, b: { x: 1 } }]);
    const kq = await chayHttps({ ref: 'r'.repeat(20), pat: PAT, sql: 'select a, b from t', fetchImpl: f });
    expect(f.goi).toHaveLength(1);
    expect(ENDPOINT_HTTPS).toMatch(/\/read-only$/);
    expect(f.goi[0].url).toBe(`https://api.supabase.com/v1/projects/${'r'.repeat(20)}${ENDPOINT_HTTPS}`);
    expect(f.goi[0].init.method).toBe('POST');
    expect(f.goi[0].init.headers.Authorization).toBe(`Bearer ${PAT}`);
    expect(Object.keys(f.goi[0].body)).toEqual(['query']);
    expect(f.goi[0].body.query).toBe(`${CAU_MO_DAU_HTTPS}select a, b from t`);
    expect(CAU_MO_DAU_HTTPS).toMatch(/^SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30s'; /);
    expect(CAU_MO_DAU_HTTPS.endsWith('\n')).toBe(true);
    expect(kq).toEqual({ cot: ['a', 'b'], dong: [[1, null], [2, { x: 1 }]] });
  });

  it('kết quả rỗng ⇒ không cột, không dòng', async () => {
    expect(await chayHttps({ ref: 'r'.repeat(20), pat: PAT, sql: 'select 1 where false', fetchImpl: fetchGia(201, []) }))
      .toEqual({ cot: [], dong: [] });
  });

  it('400 là lỗi SQL (mã SQLSTATE); 401/404/phản hồi lạ/mạng hỏng là KHÔNG ĐO ĐƯỢC', async () => {
    const goi = (f) => chayHttps({ ref: 'r'.repeat(20), pat: PAT, sql: 'select 1', fetchImpl: f });
    await expect(goi(fetchGia(400, { message: 'Failed to run sql query: ERROR:  42703: column "x" does not exist\n' })))
      .rejects.toMatchObject({ maLoi: '42703', message: 'column "x" does not exist' });
    for (const f of [fetchGia(401, { message: 'Unauthorized' }), fetchGia(404, 'Not Found'), fetchGia(201, { a: 1 }), fetchGia(201, 'xx')]) {
      await expect(goi(f)).rejects.toMatchObject({ khongDoDuoc: true });
    }
    await expect(goi(vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); })))
      .rejects.toMatchObject({ khongDoDuoc: true, message: expect.stringMatching(/ECONNRESET/) });
  });

  it('lỗi server: trừ dòng lệnh mở đầu khỏi "LINE n", dấu ^ giữ đúng cột', () => {
    const thongDiep = 'Failed to run sql query: ERROR:  42601: syntax error at or near "where"\nLINE 10: select from where\n                     ^\n';
    const { ma, thongDiep: ra } = docLoiHttps(thongDiep);
    expect(ma).toBe('42601');
    const [, dong, mu] = ra.split('\n');
    expect(dong).toBe('LINE 9:  select from where');
    expect(dong.indexOf('where')).toBe(mu.indexOf('^'));
    expect(docLoiHttps('Failed to run sql query: lạ')).toEqual({ ma: null, thongDiep: 'lạ' });
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

  it('SQL ghi bị chặn trước mọi lượt gọi HTTPS', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fetchGia(201, []);
    const env = { IHOMECRM_VAULT: vaultRong(), SUPABASE_PAT: PAT };
    expect(await main(['--via', 'https', '--sql', 'select 1; delete from t'], { env, fetchImpl: f })).toBe(2);
    expect(await main(['--via', 'https', '--sql', 'insert into t values (1)'], { env, fetchImpl: f })).toBe(2);
    expect(f).not.toHaveBeenCalled();
  });

  it('auto: cổng pooler đóng ⇒ đọc qua HTTPS, ghi chú ra stderr, stdout chỉ có kết quả', async () => {
    const loi = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ra = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fetchGia(201, [{ n: 61 }]);
    const thamDo = vi.fn(async () => false);
    const env = { IHOMECRM_VAULT: vaultRong(), SUPABASE_DB_PASSWORD: 'mk', SUPABASE_PAT: PAT };
    expect(await main(['--json', '--sql', 'select 61 as n'], { env, fetchImpl: f, thamDo })).toBe(0);
    expect(thamDo).toHaveBeenCalledWith(expect.stringMatching(/pooler\.supabase\.com$/), 5432);
    expect(f.goi[0].url).toBe(`https://api.supabase.com/v1/projects/${PROD_REF}${ENDPOINT_HTTPS}`);
    expect(JSON.parse(ra.mock.calls[0][0])).toEqual([{ n: 61 }]);
    expect(loi.mock.calls.flat().join('\n')).toMatch(/không mở được .*5432.*Management API/);
  });

  it('auto: thiếu mật khẩu database vẫn đọc được bằng PAT', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ra = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { IHOMECRM_VAULT: vaultRong(), SUPABASE_PAT: PAT };
    expect(await main(['--sql', 'select 1 as a where false'], { env, fetchImpl: fetchGia(201, []), thamDo: vi.fn() })).toBe(0);
    expect(ra.mock.calls[0][0]).toBe('(0 dòng)');
  });

  it('pg tường minh không bao giờ chuyển sang HTTPS; auto thiếu cả hai credential ⇒ thoát 3 nêu cả hai lý do', async () => {
    const loi = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fetchGia(201, []);
    expect(await main(['--via', 'pg', '--sql', 'select 1'], { env: { IHOMECRM_VAULT: vaultRong(), SUPABASE_PAT: PAT }, fetchImpl: f })).toBe(3);
    expect(f).not.toHaveBeenCalled();
    expect(await main(['--sql', 'select 1'], { env: { IHOMECRM_VAULT: vaultRong() }, fetchImpl: f })).toBe(3);
    expect(loi.mock.calls.flat().join('\n')).toMatch(/SUPABASE_PAT.*đường pg: Thiếu SUPABASE_DB_PASSWORD/);
  });

  it('TEST trỏ nhầm production ⇒ dừng (thoát 2), không chuyển đường', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fetchGia(201, []);
    const env = { IHOMECRM_VAULT: vaultRong(), TEST_SUPABASE_REF: PROD_REF, TEST_SUPABASE_DB_PASSWORD: 'x', TEST_SUPABASE_POOLER_HOST: 'h', TEST_SUPABASE_PAT: PAT };
    expect(await main(['--env', 'test', '--sql', 'select 1'], { env, fetchImpl: f })).toBe(2);
    expect(await main(['--env', 'test', '--via', 'https', '--sql', 'select 1'], { env, fetchImpl: f })).toBe(2);
    expect(f).not.toHaveBeenCalled();
  });

  it('lỗi truy vấn qua HTTPS ⇒ thoát 1, che PAT nếu server vọng lại', async () => {
    const loi = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fetchGia(400, { message: `Failed to run sql query: ERROR:  42501: permission denied ${PAT}` });
    expect(await main(['--via', 'https', '--sql', 'select 1'], { env: { IHOMECRM_VAULT: vaultRong(), SUPABASE_PAT: PAT }, fetchImpl: f })).toBe(1);
    const chu = loi.mock.calls.flat().join('\n');
    expect(chu).toMatch(/\[42501\]/);
    expect(chu).not.toContain(PAT);
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
