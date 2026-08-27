/**
 * Toán thuần cho panel "Chu trình phòng" (/thu-tien) — Plan 2 Task 6A/7 Step 4.
 *
 * Tách khỏi UI theo đúng án lệ của repo: design chỉ là hình ảnh, logic phải tự
 * kiểm được bằng unit test trước khi có một pixel nào (memory
 * design-la-hinh-anh-logic-phai-tu-kiem).
 *
 * Nguồn dữ liệu: RPC `get_room_cash_lifecycle_v1(p_room_id, p_from, p_to)` —
 * TIMELINE THEO PHÒNG, không phải cây hợp đồng: production không có một liên
 * kết cha-con nào giữa các hợp đồng (parent_contract_id 0/366, đo 27/08/2026);
 * gia hạn sửa ngày trên chính hợp đồng cũ. Mỗi hợp đồng là MỘT THANH trên trục
 * thời gian, khoảng hở giữa hai thanh là thời gian phòng trống.
 */

export interface LifecycleSegment {
  contractId: string;
  contractNumber: string | null;
  segIndex: number;
  /** NULL = không biết mốc vào (chuỗi audit không đủ — nhìn cờ trusted). */
  fromDate: string | null;
  /** Nửa mở [from, to); NULL = đang còn ở. */
  toDate: string | null;
  sourcePath: string | null;
  trusted: boolean;
  diagnostic: string | null;
}

export interface LifecycleEvent {
  type: string;
  date: string;
  contractId: string | null;
  amount: number | null;
  trusted: boolean;
  meta: Record<string, unknown> | null;
}

export interface LifecycleVacancy {
  fromDate: string;
  /** NULL = trống tới hôm nay. */
  toDate: string | null;
  days: number;
}

export interface LifecycleContract {
  id: string;
  number: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  actualEndDate: string | null;
  rentPrice: number | null;
  totalDeposit: number | null;
  tenantName: string | null;
}

