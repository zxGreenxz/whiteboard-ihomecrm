import { describe, it, expect } from 'vitest';
import {
  validatePostFinanceExecutionInput,
  isValidIsoDate,
  parseIsoDate,
  isUuid,
  type PostFinanceExecutionInput,
} from '../incomeExpensePostingValidation';

// UUID hợp lệ tối thiểu cho các trường id.
const SUBJECT_ID = '11111111-1111-1111-1111-111111111111';
const CASHBOOK_ID = '22222222-2222-2222-2222-222222222222';

/** Base: phiếu VOUCHER hợp lệ, manual (yêu cầu chứng từ). */
function validVoucher(
  over: Partial<PostFinanceExecutionInput> = {},
): PostFinanceExecutionInput {
  return {
    subjectKind: 'VOUCHER',
    subjectId: SUBJECT_ID,
    cashbookId: CASHBOOK_ID,
    postedOn: '2026-07-22',
    evidenceIds: ['evidence-1'],
    expectedExecutionRevision: 0,
    expectedApprovalVersion: 1,
    expectedPostingVersion: 1,
    idempotencyKey: 'idem-key-abc',
    ...over,
  };
}

/** Base: MULTI_TRANCHE salary authorization. */
function validSalary(
  over: Partial<PostFinanceExecutionInput> = {},
): PostFinanceExecutionInput {
  return {
    subjectKind: 'SALARY_AUTHORIZATION',
    subjectId: SUBJECT_ID,
    cashbookId: CASHBOOK_ID,
    postedOn: '2026-07-22',
    evidenceIds: ['evidence-1'],
    amount: 500_000,
    expectedExecutionRevision: 0,
    expectedApprovalVersion: 1,
    expectedPostingVersion: 1,
    idempotencyKey: 'idem-key-salary',
    ...over,
  };
}

describe('helpers thuần', () => {
  it('parseIsoDate: nhận ngày lịch hợp lệ, loại ngày tràn/sai định dạng', () => {
    expect(parseIsoDate('2026-07-22')).toBeInstanceOf(Date);
    expect(parseIsoDate('2026-02-29')).toBeNull(); // 2026 không nhuận
    expect(parseIsoDate('2024-02-29')).toBeInstanceOf(Date); // 2024 nhuận
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-7-2')).toBeNull(); // thiếu zero-pad
    expect(parseIsoDate('22/07/2026')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });

  it('isValidIsoDate phản ánh parseIsoDate', () => {
    expect(isValidIsoDate('2026-07-22')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
  });

  it('isUuid: chấp uuid, từ chối chuỗi thường', () => {
    expect(isUuid(SUBJECT_ID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('validatePostFinanceExecutionInput — trường bắt buộc', () => {
  it('input VOUCHER hợp lệ → ok, không lỗi', () => {
    const r = validatePostFinanceExecutionInput(validVoucher());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('thiếu ngày → lỗi postedOn', () => {
    const r = validatePostFinanceExecutionInput(validVoucher({ postedOn: '' }));
    expect(r.ok).toBe(false);
    expect(r.errors.postedOn).toBeTruthy();
  });

  it('ngày sai định dạng → lỗi postedOn', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ postedOn: '2026-02-30' }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.postedOn).toBeTruthy();
  });

  it('thiếu sổ quỹ → lỗi cashbookId', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ cashbookId: '' }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.cashbookId).toBeTruthy();
  });

  it('sổ quỹ không phải uuid → lỗi cashbookId', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ cashbookId: 'so-quy-1' }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.cashbookId).toBeTruthy();
  });

  it('manual: thiếu chứng từ (mảng rỗng) → lỗi evidenceIds', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ evidenceIds: [] }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.evidenceIds).toBeTruthy();
  });

  it('manual: chứng từ toàn chuỗi rỗng vẫn tính là thiếu', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ evidenceIds: ['', '   '] }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.evidenceIds).toBeTruthy();
  });

  it('system reference (requireEvidence=false): mảng rỗng vẫn hợp lệ', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ evidenceIds: [] }),
      { requireEvidence: false },
    );
    expect(r.ok).toBe(true);
  });

  it('thiếu idempotency key → lỗi idempotencyKey', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ idempotencyKey: '' }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.idempotencyKey).toBeTruthy();
  });

  it('version sai (không phải số nguyên không âm) → lỗi tương ứng', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ expectedPostingVersion: -1 }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.expectedPostingVersion).toBeTruthy();
  });
});

describe('validatePostFinanceExecutionInput — amount theo subjectKind', () => {
  it('VOUCHER: gửi amount bị TẪ CHỐI (read-only = tổng đã duyệt)', () => {
    const r = validatePostFinanceExecutionInput(
      validVoucher({ amount: 1_000_000 }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.amount).toBeTruthy();
  });

  it('VOUCHER: không gửi amount → hợp lệ', () => {
    const r = validatePostFinanceExecutionInput(validVoucher());
    expect(r.ok).toBe(true);
    expect(r.errors.amount).toBeUndefined();
  });

  it('MULTI_TRANCHE: amount trong hạn mức → ok', () => {
    const r = validatePostFinanceExecutionInput(
      validSalary({ amount: 500_000 }),
      { remainingAmount: 800_000 },
    );
    expect(r.ok).toBe(true);
  });

  it('MULTI_TRANCHE: amount = đúng remaining (biên) → ok', () => {
    const r = validatePostFinanceExecutionInput(
      validSalary({ amount: 800_000 }),
      { remainingAmount: 800_000 },
    );
    expect(r.ok).toBe(true);
  });

  it('MULTI_TRANCHE: amount > remaining → lỗi amount', () => {
    const r = validatePostFinanceExecutionInput(
      validSalary({ amount: 800_001 }),
      { remainingAmount: 800_000 },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.amount).toBeTruthy();
  });

  it('MULTI_TRANCHE: amount = 0 → lỗi amount (phải > 0)', () => {
    const r = validatePostFinanceExecutionInput(validSalary({ amount: 0 }), {
      remainingAmount: 800_000,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.amount).toBeTruthy();
  });

  it('MULTI_TRANCHE: amount âm → lỗi amount', () => {
    const r = validatePostFinanceExecutionInput(
      validSalary({ amount: -100 }),
      { remainingAmount: 800_000 },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.amount).toBeTruthy();
  });

  it('MULTI_TRANCHE: thiếu amount → lỗi amount', () => {
    const r = validatePostFinanceExecutionInput(
      validSalary({ amount: undefined }),
      { remainingAmount: 800_000 },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.amount).toBeTruthy();
  });

  it('MULTI_TRANCHE: thiếu remaining context → lỗi amount (không đủ dữ liệu)', () => {
    const r = validatePostFinanceExecutionInput(validSalary({ amount: 500_000 }));
    expect(r.ok).toBe(false);
    expect(r.errors.amount).toBeTruthy();
  });
});
