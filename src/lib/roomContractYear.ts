// =============================================================================
// roomContractYear.ts — TOÁN THUẦN của panel "Vòng đời hợp đồng" trên trang
// Báo cáo Lợi Nhuận (bấm số phòng ở cột Khoản thu).
//
// Hai màn:
//   1. Danh sách hợp đồng của MỘT phòng trong MỘT năm: dải thời gian 12 tháng,
//      khoảng phòng trống kèm lý do, thẻ hợp đồng (cách kết thúc + cọc/công nợ).
//   2. Chi tiết một hợp đồng từ ngày vào tới ngày ra: thời hạn, cọc & công nợ
//      hai chiều, diễn biến theo ngày.
//
// ── NGUỒN — không nguồn nào bị tính lại ở đây ──────────────────────────────
//   · Trục thời gian, khoảng trống, sự kiện hoá đơn/thanh lý/hoàn cọc:
//     `get_room_cash_lifecycle_v1` (RPC theo PHÒNG, fail-closed theo toà).
//   · MỌI con số cọc và nợ hoá đơn: `Lane` của `useContractLifecycle` — cọc dựng
//     từ phiếu (không từ `deposit_paid`), nợ từ hoá đơn hiệu lực. KHÔNG lấy
//     `DEPOSIT_RECEIVED.amount` của RPC làm cọc (phiếu hỗn hợp bị cộng dư).
//   · Sang nhượng / gia hạn / SĐT khách / tên phòng chuyển tới: đọc phụ
//     (`RoomContractExtras`) — hỏng thì chỉ mất các mốc đó.
//
// Chưa chứng minh được thì ghi `CHUA_DU_DU_LIEU`, không bao giờ in "0 đ".
// KHÔNG đọc đồng hồ: `todayISO` luôn là tham số.
// =============================================================================

import {
  CHUA_DU_DU_LIEU, cocChuaChungMinh, type Lane, type LifecycleContractRow,
} from '@/lib/contractLifecycle';
import { fmtMoney, fmtNgay } from '@/lib/contractSettlement';
import type { LifecycleContract, LifecycleEvent, LifecyclePayload } from '@/lib/roomLifecycle';

// ─────────────────────────────────────────────────────────────────────
// Kiểu
// ─────────────────────────────────────────────────────────────────────

/**
 * Cách một hợp đồng rời (hoặc chưa rời) phòng này. Sang nhượng KHÔNG nằm đây:
 * `transfer_contract_impl` đổi khách ngay trên hợp đồng cũ, phòng không trống
 * ngày nào — nó là một MỐC trong hợp đồng, không phải cách kết thúc.
 */
export type EndKind = 'active' | 'ontime' | 'early' | 'forfeit' | 'room' | 'expired';

export const END_LABEL: Record<EndKind, string> = {
  active: 'Đang hiệu lực',
  ontime: 'Thanh lý đúng hạn',
  early: 'Thanh lý trước hạn',
  forfeit: 'Bỏ cọc',
  room: 'Chuyển phòng',
  expired: 'Hết hạn · chưa thanh lý',
};

/** Nhãn ngắn cho khoảng phòng trống sau hợp đồng (khớp `vacancyReason.ts`). */
export const VACANCY_LABEL: Record<EndKind, string> = {
  active: 'Trống phòng',
  ontime: 'Thanh lý HĐ',
  early: 'Thanh lý HĐ',
  forfeit: 'Bỏ cọc',
  room: 'Chuyển phòng',
  expired: 'Hết hạn HĐ',
};

/** Tông màu — UI tự ánh xạ sang bảng màu. */
export type Tone = 'green' | 'red' | 'amber' | 'neutral' | 'purple' | 'pink';

export interface Chip { text: string; tone: Tone }

/** Đọc phụ cho sang nhượng / gia hạn / khách — xem `useRoomContractExtras`. */
export interface RoomContractExtras {
  transfers: {
    contractId: string;
    type: string;
    date: string | null;
    oldRoomId: string | null;
    newRoomId: string | null;
    newRoomName: string | null;
  }[];
  extensions: {
    contractId: string;
    date: string | null;
    oldEndDate: string | null;
    newEndDate: string | null;
  }[];
  /** contractId → khách đại diện hiện tại. */
  customers: Map<string, { name: string | null; phone: string | null }>;
}

/**
 * Trạng thái nguồn tiền (lane): `undefined` = đang tải, `null` = đọc lỗi
 * (kèm `lanesError`), Map = đã đọc — hợp đồng không có mục thì chưa đủ dữ liệu.
 */
export type LaneSource = Map<string, Lane> | null | undefined;

// ─────────────────────────────────────────────────────────────────────
// Tiện ích ngày — 'YYYY-MM-DD' → mốc UTC để trừ ra số ngày nguyên
// ─────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const t = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const daysBetween = (a: string, b: string): number => Math.round((t(b) - t(a)) / DAY);
const d10 = (s: string | null | undefined): string | null => (s ? s.slice(0, 10) : null);
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const addDays = (iso: string, n: number): string => new Date(t(iso) + n * DAY).toISOString().slice(0, 10);

