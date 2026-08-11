import { describe, expect, it } from 'vitest';
import {
  ownCashAccountId,
  resolveAccountIdForMethod,
  resolveTmAccountId,
  type BuildingAccountDefaults,
  type CashAccountLite,
} from '../cashAccount';

const TAM = '90450d5f-29b6-4897-bdef-cdb5fb53f339';
const JOEY = 'd45a7506-5250-4d99-ac94-9f73cbd4df17';
const NATHAN = 'df8d1df5-1c24-4723-9733-4640c43c382b';

// Dữ liệu giống thật: useAccounts trả về theo tên A→Z.
const ACCOUNTS: CashAccountLite[] = [
  { id: 'chung', name: 'Chung', user_id: TAM, is_default: false },
  { id: 'hien-thu', name: 'Hiển Thu', user_id: JOEY, is_default: false },
  { id: 'hiep-thu', name: 'Hiệp Thu', user_id: NATHAN, is_default: false },
  { id: 'huy-thu', name: 'Huy Thu', user_id: TAM, is_default: false },
  { id: 'tam-thu', name: 'Tâm Thu', user_id: TAM, is_default: false },
  { id: 'ag', name: 'AG708', user_id: TAM, is_default: false },
];

describe('ownCashAccountId', () => {
  it('user 1 sổ "…Thu" → lấy đúng sổ đó', () => {
    expect(ownCashAccountId(ACCOUNTS, JOEY)).toBe('hien-thu');
    expect(ownCashAccountId(ACCOUNTS, NATHAN)).toBe('hiep-thu');
  });

  it('user nhiều sổ "…Thu", chưa đánh dấu default → lấy sổ đầu (A→Z) = Huy Thu', () => {
    expect(ownCashAccountId(ACCOUNTS, TAM)).toBe('huy-thu');
  });

  it('đánh dấu is_default cho Tâm Thu → ưu tiên Tâm Thu dù đứng sau A→Z', () => {
    const accts = ACCOUNTS.map((a) => (a.id === 'tam-thu' ? { ...a, is_default: true } : a));
    expect(ownCashAccountId(accts, TAM)).toBe('tam-thu');
  });

  it('user không có sổ "…Thu" / userId rỗng → ""', () => {
    expect(ownCashAccountId(ACCOUNTS, 'unknown-user')).toBe('');
    expect(ownCashAccountId(ACCOUNTS, null)).toBe('');
  });
});

describe('resolveTmAccountId (own → Chung → tên toà)', () => {
  it('có sổ own → dùng sổ own', () => {
    expect(resolveTmAccountId(ACCOUNTS, JOEY, '102LVT')).toBe('hien-thu');
  });

  it('không own → rơi về "Chung"', () => {
    const noOwn = ACCOUNTS.filter((a) => a.user_id !== 'staff-x');
    expect(resolveTmAccountId(noOwn, 'staff-x', 'TòaA')).toBe('chung');
  });

  it('không own & không "Chung" → sổ trùng tên toà', () => {
    const accts: CashAccountLite[] = [{ id: 'b1', name: 'TòaA', user_id: 'owner', is_default: false }];
    expect(resolveTmAccountId(accts, 'staff-x', 'TòaA')).toBe('b1');
  });

  it('không resolve được → ""', () => {
    const accts: CashAccountLite[] = [{ id: 'x', name: 'Khác', user_id: 'o', is_default: false }];
    expect(resolveTmAccountId(accts, 'staff-x', 'TòaA')).toBe('');
  });
});

describe('resolveAccountIdForMethod (TM/TK/TT)', () => {
  const BLD = {
    name: '102LVT',
    default_account_id_tk: 'acc-tk',
    default_account_id_tt: 'acc-tt',
  };

  it('TM delegate resolveTmAccountId', () => {
    expect(resolveAccountIdForMethod('TM', ACCOUNTS, JOEY, BLD)).toBe('hien-thu');
  });

  it('TK/TT ưu tiên sổ mặc định của tòa', () => {
    expect(resolveAccountIdForMethod('TK', ACCOUNTS, JOEY, BLD)).toBe('acc-tk');
    expect(resolveAccountIdForMethod('TT', ACCOUNTS, JOEY, BLD)).toBe('acc-tt');
  });

  it('tòa thiếu sổ mặc định → fallback sổ trùng tên tòa', () => {
    const accts: CashAccountLite[] = [
      ...ACCOUNTS,
      { id: 'b-102', name: '102LVT', user_id: TAM, is_default: false },
    ];
    const bld: BuildingAccountDefaults = {
      name: '102LVT',
      default_account_id_tk: null,
      default_account_id_tt: null,
    };
    expect(resolveAccountIdForMethod('TK', accts, JOEY, bld)).toBe('b-102');
    expect(resolveAccountIdForMethod('TT', accts, JOEY, bld)).toBe('b-102');
  });

  it('không có gì để fallback → ""', () => {
    const bld: BuildingAccountDefaults = {
      name: 'TòaLạ',
      default_account_id_tk: null,
      default_account_id_tt: null,
    };
    expect(resolveAccountIdForMethod('TK', ACCOUNTS, JOEY, bld)).toBe('');
    expect(resolveAccountIdForMethod('TT', ACCOUNTS, JOEY, null)).toBe('');
  });
});
