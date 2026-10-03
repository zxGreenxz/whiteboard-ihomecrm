import { describe, expect, it } from 'vitest';
import {
  IMPORT_SYSTEM_ONLY_MESSAGE,
  groupIeTypesForPicker,
  ieTypeMatchesQuery,
  maintenanceIeTypeMissingMessage,
  pickMaintenanceIeType,
  resolveImportIeType,
} from '../ieTypeLookup';

type Row = {
  id: string;
  name: string;
  type: 'income' | 'expense';
  category?: string | null;
  archived_at?: string | null;
  merged_into_id?: string | null;
  system_only?: boolean;
  keywords?: string[] | null;
};

const row = (id: string, name: string, extra: Partial<Row> = {}): Row => ({ id, name, type: 'expense', ...extra });

describe('ô tìm hạng mục', () => {
  it('khớp tên bỏ dấu và cả cụm từ hay nói', () => {
    const dienLanh = row('t1', 'Điện lạnh', { keywords: ['bơm gas', 'xả giàn'] });
    expect(ieTypeMatchesQuery(dienLanh, 'dien')).toBe(true);
    expect(ieTypeMatchesQuery(dienLanh, 'BOM GAS')).toBe(true);
    expect(ieTypeMatchesQuery(dienLanh, 'xa gian')).toBe(true);
    expect(ieTypeMatchesQuery(dienLanh, 'thang máy')).toBe(false);
    // Môi trường chưa áp migration: keywords vắng ⇒ chỉ khớp tên.
    expect(ieTypeMatchesQuery({ name: 'Tiền rác' }, 'rac')).toBe(true);
    expect(ieTypeMatchesQuery({ name: 'Tiền rác' }, '')).toBe(true);
  });

  it('gom nhóm theo thứ tự đã xếp, mục chưa có nhóm xuống "Khác" cuối cùng', () => {
    const groups = groupIeTypesForPicker([
      row('a', 'A', { category: null }),
      row('b', 'B', { category: 'Cố định hằng tháng' }),
      row('c', 'C', { category: 'Sửa chữa – bảo trì' }),
      row('d', 'D', { category: 'Cố định hằng tháng' }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Cố định hằng tháng', 'Sửa chữa – bảo trì', 'Khác']);
    expect(groups[0]?.items.map((t) => t.id)).toEqual(['b', 'd']);
    expect(groups[2]?.items.map((t) => t.id)).toEqual(['a']);
  });
});

describe('nhập Excel giải tên hạng mục', () => {
  const dienLanh = row('dl', 'Điện lạnh');
  const suaMayLanh = row('old', 'Sửa Máy Lạnh', { archived_at: '2026-10-03T00:00:00Z', merged_into_id: 'dl' });
  const boHan = row('cu', 'Mục cũ', { archived_at: '2026-10-03T00:00:00Z' });
  const hoaHong = row('hh', 'Hoa hồng môi giới', { system_only: true });
  const thuHeThong = row('tc', 'Thu tiền cọc', { type: 'income', system_only: true });
  const rows = [dienLanh, suaMayLanh, boHan, hoaHong, thuHeThong];

  it('mục đã lưu trữ có gộp ⇒ dùng mục đích', () => {
    const r = resolveImportIeType(rows, 'sửa máy lạnh', 'expense');
    expect(r).toEqual({ ok: true, type: dienLanh });
  });

  it('mục CHI hệ thống ⇒ lỗi dòng, không nhập', () => {
    const r = resolveImportIeType(rows, 'Hoa hồng môi giới', 'expense');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(IMPORT_SYSTEM_ONLY_MESSAGE);
  });

  it('mục THU hệ thống vẫn nhập như cũ (máy chủ chỉ chặn chiều chi)', () => {
    expect(resolveImportIeType(rows, 'Thu tiền cọc', 'income')).toEqual({ ok: true, type: thuHeThong });
  });

  it('mục lưu trữ không có đích gộp ⇒ lỗi; không có tên ⇒ lỗi như cũ', () => {
    const archived = resolveImportIeType(rows, 'Mục cũ', 'expense');
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.message).toContain('đã lưu trữ');
    expect(resolveImportIeType(rows, 'Không có', 'expense')).toEqual({
      ok: false,
      message: 'Không tìm thấy hạng mục "Không có" (loại expense)',
    });
  });

  it('đích gộp bị lưu trữ hoặc thiếu ⇒ lỗi, không đoán', () => {
    const chain = [
      row('x', 'X', { archived_at: '2026-10-03', merged_into_id: 'y' }),
      row('y', 'Y', { archived_at: '2026-10-03' }),
    ];
    expect(resolveImportIeType(chain, 'X', 'expense').ok).toBe(false);
    expect(resolveImportIeType([row('z', 'Z', { archived_at: '2026-10-03', merged_into_id: 'missing' })], 'Z', 'expense').ok).toBe(false);
  });

  it('trùng tên: ưu tiên mục đang dùng', () => {
    const active = row('new', 'Internet');
    const old = row('old2', 'internet', { archived_at: '2026-10-03', merged_into_id: 'other' });
    expect(resolveImportIeType([old, active], 'INTERNET', 'expense')).toEqual({ ok: true, type: active });
  });
});

describe('công cụ phí bảo trì chọn hạng mục có sẵn', () => {
  it('ưu tiên đúng tên "vệ sinh máy lạnh" dù có mục khác chứa "máy lạnh"', () => {
    const rows = [
      row('sua', 'Sửa máy lạnh 2'),
      row('vs', 'vệ sinh máy lạnh'),
    ];
    expect(pickMaintenanceIeType(rows, 'ml')?.id).toBe('vs');
  });

  it('bỏ qua mục đã lưu trữ, kể cả đúng tên', () => {
    const rows = [
      row('vs', 'Vệ sinh máy giặt', { archived_at: '2026-10-03' }),
      row('lap', 'Lắp Máy Giặt', { archived_at: '2026-10-03' }),
      row('bt', 'Bảo trì  máy giặt'),
    ];
    expect(pickMaintenanceIeType(rows, 'mg')?.id).toBe('bt');
    expect(pickMaintenanceIeType(rows.slice(0, 2), 'mg')).toBeNull();
  });

  it('không có mục đúng tên ⇒ khớp chứa "máy lạnh" như cũ; không có gì ⇒ null', () => {
    expect(pickMaintenanceIeType([row('k', 'Kiểm tra máy lạnh')], 'ml')?.id).toBe('k');
    expect(pickMaintenanceIeType([row('d', 'Điện lạnh')], 'ml')).toBeNull();
    expect(maintenanceIeTypeMissingMessage('ml')).toContain('chủ công ty');
  });
});
