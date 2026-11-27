// @vitest-environment jsdom
// Đợt 7: dấu `lead-conversion` của luồng chuyển khách hẹn BẢN TRƯỚC (khách thuê → phiếu cọc → khách hẹn). Luồng hiện hành
// không ghi dấu này nữa; dấu cũ được kết luận một lần, không chạy lại bước ghi nào, không chặn mãi.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetDeadIntentKeys, forgetLeadConversionTrace, forgetOrphanLeadConversionTraces, readLeadConversionTrace, resolveLegacyLeadConversion, type LeadConversionTrace } from '../leadConversionProgress';
import type { FinancialPendingRecord } from '../financialPending';

const LEAD = 'lead-1';
const pending = (over: Partial<FinancialPendingRecord> = {}): FinancialPendingRecord => ({
  namespace: 'lead-conversion', userId: 'actor', organizationId: 'org-a', businessKey: LEAD,
  attemptId: 'legacy-attempt', requestKey: 'legacy-attempt', completedIds: [], startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), ...over,
});
const trace = (value: Partial<LeadConversionTrace>) => localStorage.setItem('ihome:lead-conversion-trace:v1:legacy-attempt', JSON.stringify({ leadId: LEAD, stage: 'tenant', canResume: true, ...value }));
const ports = () => ({ readDeposit: vi.fn(async (id: string) => ({ id })), findDeposits: vi.fn(async () => [] as string[]) });
beforeEach(() => localStorage.clear());

describe('dấu chuyển khách hẹn bản trước', () => {
  it('phiếu cọc đã nhận mã ở lần trước và đọc thấy: chỉ còn bước đánh dấu khách hẹn, không tạo phiếu khác', async () => {
    trace({ stage: 'lead', tenantId: 'tenant-1', depositId: 'deposit-1', canResume: true });
    const io = ports();
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1', 'deposit-1'] }), LEAD, io)).resolves.toEqual({ kind: 'deposit', depositId: 'deposit-1', exact: true });
    expect(io.findDeposits).not.toHaveBeenCalled();
  });

  it('bước tạo phiếu chưa bắt đầu (lệnh không tới máy chủ ở bước khách thuê): chưa có tiền ⇒ gỡ dấu, làm như bình thường', async () => {
    trace({ stage: 'tenant', canResume: false });
    await expect(resolveLegacyLeadConversion(pending(), LEAD, ports())).resolves.toEqual({ kind: 'clear' });
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: true });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, ports())).resolves.toEqual({ kind: 'clear' });
  });

  it('phiếu cọc đã gửi mà mất phản hồi: tra gần đúng theo khách thuê, thấy thì chỉ báo «có thể» (mới nhất trước), không tự tạo', async () => {
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: false });
    const io = ports();io.findDeposits.mockResolvedValue(['deposit-new', 'deposit-old']);
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, io)).resolves.toEqual({ kind: 'deposit', depositId: 'deposit-new', exact: false });
    expect(io.findDeposits).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ attemptId: 'legacy-attempt' }));
  });

  it('phiếu cọc đã gửi, tra không thấy phiếu nào và lần gửi đã kết thúc: lần trước chưa ghi ⇒ gỡ dấu', async () => {
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: false });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, ports())).resolves.toEqual({ kind: 'clear' });
  });

  it('dấu chưa đủ 2 phút: chưa kết luận «chưa ghi» được ⇒ chặn (hộp cảnh báo)', async () => {
    trace({ stage: 'tenant', canResume: false });
    await expect(resolveLegacyLeadConversion(pending({ startedAt: new Date().toISOString() }), LEAD, ports())).resolves.toEqual({ kind: 'block' });
  });

  it('không có vết, vết của khách hẹn khác, mã phiếu không nằm trong dấu, hay phiếu không còn: chặn, không đoán', async () => {
    await expect(resolveLegacyLeadConversion(pending(), LEAD, ports())).resolves.toEqual({ kind: 'block' });
    trace({ leadId: 'lead-other', stage: 'tenant' });
    await expect(resolveLegacyLeadConversion(pending(), LEAD, ports())).resolves.toEqual({ kind: 'block' });
    trace({ stage: 'lead', tenantId: 'tenant-1', depositId: 'deposit-1' });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, ports())).resolves.toEqual({ kind: 'block' });
    const io = ports();io.readDeposit.mockResolvedValue(null as unknown as { id: string });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1', 'deposit-1'] }), LEAD, io)).resolves.toEqual({ kind: 'block' });
  });

  it('đọc máy chủ hỏng thì ném (nơi gọi giữ dấu)', async () => {
    trace({ stage: 'deposit', tenantId: 'tenant-1', canResume: false });
    const io = ports();io.findDeposits.mockRejectedValue({ code: '42501' });
    await expect(resolveLegacyLeadConversion(pending({ completedIds: ['tenant-1'] }), LEAD, io)).rejects.toMatchObject({ code: '42501' });
  });

  it('vết hỏng không chứng minh được gì; gỡ vết không ném', () => {
    localStorage.setItem('ihome:lead-conversion-trace:v1:legacy-attempt', '{không phải json');
    expect(readLeadConversionTrace('legacy-attempt')).toBeNull();
    forgetLeadConversionTrace('legacy-attempt');
    expect(localStorage.getItem('ihome:lead-conversion-trace:v1:legacy-attempt')).toBeNull();
  });
});

