import { describe, expect, it } from 'vitest';
import { appendSupplementInputSchema, formatSupplementAuthor, getVoucherDisplayAttachments, supplementFormSchema, supplementErrorMessage,
  type IncomeExpenseSupplement } from '../incomeExpenseSupplement';

const supplement = { id: 'one', note: '[THU TACH COC demo]\nMô tả nguyên văn', attachments: ['proof-old', 'proof-new'],
  actor_name: 'Kế toán DEMO', created_at: '2026-09-10T04:30:00Z' } as IncomeExpenseSupplement;

describe('supplement presentation without mutating financial input', () => {
  it('combines evidence in order without replacing original arrays or machine notes', () => {
    const voucher = Object.freeze({ notes: '[THU TACH COC demo]', attachments: ['proof-old'], supplements: [supplement] });
    expect(getVoucherDisplayAttachments(voucher)).toEqual(['proof-old', 'proof-new']);
    expect(voucher.attachments).toEqual(['proof-old']);
    expect(voucher.notes).toBe('[THU TACH COC demo]');
    expect(supplement.note).toBe('[THU TACH COC demo]\nMô tả nguyên văn');
  });
  it('accepts independent note or photo additions and rejects an empty save', () => {
    expect(supplementFormSchema.safeParse({ note: supplement.note, attachments: [] }).success).toBe(true);
    expect(supplementFormSchema.safeParse({ note: '', attachments: ['https://proof.test/new.png'] }).success).toBe(true);
    expect(supplementFormSchema.safeParse({ note: ' \n', attachments: [] }).success).toBe(false);
  });
  it('rejects missing retry identity and invalid voucher before making a request', () => {
    const input = { voucherId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'retry', note: 'Bổ sung', attachments: [] };
    expect(appendSupplementInputSchema.safeParse(input).success).toBe(true);
    expect(appendSupplementInputSchema.safeParse({ ...input, idempotencyKey: ' ' }).success).toBe(false);
    expect(appendSupplementInputSchema.safeParse({ ...input, voucherId: 'invalid' }).success).toBe(false);
  });
  it('stamps display with the stored actor and local time, preserving multiline text separately', () => {
    expect(formatSupplementAuthor(supplement)).toContain('Người bổ sung: Kế toán DEMO');
    expect(formatSupplementAuthor(supplement)).toContain('11:30');
    expect(formatSupplementAuthor(supplement)).toContain('10/09/2026');
  });
  it('distinguishes permission, validation, and replay conflicts without surfacing database internals', () => {
    const permission = supplementErrorMessage({ code: '42501', message: 'private table secret' });
    expect(permission).toContain('không có quyền'); expect(permission).not.toContain('secret');
    expect(supplementErrorMessage({ code: '22023' })).toContain('không hợp lệ');
    expect(supplementErrorMessage({ code: '23505' })).toContain('nội dung khác');
  });
});
