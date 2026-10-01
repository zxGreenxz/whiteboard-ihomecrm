import { expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { receivingCashbooksSchema } from '../useReceivingCashbooks';

const payload = (isDefault: unknown) => ({ collectorUserId: 'u1', personalCashBook: null, TK: [{ id: 'a', name: 'TK phụ', isDefault }], TT: [] });

// `a.id = v_default_tk` với v_default_tk NULL ra null: toà chưa chọn sổ mặc định nhưng có sổ phụ.
it('sổ phụ của toà chưa có sổ mặc định (isDefault null) không làm hỏng màn thu tiền', () => {
  expect(receivingCashbooksSchema.parse(payload(null)).TK[0].isDefault).toBeUndefined();
});
it('giữ đúng sổ mặc định đã chọn', () => {
  expect(receivingCashbooksSchema.parse(payload(true)).TK[0].isDefault).toBe(true);
  expect(receivingCashbooksSchema.parse(payload(false)).TK[0].isDefault).toBe(false);
});
it('giá trị sai kiểu vẫn bị từ chối', () => {
  expect(() => receivingCashbooksSchema.parse(payload('yes'))).toThrow();
});