/** Kho giả theo đúng thứ tự khoá như kho thật; `fail` chọn thao tác nào ném lỗi. */
function memoryStore(entries: Record<string, string>, fail: { length?: boolean; key?: boolean; read?: boolean; remove?: (key: string) => boolean } = {}) {
  const values = new Map(Object.entries(entries));
  const blocked = () => new DOMException('blocked', 'SecurityError');
  const store = {
    get length() { if (fail.length) throw blocked(); return values.size; },
    key: (index: number) => { if (fail.key) throw blocked(); return [...values.keys()][index] ?? null; },
    getItem: (name: string) => { if (fail.read) throw blocked(); return values.get(name) ?? null; },
    removeItem: (name: string) => { if (fail.remove?.(name)) throw blocked(); values.delete(name); },
  };
  return { store, names: () => [...values.keys()].sort() };
}

// Đợt 11: hai họ khoá «ý định» của bản trước không còn mã nào ghi hay đọc: quay số (`ihome:lucky-draw-intent:v1:*`, bản này
// lưu lượt vào `meta` của dấu) và mẫu in mặc định (`ihome:template-default-intent:v1:*`, đợt 8 bỏ dấu). Dọn lúc mở app.
describe('dọn khoá «ý định» không còn ai đọc', () => {
  const kept = [
    'ihome:lucky-draw-intent:v2:req-a', 'ihome:lucky-draw-intent:v1', 'xihome:lucky-draw-intent:v1:req-a',
    'ihome:template-default-intent:v1', 'ihome:template-default-intent:v10:req-b', 'ihome:lead-conversion-trace:v1:req-c',
    'ihome:financial-pending:v1:lucky-admin:actor:actor-scope:draw%3Aev', 'ihomecrm.selectedOrganizationId',
  ];

  it('gỡ đúng hai họ theo tiền tố chính xác, giữ khoá giống tiền tố mà khác họ, trả số khoá đã gỡ', () => {
    const { store, names } = memoryStore(Object.fromEntries([
      ...kept, 'ihome:lucky-draw-intent:v1:req-a', 'ihome:lucky-draw-intent:v1:req-d', 'ihome:template-default-intent:v1:req-b',
    ].map(name => [name, '{}'])));
    expect(forgetDeadIntentKeys(store)).toBe(3);
    expect(names()).toEqual([...kept].sort());
    expect(forgetDeadIntentKeys(store)).toBe(0);
  });

  it('mặc định dùng kho thật của trình duyệt', () => {
    localStorage.setItem('ihome:lucky-draw-intent:v1:req-a', '{}');
    localStorage.setItem('ihome:template-default-intent:v1:req-b', '{}');
    localStorage.setItem('ihome:lucky-draw-intent:v2:req-a', '{}');
    expect(forgetDeadIntentKeys()).toBe(2);
    expect(Object.keys(localStorage)).toEqual(['ihome:lucky-draw-intent:v2:req-a']);
  });

  it('kho ném lỗi (chặn bộ nhớ) thì bỏ qua êm: không ném, chỉ đếm khoá đã gỡ được', () => {
    const entries = { 'ihome:lucky-draw-intent:v1:req-a': '{}', 'ihome:template-default-intent:v1:req-b': '{}' };
    expect(forgetDeadIntentKeys(memoryStore(entries, { length: true }).store)).toBe(0);
    expect(forgetDeadIntentKeys(memoryStore(entries, { key: true }).store)).toBe(0);
    const partial = memoryStore(entries, { remove: name => name.startsWith('ihome:lucky') });
    expect(forgetDeadIntentKeys(partial.store)).toBe(1);
    expect(partial.names()).toEqual(['ihome:lucky-draw-intent:v1:req-a']);
  });
});

