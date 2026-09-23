import { describe, expect, it } from 'vitest';

import { matKhauTest } from '../test-env/hau-ky.mjs';
import { sqlDefaultAcl, tachLoiPgRestore } from '../test-env/khoi-phuc.mjs';
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

  it('ràng buộc chỉ khác ngoặc là "tương đương", khác nghĩa vẫn là "khác"', () => {
    const prod = [{ k: 'con:public.t.c1', v: 'A:N' }, { k: 'con:public.t.c2', v: 'B:M' }];
    const test = [{ k: 'con:public.t.c1', v: 'X:N' }, { k: 'con:public.t.c2', v: 'Y:Z' }];
    expect(soVanTay(prod, test)).toEqual([
      { k: 'con:public.t.c1', loai: 'tương đương' },
      { k: 'con:public.t.c2', loai: 'khác' },
    ]);
  });

  it('so mã băm từng bảng: bảng lệch dòng phải lộ ra', () => {
    expect(soBam({ 'public.a': 'h:3', 'public.b': 'h:1' }, { 'public.a': 'h:3', 'public.b': 'k:1' }))
      .toEqual([{ k: 'public.b', prod: 'h:1', test: 'k:1' }]);
    expect(soBam({ 'public.a': 'h:3' }, {})).toEqual([{ k: 'public.a', prod: 'h:3', test: null }]);
  });

  it('bảng auth chỉ băm cột chung, bảng ứng dụng băm cả dòng', () => {
    const sql = sqlBamLo([{ sch: 'auth', bang: 'users' }, { sch: 'public', bang: 'invoices' }]);
    expect(sql).toContain('row(x.id, x.email, x.role');
    // mật khẩu TEST cố ý khác production ⇒ không băm cột hash mật khẩu
    expect(sql).not.toContain('encrypted_password');
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

describe('môi trường TEST — mật khẩu tất định', () => {
  it('cùng seed + email ⇒ cùng mật khẩu (vault và CI khớp nhau), khác seed ⇒ khác', () => {
    const a = matKhauTest('seed-1', 'Nathan@username.ihomecrm.local');
    expect(a).toBe(matKhauTest('seed-1', 'nathan@username.ihomecrm.local'));
    expect(a).not.toBe(matKhauTest('seed-2', 'nathan@username.ihomecrm.local'));
    expect(a).toMatch(/^Tt!.{16}$/);
  });
});

describe('môi trường TEST — tách lỗi pg_restore', () => {
  it('lấy ĐỦ câu lệnh nhiều dòng (án lệ 23/09: chỉ lấy dòng đầu ⇒ 16 khoá ngoại bị nuốt)', () => {
    const err = [
      'pg_restore: error: could not execute query: ERROR:  insert or update on table "t" violates foreign key constraint "t_fk"',
      'DETAIL:  Key (x)=(1) is not present in table "p".',
      'Command was: ALTER TABLE ONLY public.t',
      '    ADD CONSTRAINT t_fk FOREIGN KEY (x) REFERENCES public.p(id);',
      '',
      '',
      'pg_restore: error: could not execute query: ERROR:  deadlock detected',
      'Command was: CREATE POLICY p ON public.t USING (true);',
      '',
    ].join('\r\n');
    const k = tachLoiPgRestore(err);
    expect(k).toHaveLength(2);
    expect(k[0].lenh).toContain('ADD CONSTRAINT t_fk FOREIGN KEY');
    expect(k[0].chiTiet).toContain('is not present');
    expect(k[1].loi).toBe('deadlock detected');
    expect(k[1].lenh).toBe('CREATE POLICY p ON public.t USING (true);');
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
