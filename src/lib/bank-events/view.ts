import type { BankEvent, BankSource, BankStatus } from '@/lib/bank-events/service';

/** Chiều tiền của một tin: chỉ tin tách được số tiền và chiều mới là vào/ra, còn lại là "Khác". */
export type Flow = 'in' | 'out' | 'other';
export type FlowFilter = Flow | 'all';

const VN_TZ = 'Asia/Ho_Chi_Minh';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: VN_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const moneyFormat = new Intl.NumberFormat('vi-VN');
const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

export const flowOf = (event: BankEvent): Flow => {
  const summary = event.summary;
  return summary && summary.amount !== null && (summary.direction === 'in' || summary.direction === 'out') ? summary.direction : 'other';
};

/** Ngày theo giờ Việt Nam dạng YYYY-MM-DD. */
export const vnDay = (iso: string) => dayFormat.format(new Date(iso));
export const vnClock = (iso: string) => clockFormat.format(new Date(iso));
/** 08:14:33 19/10/26 — dạng gọn cho đồng hồ máy chủ và mốc liên lạc. */
export const vnStamp = (iso: string | null | undefined) => {
  if (!iso) return 'Chưa ghi nhận';
  const [y, m, d] = vnDay(iso).split('-');
  return `${vnClock(iso)} ${d}/${m}/${y.slice(2)}`;
};
export const dayStartIso = (day: string) => new Date(`${day}T00:00:00+07:00`).toISOString();
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const weekday = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
export const dayText = (day: string) => day.split('-').reverse().join('/');
export const dayLabel = (day: string, today: string) => day === today ? 'Hôm nay' : day === shiftDay(today, -1) ? 'Hôm qua' : weekday(day);

export const shortId = (value: string) => value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
export const money = (value: number) => moneyFormat.format(Math.abs(value));
export const signedMoney = (value: number, flow: Flow) => `${flow === 'in' ? '+' : flow === 'out' ? '−' : ''}${money(value)}`;

export interface FlowTotals { inSum: number; inCount: number; outSum: number; outCount: number; net: number; inShare: number | null }
export function flowTotals(events: readonly BankEvent[]): FlowTotals {
  let inSum = 0, inCount = 0, outSum = 0, outCount = 0;
  for (const event of events) {
    const flow = flowOf(event), amount = event.summary?.amount ?? 0;
    if (flow === 'in') { inSum += amount; inCount++; }
    else if (flow === 'out') { outSum += amount; outCount++; }
  }
  const moved = inSum + outSum;
  return { inSum, inCount, outSum, outCount, net: inSum - outSum, inShare: moved > 0 ? Math.round(inSum / moved * 100) : null };
}

export interface DayGroup { day: string; events: BankEvent[]; totals: FlowTotals }
/** Nhóm theo ngày máy chủ nhận (giờ Việt Nam), giữ nguyên thứ tự mới → cũ của danh sách. */
export function groupByDay(events: readonly BankEvent[]): DayGroup[] {
  const groups = new Map<string, BankEvent[]>();
  for (const event of events) {
    const day = vnDay(event.receivedAt);
    const list = groups.get(day);
    if (list) list.push(event); else groups.set(day, [event]);
  }
  return [...groups].map(([day, list]) => ({ day, events: list, totals: flowTotals(list) }));
}

export const flowCounts = (events: readonly BankEvent[]) => {
  const counts: Record<FlowFilter, number> = { all: events.length, in: 0, out: 0, other: 0 };
  for (const event of events) counts[flowOf(event)]++;
  return counts;
};

const BANK_CODES: Record<string, string> = {
  Vietcombank: 'VCB', Techcombank: 'TCB', VietinBank: 'CTG', Agribank: 'AGR', Sacombank: 'STB', HDBank: 'HDB',
  SeABank: 'SSB', Eximbank: 'EIB', LPBank: 'LPB', 'Nam A Bank': 'NAB', 'BAOVIET Bank': 'BAOV', PVcomBank: 'PVB',
  KienlongBank: 'KLB', 'Bac A Bank': 'BAB', 'Viet Capital Bank': 'BVB', Saigonbank: 'SGB', VietABank: 'VAB',
  'Standard Chartered': 'SC', 'Public Bank': 'PBB', TPBank: 'TPB', VPBank: 'VPB',
};
/** Mã ngắn cho ô ngân hàng; tên lạ thì lấy 4 chữ đầu. */
export const bankCode = (bank: string) => BANK_CODES[bank] ?? (bank.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || '—');
/** Bộ tách chỉ trả 4 số cuối dạng '••5847'; hiển thị thống nhất '•••• 5847'. */
export const maskAccount = (account: string) => `•••• ${account.replace(/^[•.*\s]+/, '')}`;

