import { describe, expect, it } from 'vitest';
import {
  bindCccdScanResult,
  isCurrentCccdScan,
  mapCccdToCustomerFields,
} from '../cccdCustomerMapping';

const qr = {
  idNumber: '001234567890',
  fullName: 'Nguyễn Minh An',
  dateOfBirth: '1994-03-02',
  gender: 'Nữ',
  permanentAddress: '12 Đường Mẫu, Phường Thử, Thành phố Ví Dụ',
  idIssueDate: '2022-05-06',
  idIssuePlace: 'Cục Cảnh Sát',
} as const;

describe('mapCccdToCustomerFields', () => {
  it('maps QR fields for the contract dialog without losing a leading zero', () => {
    expect(mapCccdToCustomerFields(qr, 'database')).toEqual({
      full_name: 'Nguyễn Minh An',
      id_number: '001234567890',
      date_of_birth: '1994-03-02',
      gender: 'FEMALE',
      id_type: 'CCCD',
      id_issue_date: '2022-05-06',
      id_issue_place: 'Cục Cảnh Sát',
      detailed_address: '12 Đường Mẫu, Phường Thử, Thành phố Ví Dụ',
      permanent_address: '12 Đường Mẫu, Phường Thử, Thành phố Ví Dụ',
    });
  });

  it('keeps the Vietnamese gender representation used by CustomerForm', () => {
    expect(mapCccdToCustomerFields(qr, 'display').gender).toBe('Nữ');
    expect(mapCccdToCustomerFields({ ...qr, gender: 'Không rõ' }, 'display').gender).toBe('Khác');
  });

  it('applies OCR authority and full original address without inventing a date', () => {
    expect(mapCccdToCustomerFields({
      idNumber: '009876543210',
      fullName: 'Trần Minh Bình',
      dateOfBirth: '',
      gender: 'Nam',
      permanentAddress: 'Thôn Mẫu, Xã Thử, Tỉnh Ví Dụ',
      idIssueDate: '',
      idIssuePlace: 'Bất kỳ',
      source: 'ocr',
    }, 'database')).toEqual({
      full_name: 'Trần Minh Bình',
      id_number: '009876543210',
      gender: 'MALE',
      id_type: 'CCCD',
      id_issue_place: 'Cục Cảnh sát',
      detailed_address: 'Thôn Mẫu, Xã Thử, Tỉnh Ví Dụ',
      permanent_address: 'Thôn Mẫu, Xã Thử, Tỉnh Ví Dụ',
    });
  });

  it('does not emit empty OCR fields that would clear manual input', () => {
    expect(mapCccdToCustomerFields({
      idNumber: '',
      fullName: '',
      dateOfBirth: '',
      gender: '',
      permanentAddress: '',
      idIssueDate: '',
      idIssuePlace: '',
      source: 'ocr',
    }, 'display')).toEqual({ id_type: 'CCCD', id_issue_place: 'Cục Cảnh sát' });
  });
});

describe('bindCccdScanResult', () => {
  it('keeps an old mounted scanner callback expired after a type roundtrip', () => {
    const applied: string[] = [];
    const context = { generation: 4, active: true, customerType: 'INDIVIDUAL' as const };
    const oldCallback = bindCccdScanResult<string>(4, () => context, value => { applied.push(value); });
    Object.assign(context, { generation: 5, customerType: 'ORGANIZATION' });
    Object.assign(context, { generation: 6, customerType: 'INDIVIDUAL' });
    oldCallback('stale');
    expect(applied).toEqual([]);
  });

  it('keeps an old mounted scanner callback expired after close and reopen', () => {
    const applied: string[] = [];
    const context = { generation: 8, active: true, customerType: 'INDIVIDUAL' as const };
    const oldCallback = bindCccdScanResult<string>(8, () => context, value => { applied.push(value); });
    Object.assign(context, { generation: 10 });
    oldCallback('stale');
    expect(applied).toEqual([]);
  });
});

describe('isCurrentCccdScan', () => {
  it('rejects results after close/reopen or a switch to organization', () => {
    expect(isCurrentCccdScan(2, 3, true, 'INDIVIDUAL')).toBe(false);
    expect(isCurrentCccdScan(3, 3, true, 'ORGANIZATION')).toBe(false);
    expect(isCurrentCccdScan(3, 3, false, 'INDIVIDUAL')).toBe(false);
    expect(isCurrentCccdScan(3, 3, true, 'INDIVIDUAL')).toBe(true);
  });
});
