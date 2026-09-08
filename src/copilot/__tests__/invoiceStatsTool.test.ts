import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCtx } from '../tools/registry';

// Only the remote RPC boundary is mocked; execute the registered business tool.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
const { TOOL_NGHIEP_VU } = await import('../tools/nghiepVuTools');
const tool = TOOL_NGHIEP_VU.find(t => t.name === 'cong_no_tong_quan')!;
const ctx: ToolCtx = { organizationId: 'dddd0000-0000-4000-8000-000000000001', perms: undefined, threadId: null, generation: 0, isSuperAdmin: false };
const zero = {
  total_amount: 0, total_paid: 0, total_remaining: 0, total_refunded: 0, total_count: 0,
  rent_amount: 0, electric_amount: 0, water_amount: 0, pdv_amount: 0, total_collected: 0,
  payment_tm: 0, payment_tk: 0, payment_tt: 0, payment_ct: 0, change_amount: 0, deposit_collected: 0,
};
const zeroRows = `- total_amount: 0 đ
- total_paid: 0 đ
- total_remaining: 0 đ
- total_refunded: 0 đ
- total_count: 0
- rent_amount: 0 đ
- electric_amount: 0 đ
- water_amount: 0 đ
- pdv_amount: 0 đ
- total_collected: 0 đ
- payment_tm: 0 đ
- payment_tk: 0 đ
- payment_tt: 0 đ
- payment_ct: 0 đ
- change_amount: 0 đ
- deposit_collected: 0 đ`;
const emptySummary = 'Không có hóa đơn và không có công nợ trong phạm vi truy vấn này.';
const malformedError = 'Dữ liệu thống kê hoá đơn không hợp lệ.';
async function run(payload: unknown, args: { thang?: string } = { thang: '2099-01' }) {
  rpc.mockResolvedValue({ data: payload, error: null });
  return tool.execute(args, ctx);
}
beforeEach(() => rpc.mockReset());

describe('registered invoice statistics boundary', () => {
  it('renders canonical zero count without currency, three totals and scoped absence, retaining all 16 rows', async () => {
    expect(await run(zero)).toBe(`Thống kê hoá đơn kỳ 2099-01: 0 hóa đơn.\nTổng phải thu: 0 đ; đã trả: 0 đ; còn nợ: 0 đ.\n${emptySummary}\n${zeroRows}`);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('copilot_invoice_stats_v1', { p_organization_id: ctx.organizationId, p_billing_month: '2099-01' });
  });

  it('preserves positive count, every money field and original response order with established whole-dong rounding', async () => {
    const payload = { total_amount: 12000.5, total_paid: 2000.4, total_remaining: 10000.1, total_refunded: -5.5, total_count: 2,
      rent_amount: 9000, electric_amount: 1001, water_amount: 1002, pdv_amount: 1003, total_collected: 2001,
      payment_tm: 2002, payment_tk: 2003, payment_tt: 2004, payment_ct: 2005, change_amount: -2006, deposit_collected: 3007 };
    const result = await run(Object.fromEntries(Object.entries(payload).reverse()), { thang: '2026-07' });
    expect(result).toBe(`Thống kê hoá đơn kỳ 2026-07: 2 hóa đơn.
Tổng phải thu: 12.001 đ; đã trả: 2.000 đ; còn nợ: 10.000 đ.
- deposit_collected: 3.007 đ
- change_amount: -2.006 đ
- payment_ct: 2.005 đ
- payment_tt: 2.004 đ
- payment_tk: 2.003 đ
- payment_tm: 2.002 đ
- total_collected: 2.001 đ
- pdv_amount: 1.003 đ
- water_amount: 1.002 đ
- electric_amount: 1.001 đ
- rent_amount: 9.000 đ
- total_count: 2
- total_refunded: -6 đ
- total_remaining: 10.000 đ
- total_paid: 2.000 đ
- total_amount: 12.001 đ`);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('copilot_invoice_stats_v1', { p_organization_id: ctx.organizationId, p_billing_month: '2026-07' });
  });

  it.each([{ total_count: 2, total_remaining: 0 }, { total_count: 0, total_remaining: 500 }])('does not infer joint absence from either zero alone: %j', async values => {
    const result = await run({ ...zero, ...values });
    expect(result).toContain(`${values.total_count} hóa đơn.`);
    expect(result).not.toContain('Không có hóa đơn');
    expect(result).not.toContain('không có công nợ');
    expect(result).toContain(`- total_count: ${values.total_count}\n`);
  });

  it('keeps independent collected deposits visible despite zero invoices and debt', async () => {
    expect(await run({ ...zero, deposit_collected: 7654000 })).toBe(`Thống kê hoá đơn kỳ 2099-01: 0 hóa đơn.\nTổng phải thu: 0 đ; đã trả: 0 đ; còn nợ: 0 đ.\n${emptySummary}\n${zeroRows.replace('- deposit_collected: 0 đ', '- deposit_collected: 7.654.000 đ')}`);
  });

  it('without a month labels only the selected company authorized scope and omits the RPC month argument', async () => {
    expect(await run(zero, {})).toBe(`Thống kê hoá đơn trong phạm vi được phép của công ty đã chọn: 0 hóa đơn.\nTổng phải thu: 0 đ; đã trả: 0 đ; còn nợ: 0 đ.\n${emptySummary}\n${zeroRows}`);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('copilot_invoice_stats_v1', { p_organization_id: ctx.organizationId });
  });

  it.each([null, undefined, false, 0, '', 'invalid', [], [zero], {}, { ...zero, extra: 0 }].map(payload => ({ payload })))('rejects malformed objects instead of manufacturing absence: %j', async ({ payload }) => {
    await expect(run(payload)).rejects.toThrow(malformedError);
  });

  it.each(Object.keys(zero))('requires finite numeric field %s, never coercing/defaulting it', async key => {
    const missing = { ...zero }; delete missing[key];
    for (const payload of [missing, ...[undefined, null, '0', false, {}, [], NaN, Infinity, -Infinity].map(value => ({ ...zero, [key]: value }))]) {
      await expect(run(payload)).rejects.toThrow(malformedError);
    }
  });

  it.each([-1, 0.5])('rejects noninteger or negative invoice count %s', async total_count => {
    await expect(run({ ...zero, total_count })).rejects.toThrow(malformedError);
  });

  it('retains RPC failures and refuses missing organization before reading', async () => {
    rpc.mockResolvedValue({ data: zero, error: { message: 'permission denied' } });
    await expect(tool.execute({}, ctx)).rejects.toThrow('Lỗi tải thống kê hoá đơn: permission denied');
    rpc.mockClear();
    await expect(tool.execute({}, { ...ctx, organizationId: null })).rejects.toThrow('organization_required');
    expect(rpc).not.toHaveBeenCalled();
  });
});
