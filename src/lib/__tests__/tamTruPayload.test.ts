import { describe, expect, it } from 'vitest';
import {
  buildTamTruPayload, genderCode, normalizeProvinceName, splitBuildingAddress, tempResidentTo, TamTruInputError,
  type TamTruAttachment,
} from '../tamTruPayload';

const customer = {
  id: 'c1', full_name: ' Nguyễn Gia Bình ', date_of_birth: '2008-10-18', gender: 'Nam',
  id_number: '034208012538', phone: '0843181008', email: '',
};
const building = {
  name: '950NK', street_address: '950/65 Nguyễn Kiệm, Khu Phố 14 , Phường Hạnh Thông, TP Hồ Chí Minh',
  province: 'Thành phố Hồ Chí Minh',
};
const att: TamTruAttachment[] = [
  { kind: 'OWNERSHIP', fileName: 'c.webp', contentType: 'image/webp', url: 'https://s/3' },
  { kind: 'CT01', fileName: 'a.webp', contentType: 'image/webp', url: 'https://s/1' },
  { kind: 'LEASE', fileName: 'b.webp', contentType: 'image/webp', url: 'https://s/2' },
];

describe('normalizeProvinceName', () => {
  it('quy về tên đầy đủ cho các cách viết TP.HCM', () => {
    for (const raw of ['Hồ Chí Minh', 'TP Hồ Chí Minh', 'TP. Hồ Chí Minh', 'Thành phố Hồ Chí Minh', 'thành phố hồ chí minh']) {
      expect(normalizeProvinceName(raw)).toBe('Thành phố Hồ Chí Minh');
    }
  });
  it('tỉnh thường thêm tiền tố Tỉnh', () => {
    expect(normalizeProvinceName('Đồng Nai')).toBe('Tỉnh Đồng Nai');
    expect(normalizeProvinceName('Tỉnh Đồng Nai')).toBe('Tỉnh Đồng Nai');
  });
});

describe('splitBuildingAddress', () => {
  it('tách phường mới và phần địa chỉ đứng trước', () => {
    expect(splitBuildingAddress(building.street_address)).toEqual({ address: '950/65 Nguyễn Kiệm, Khu Phố 14', wardName: 'Phường Hạnh Thông' });
  });
  it('không có phường thì wardName null', () => {
    expect(splitBuildingAddress('1392 Quang Trung')).toEqual({ address: '1392 Quang Trung', wardName: null });
  });
  it('nhận Xã, Thị trấn, Đặc khu', () => {
    expect(splitBuildingAddress('Ấp 3, Xã Bình Mỹ, TP Hồ Chí Minh').wardName).toBe('Xã Bình Mỹ');
    expect(splitBuildingAddress('12 Trần Phú, Đặc khu Phú Quốc').wardName).toBe('Đặc khu Phú Quốc');
  });
});

describe('genderCode', () => {
  it.each([
    ['Nam', '2'], ['MALE', '2'], ['Nữ', '3'], ['FEMALE', '3'], ['Khác', '4'], ['OTHER', '4'], ['', null], [null, null],
  ])('%s → %s', (raw, code) => {
    expect(genderCode(raw)).toBe(code);
  });
});

describe('tempResidentTo', () => {
  it('cộng 24 tháng theo giờ Việt Nam', () => {
    expect(tempResidentTo(new Date('2026-09-15T02:00:00Z'), 24)).toBe('15/09/2028');
  });
  it('cộng 12 tháng qua mốc ngày UTC/VN', () => {
    // 17:30 UTC = 00:30 hôm sau giờ Việt Nam.
    expect(tempResidentTo(new Date('2026-09-15T17:30:00Z'), 12)).toBe('16/09/2027');
  });
  it('kẹp 29/02', () => {
    expect(tempResidentTo(new Date('2028-02-29T05:00:00Z'), 12)).toBe('28/02/2029');
  });
});

describe('buildTamTruPayload', () => {
  it('dựng gói đúng từ dữ liệu CRM', () => {
    const p = buildTamTruPayload({ customer, building, roomNumber: 'MADRID 4', durationMonths: 24, attachments: att, now: new Date('2026-09-15T02:00:00Z') });
    expect(p.version).toBe(1);
    expect(p.receive).toEqual({ provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Hạnh Thông' });
    expect(p.person).toEqual({ fullName: 'Nguyễn Gia Bình', dob: '18/10/2008', genderCode: '2', idNumber: '034208012538', phone: '0843181008', email: '' });
    expect(p.address).toBe('950/65 Nguyễn Kiệm, Khu Phố 14');
    expect(p.household).toEqual({ relationshipCode: 'CH01' });
    expect(p.tempResidentTo).toBe('15/09/2028');
    expect(p.attachments.map(a => a.kind)).toEqual(['CT01', 'LEASE', 'OWNERSHIP']);
    expect(p.buildingName).toBe('950NK');
    expect(p.roomNumber).toBe('MADRID 4');
  });

  it.each([
    ['CCCD sai', { ...customer, id_number: '12345' }, building, att, /CCCD/],
    ['thiếu ngày sinh', { ...customer, date_of_birth: null }, building, att, /ngày sinh/i],
    ['thiếu giới tính', { ...customer, gender: null }, building, att, /giới tính/i],
    ['giới tính lạ', { ...customer, gender: 'x' }, building, att, /giới tính/i],
    ['toà thiếu địa chỉ', customer, { ...building, street_address: null }, att, /địa chỉ chi tiết/i],
    ['toà thiếu phường', customer, { ...building, street_address: '1392 Quang Trung' }, att, /phường/i],
    ['toà chỉ có phường', customer, { ...building, street_address: 'Phường Hạnh Thông, TP HCM' }, att, /số nhà/i],
    ['thiếu ảnh chủ quyền', customer, building, att.filter(a => a.kind !== 'OWNERSHIP'), /chỗ ở hợp pháp/i],
    ['thiếu ảnh CT01', customer, building, att.filter(a => a.kind !== 'CT01'), /CT01/],
    ['thiếu ảnh hợp đồng', customer, building, att.filter(a => a.kind !== 'LEASE'), /hợp đồng/i],
  ])('báo lỗi rõ khi %s', (_name, c, b, a, re) => {
    const run = () => buildTamTruPayload({ customer: c, building: b, roomNumber: 'P1', durationMonths: 24, attachments: a });
    expect(run).toThrowError(re);
    expect(run).toThrow(TamTruInputError);
  });
});
