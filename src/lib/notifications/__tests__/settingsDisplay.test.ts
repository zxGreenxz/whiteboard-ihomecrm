import { describe, expect, it } from 'vitest';
import {
  assessDeliveryQueue,
  describeUserAgent,
  formatHour,
  noRecipientLabel,
  pushOutcomeLabel,
  quietHoursLength,
  readTestPushOutcome,
  testPushFeedback,
  type DeliveryQueueInput,
} from '../settingsDisplay';

describe('nhãn trạng thái thẻ Sức khoẻ (SETTINGS-5)', () => {
  it('DISABLED và UNKNOWN có nhãn riêng, không rơi vào "Kết quả khác"', () => {
    expect(pushOutcomeLabel('DISABLED')).toEqual({ label: 'Người nhận đã tắt đẩy về máy', tone: 'muted' });
    expect(pushOutcomeLabel('UNKNOWN')).toEqual({ label: 'Chưa rõ kết quả', tone: 'muted' });
    expect(pushOutcomeLabel('DISABLED').label).not.toContain('Kết quả khác');
  });
  it('no_recipient_7d: họ + lý do sang tiếng Việt; mã lạ giữ nguyên mã thô', () => {
    const titles = { E1: { title: 'Phiếu chờ tôi duyệt' } };
    expect(noRecipientLabel({ event: 'E1', reason: 'NO_APPROVER_IN_SCOPE' }, titles))
      .toEqual({ event: 'Phiếu chờ tôi duyệt', reason: 'Không có người duyệt trong phạm vi' });
    expect(noRecipientLabel({ event: 'INVOICE_OVERDUE', reason: 'NO_RECIPIENT_IN_SCOPE' }, titles))
      .toEqual({ event: 'Hoá đơn quá hạn', reason: 'Không có ai đủ quyền trong phạm vi toà' });
    expect(noRecipientLabel({ event: 'X9', reason: 'LA' }, titles)).toEqual({ event: 'X9', reason: 'LA' });
  });
});

describe('assessDeliveryQueue — chỉ nói "lượt gửi có thể đang lỗi" khi chính lượt drain hỏng (SETTINGS-3)', () => {
  const NOW = '2026-10-21T23:00:00Z';
  const base: DeliveryQueueInput = {
    generatedAt: NOW,
    queue: { queued: 3, oldestQueuedAt: '2026-10-21T21:30:00Z' },
    lastDrainAt: '2026-10-21T22:50:00Z',
    lastDrainOkAt: '2026-10-21T22:50:00Z',
    lastDrainError: null,
  };
  it('QUEUED cũ 90 phút (giờ yên) nhưng lượt thành công 10 phút trước ⇒ KHÔNG cảnh báo lỗi', () => {
    const a = assessDeliveryQueue(base);
    expect(a.drainProblem).toBeNull();
    // Máy chủ chưa tách dòng giờ yên ⇒ chỉ ghi chú trung tính.
    expect(a.queueNote).toEqual({ kind: 'old-maybe-quiet', minutes: 90, since: '2026-10-21T21:30:00Z' });
  });
  it('máy chủ trả oldest_eligible_queued_at: dòng giờ yên không tính; deferred_quiet là số trung tính', () => {
    const a = assessDeliveryQueue({ ...base, queue: { ...base.queue, oldestEligibleQueuedAt: null, deferredQuiet: 3 } });
    expect(a.drainProblem).toBeNull();
    expect(a.queueNote).toBeNull();
    expect(a.deferredQuiet).toBe(3);
    const stuck = assessDeliveryQueue({ ...base, queue: { ...base.queue, oldestEligibleQueuedAt: '2026-10-21T22:00:00Z', deferredQuiet: 0 } });
    expect(stuck.drainProblem).toBeNull();
    expect(stuck.queueNote).toEqual({ kind: 'stuck-eligible', minutes: 60, since: '2026-10-21T22:00:00Z' });
  });
  it('lượt thành công gần nhất cũ hơn 30 phút ⇒ cảnh báo, kể cả khi hàng chờ trống', () => {
    const a = assessDeliveryQueue({ ...base, queue: { queued: 0, oldestQueuedAt: null }, lastDrainAt: '2026-10-21T22:55:00Z', lastDrainOkAt: '2026-10-21T22:20:00Z' });
    expect(a.drainProblem).toEqual({ kind: 'stale', minutes: 40, since: '2026-10-21T22:20:00Z' });
    expect(a.latestDrainFailed).toBe(true);
  });
  it('last_drain_error (super admin) ⇒ cảnh báo kèm lỗi; đã chạy mà chưa lượt nào OK ⇒ cảnh báo', () => {
    expect(assessDeliveryQueue({ ...base, lastDrainError: 'send-push 500' }).drainProblem).toEqual({ kind: 'error', message: 'send-push 500' });
    expect(assessDeliveryQueue({ ...base, lastDrainOkAt: null }).drainProblem).toEqual({ kind: 'never-ok' });
  });
  it('chưa có lượt nào chạy: chỉ cảnh báo khi có dòng ĐỦ ĐIỀU KIỆN chờ lâu', () => {
    const chua = { ...base, lastDrainAt: null, lastDrainOkAt: null };
    expect(assessDeliveryQueue({ ...chua, queue: { ...base.queue, oldestEligibleQueuedAt: null } }).drainProblem).toBeNull();
    expect(assessDeliveryQueue({ ...chua, queue: { ...base.queue, oldestEligibleQueuedAt: '2026-10-21T21:30:00Z' } }).drainProblem).toEqual({ kind: 'never-ok' });
  });
});