// Vết tiến độ chuyển khách hẹn bản trước chỉ được đọc qua `requestKey` của một dấu `lead-conversion`, và không còn mã nào ghi
// dấu đó. Vết không còn dấu nào trỏ tới (dấu đã gỡ qua hộp cảnh báo, hoặc ở tab khác) không bao giờ được đọc lại.
describe('vết chuyển khách hẹn không còn dấu trỏ tới', () => {
  const mark = (user: string, lead: string, requestKey: string) => [
    `ihome:financial-pending:v1:lead-conversion:${user}:org-a:${lead}`,
    JSON.stringify({ namespace: 'lead-conversion', userId: user, organizationId: 'org-a', businessKey: lead, attemptId: requestKey, requestKey, completedIds: [], startedAt: '2026-11-20T01:00:00.000Z' }),
  ];

  it('gỡ vết mồ côi; giữ vết còn dấu trỏ tới (kể cả dấu của tài khoản khác) và khoá khác họ', () => {
    const { store, names } = memoryStore(Object.fromEntries([
      mark('other', 'lead-2', 'k2'),
      ['ihome:lead-conversion-trace:v1:k2', '{}'], ['ihome:lead-conversion-trace:v1:gone', '{}'],
      ['ihome:lead-conversion-trace:v1', '{}'], ['ihome:lead-conversion-trace:v2:gone', '{}'],
    ]));
    expect(forgetOrphanLeadConversionTraces(store)).toBe(1);
    expect(names()).toEqual(['ihome:financial-pending:v1:lead-conversion:other:org-a:lead-2', 'ihome:lead-conversion-trace:v1', 'ihome:lead-conversion-trace:v1:k2', 'ihome:lead-conversion-trace:v2:gone']);
  });

  it('một dấu chuyển khách hẹn không đọc được ⇒ không chứng minh được vết nào mồ côi, không gỡ gì', () => {
    const { store, names } = memoryStore({ 'ihome:financial-pending:v1:lead-conversion:actor:org-a:lead-1': '{hỏng', 'ihome:lead-conversion-trace:v1:gone': '{}' });
    expect(forgetOrphanLeadConversionTraces(store)).toBe(0);
    expect(names()).toContain('ihome:lead-conversion-trace:v1:gone');
  });

  it('kho ném lỗi thì bỏ qua êm', () => {
    const entries = { 'ihome:lead-conversion-trace:v1:gone': '{}' };
    expect(forgetOrphanLeadConversionTraces(memoryStore(entries, { length: true }).store)).toBe(0);
    expect(forgetOrphanLeadConversionTraces(memoryStore({ ...entries, [mark('a', 'l', 'k')[0]]: mark('a', 'l', 'k')[1] }, { read: true }).store)).toBe(0);
  });
});
