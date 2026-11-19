import { describe, expect, it, vi } from 'vitest';
import { AdjustmentBuildError, adjustmentBlockerMessage, fetchAdjustmentBuild, keptItemsById, type AdjustmentBuild } from '@/lib/invoiceAdjustmentBuildRpc';

const ID = 'dddd0000-0000-4000-8000-000000000101';
const LINE = 'dddd0000-0000-4000-8000-000000000111';
const line = { id: LINE, service_id: null, type: 'OTHER', accounting_class: 'REVENUE', description: 'Phí gửi xe máy', unit_price: 125000, quantity: 1,
  coefficient: 1, previous_reading: null, current_reading: null, from_date: null, to_date: null, sort_order: 4 };
const payload = (extra: Record<string, unknown> = {}) => ({ invoiceId: ID, kind: 'MONTHLY', blockers: [],
  before: { items: [line], lines: [], subtotal: 125000, previousDebt: 0, sourcedDebt: 0 }, after: {}, ...extra });

describe('fetchAdjustmentBuild (hàm dùng chung invoice_adjustment_build_v1)', () => {
  it('gọi đúng tên + tham số (thao tác rỗng) và trả dòng giữ nguyên theo id', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: payload(), error: null });
    const build = await fetchAdjustmentBuild(invoke, ID);
    expect(invoke).toHaveBeenCalledWith('invoice_adjustment_build_v1', { p_invoice_id: ID, p_ops: {} });
    expect(keptItemsById(build).get(LINE)).toEqual(line);
    expect(adjustmentBlockerMessage(build)).toBeNull();
  });

  it('lỗi RPC (vd hàm chưa áp: PGRST202), khuôn lạ hay hoá đơn khác ⇒ AdjustmentBuildError, không lưu được', async () => {
    for (const response of [{ data: null, error: { code: 'PGRST202', message: 'not found' } }, { data: { invoiceId: ID }, error: null },
      { data: payload({ invoiceId: LINE }), error: null }, { data: payload({ before: { items: [{ ...line, type: 'LẠ' }], previousDebt: 0, sourcedDebt: 0 } }), error: null }]) {
      await expect(fetchAdjustmentBuild(vi.fn().mockResolvedValue(response), ID)).rejects.toBeInstanceOf(AdjustmentBuildError);
    }
  });
});

describe('adjustmentBlockerMessage: cùng câu với bản tính ở trình duyệt trước Mốc 5', () => {
  const build = (blockers: string[], previousDebt = 0, sourcedDebt = 0) => ({ ...payload({ blockers }),
    before: { items: [line], previousDebt, sourcedDebt } }) as AdjustmentBuild;
  it('nợ cũ lệch nguồn / nguồn lạ / thanh lý / chưa phát hành', () => {
    expect(adjustmentBlockerMessage(build(['debt_source_mismatch'], 100000, 60000))).toMatch(/Nợ cũ 100\.000 đ không khớp nguồn đối chiếu \(60\.000 đ\)/);
    expect(adjustmentBlockerMessage(build(['debt_source_invalid'], 100000))).toMatch(/Nợ cũ 100\.000 đ có nguồn không hợp lệ/);
    expect(adjustmentBlockerMessage(build(['settlement']))).toMatch(/thanh lý chưa hỗ trợ điều chỉnh/);
    expect(adjustmentBlockerMessage(build(['not_issued']))).toMatch(/chưa phát hành/);
    expect(adjustmentBlockerMessage(build([]))).toBeNull();
  });
});
