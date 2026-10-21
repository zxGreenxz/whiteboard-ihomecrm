import { describe, expect, it } from 'vitest';
import {
  describeUserAgent,
  formatHour,
  pushOutcomeLabel,
  quietHoursLength,
  readTestPushOutcome,
  testPushFeedback,
} from '../settingsDisplay';

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
