import { describe, it, expect } from 'vitest';
import { parseCccdQr } from '../cccdQrParser';

describe('parseCccdQr', () => {
  it('parse được payload chuẩn 7 trường', () => {
    const raw =
      '094095000036|025237827|Trần Bảo Hiệp|10021995|Nam|78H/2, KP3, P.Hiệp Thành, Quận 12, TP.Hồ Chí Minh|13032022';
    const data = parseCccdQr(raw);
    expect(data).not.toBeNull();
    expect(data!.idNumber).toBe('094095000036');
    expect(data!.fullName).toBe('Trần Bảo Hiệp');
    expect(data!.dateOfBirth).toBe('1995-02-10');
    expect(data!.gender).toBe('Nam');
    expect(data!.permanentAddress).toBe(
      '78H/2, KP3, P.Hiệp Thành, Quận 12, TP.Hồ Chí Minh'
    );
    expect(data!.idIssueDate).toBe('2022-03-13');
    expect(data!.idIssuePlace).toBe('Cục Cảnh Sát');
  });

  it('normalize "Male" → "Nam", "Female" → "Nữ"', () => {
    expect(parseCccdQr('1|2|A|01012000|Male|x|01012020')!.gender).toBe('Nam');
    expect(parseCccdQr('1|2|A|01012000|Female|x|01012020')!.gender).toBe('Nữ');
    expect(parseCccdQr('1|2|A|01012000|Nữ|x|01012020')!.gender).toBe('Nữ');
  });

  it('trả null nếu input rỗng', () => {
    expect(parseCccdQr('')).toBeNull();
    expect(parseCccdQr('   ')).toBeNull();
    expect(parseCccdQr(null)).toBeNull();
    expect(parseCccdQr(undefined)).toBeNull();
  });

  it('ném lỗi nếu thiếu trường', () => {
    expect(() => parseCccdQr('only|three|fields')).toThrow();
  });

  it('ngày không hợp lệ trả về chuỗi rỗng (không ném lỗi)', () => {
    const d = parseCccdQr('1|2|A|99999999|Nam|x|01012020');
    expect(d!.dateOfBirth).toBe('');
    expect(d!.idIssueDate).toBe('2020-01-01');
  });

  it('ngày sinh ngày 31 tháng 12', () => {
    expect(parseCccdQr('1|2|A|31121999|Nam|x|01012020')!.dateOfBirth).toBe(
      '1999-12-31'
    );
  });
});
