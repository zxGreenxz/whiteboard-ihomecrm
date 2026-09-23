import { describe, expect, it } from 'vitest';

import { sqlDefaultAcl } from '../test-env/khoi-phuc.mjs';
import { PROD_REF, batBuocDichTest } from '../test-env/lib.mjs';
import { soBam, soVanTay, sqlBamLo } from '../test-env/van-tay.mjs';

describe('môi trường TEST — phép so vân tay', () => {
  it('khớp tuyệt đối thì không có khác biệt', () => {
    const a = [{ k: 'fn:public.f()', v: '1' }, { k: 'pol:public.t.p', v: '2' }];
    expect(soVanTay(a, [...a].reverse())).toEqual([]);
  });

  it('bắt đủ ba loại lệch: thiếu, thừa, khác', () => {
    const prod = [{ k: 'fn:a', v: '1' }, { k: 'fn:b', v: '2' }];
    const test = [{ k: 'fn:b', v: 'X' }, { k: 'fn:c', v: '3' }];
    expect(soVanTay(prod, test)).toEqual([
      { k: 'fn:a', loai: 'thiếu trên TEST' },
      { k: 'fn:b', loai: 'khác' },
      { k: 'fn:c', loai: 'thừa trên TEST' },
    ]);
  });

  it('so mã băm từng bảng: bảng lệch dòng phải lộ ra', () => {
    expect(soBam({ 'public.a': 'h:3', 'public.b': 'h:1' }, { 'public.a': 'h:3', 'public.b': 'k:1' }))
      .toEqual([{ k: 'public.b', prod: 'h:1', test: 'k:1' }]);
    expect(soBam({ 'public.a': 'h:3' }, {})).toEqual([{ k: 'public.a', prod: 'h:3', test: null }]);
  });

  it('bảng auth chỉ băm cột chung, bảng ứng dụng băm cả dòng', () => {
    const sql = sqlBamLo([{ sch: 'auth', bang: 'users' }, { sch: 'public', bang: 'invoices' }]);
    expect(sql).toContain('row(x.id, x.email, x.encrypted_password');
    expect(sql).toContain('md5(x::text) h from "public"."invoices"');
  });
});

describe('môi trường TEST — tái lập default privileges', () => {
  it('sinh đúng GRANT theo từng loại object, bỏ qua chính postgres', () => {
    const sql = sqlDefaultAcl([
      { sch: 'public', loai: 'r', acl: ['postgres=arwdDxtm/postgres', 'anon=r/postgres'] },
      { sch: '', loai: 'f', acl: ['=X/postgres', 'service_role=X/postgres'] },
    ]);
    expect(sql).toBe([
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "public" GRANT SELECT ON TABLES TO "anon";',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO "service_role";',
    ].join('\n'));
  });
});

describe('môi trường TEST — chốt an toàn', () => {
  it('từ chối ghi khi đích là production, trước mọi truy vấn', async () => {
    await expect(batBuocDichTest({ testRef: PROD_REF }, 'postgresql://x')).rejects.toThrow(/PRODUCTION/);
  });

  it('từ chối khi chuỗi kết nối chứa ref production dù ref khai là TEST', async () => {
    await expect(batBuocDichTest({ testRef: 'aaaaaaaaaaaaaaaaaaaa' }, `postgresql://postgres.${PROD_REF}@h/postgres`))
      .rejects.toThrow(/PRODUCTION/);
  });
});