export interface LifecyclePayload {
  room: { id: string; name: string; buildingId: string; buildingName: string };
  range: { from: string | null; to: string | null };
  contracts: LifecycleContract[];
  segments: LifecycleSegment[];
  events: LifecycleEvent[];
  vacancies: LifecycleVacancy[];
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────
// Trục thời gian
// ─────────────────────────────────────────────────────────────────────

export interface TimeDomain {
  /** epoch ms */
  min: number;
  max: number;
}

const DAY_MS = 86_400_000;

const ms = (d: string | null | undefined): number | null => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Miền thời gian của trục: phủ mọi segment + sự kiện, kéo tới `today` khi còn
 * segment mở. Luôn nới mỗi đầu 2% (tối thiểu 7 ngày) cho nhãn khỏi dính mép.
 * Không có gì để vẽ ⇒ null (UI hiện trạng thái rỗng, không vẽ trục ma).
 */
export function timelineDomain(
  payload: Pick<LifecyclePayload, 'segments' | 'events'>,
  todayISO: string,
): TimeDomain | null {
  const points: number[] = [];
  for (const s of payload.segments) {
    const a = ms(s.fromDate);
    const b = ms(s.toDate);
    if (a !== null) points.push(a);
    if (b !== null) points.push(b);
    if (b === null && a !== null) {
      const today = ms(todayISO);
      if (today !== null) points.push(today); // segment mở chạy tới hôm nay
    }
  }
  for (const e of payload.events) {
    const t = ms(e.date);
    if (t !== null) points.push(t);
  }
  if (points.length === 0) return null;
  let min = Math.min(...points);
  let max = Math.max(...points);
  if (min === max) {
    // Một mốc duy nhất: nới thành cửa sổ 30 ngày cho có trục mà đặt.
    min -= 15 * DAY_MS;
    max += 15 * DAY_MS;
  }
  const pad = Math.max((max - min) * 0.02, 7 * DAY_MS);
  return { min: min - pad, max: max + pad };
}

/** Vị trí % trên trục (clamp 0..100 — điểm ngoài miền không được văng ra ngoài khung). */
export function datePercent(date: string, domain: TimeDomain): number {
  const t = ms(date);
  if (t === null) return 0;
  const raw = ((t - domain.min) / (domain.max - domain.min)) * 100;
  return Math.min(100, Math.max(0, raw));
}

// ─────────────────────────────────────────────────────────────────────
// Lane: mỗi hợp đồng một hàng, mỗi segment một thanh
// ─────────────────────────────────────────────────────────────────────

export interface LaneBar {
  segIndex: number;
  /** % trên trục */
  left: number;
  width: number;
  openEnded: boolean;
  /** Mốc vào không xác định (fromDate null) — vẽ mờ mép trái. */
  openStarted: boolean;
  trusted: boolean;
  sourcePath: string | null;
}

export interface Lane {
  contractId: string;
  contractNumber: string | null;
  contract: LifecycleContract | null;
  bars: LaneBar[];
  /** Mốc sắp lane: min fromDate của các thanh (null xếp trước — không biết từ bao giờ). */
  sortKey: number;
}

/**
 * Dựng lane từ segments + contracts. Bất biến (unit test giữ):
 *  - mỗi contractId đúng một lane;
 *  - thanh trong lane không chồng nhau và xếp theo thời gian;
 *  - width ≥ 0.5% để thanh một-ngày vẫn nhìn thấy được.
 */
export function buildLanes(
  payload: Pick<LifecyclePayload, 'segments' | 'contracts'>,
  domain: TimeDomain,
  todayISO: string,
): Lane[] {
  const byContract = new Map<string, LifecycleSegment[]>();
  for (const s of payload.segments) {
    const arr = byContract.get(s.contractId) ?? [];
    arr.push(s);
    byContract.set(s.contractId, arr);
  }
  const contractIndex = new Map(payload.contracts.map((c) => [c.id, c]));

  const lanes: Lane[] = [];
  for (const [contractId, segs] of byContract) {
    segs.sort((a, b) => (ms(a.fromDate) ?? -Infinity) - (ms(b.fromDate) ?? -Infinity));
    const bars: LaneBar[] = segs.map((s) => {
      const from = s.fromDate ?? null;
      const to = s.toDate ?? todayISO;
      const left = from ? datePercent(from, domain) : 0;
      const right = datePercent(to, domain);
      return {
        segIndex: s.segIndex,
        left,
        width: Math.max(right - left, 0.5),
        openEnded: s.toDate === null,
        openStarted: s.fromDate === null,
        trusted: s.trusted,
        sourcePath: s.sourcePath,
      };
    });
    lanes.push({
      contractId,
      contractNumber: segs[0]?.contractNumber ?? null,
      contract: contractIndex.get(contractId) ?? null,
      bars,
      sortKey: ms(segs[0]?.fromDate ?? null) ?? -Infinity,
    });
  }
  lanes.sort((a, b) => a.sortKey - b.sortKey);
  return lanes;
}

// ─────────────────────────────────────────────────────────────────────
// Nhãn & tông màu sự kiện — bảng PHẢI phủ đủ taxonomy RPC phát ra
// ─────────────────────────────────────────────────────────────────────

export type EventTone = 'in' | 'out' | 'neutral' | 'warn';

export const EVENT_LABEL: Record<string, { label: string; tone: EventTone }> = {
  CONTRACT_OPENED: { label: 'Mở hợp đồng', tone: 'neutral' },
  ROOM_CHANGED_IN: { label: 'Chuyển đến phòng này', tone: 'neutral' },
  ROOM_CHANGED_OUT: { label: 'Chuyển sang phòng khác', tone: 'neutral' },
  CONTRACT_CLOSED: { label: 'Rời phòng', tone: 'neutral' },
  DEPOSIT_RECEIVED: { label: 'Thu cọc', tone: 'in' },
  INVOICE_ISSUED: { label: 'Phát hành hoá đơn', tone: 'neutral' },
  INVOICE_COLLECTION_POSTED: { label: 'Thu tiền hoá đơn', tone: 'in' },
  TERMINATION_REQUESTED: { label: 'Hồ sơ thanh lý', tone: 'warn' },
  SETTLEMENT_OFFSET_POSTED: { label: 'Cấn cọc thanh lý', tone: 'neutral' },
  DEPOSIT_FORFEIT_POSTED: { label: 'Bỏ cọc', tone: 'out' },
  DEPOSIT_REFUND_POSTED: { label: 'Hoàn cọc (tiền đã ra két)', tone: 'out' },
  COMMISSION_PAID: { label: 'Hoa hồng / thưởng', tone: 'out' },
};

/** Danh sách type RPC phát ra — dùng cho test "bảng nhãn không thiếu type nào". */
export const RPC_EVENT_TYPES = Object.keys(EVENT_LABEL);

export function eventLabel(type: string): { label: string; tone: EventTone } {
  return EVENT_LABEL[type] ?? { label: type, tone: 'neutral' };
}

// ─────────────────────────────────────────────────────────────────────
// Kiểm bất biến vacancy phía client — server tính, client XÁC MINH.
// Server sai thì hiện cảnh báo thay vì vẽ bừa (fail-closed về hiển thị).
// ─────────────────────────────────────────────────────────────────────

export function vacancyProblems(
  payload: Pick<LifecyclePayload, 'segments' | 'vacancies'>,
): string[] {
  const problems: string[] = [];
  for (const v of payload.vacancies) {
    const a = ms(v.fromDate);
    const b = ms(v.toDate);
    if (a === null) {
      problems.push(`vacancy thiếu fromDate`);
      continue;
    }
    if (b !== null && b <= a) problems.push(`vacancy ngược mốc: ${v.fromDate} → ${v.toDate}`);
    if (v.days < 0) problems.push(`vacancy days âm: ${v.days}`);
    // Không được chồng lên một segment ĐÁNG TIN nào
    for (const s of payload.segments) {
      if (!s.trusted) continue;
      const sa = ms(s.fromDate);
      const sb = ms(s.toDate); // null = đang ở
      if (sa === null) continue;
      const vEnd = b ?? Infinity;
      const sEnd = sb ?? Infinity;
      const overlap = Math.max(a, sa) < Math.min(vEnd, sEnd);
      if (overlap) {
        problems.push(
          `vacancy ${v.fromDate}→${v.toDate ?? 'nay'} chồng segment ${s.contractNumber ?? s.contractId}`,
        );
      }
    }
  }
  return problems;
}
