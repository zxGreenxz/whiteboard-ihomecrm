import { describe, expect, it } from 'vitest';
import type { BankEvent, BankSummary } from '../service';
import { arrivals, bankCode, dayLabel, eventFacts, flowCounts, flowOf, flowTotals, groupByDay, intakeState, isSilentGmail, maskAccount, relativeTime, sourceState, vnDay, vnStamp } from '../view';
import { fixtureEvent, fixtureSource, fixtureStatus } from './fixtures';

const summary = (patch: Partial<BankSummary>): BankSummary => ({ direction: null, amount: null, balance: null, account: null, description: null, bank: null, transactedAt: null, ...patch });
const event = (id: string, receivedAt: string, patch: Partial<BankEvent> = {}): BankEvent => ({ ...fixtureEvent, id, receivedAt, ...patch });
const incoming = (id: string, receivedAt: string, amount: number) => event(id, receivedAt, { summary: summary({ direction: 'in', amount }), summaryStatus: 'parsed' });
const outgoing = (id: string, receivedAt: string, amount: number) => event(id, receivedAt, { summary: summary({ direction: 'out', amount }), summaryStatus: 'parsed' });

describe('chiều tiền và tổng', () => {
  it('chỉ tin tách được số tiền và chiều mới là vào/ra', () => {
    expect(flowOf(incoming('a', '2026-10-19T01:00:00Z', 5))).toBe('in');
    expect(flowOf(outgoing('b', '2026-10-19T01:00:00Z', 5))).toBe('out');
    expect(flowOf(event('c', '2026-10-19T01:00:00Z', { summary: summary({ direction: 'in' }) }))).toBe('other');
    expect(flowOf(event('d', '2026-10-19T01:00:00Z', { summary: summary({ amount: 9 }) }))).toBe('other');
    expect(flowOf(event('e', '2026-10-19T01:00:00Z'))).toBe('other');
  });
  it('cộng riêng vào/ra, tin khác không vào tổng', () => {
    const list = [incoming('a', '2026-10-19T01:00:00Z', 5_500_000), incoming('b', '2026-10-19T02:00:00Z', 3_200_000), outgoing('c', '2026-10-19T03:00:00Z', 1_250_000), event('d', '2026-10-19T04:00:00Z')];
    expect(flowTotals(list)).toEqual({ inSum: 8_700_000, inCount: 2, outSum: 1_250_000, outCount: 1, net: 7_450_000, inShare: 87 });
    expect(flowCounts(list)).toEqual({ all: 4, in: 2, out: 1, other: 1 });
    expect(flowTotals([event('x', '2026-10-19T01:00:00Z')]).inShare).toBeNull();
  });
});

describe('ngày theo giờ Việt Nam', () => {
  it('nhóm theo ngày máy chủ nhận ở múi +07, giữ thứ tự', () => {
    const groups = groupByDay([incoming('late', '2026-10-18T17:30:00Z', 1), outgoing('day', '2026-10-18T16:59:59Z', 2), incoming('prev', '2026-10-18T01:00:00Z', 3)]);
    expect(groups.map(group => [group.day, group.events.map(item => item.id)])).toEqual([['2026-10-19', ['late']], ['2026-10-18', ['day', 'prev']]]);
    expect(groups[1].totals.outSum).toBe(2);
  });
  it('nhãn Hôm nay / Hôm qua / thứ, kể cả qua đầu tháng', () => {
    expect(dayLabel('2026-10-19', '2026-10-19')).toBe('Hôm nay');
    expect(dayLabel('2026-09-30', '2026-10-01')).toBe('Hôm qua');
    expect(dayLabel('2026-10-17', '2026-10-19')).toBe('Thứ Bảy');
    expect(vnDay('2026-10-18T17:00:00Z')).toBe('2026-10-19');
    expect(vnStamp('2026-10-19T10:48:20Z')).toBe('17:48:20 19/10/26');
  });
});