export const emptySummaryText = (event: BankEvent) => event.summaryStatus === 'unavailable' ? 'Không giải mã được để tóm tắt'
  : event.eventType === 'gateway.test' ? 'Tin thử từ nguồn'
  : event.summaryStatus === 'unparsed' ? 'Không phải tin biến động số dư' : 'Chưa có tóm tắt';

/** Những gì danh sách và chi tiết hiển thị từ tóm tắt đã tách; thiếu thì ghi rõ lý do thay vì để trống. */
export function eventFacts(event: BankEvent) {
  const summary = event.summary ?? null, flow = flowOf(event);
  const amount = summary?.amount ?? null, bank = summary?.bank ?? null;
  return {
    flow, bank, code: bank ? bankCode(bank) : null,
    account: summary?.account ? maskAccount(summary.account) : null,
    description: summary?.description || (amount !== null ? 'Không có nội dung chuyển khoản' : emptySummaryText(event)),
    hasDescription: !!summary?.description,
    amountText: amount !== null ? signedMoney(amount, flow) : null,
    balanceText: summary?.balance != null ? money(summary.balance) : null,
  };
}

export function relativeTime(iso: string | null | undefined, nowIso: string | undefined): string {
  if (!iso) return 'Chưa ghi nhận';
  if (!nowIso) return vnStamp(iso);
  const minutes = Math.round((Date.parse(nowIso) - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'Vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} giờ trước` : `${Math.round(hours / 24)} ngày trước`;
}

// Script Gmail báo sống tối đa 10 phút/lần (đêm 10 phút/lượt): quá 30 phút theo đồng hồ máy chủ là đáng ngờ.
export const isSilentGmail = (source: BankSource, serverTime: string | undefined) => source.kind === 'gmail' && !!source.deviceId
  && source.enabled && !source.revokedAt && !!serverTime
  && (!source.lastSeenAt || Date.parse(serverTime) - Date.parse(source.lastSeenAt) > 30 * 60_000);

export type SourceState = 'revoked' | 'silent' | 'enabled' | 'paused';
export const sourceState = (source: BankSource, serverTime: string | undefined): SourceState =>
  source.revokedAt ? 'revoked' : isSilentGmail(source, serverTime) ? 'silent' : source.enabled ? 'enabled' : 'paused';

/** Trạng thái tiếp nhận nói đúng điều đã biết: thiếu địa chỉ nhận hoặc không có nguồn bật thì không ghi "đang tiếp nhận". */
export function intakeState(status: BankStatus | undefined, failed: boolean): { live: boolean; label: string } {
  if (failed) return { live: false, label: 'Chưa tải được trạng thái' };
  if (!status) return { live: false, label: 'Đang kiểm tra' };
  if (!status.ingestUrl) return { live: false, label: 'Chưa cấu hình địa chỉ nhận' };
  if (!status.enabledSources) return { live: false, label: 'Chưa có nguồn đang bật' };
  return { live: true, label: 'Đang tiếp nhận' };
}

export const silentMinutes =(source: BankSource, serverTime: string) => source.lastSeenAt ? Math.round((Date.parse(serverTime) - Date.parse(source.lastSeenAt)) / 60_000) : null;

/** Tin mới xuất hiện so với lần tải trước của cùng bộ lọc: chưa từng thấy và nhận không sớm hơn tin mới nhất đã thấy. */
export function arrivals(previous: readonly BankEvent[], next: readonly BankEvent[]): BankEvent[] {
  const seen = new Set(previous.map(event => event.id));
  const newest = previous.reduce((max, event) => Math.max(max, Date.parse(event.receivedAt)), -Infinity);
  return next.filter(event => !seen.has(event.id) && Date.parse(event.receivedAt) >= newest);
}