/** Số tháng tròn giữa hai ngày (không đủ ngày của tháng cuối thì không tính). */
export function monthsBetween(a: string, b: string): number {
  const m = (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  return Math.max(0, m + (+b.slice(8, 10) >= +a.slice(8, 10) ? 0 : -1));
}

/** Tiền, hoặc "Chưa đủ dữ liệu" khi chưa chứng minh được. */
export const money = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? CHUA_DU_DU_LIEU : fmtMoney(n);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─────────────────────────────────────────────────────────────────────
// Nhịp cư trú: mỗi hợp đồng MỘT nhịp trên phòng này
// ─────────────────────────────────────────────────────────────────────

export interface Stay {
  contract: LifecycleContract;
  /** Ngày vào phòng này (null = chuỗi audit không đủ để biết). */
  from: string | null;
  /** Ngày rời phòng này; null = còn đang ở. */
  to: string | null;
  trusted: boolean;
}

export function buildStays(payload: Pick<LifecyclePayload, 'contracts' | 'segments'>): Stay[] {
  const byId = new Map(payload.contracts.map((c) => [c.id, c]));
  const acc = new Map<string, Stay & { open: boolean }>();
  for (const s of [...payload.segments].sort((a, b) => a.segIndex - b.segIndex)) {
    const c = byId.get(s.contractId);
    if (!c) continue;
    const from = d10(s.fromDate);
    const to = d10(s.toDate);
    const cu = acc.get(s.contractId);
    if (!cu) {
      acc.set(s.contractId, { contract: c, from, to, trusted: s.trusted, open: to === null });
      continue;
    }
    if (from && (!cu.from || from < cu.from)) cu.from = from;
    if (to === null) cu.open = true;
    else if (!cu.to || to > cu.to) cu.to = to;
    cu.trusted = cu.trusted && s.trusted;
  }
  return [...acc.values()]
    .map(({ open, ...s }) => ({ ...s, to: open ? null : s.to }))
    .sort((a, b) => (a.from ?? '').localeCompare(b.from ?? '') || a.contract.id.localeCompare(b.contract.id));
}

// ─────────────────────────────────────────────────────────────────────
// Cách kết thúc
// ─────────────────────────────────────────────────────────────────────

const EFFECTIVE = new Set(['APPROVED', 'COMPLETED']);
const metaStr = (e: LifecycleEvent, k: string): string | null => {
  const v = e.meta?.[k];
  return typeof v === 'string' ? v : null;
};

const eventsOf = (payload: Pick<LifecyclePayload, 'events'>, contractId: string) =>
  payload.events.filter((e) => e.contractId === contractId);

/** Bản thanh lý hiệu lực: ưu tiên lane (đã đọc thẳng bảng), rồi sự kiện RPC. */
function terminationTypeOf(events: LifecycleEvent[], lane: Lane | undefined): string | null {
  if (lane?.termination) return lane.termination.termination_type ?? 'NORMAL';
  const ev = events
    .filter((e) => e.type === 'TERMINATION_REQUESTED' && EFFECTIVE.has(metaStr(e, 'status') ?? ''))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return ev ? metaStr(ev, 'type') ?? 'NORMAL' : null;
}

export function endKindOf(
  stay: Stay,
  events: LifecycleEvent[],
  lane: Lane | undefined,
  todayISO: string,
): EndKind {
  const c = stay.contract;
  const end = d10(c.endDate);
  if (stay.to === null) return end && end < todayISO ? 'expired' : 'active';
  if (events.some((e) => e.type === 'ROOM_CHANGED_OUT' && d10(e.date) === stay.to)) return 'room';
  const type = terminationTypeOf(events, lane);
  if (type === 'FORFEIT') return 'forfeit';
  if (!type && c.status === 'EXPIRED') return 'expired';
  // Kết thúc sớm hơn hạn quá 3 ngày ⇒ trước hạn (dung sai cho chốt sổ lệch ngày).
  return end && daysBetween(stay.to, end) > 3 ? 'early' : 'ontime';
}

// ─────────────────────────────────────────────────────────────────────
// Cọc & công nợ hai chiều — CHỈ từ lane (nguồn đã kiểm chứng)
// ─────────────────────────────────────────────────────────────────────

type Money = number | null;

/** Hình dạng hàng hợp đồng mà `cocChuaChungMinh` cần — chỉ các cột nó đọc. */
const asContractRow = (c: LifecycleContract): LifecycleContractRow => ({
  id: c.id, organization_id: null, contract_number: c.number, room_id: null, status: c.status,
  signed_date: null, start_date: c.startDate, end_date: c.endDate, actual_end_date: c.actualEndDate,
  total_deposit: c.totalDeposit, rent_price: c.rentPrice,
});

export interface BalanceRow { label: string; value: string; tone: Tone; strong: boolean }

export interface Balances {
  /** Cọc thực thu (null = chưa chứng minh). */
  depositPaid: Money;
  /** Cọc còn giữ (null = chưa chứng minh). */
  depositHeld: Money;
  depositShort: Money;
  invoicePaid: Money;
  invoiceDebt: Money;
  tenantOwe: Money;
  landOwe: Money;
  refundDue: Money;
  refundPaid: number;
  chips: Chip[];
  summary: Chip;
  tenantRows: BalanceRow[];
  landRows: BalanceRow[];
}

const sumEvents = (events: LifecycleEvent[], type: string): number =>
  events.filter((e) => e.type === type).reduce((s, e) => s + (num(e.amount) ?? 0), 0);

const add = (a: Money, b: Money): Money => (a === null || b === null ? null : a + b);

export function buildBalances(a: {
  kind: EndKind;
  contract: LifecycleContract;
  events: LifecycleEvent[];
  lane: Lane | undefined;
  lanes: LaneSource;
  roomChangeTo: string | null;
}): Balances {
  const { kind, contract: c, events, lane } = a;
  const loading = a.lanes === undefined;
  const committed = num(c.totalDeposit) ?? 0;
  const unproven = !lane || !lane.deposit || cocChuaChungMinh(asContractRow(c), lane.deposit);
  const depositPaid: Money = unproven ? null : lane!.deposit!.grossCollected;
  const depositHeld: Money = unproven ? null : lane!.deposit!.netHeld;
  const stillHere = kind === 'active' || kind === 'expired';
  const depositShort: Money = !stillHere ? 0 : depositPaid === null ? null : Math.max(0, committed - depositPaid);
  const invoicePaid: Money = lane?.invoice ? lane.invoice.paid : null;
  const invoiceDebt: Money = lane?.invoice ? Math.max(0, lane.invoice.debt) : null;
  const tenantOwe = add(depositShort, invoiceDebt);

  const ended = kind === 'ontime' || kind === 'early';
  const refundDue: Money = ended ? num(lane?.termination?.refund_amount) : null;
  const refundPaid = sumEvents(events, 'DEPOSIT_REFUND_POSTED');
  const landOwe: Money = ended
    ? refundDue === null ? null : Math.max(0, refundDue - refundPaid)
    : kind === 'expired' ? depositHeld
    : 0;
  const settled = num(lane?.termination?.total_deposit);

  // ── Chip trên thẻ hợp đồng ────────────────────────────────────────────
  const dang = (text: string): Chip => ({ text, tone: 'neutral' });
  const chips: Chip[] = [];
  if (loading) {
    chips.push(dang('Đang tải cọc & công nợ…'));
  } else {
    chips.push(
      kind === 'forfeit' ? { text: 'Cọc đã chuyển thành doanh thu', tone: 'neutral' }
      : depositPaid === null ? { text: `Cọc: ${CHUA_DU_DU_LIEU}`, tone: 'neutral' }
      : depositShort && depositShort > 0
        ? { text: `Thiếu cọc ${fmtMoney(depositShort)} (đã đóng ${fmtMoney(depositPaid)}/${fmtMoney(committed)})`, tone: 'red' }
      : { text: `Đủ cọc ${fmtMoney(depositPaid)}`, tone: 'green' },
    );
    chips.push(
      invoiceDebt === null ? { text: `Tiền phòng: ${CHUA_DU_DU_LIEU}`, tone: 'neutral' }
      : invoiceDebt > 0 ? { text: `Khách còn nợ tiền phòng ${fmtMoney(invoiceDebt)}`, tone: 'amber' }
      : { text: 'Khách không nợ tiền phòng', tone: 'green' },
    );
    chips.push(
      ended
        ? refundDue === null ? { text: `Hoàn cọc: ${CHUA_DU_DU_LIEU}`, tone: 'neutral' }
          : refundDue <= 0 ? { text: 'Không phải hoàn cọc', tone: 'neutral' }
          : landOwe && landOwe > 0 ? { text: `Chủ nhà chưa hoàn cọc ${fmtMoney(landOwe)}`, tone: 'red' }
          : { text: `Đã hoàn cọc ${fmtMoney(refundPaid)}`, tone: 'green' }
      : kind === 'forfeit' ? { text: 'Chủ nhà không phải hoàn', tone: 'neutral' }
      : kind === 'room' ? { text: 'Cọc chuyển theo sang phòng mới', tone: 'purple' }
      : kind === 'expired' ? { text: `Chủ nhà đang giữ cọc ${money(depositHeld)} · chờ thanh lý`, tone: 'amber' }
      : { text: `Chủ nhà đang giữ cọc ${money(depositHeld)}`, tone: 'neutral' },
    );
  }

  // ── Dòng tóm tắt ─────────────────────────────────────────────────────
  const summary: Chip = loading
    ? dang('Đang tải cọc & công nợ…')
    : kind === 'active'
      ? tenantOwe === null ? dang(`Công nợ: ${CHUA_DU_DU_LIEU}`)
        : tenantOwe > 0 ? { text: `Khách còn nợ ${fmtMoney(tenantOwe)} · chủ nhà đang giữ cọc ${money(depositHeld)}`, tone: 'amber' }
        : { text: `Không có công nợ · chủ nhà đang giữ cọc ${money(depositHeld)}`, tone: 'green' }
    : kind === 'expired'
      ? {
          text: `Chưa tất toán · cần lập thanh lý${tenantOwe && tenantOwe > 0 ? `, khách còn nợ ${fmtMoney(tenantOwe)}` : ''}`
            + `, hoàn cọc ${money(depositHeld)}`,
          tone: 'red',
        }
    : tenantOwe === null || landOwe === null ? dang(`Chưa đủ dữ liệu để kết luận tất toán`)
    : tenantOwe === 0 && landOwe === 0 ? { text: 'Đã tất toán · khách và chủ nhà không còn nợ nhau', tone: 'green' }
    : {
        text: [
          tenantOwe > 0 ? `Khách còn nợ ${fmtMoney(tenantOwe)}` : '',
          landOwe > 0 ? `Chủ nhà còn nợ khách ${fmtMoney(landOwe)} (chưa hoàn cọc)` : '',
        ].filter(Boolean).join(' · '),
        tone: 'red',
      };

  // ── Hai bảng ─────────────────────────────────────────────────────────
  const row = (label: string, v: Money | string, o: { tone?: Tone; strong?: boolean } = {}): BalanceRow => ({
    label,
    value: typeof v === 'string' ? v : money(v),
    tone: typeof v !== 'string' && v === null ? 'neutral' : o.tone ?? 'neutral',
    strong: !!o.strong,
  });
  const oweTone = (v: Money): Tone => (v !== null && v > 0 ? 'red' : 'green');

  const tenantRows: BalanceRow[] = [
    row('Cọc theo HĐ', committed),
    row('Cọc đã đóng (thực thu)', depositPaid, { tone: depositShort && depositShort > 0 ? 'red' : 'green' }),
    row('Hoá đơn phát sinh', add(invoicePaid, invoiceDebt)),
    row('Đã thu', invoicePaid, { tone: 'green' }),
    ...(kind === 'forfeit' ? [row('Hoá đơn còn nợ khi bỏ cọc', 'Đã huỷ', { tone: 'neutral' })] : []),
    row('Khách còn nợ', tenantOwe, { strong: true, tone: oweTone(tenantOwe) }),
  ];

  const landRows: BalanceRow[] = ended
    ? [
        row('Cọc chốt khi thanh lý', settled),
        row('Khấu trừ khi thanh lý', settled !== null && refundDue !== null ? Math.max(0, settled - refundDue) : null),
        row('Phải hoàn cho khách', refundDue),
        row('Đã hoàn (đã ghi sổ chi)', refundPaid, { tone: refundPaid > 0 ? 'green' : refundDue ? 'red' : 'neutral' }),
        row('Chủ nhà còn nợ khách', landOwe, { strong: true, tone: oweTone(landOwe) }),
      ]
    : kind === 'forfeit'
      ? [
          row('Cọc chốt khi thanh lý', settled),
          row('Chuyển thành doanh thu bỏ cọc', sumEvents(events, 'DEPOSIT_FORFEIT_POSTED') || settled),
          row('Chủ nhà còn nợ khách', 0, { strong: true, tone: 'green' }),
        ]
    : kind === 'room'
      ? [
          row('Cọc còn giữ', depositHeld),
          row(`Chuyển theo sang phòng ${a.roomChangeTo ?? 'mới'}`, depositHeld, { tone: 'purple' }),
          row('Chủ nhà còn nợ khách', 0, { strong: true, tone: 'green' }),
        ]
    : [
        row('Cọc đang giữ', depositHeld),
        kind === 'expired'
          ? row('Phải hoàn khi thanh lý (tạm tính)', depositHeld, { tone: 'red' })
          : row('Hoàn khi kết thúc HĐ', 'Chưa đến hạn'),
        row('Chủ nhà còn nợ khách', landOwe, { strong: true, tone: kind === 'expired' ? oweTone(landOwe) : 'green' }),
      ];

  return {
    depositPaid, depositHeld, depositShort, invoicePaid, invoiceDebt, tenantOwe, landOwe,
    refundDue, refundPaid, chips, summary, tenantRows, landRows,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Lý do / ghi chú kết thúc
// ─────────────────────────────────────────────────────────────────────

export function reasonOf(a: {
  kind: EndKind;
  stay: Stay;
  events: LifecycleEvent[];
  lane: Lane | undefined;
  extras: RoomContractExtras | null;
  roomChangeTo: string | null;
  todayISO: string;
  lanes: LaneSource;
}): string {
  const { kind, stay, lane } = a;
  const c = stay.contract;
  const end = d10(c.endDate);
  const refund = num(lane?.termination?.refund_amount);
  const settled = num(lane?.termination?.total_deposit);
  const refundText = refund === null ? ''
    : ` · hoàn cọc ${fmtMoney(refund)}${settled !== null && settled > refund ? ` (khấu trừ ${fmtMoney(settled - refund)})` : ''}`;
  const noRecord = (kind === 'ontime' || kind === 'early') && !lane?.termination && a.lanes !== undefined
    ? ' · chưa có hồ sơ thanh lý hiệu lực' : '';
  const pending = a.events.some(
    (e) => e.type === 'TERMINATION_REQUESTED' && !EFFECTIVE.has(metaStr(e, 'status') ?? ''),
  ) ? ' · có hồ sơ thanh lý chờ duyệt' : '';
  const tenantChanges = (a.extras?.transfers ?? []).filter(
    (x) => x.contractId === c.id && x.type !== 'ROOM_CHANGE' && x.date,
  );
  const sang = tenantChanges.length
    ? ` · có sang nhượng ${tenantChanges.map((x) => fmtNgay(x.date)).join(', ')}` : '';

  switch (kind) {
    case 'ontime': return `Hết hạn, không gia hạn${refundText}${noRecord}${sang}`;
    case 'early':
      return `Trả phòng trước hạn ${end && stay.to ? daysBetween(stay.to, end) : '?'} ngày${refundText}${noRecord}${sang}`;
    case 'forfeit': return `Khách bỏ cọc · cọc chuyển thành doanh thu, không hoàn${sang}`;
    case 'room': return `Chuyển sang phòng ${a.roomChangeTo ?? 'khác'} · cọc chuyển theo hợp đồng${sang}`;
    case 'expired':
      return c.status === 'EXPIRED'
        ? `Đã hết hạn ${end ? daysBetween(end, stay.to ?? a.todayISO) : '?'} ngày, chưa lập thanh lý · cọc đang giữ${pending}${sang}`
        : `Quá hạn ${end ? daysBetween(end, a.todayISO) : '?'} ngày, chưa gia hạn hay thanh lý · cọc đang giữ${pending}${sang}`;
    default: {
      const cameIn = a.events.some((e) => e.type === 'ROOM_CHANGED_IN');
      return `${cameIn ? 'Chuyển đến từ phòng khác' : ''}${pending}${sang}`.replace(/^ · /, '');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Màn 1 — danh sách theo năm
// ─────────────────────────────────────────────────────────────────────

export interface ContractCard {
  id: string;
  number: string;
  tenant: string;
  kind: EndKind;
  status: string;
  inText: string;
  outText: string;
  /** Có ngày rời thật (khác "hạn"). */
  hasOut: boolean;
  duration: string;
  reason: string;
  rentText: string;
  depositText: string;
  invoiceCount: number;
  paidYear: number;
  chips: Chip[];
}

export type LifecycleItem =
  | { type: 'gap'; key: string; text: string }
  | { type: 'contract'; key: string; card: ContractCard };

export interface GanttBar {
  contractId: string;
  kind: EndKind;
  label: string;
  title: string;
  left: number;
  width: number;
}

export interface Kpi { label: string; value: string; sub: string; tone: 'white' | 'mint' | 'gold' | 'peach' }

export interface RoomYearView {
  year: number;
  items: LifecycleItem[];
  contractCount: number;
  bars: GanttBar[];
  /** % vị trí hôm nay trên trục năm, hoặc null khi không phải năm hiện tại. */
  todayLeft: number | null;
  currentMonth: number | null;
  kpis: Kpi[];
  /** Năm sớm nhất có dữ liệu — chặn nút lùi năm. */
  minYear: number;
  maxYear: number;
  diagnostics: string[];
}

export interface RoomYearInput {
  payload: LifecyclePayload;
  year: number;
  todayISO: string;
  lanes: LaneSource;
  extras: RoomContractExtras | null;
}

export function tenantName(c: LifecycleContract, lane: Lane | undefined, extras: RoomContractExtras | null): string {
  const a = extras?.customers.get(c.id)?.name?.trim();
  if (a) return a;
  const b = lane?.customer?.trim();
  if (b && b !== 'Chưa có tên khách') return b;
  return c.tenantName?.trim() || 'Chưa có tên khách';
}

const roomChangeTarget = (contractId: string, extras: RoomContractExtras | null, roomId: string): string | null =>
  extras?.transfers.find((x) => x.contractId === contractId && x.type === 'ROOM_CHANGE' && x.oldRoomId === roomId)
    ?.newRoomName ?? null;

/** Năm của kỳ hoá đơn (meta.billingMonth 'YYYY-MM'), rơi về năm của ngày. */
const billingYear = (e: LifecycleEvent): number => {
  const bm = metaStr(e, 'billingMonth');
  return +(bm ?? e.date).slice(0, 4);
};

export function contractContext(input: Omit<RoomYearInput, 'year'>, stay: Stay) {
  const c = stay.contract;
  const events = eventsOf(input.payload, c.id);
  const lane = input.lanes ? input.lanes.get(c.id) : undefined;
  const kind = endKindOf(stay, events, lane, input.todayISO);
  const roomChangeTo = roomChangeTarget(c.id, input.extras, input.payload.room.id);
  return { c, events, lane, kind, roomChangeTo };
}

export function buildRoomYear(input: RoomYearInput): RoomYearView {
  const { payload, year, todayISO } = input;
  const ys = `${year}-01-01`;
  const ye = `${year}-12-31`;
  const yNext = `${year + 1}-01-01`;
  const span = daysBetween(ys, yNext);
  const pos = (iso: string) => Math.max(0, Math.min(100, (daysBetween(ys, iso) / span) * 100));
  const thisYear = +todayISO.slice(0, 4);

  const stays = buildStays(payload);
  const inYear = stays.filter((s) => (s.from ?? ys) <= ye && (s.to ?? todayISO) >= ys);

  const collections = payload.events.filter((e) => e.type === 'INVOICE_COLLECTION_POSTED');
  const cards: { from: string; item: LifecycleItem; ctx: ReturnType<typeof contractContext>; stay: Stay }[] = [];
  for (const s of inYear) {
    const ctx = contractContext(input, s);
    const { c, events, lane, kind, roomChangeTo } = ctx;
    const end = d10(c.endDate);
    const outDate = s.to ?? end;
    const mo = s.from && outDate ? monthsBetween(s.from, outDate) : null;
    const bal = buildBalances({ kind, contract: c, events, lane, lanes: input.lanes, roomChangeTo });
    const card: ContractCard = {
      id: c.id,
      number: c.number ?? '—',
      tenant: tenantName(c, lane, input.extras),
      kind,
      status: END_LABEL[kind],
      inText: fmtNgay(s.from),
      outText: s.to ? fmtNgay(s.to) : `${fmtNgay(end)} (hạn)`,
      hasOut: !!s.to,
      duration: mo === null ? '' : s.to ? `${mo} tháng` : `hạn ${mo + 1} tháng`,
      reason: reasonOf({ kind, stay: s, events, lane, extras: input.extras, roomChangeTo, todayISO, lanes: input.lanes }),
      rentText: money(num(c.rentPrice)),
      depositText: money(num(c.totalDeposit)),
      invoiceCount: events.filter((e) => e.type === 'INVOICE_ISSUED').length,
      paidYear: collections
        .filter((e) => e.contractId === c.id && billingYear(e) === year)
        .reduce((sum, e) => sum + (num(e.amount) ?? 0), 0),
      chips: bal.chips,
    };
    cards.push({ from: s.from ?? ys, item: { type: 'contract', key: c.id, card }, ctx, stay: s });
  }

  // Khoảng trống: server tính (chuẩn island), client chỉ gắn lý do + lọc năm.
  const gaps: { from: string; item: LifecycleItem }[] = [];
  for (const v of payload.vacancies) {
    const from = d10(v.fromDate);
    if (!from) continue;
    const to = d10(v.toDate);
    if (from > ye || (to ?? todayISO) < ys) continue;
    const before = cards
      .filter((x) => x.stay.to && x.stay.to <= from)
      .sort((a, b) => (b.stay.to ?? '').localeCompare(a.stay.to ?? ''))[0]
      ?? stays.filter((x) => x.to && x.to <= from).sort((a, b) => (b.to ?? '').localeCompare(a.to ?? ''))
        .map((x) => ({ ctx: contractContext(input, x) }))[0];
    const why = before ? VACANCY_LABEL[before.ctx.kind] : 'Trống phòng';
    const text = to
      ? `Phòng trống ${v.days} ngày · ${ddmm(from)} → ${ddmm(addDays(to, -1))} — ${why}`
      : `Phòng trống ${v.days} ngày từ ${ddmm(from)} — ${why}`;
    gaps.push({ from, item: { type: 'gap', key: `gap-${from}`, text } });
  }

  const items = [...cards, ...gaps]
    .sort((a, b) => a.from.localeCompare(b.from) || (a.item.type === 'gap' ? 1 : -1))
    .map((x) => x.item);

  const bars: GanttBar[] = cards
    .filter((x) => x.stay.from)
    .map(({ stay: s, ctx, item }) => {
      const card = (item as { card: ContractCard }).card;
      const end = d10(s.contract.endDate);
      const stop = s.to ?? (end && end > todayISO ? end : todayISO);
      const l = pos(s.from!);
      const r = pos(addDays(stop, 1));
      const last = card.tenant.split(/\s+/).pop() ?? card.tenant;
      return {
        contractId: s.contract.id,
        kind: ctx.kind,
        label: `${last} · ${ddmm(s.from!)}–${ddmm(stop)}`,
        title: `${card.number} · ${card.tenant}`,
        left: l,
        width: Math.max(r - l, 0.5),
      };
    });

  // Lấp đầy: hợp các nhịp ĐÁNG TIN trong [đầu năm, min(hôm nay, cuối năm)].
  const cap = year === thisYear ? todayISO : ye;
  const elapsed = year > thisYear ? 0 : daysBetween(ys, cap) + 1;
  const occupied = new Set<number>();
  for (const s of stays) {
    if (!s.trusted || !s.from) continue;
    const a = s.from > ys ? s.from : ys;
    const bRaw = s.to ?? todayISO;
    const b = bRaw < cap ? bRaw : cap;
    for (let i = daysBetween(ys, a); i <= daysBetween(ys, b); i++) if (i >= 0) occupied.add(i);
  }
  const occ = elapsed > 0 ? Math.min(100, Math.round((occupied.size / elapsed) * 100)) : null;
  const paidYear = collections
    .filter((e) => billingYear(e) === year)
    .reduce((sum, e) => sum + (num(e.amount) ?? 0), 0);
  const endedLabels = cards.filter((x) => x.ctx.kind !== 'active').map((x) => VACANCY_LABEL[x.ctx.kind]);

  const firstYear = stays.reduce(
    (m, s) => (s.from ? Math.min(m, +s.from.slice(0, 4)) : m),
    Math.min(year, thisYear),
  );

  const diagnostics: string[] = [];
  if (stays.some((s) => !s.trusted)) diagnostics.push('Lịch sử cư trú của phòng có đoạn chưa đủ tin cậy — mốc ngày có thể lệch');

  return {
    year,
    items,
    contractCount: cards.length,
    bars,
    todayLeft: year === thisYear ? pos(todayISO) : null,
    currentMonth: year === thisYear ? +todayISO.slice(5, 7) - 1 : null,
    kpis: [
      { label: 'SỐ HỢP ĐỒNG', value: String(cards.length), sub: endedLabels.join(' · ') || 'Không có HĐ kết thúc', tone: 'white' },
      {
        label: 'LẤP ĐẦY',
        value: occ === null ? '—' : `${occ}%`,
        sub: year === thisYear ? `Tính tới ${fmtNgay(todayISO)}` : year > thisYear ? 'Năm chưa tới' : `Cả năm ${year}`,
        tone: 'mint',
      },
      { label: 'ĐÃ THU TỪ PHÒNG', value: fmtMoney(paidYear), sub: `Hoá đơn kỳ ${year} · không gồm cọc`, tone: 'mint' },
    ],
    minYear: firstYear,
    maxYear: thisYear,
    diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Màn 2 — chi tiết một hợp đồng từ ngày vào tới ngày ra
// ─────────────────────────────────────────────────────────────────────

export type EventKind =
  | 'dep' | 'in' | 'inv' | 'owe' | 'mark' | 'out' | 'ref' | 'now' | 'future' | 'forfeit' | 'transfer';

export interface DetailEvent {
  key: string;
  date: string;
  title: string;
  sub: string;
  amt: string;
  amtTone: Tone | 'ink' | 'orange';
  note: string;
  noteTone: Tone | 'muted';
  kind: EventKind;
}

export interface ContractDetailView {
  contractId: string;
  number: string;
  tenant: string;
  kind: EndKind;
  status: string;
  reason: string;
  inText: string;
  outLabel: string;
  outText: string;
  pct: number;
  progressText: string;
  tiles: { label: string; value: string; sub: string }[];
  balances: Balances;
  events: DetailEvent[];
  kpis: Kpi[];
}

const ORDER: Record<EventKind, number> = {
  dep: 0, in: 1, inv: 2, owe: 3, mark: 4, transfer: 5, out: 6, forfeit: 6, ref: 7, now: 8, future: 9,
};

export function buildContractDetail(input: Omit<RoomYearInput, 'year'>, contractId: string): ContractDetailView | null {
  const stay = buildStays(input.payload).find((s) => s.contract.id === contractId);
  if (!stay) return null;
  const { todayISO } = input;
  const { c, events, lane, kind, roomChangeTo } = contractContext(input, stay);
  const bal = buildBalances({ kind, contract: c, events, lane, lanes: input.lanes, roomChangeTo });
  const start = d10(c.startDate) ?? stay.from;
  const end = d10(c.endDate);
  const leave = stay.to;
  const tenant = tenantName(c, lane, input.extras);
  const phone = input.extras?.customers.get(c.id)?.phone ?? null;

  const total = start && end ? Math.max(1, daysBetween(start, end)) : null;
  const done = start && total ? Math.min(Math.max(0, daysBetween(start, leave ?? todayISO)), total) : 0;
  const stayFrom = stay.from ?? start;
  const stayDays = stayFrom ? daysBetween(stayFrom, leave ?? todayISO) + 1 : null;
  const stayMonths = stayFrom ? monthsBetween(stayFrom, leave ?? todayISO) : null;
  const invCount = events.filter((e) => e.type === 'INVOICE_ISSUED').length;

  // ── Diễn biến ────────────────────────────────────────────────────────
  const ev: DetailEvent[] = [];
  const push = (e: Omit<DetailEvent, 'key'>) => ev.push({ ...e, key: `${ev.length}` });
  const blank = { amt: '', amtTone: 'ink' as const, note: '', noteTone: 'muted' as const };

  // Cọc: từ CHỨNG TỪ của lane (không từ DEPOSIT_RECEIVED của RPC).
  if (lane?.deposit && !cocChuaChungMinh(asContractRow(c), lane.deposit)) {
    for (const e of lane.deposit.evidence) {
      if (e.direction !== 'IN' || !e.date) continue;
      push({
        date: e.date.slice(0, 10),
        title: e.bucket === 'REAL_CASH' ? 'Thu cọc' : 'Ghi nhận cọc lịch sử (sổ ảo)',
        sub: `Phiếu ${e.code ?? 'chưa có mã'}${e.verification === 'verified' ? '' : ' · chưa đối chiếu bút toán'}`,
        amt: fmtMoney(e.amount), amtTone: 'green', note: 'Không tính KQKD', noteTone: 'muted', kind: 'dep',
      });
    }
  } else if (input.lanes !== undefined && (num(c.totalDeposit) ?? 0) > 0 && start) {
    push({
      date: start, title: 'Cọc', sub: `Cam kết ${fmtMoney(num(c.totalDeposit) ?? 0)} · chưa chứng minh được phiếu thu cọc`,
      amt: CHUA_DU_DU_LIEU, amtTone: 'neutral', note: '', noteTone: 'muted', kind: 'owe',
    });
  }

  const opened = events.find((e) => e.type === 'CONTRACT_OPENED' || e.type === 'ROOM_CHANGED_IN');
  if (stayFrom) {
    push({
      ...blank,
      date: stayFrom,
      title: opened?.type === 'ROOM_CHANGED_IN' ? 'Chuyển đến phòng này' : 'Ký hợp đồng & nhận phòng',
      sub: `${c.number ?? '—'} · thời hạn ${fmtNgay(c.startDate)} → ${fmtNgay(c.endDate)}`,
      kind: 'in',
    });
  }

  // Hoá đơn: gộp phát hành + đã thu theo KỲ.
  const byMonth = new Map<string, { issued: number; paid: number; n: number; date: string; paidDate: string | null }>();
  for (const e of events) {
    if (e.type !== 'INVOICE_ISSUED' && e.type !== 'INVOICE_COLLECTION_POSTED') continue;
    const k = metaStr(e, 'billingMonth') ?? e.date.slice(0, 7);
    const g = byMonth.get(k) ?? { issued: 0, paid: 0, n: 0, date: e.date.slice(0, 10), paidDate: null };
    if (e.type === 'INVOICE_ISSUED') {
      g.issued += num(e.amount) ?? 0;
      g.n += 1;
      if (e.date.slice(0, 10) < g.date) g.date = e.date.slice(0, 10);
    } else {
      g.paid += num(e.amount) ?? 0;
      g.paidDate = e.date.slice(0, 10);
    }
    byMonth.set(k, g);
  }
  const months = [...byMonth.keys()].sort();
  months.forEach((k, i) => {
    const g = byMonth.get(k)!;
    const lbl = `${k.slice(5, 7)}/${k.slice(0, 4)}`;
    const full = g.issued > 0 && g.paid >= g.issued - 0.5;
    const title = i === 0 ? `Tiền phòng tháng đầu tiên – ${lbl}`
      : leave && i === months.length - 1 ? `Tiền phòng tháng cuối – ${lbl}`
      : `Tiền phòng – ${lbl}`;
    push({
      date: g.date,
      title,
      sub: `Hoá đơn kỳ ${lbl}${g.n > 1 ? ` · ${g.n} hoá đơn` : ''}${g.paidDate && g.paid > 0 ? ` · thu ngày ${fmtNgay(g.paidDate)}` : ''}`,
      amt: g.n > 0 ? fmtMoney(g.issued) : '',
      amtTone: 'green',
      note: full ? 'Đã thu' : g.paid > 0 ? `Còn thiếu ${fmtMoney(g.issued - g.paid)}` : g.n > 0 ? 'Chưa thu' : `Đã thu ${fmtMoney(g.paid)}`,
      noteTone: full ? 'green' : 'amber',
      kind: full || g.n === 0 ? 'inv' : 'owe',
    });
  });

  for (const x of input.extras?.extensions ?? []) {
    if (x.contractId !== c.id || !x.date) continue;
    push({
      ...blank, date: x.date.slice(0, 10), title: 'Gia hạn hợp đồng',
      sub: `Hạn cũ ${fmtNgay(x.oldEndDate)} → hạn mới ${fmtNgay(x.newEndDate)}`, kind: 'mark',
    });
  }
  for (const x of input.extras?.transfers ?? []) {
    if (x.contractId !== c.id || x.type === 'ROOM_CHANGE' || !x.date) continue;
    push({
      ...blank, date: x.date.slice(0, 10), title: 'Sang nhượng hợp đồng',
      sub: 'Đổi khách đại diện trên cùng hợp đồng · phòng không trống ngày nào',
      note: 'Cọc chuyển cho khách mới', noteTone: 'purple', kind: 'transfer',
    });
  }

  const refund = num(lane?.termination?.refund_amount);
  for (const e of events) {
    const date = e.date.slice(0, 10);
    const amt = num(e.amount);
    switch (e.type) {
      case 'TERMINATION_REQUESTED': {
        const eff = EFFECTIVE.has(metaStr(e, 'status') ?? '');
        const forfeit = metaStr(e, 'type') === 'FORFEIT';
        push({
          date,
          title: !eff ? 'Hồ sơ thanh lý (chưa duyệt)'
            : forfeit ? 'Khách bỏ cọc · thanh lý HĐ'
            : kind === 'early' ? 'Thanh lý trước hạn' : 'Thanh lý hợp đồng',
          sub: forfeit ? 'Không hoàn cọc · hoá đơn còn nợ bị huỷ'
            : end && leave ? `Trả phòng ${fmtNgay(leave)}${daysBetween(leave, end) > 3 ? ` · sớm ${daysBetween(leave, end)} ngày so với hạn` : ''}`
            : 'Chốt điện nước, kiểm tra tài sản',
          amt: forfeit ? '' : money(amt),
          amtTone: 'ink',
          note: forfeit ? '' : 'Quyết toán hoàn',
          noteTone: 'muted',
          kind: forfeit ? 'forfeit' : eff ? 'out' : 'mark',
        });
        break;
      }
      case 'SETTLEMENT_OFFSET_POSTED':
        push({ date, title: 'Cấn cọc khi thanh lý', sub: `Phiếu ${metaStr(e, 'code') ?? '—'}`, amt: money(amt), amtTone: 'ink', note: 'Trừ nợ vào cọc', noteTone: 'muted', kind: 'mark' });
        break;
      case 'DEPOSIT_FORFEIT_POSTED':
        push({ date, title: 'Cọc chuyển thành doanh thu', sub: `Phiếu ${metaStr(e, 'code') ?? '—'}`, amt: money(amt), amtTone: 'green', note: 'Doanh thu bỏ cọc', noteTone: 'red', kind: 'forfeit' });
        break;
      case 'DEPOSIT_REFUND_POSTED':
        push({ date, title: 'Hoàn cọc cho khách', sub: `Phiếu chi ${metaStr(e, 'code') ?? '—'}`, amt: amt === null ? CHUA_DU_DU_LIEU : `−${fmtMoney(amt)}`, amtTone: 'orange', note: 'Tiền đã ra két', noteTone: 'muted', kind: 'ref' });
        break;
      case 'COMMISSION_PAID':
        push({ date, title: 'Hoa hồng / thưởng', sub: metaStr(e, 'name') ?? `Phiếu ${metaStr(e, 'code') ?? '—'}`, amt: amt === null ? '' : `−${fmtMoney(amt)}`, amtTone: 'orange', note: '', noteTone: 'muted', kind: 'mark' });
        break;
      case 'ROOM_CHANGED_OUT':
        push({ date, title: `Chuyển sang phòng ${roomChangeTo ?? 'khác'}`, sub: 'Kết thúc ở phòng này · phòng trống từ hôm sau', amt: '', amtTone: 'ink', note: 'Cọc chuyển theo', noteTone: 'purple', kind: 'transfer' });
        break;
      case 'CONTRACT_CLOSED':
        if (!events.some((x) => x.type === 'TERMINATION_REQUESTED' && x.date.slice(0, 10) === date)) {
          push({ ...blank, date, title: 'Trả phòng', sub: kind === 'expired' ? 'Hết hạn hợp đồng' : 'Kết thúc ở phòng này', kind: 'out' });
        }
        break;
      default:
        break;
    }
  }

  if ((kind === 'ontime' || kind === 'early') && refund !== null && bal.landOwe !== null && bal.landOwe > 0 && leave) {
    push({
      date: leave, title: 'Chưa hoàn cọc cho khách',
      sub: `Phải hoàn ${fmtMoney(refund)} · đã hoàn ${fmtMoney(bal.refundPaid)}`,
      amt: fmtMoney(bal.landOwe), amtTone: 'red', note: 'Chủ nhà còn nợ khách', noteTone: 'red', kind: 'owe',
    });
  }
  if (kind === 'expired' && end) {
    push({ ...blank, date: end, title: 'Hết hạn hợp đồng', sub: 'Không gia hạn · chưa lập thanh lý', kind: 'owe' });
    if (!leave) {
      push({
        date: todayISO, title: 'Hôm nay · chưa thanh lý',
        sub: `Quá hạn ${daysBetween(end, todayISO)} ngày · cần thanh lý và hoàn cọc ${money(bal.depositHeld)}`,
        amt: '', amtTone: 'ink', note: 'Cần xử lý', noteTone: 'pink', kind: 'now',
      });
    }
  }
  if (kind === 'active') {
    push({ ...blank, date: todayISO, title: 'Hôm nay · đang ở', sub: end ? `Còn ${daysBetween(todayISO, end)} ngày tới hạn hợp đồng` : 'Chưa có ngày hết hạn', kind: 'now' });
    if (end) push({ ...blank, date: end, title: 'Ngày hết hạn dự kiến', sub: 'Chưa có thông báo trả phòng', kind: 'future' });
  }

  ev.sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.kind] - ORDER[b.kind]);

  const outLabel = leave ? 'NGÀY RA' : 'HẾT HẠN';
  const progressText = kind === 'expired' && end
    ? `Quá hạn ${daysBetween(end, leave ?? todayISO)} ngày`
    : leave && total !== null ? `Ở ${stayDays} ngày / hạn ${total + 1} ngày`
    : end ? `Đã ở ${stayDays ?? '?'} ngày · còn ${daysBetween(todayISO, end)} ngày` : '';

  const depNote = kind === 'forfeit' ? 'Chuyển thành doanh thu'
    : kind === 'room' ? 'Chuyển theo sang phòng mới'
    : kind === 'ontime' || kind === 'early'
      ? bal.refundDue === null ? `Hoàn cọc: ${CHUA_DU_DU_LIEU}` : `Quyết toán hoàn ${fmtMoney(bal.refundDue)}`
    : bal.depositPaid === null ? `Thực thu: ${CHUA_DU_DU_LIEU}` : `Thực thu ${fmtMoney(bal.depositPaid)}`;

  return {
    contractId: c.id,
    number: c.number ?? '—',
    tenant,
    kind,
    status: END_LABEL[kind],
    reason: reasonOf({ kind, stay, events, lane, extras: input.extras, roomChangeTo, todayISO, lanes: input.lanes }),
    inText: fmtNgay(stayFrom),
    outLabel,
    outText: fmtNgay(leave ?? end),
    pct: total ? Math.round((done / total) * 100) : 0,
    progressText,
    tiles: [
      { label: 'Khách thuê', value: tenant, sub: phone ?? '—' },
      { label: 'Giá thuê', value: money(num(c.rentPrice)), sub: 'mỗi tháng' },
      { label: 'Tiền cọc', value: money(num(c.totalDeposit)), sub: depNote },
      {
        label: 'Thời gian ở',
        value: stayMonths === null ? '—' : `${stayMonths} tháng`,
        sub: `${stayDays ?? '?'} ngày · ${invCount} hoá đơn`,
      },
    ],
    balances: bal,
    events: ev,
    kpis: [
      { label: 'ĐÃ THU', value: money(bal.invoicePaid), sub: 'Tiền phòng + dịch vụ, không gồm cọc', tone: 'mint' },
      {
        label: 'KHÁCH CÒN NỢ',
        value: money(bal.tenantOwe),
        sub: bal.tenantOwe && bal.tenantOwe > 0 ? 'Cọc thiếu + hoá đơn chưa thu' : bal.tenantOwe === 0 ? 'Không nợ' : '',
        tone: bal.tenantOwe && bal.tenantOwe > 0 ? 'gold' : 'white',
      },
      {
        label: 'CHỦ NHÀ CÒN NỢ KHÁCH',
        value: money(bal.landOwe),
        // Đang ở: 0 là kết luận cấu trúc (cọc chưa tới hạn hoàn), không phải số đọc được.
        sub: bal.landOwe && bal.landOwe > 0 ? (kind === 'expired' ? 'Cọc đang giữ · chờ thanh lý' : 'Cọc chưa hoàn')
          : kind === 'active' ? 'Chưa đến hạn hoàn cọc' : depNote,
        tone: bal.landOwe && bal.landOwe > 0 ? 'peach' : 'white',
      },
    ],
  };
}