describe('hiển thị tóm tắt', () => {
  it('mã ngân hàng và số tài khoản rút gọn', () => {
    expect(bankCode('Vietcombank')).toBe('VCB');
    expect(bankCode('MB')).toBe('MB');
    expect(bankCode('Kho Bac Moi')).toBe('KHOB');
    expect(maskAccount('••5847')).toBe('•••• 5847');
  });
  it('thiếu tóm tắt thì nói rõ lý do, có số tiền thì có dấu', () => {
    expect(eventFacts(event('u', '2026-10-19T01:00:00Z', { summaryStatus: 'unavailable', summary: null })).description).toBe('Không giải mã được để tóm tắt');
    expect(eventFacts(event('t', '2026-10-19T01:00:00Z', { eventType: 'gateway.test' })).description).toBe('Tin thử từ nguồn');
    expect(eventFacts(event('n', '2026-10-19T01:00:00Z', { summaryStatus: 'unparsed', summary: null })).description).toBe('Không phải tin biến động số dư');
    const facts = eventFacts(event('p', '2026-10-19T01:00:00Z', { summary: summary({ direction: 'out', amount: 1_250_000, balance: 22_880_000, bank: 'MB', account: '••7730' }) }));
    expect(facts).toMatchObject({ flow: 'out', code: 'MB', account: '•••• 7730', amountText: '−1.250.000', balanceText: '22.880.000', description: 'Không có nội dung chuyển khoản', hasDescription: false });
  });
});

describe('tin mới giữa hai lần tải', () => {
  const first = [incoming('b', '2026-10-19T10:41:00Z', 1), incoming('a', '2026-10-19T10:22:00Z', 1)];
  it('báo tin chưa thấy và không cũ hơn tin mới nhất đã thấy', () => {
    const next = [incoming('c', '2026-10-19T10:48:00Z', 1), ...first];
    expect(arrivals(first, next).map(item => item.id)).toEqual(['c']);
  });
  it('tin cũ lộ ra do tin khác rời trang không bị báo là mới', () => {
    expect(arrivals(first, [first[0], incoming('old', '2026-10-19T09:00:00Z', 1)])).toEqual([]);
  });
  it('lần tải trước rỗng thì tin đến đầu tiên là mới', () => {
    expect(arrivals([], first).map(item => item.id)).toEqual(['b', 'a']);
  });
});

describe('nguồn Gmail im lặng', () => {
  const gmail = { ...fixtureSource, kind: 'gmail' as const, heartbeat: null, lastSeenAt: '2026-10-19T10:00:00Z' };
  it('quá 30 phút theo đồng hồ máy chủ mới cảnh báo; nguồn tắt, thu hồi hay chưa gắn script thì không', () => {
    expect(isSilentGmail(gmail, '2026-10-19T10:30:00Z')).toBe(false);
    expect(isSilentGmail(gmail, '2026-10-19T10:31:00Z')).toBe(true);
    expect(isSilentGmail({ ...gmail, enabled: false }, '2026-10-19T12:00:00Z')).toBe(false);
    expect(isSilentGmail({ ...gmail, revokedAt: '2026-10-19T11:00:00Z' }, '2026-10-19T12:00:00Z')).toBe(false);
    expect(isSilentGmail({ ...gmail, deviceId: null }, '2026-10-19T12:00:00Z')).toBe(false);
    expect(isSilentGmail({ ...fixtureSource, lastSeenAt: null }, '2026-10-19T12:00:00Z')).toBe(false);
    expect(isSilentGmail(gmail, undefined)).toBe(false);
  });
  it('nhãn nguồn: thu hồi > cần kiểm tra > đang bật > tạm dừng', () => {
    expect(sourceState({ ...gmail, revokedAt: '2026-10-19T11:00:00Z' }, '2026-10-19T12:00:00Z')).toBe('revoked');
    expect(sourceState(gmail, '2026-10-19T12:00:00Z')).toBe('silent');
    expect(sourceState(gmail, '2026-10-19T10:10:00Z')).toBe('enabled');
    expect(sourceState({ ...fixtureSource, enabled: false }, '2026-10-19T12:00:00Z')).toBe('paused');
  });
  it('chỉ ghi "đang tiếp nhận" khi có địa chỉ nhận và có nguồn bật', () => {
    expect(intakeState(fixtureStatus, false)).toEqual({ live: true, label: 'Đang tiếp nhận' });
    expect(intakeState({ ...fixtureStatus, ingestUrl: null }, false).live).toBe(false);
    expect(intakeState({ ...fixtureStatus, enabledSources: 0 }, false).label).toBe('Chưa có nguồn đang bật');
    expect(intakeState(undefined, true).label).toBe('Chưa tải được trạng thái');
  });
  it('mốc tương đối theo đồng hồ máy chủ', () => {
    expect(relativeTime('2026-10-19T10:47:58Z', '2026-10-19T10:48:20Z')).toBe('Vừa xong');
    expect(relativeTime('2026-10-19T10:06:10Z', '2026-10-19T10:48:20Z')).toBe('42 phút trước');
    expect(relativeTime('2026-10-19T02:30:00Z', '2026-10-19T10:48:20Z')).toBe('8 giờ trước');
    expect(relativeTime(null, '2026-10-19T10:48:20Z')).toBe('Chưa ghi nhận');
  });
});
