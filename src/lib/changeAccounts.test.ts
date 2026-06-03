import { describe, expect, it } from 'vitest';
import {
  JOEY_USER_ID,
  NATHAN_USER_ID,
  changeAccountOptions,
  findOwnChangeAccount,
  ownChangeAccountName,
} from './changeAccounts';

// Danh sách sổ giống dữ liệu thật: 2 sổ Thối + vài sổ khác (ngầm thứ tự tên,
// "Hiển Thối" đứng trước "Hiệp Thối" như Postgres trả về).
const ACCOUNTS = [
  { id: 'b1', name: 'AG708' },
  { id: 'hc', name: 'Hiển Chi' },
  { id: 'hien-thoi', name: 'Hiển Thối' },
  { id: 'ht', name: 'Hiển Thu' },
  { id: 'hiep-thoi', name: 'Hiệp Thối' },
  { id: 'het', name: 'Hiệp Thu' },
];

const SUPER_ADMIN_ID = '90450d5f-29b6-4897-bdef-cdb5fb53f339';

describe('ownChangeAccountName', () => {
  it('map đúng Hiển/Hiệp theo user id', () => {
    expect(ownChangeAccountName(JOEY_USER_ID)).toBe('Hiển Thối');
    expect(ownChangeAccountName(NATHAN_USER_ID)).toBe('Hiệp Thối');
  });

  it('trả null cho user ngoài map / null / undefined', () => {
    expect(ownChangeAccountName(SUPER_ADMIN_ID)).toBeNull();
    expect(ownChangeAccountName(null)).toBeNull();
    expect(ownChangeAccountName(undefined)).toBeNull();
  });
});

describe('changeAccountOptions', () => {
  it('Nathan chỉ thấy Hiệp Thối', () => {
    expect(changeAccountOptions(ACCOUNTS, NATHAN_USER_ID)).toEqual([
      { id: 'hiep-thoi', name: 'Hiệp Thối' },
    ]);
  });

  it('Joey chỉ thấy Hiển Thối', () => {
    expect(changeAccountOptions(ACCOUNTS, JOEY_USER_ID)).toEqual([
      { id: 'hien-thoi', name: 'Hiển Thối' },
    ]);
  });

  it('super-admin / user ngoài map giữ nguyên toàn bộ danh sách', () => {
    expect(changeAccountOptions(ACCOUNTS, SUPER_ADMIN_ID)).toBe(ACCOUNTS);
    expect(changeAccountOptions(ACCOUNTS, null)).toBe(ACCOUNTS);
  });
});

describe('findOwnChangeAccount', () => {
  it('Nathan → Hiệp Thối, Joey → Hiển Thối', () => {
    expect(findOwnChangeAccount(ACCOUNTS, NATHAN_USER_ID)?.id).toBe('hiep-thoi');
    expect(findOwnChangeAccount(ACCOUNTS, JOEY_USER_ID)?.id).toBe('hien-thoi');
  });

  it('user ngoài map → sổ "Thối" đầu tiên (giữ hành vi cũ)', () => {
    expect(findOwnChangeAccount(ACCOUNTS, SUPER_ADMIN_ID)?.id).toBe('hien-thoi');
    expect(findOwnChangeAccount(ACCOUNTS, null)?.id).toBe('hien-thoi');
  });

  it('không có sổ Thối nào → undefined', () => {
    const noThoi = [{ id: 'x', name: 'AG708' }];
    expect(findOwnChangeAccount(noThoi, SUPER_ADMIN_ID)).toBeUndefined();
  });
});
