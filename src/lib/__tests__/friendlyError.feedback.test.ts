import { describe, expect, it } from 'vitest';
import { friendlyError } from '../friendlyError';

describe('safe operation feedback', () => {
  it.each([500,502,503,504])('treats HTTP %s without transport words as an unconfirmed result', status => {
    const result = friendlyError({status,message:'Internal Server Error'}, 'Chưa thu tiền', {operation:'thu tiền',financial:true});
    expect(result.outcome).toBe('unknown');
    expect(result.recovery).toBe('reconcile');
  });
  it('retains nested code and cause without exposing a SQL payload', () => {
    const cause = { error: { code: '23505', message: 'duplicate key violates constraint secret_index', details: 'Key (id)=(secret)' } };
    const result = friendlyError(cause, 'Chưa lưu được khách hàng', { operation: 'lưu khách hàng' });
    expect(result.code).toBe('23505');
    expect(result.cause).toBe(cause);
    expect(result.description).not.toMatch(/secret|constraint/);
    expect(result.fieldErrors).toEqual({});
  });
  it('does not invent a deployment/version explanation from a database system code', () => {
    const result = friendlyError({ code: '42883', message: 'function secret_func does not exist' }, 'Chưa lưu được hợp đồng');
    expect(result.description).not.toMatch(/cập nhật|phiên bản|secret_func/);
    expect(result.description).toMatch(/hệ thống/);
  });
  it('does not guess a field from SQLSTATE alone', () => {
    expect(friendlyError({ code: '22023', message: 'unknown constraint' }).fieldErrors).toEqual({});
  });
  it('does not pass unrecognized Vietnamese technical text through permission/state errors', () => {
    for (const code of ['42501', '55000']) {
      const result = friendlyError({ code, message: 'Không ghi được bảng secret_table: SELECT * FROM users' });
      expect(result.description).not.toMatch(/secret_table|SELECT/);
    }
  });
  it('keeps a money timeout uncertain and asks for reconciliation, never a new submission', () => {
    const result = friendlyError(new Error('Failed to fetch'), 'Chưa thu được tiền', { operation: 'thu tiền hóa đơn', financial: true });
    expect(result.outcome).toBe('unknown');
    expect(result.title).toContain('Chưa xác nhận được kết quả');
    expect(result.description).not.toMatch(/thử lại|tạo lại/);
    expect(result.recovery).toBe('reconcile');
  });
  it('classifies expired sessions before generic access errors', () => {
    const result = friendlyError({ code: 'PGRST301', status: 401, message: 'JWT expired' });
    expect(result.description).toContain('Đăng nhập lại');
    expect(result.recovery).toBe('sign-in');
  });
});