describe('quietHoursLength — cùng quy ước với notify_claim_push_batch_v1', () => {
  it.each([
    [21, 7, 10], [22, 6, 8], [0, 7, 7], [7, 21, 14], [21, 8, 11], [23, 0, 1], [5, 5, 0],
  ])('%i→%i dài %i giờ', (start, end, hours) => {
    expect(quietHoursLength(start, end)).toBe(hours);
  });
  it('định dạng giờ hai chữ số', () => { expect(formatHour(7)).toBe('07:00'); expect(formatHour(21)).toBe('21:00'); });
});

describe('describeUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari · iPhone'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0', 'Edge · Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox · macOS'],
    ['Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 'Samsung Internet · Android'],
  ])('%s', (ua, label) => { expect(describeUserAgent(ua)).toBe(label); });
  it('thiếu UA không bịa tên máy', () => { expect(describeUserAgent(null)).toBe('Thiết bị không rõ'); expect(describeUserAgent('curl/8.0')).toBe('Thiết bị không rõ'); });
});

describe('phản hồi gửi thử đọc outcome', () => {
  it('NO_DEVICE là cảnh báo có hướng dẫn, không phải thành công', () => {
    const r = testPushFeedback({ outcome: 'NO_DEVICE', sent: 0, failed: 0, total: 0, pruned: 0 });
    expect(r.tone).toBe('warn');
    expect(r.message).toMatch(/Chưa có thiết bị nào đang bật/);
  });
  it('PARTIAL nêu số máy và máy hết hạn', () => {
    const r = testPushFeedback({ outcome: 'PARTIAL', sent: 1, failed: 1, total: 2, pruned: 1 });
    expect(r.tone).toBe('warn');
    expect(r.message).toMatch(/1\/2/);
    expect(r.message).toMatch(/hết hạn/);
  });
  it('SENT không khẳng định máy đã hiện thông báo', () => {
    const r = testPushFeedback({ outcome: 'SENT', sent: 2, failed: 0, total: 2, pruned: 0 });
    expect(r.tone).toBe('ok');
    expect(r.message).toMatch(/đã nhận/);
    expect(r.message).toMatch(/tuỳ quyền thông báo/);
  });
  it('outcome lạ không thành thành công', () => {
    expect(testPushFeedback({ outcome: 'CONFIG_ERROR', sent: 0, failed: 0, total: 0, pruned: 0 }).tone).toBe('error');
    expect(pushOutcomeLabel('XYZ').label).toContain('XYZ');
  });
  it('ưu tiên outcome do máy chủ trả (C8), bản cũ thì suy từ số đếm', () => {
    expect(readTestPushOutcome({ sent: 0, failed: 0, total: 0, outcome: 'NO_DEVICE' })).toBe('NO_DEVICE');
    expect(readTestPushOutcome({ sent: 1, failed: 0, total: 1, outcome: 'DUPLICATE' })).toBe('DUPLICATE');
    expect(readTestPushOutcome({ sent: 0, failed: 0, total: 0 })).toBe('NO_DEVICE');
    expect(readTestPushOutcome({ sent: 1, failed: 1, total: 2 })).toBe('PARTIAL');
    expect(readTestPushOutcome({ sent: 0, failed: 2, total: 2 })).toBe('ALL_FAILED');
  });
});
