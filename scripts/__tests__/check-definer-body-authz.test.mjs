// Sổ cho scripts/check-definer-body-authz.mjs.
//
// Bài quan trọng nhất trong file này là bài CUỐI: chạy bộ dò trên MỘT MIGRATION
// THẬT trong repo và đòi nó nhận ra đúng những gì file đó khai. Lý do rất cụ
// thể — lúc dựng gate, `new RegExp(`\b${b}\b`)` trong template literal cho ra ký
// tự backspace chứ không phải ranh giới từ, nên gate khớp 0 bảng, không báo gì,
// và in dấu tick với 1238 hàm. Mọi bài test dùng chuỗi bịa đều xanh; chỉ phép
// đo trên vật thật mới lộ.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DANH_SACH_NHAY_CAM,
  PRIMITIVE_PHAM_VI,
  SAN_SO_HAM_DEFINER,
  catThanHam,
  chamBang,
  docSuKien,
  phanTichThanHam,
} from '../check-definer-body-authz.mjs';

const dinhNghia = (ten, than, { definer = true } = {}) =>
  `create or replace function ${ten}()\nreturns void\nlanguage plpgsql\n${
    definer ? 'security definer' : 'security invoker'
  }\nas $fn$\n${than}\n$fn$;\n`;

const cap = (ten) => `grant execute on function ${ten}() to authenticated;\n`;
const thuHoi = (ten) => `revoke all on function ${ten}() from authenticated;\n`;

const chay = (sql, tuyChon = {}) =>
  phanTichThanHam({ suKien: docSuKien(sql).map((s) => ({ ...s, file: 'x.sql' })), ...tuyChon });

describe('chamBang — ranh giới từ thật, không phải ký tự backspace', () => {
  it('khớp tên bảng đứng sau dấu chấm schema', () => {
    expect(chamBang('select * from public.invoices i', 'invoices')).toBe(true);
  });

  it('KHÔNG khớp khi tên bảng chỉ là hậu tố của tên khác', () => {
    // `accounts` không được nuốt `bank_accounts` — báo thừa làm gate mất uy tín
    // nhanh hơn bất cứ thứ gì.
    expect(chamBang('select * from public.bank_accounts', 'accounts')).toBe(false);
  });

  it('khớp cả khi bảng đứng cuối câu', () => {
    expect(chamBang('delete from customers', 'customers')).toBe(true);
  });
});

describe('catThanHam — cắt thân dollar-quoted', () => {
  it('lấy đúng phần giữa hai dấu $fn$', () => {
    const sql = 'create function f() returns void language sql as $fn$ select 1 $fn$;';
    const than = catThanHam(sql, 0);
    expect(than.body.trim()).toBe('select 1');
    expect(than.header).toContain('language sql');
  });

  it('thân không đóng ⇒ null, không ném', () => {
    expect(catThanHam('create function f() as $fn$ select 1', 0)).toBeNull();
  });
});

describe('luật cốt lõi', () => {
  it('definer + grant authenticated + bảng tiền + không guard ⇒ ĐỎ', () => {
    const sql =
      dinhNghia('public.doc_luong', 'begin select * from salary_monthly; end') +
      cap('public.doc_luong');
    const kq = chay(sql);
    expect(kq.dat).toBe(false);
    expect(kq.viPham.map((v) => v.ham)).toEqual(['public.doc_luong']);
    expect(kq.viPham[0].bang).toContain('salary_monthly');
  });

  it('có primitive phạm vi trong thân ⇒ XANH', () => {
    const sql =
      dinhNghia(
        'public.doc_luong',
        'begin if auth.uid() is null then raise exception %; end if; select * from salary_monthly; end',
      ) + cap('public.doc_luong');
    expect(chay(sql).dat).toBe(true);
  });

  it('KHÔNG grant authenticated ⇒ ngoài phạm vi gate', () => {
    const sql = dinhNghia('public.doc_luong', 'begin select * from salary_monthly; end');
    expect(chay(sql).dat).toBe(true);
  });

  it('grant rồi revoke authenticated ⇒ XANH (thứ tự trong file có tính)', () => {
    const sql =
      dinhNghia('public.doc_luong', 'begin select * from salary_monthly; end') +
      cap('public.doc_luong') +
      thuHoi('public.doc_luong');
    expect(chay(sql).dat).toBe(true);
  });

  it('SECURITY INVOKER ⇒ ngoài phạm vi (RLS vẫn gác)', () => {
    const sql =
      dinhNghia('public.doc_luong', 'begin select * from salary_monthly; end', { definer: false }) +
      cap('public.doc_luong');
    expect(chay(sql).dat).toBe(true);
  });

  it('không chạm bảng nhạy cảm ⇒ XANH', () => {
    const sql =
      dinhNghia('public.doc_gi_do', 'begin select * from app_settings; end') +
      cap('public.doc_gi_do');
    expect(chay(sql).dat).toBe(true);
  });
});

describe('chuỗi trong CHÚ THÍCH không được làm gate xanh', () => {
  it('nhắc `authorized_scope_v3` trong comment không tính là guard', () => {
    // Luật §8: gate quét văn bản không được lẫn MÃ với VĂN KỂ VỀ MÃ.
    const sql =
      dinhNghia(
        'public.doc_luong',
        '-- đáng ra phải gọi authorized_scope_v3 ở đây\nbegin select * from salary_monthly; end',
      ) + cap('public.doc_luong');
    const kq = chay(sql);
    expect(kq.dat).toBe(false);
    expect(kq.viPham.map((v) => v.ham)).toEqual(['public.doc_luong']);
  });
});

describe('hai danh sách tha bổng', () => {
  const sqlXau = () =>
    dinhNghia('public.doc_luong', 'begin select * from salary_monthly; end') + cap('public.doc_luong');

  it('"allow" có reason ⇒ XANH', () => {
    const kq = chay(sqlXau(), {
      allowlist: [{ function: 'public.doc_luong', reason: 'endpoint công khai có token' }],
    });
    expect(kq.dat).toBe(true);
  });

  it('"chuaVa" có reason ⇒ XANH và được đếm riêng', () => {
    const kq = chay(sqlXau(), {
      chuaVa: [{ function: 'public.doc_luong', reason: 'lỗ thật', owner: 'plan I1' }],
    });
    expect(kq.dat).toBe(true);
    expect(kq.soChuaVa).toBe(1);
  });

  it('tha bổng KHÔNG có reason ⇒ ĐỎ', () => {
    const kq = chay(sqlXau(), { allowlist: [{ function: 'public.doc_luong' }] });
    expect(kq.dat).toBe(false);
    expect(kq.thieuLyDo).toEqual(['public.doc_luong']);
  });

  it('reason toàn khoảng trắng cũng là KHÔNG có reason', () => {
    const kq = chay(sqlXau(), { allowlist: [{ function: 'public.doc_luong', reason: '   ' }] });
    expect(kq.dat).toBe(false);
  });

  it('nằm ở CẢ hai danh sách ⇒ ĐỎ vì mâu thuẫn', () => {
    const kq = chay(sqlXau(), {
      allowlist: [{ function: 'public.doc_luong', reason: 'an toàn' }],
      chuaVa: [{ function: 'public.doc_luong', reason: 'lỗ thật', owner: 'ai đó' }],
    });
    expect(kq.dat).toBe(false);
    expect(kq.trungHaiDanhSach).toEqual(['public.doc_luong']);
  });

  it('mục đã được vá thì bị nêu tên để GỠ, không im lặng', () => {
    const sqlTot =
      dinhNghia('public.doc_luong', 'begin perform auth.uid(); select * from salary_monthly; end') +
      cap('public.doc_luong');
    const kq = chay(sqlTot, {
      chuaVa: [{ function: 'public.doc_luong', reason: 'lỗ thật', owner: 'plan I1' }],
    });
    expect(kq.dat).toBe(true);
    expect(kq.daSiet).toEqual(['public.doc_luong']);
  });

  it('tha bổng chỉ ăn ĐÚNG hàm được nêu tên', () => {
    const sql =
      sqlXau() +
      dinhNghia('public.doc_khach', 'begin select * from customers; end') +
      cap('public.doc_khach');
    const kq = chay(sql, {
      allowlist: [{ function: 'public.doc_luong', reason: 'an toàn' }],
    });
    expect(kq.dat).toBe(false);
    expect(kq.viPham.map((v) => v.ham)).toEqual(['public.doc_khach']);
  });
});

describe('bản định nghĩa SAU đè bản trước', () => {
  it('vá ở migration sau ⇒ XANH', () => {
    const sql =
      dinhNghia('public.doc_luong', 'begin select * from salary_monthly; end') +
      cap('public.doc_luong') +
      dinhNghia('public.doc_luong', 'begin perform auth.uid(); select * from salary_monthly; end');
    expect(chay(sql).dat).toBe(true);
  });

  it('bản sau GỠ MẤT guard ⇒ ĐỎ trở lại', () => {
    // `create or replace` không reset ACL, nên quyền cũ vẫn còn — đúng cách
    // Postgres hành xử, và đúng án lệ 07/08/2026 (refactor tạo lại hàm làm lỗ
    // mở lại).
    const sql =
      dinhNghia('public.doc_luong', 'begin perform auth.uid(); select * from salary_monthly; end') +
      cap('public.doc_luong') +
      dinhNghia('public.doc_luong', 'begin select * from salary_monthly; end');
    expect(chay(sql).dat).toBe(false);
  });
});

describe('phép đo trên VẬT THẬT — bài canh lỗi backspace', () => {
  const sql = readFileSync('supabase/migrations/20260703000001_v5_foundation.sql', 'utf8');
  const suKien = docSuKien(sql).map((s) => ({ ...s, file: 'v5_foundation' }));

  it('dò được hàm get_salary_v5_config và biết nó là DEFINER', () => {
    const d = suKien.find((s) => s.loai === 'dinh-nghia' && s.ham === 'public.get_salary_v5_config');
    expect(d, 'không dò thấy hàm trong migration thật').toBeTruthy();
    expect(d.definer).toBe(true);
  });

  it('nhận ra thân hàm CHẠM salary_bonus_rules và KHÔNG có guard nào', () => {
    const kq = phanTichThanHam({ suKien });
    const v = kq.viPham.find((x) => x.ham === 'public.get_salary_v5_config');
    expect(v, 'gate không thấy lỗ có thật — nhiều khả năng phép khớp bảng hỏng').toBeTruthy();
    expect(v.bang).toContain('salary_bonus_rules');
  });
});

describe('hằng số không được rỗng', () => {
  it('danh sách bảng và primitive đều có nội dung', () => {
    expect(DANH_SACH_NHAY_CAM.length).toBeGreaterThan(20);
    expect(PRIMITIVE_PHAM_VI.length).toBeGreaterThan(4);
    expect(SAN_SO_HAM_DEFINER).toBeGreaterThan(100);
  });
});
