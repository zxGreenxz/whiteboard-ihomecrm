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
//   · RPC mới (đợt "vòng đời tiền một nguồn"): tiền hoá đơn và hoàn tiền lấy
//     `contract.money` (F2/F3, tính một lượt trong DB) — 3 số tổng THEO PHÒNG
//     đang xem, cọc vẫn theo HĐ. Payload RPC cũ (vắng `money`, `meta.invoiceId`,
//     `meta.voucherId`) ⇒ giữ nguyên đường cũ tới khi gỡ ở S22.
//
// Chưa chứng minh được thì ghi `CHUA_DU_DU_LIEU`, không bao giờ in "0 đ".
// KHÔNG đọc đồng hồ: `todayISO` luôn là tham số.
// =============================================================================

import {
  CHUA_DU_DU_LIEU, cocChuaChungMinh, type Lane, type LifecycleContractRow,
} from '@/lib/contractLifecycle';
import { fmtMoney, fmtNgay } from '@/lib/contractSettlement';
import {
  COMMISSION_KIND_LABEL, LIFECYCLE_EVENT_TYPES, STAGE_TEXT, commissionEventOf, termText,
  type CommissionStage, type InvoiceKind, type LifecycleContract, type LifecycleEvent, type LifecyclePayload,
} from '@/lib/roomLifecycle';

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

export interface Chip {
  text: string;
  tone: Tone;
  /** Đang đọc: màn vẽ vạch xám thay chữ, `text` chỉ còn cho trình đọc màn hình (chủ chốt 02/10/2026). */
  loading?: true;
}

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
  /** Phần cọc đã hoàn (RPC mới: dòng cọc trên phiếu đã trả; RPC cũ: cả phiếu). */
  refundPaid: number;
  chips: Chip[];
  summary: Chip;
  tenantRows: BalanceRow[];
  landRows: BalanceRow[];
  /** HĐ có hoá đơn ở ≥2 phòng: dòng nhỏ tổng cả HĐ dưới 3 số tổng (số tổng tính theo phòng). */
  contractLine: string | null;
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
  // Khối tiền một nguồn của RPC mới; vắng ⇒ RPC cũ, đọc lane như trước.
  const m = c.money;
  const loading = a.lanes === undefined;
  const committed = num(c.totalDeposit) ?? 0;
  const unproven = !lane || !lane.deposit || cocChuaChungMinh(asContractRow(c), lane.deposit);
  const depositPaid: Money = unproven ? null : lane!.deposit!.grossCollected;
  const depositHeld: Money = unproven ? null : lane!.deposit!.netHeld;
  const stillHere = kind === 'active' || kind === 'expired';
  const depositShort: Money = !stillHere ? 0 : depositPaid === null ? null : Math.max(0, committed - depositPaid);
  // Theo PHÒNG đang xem (chủ chốt): tiền thật khách nộp, không cọc, không cấn trừ.
  const invoicePaid: Money = m ? m.room.paidCash : lane?.invoice ? lane.invoice.paid : null;
  const invoiceDebt: Money = m ? m.room.debt : lane?.invoice ? Math.max(0, lane.invoice.debt) : null;
  const tenantOwe = add(depositShort, invoiceDebt);

  const ended = kind === 'ontime' || kind === 'early';
  // F3: phiếu hoàn tách dòng cọc / dòng ngoài cọc; "Phải hoàn" = refund_amount
  // của quyết toán kể cả khi phiếu bị sửa lệch (chủ chốt, kèm cảnh báo).
  const r = m?.refund ?? null;
  const warnings = r?.warnings ?? [];
  const noTermination = warnings.includes('NO_EFFECTIVE_TERMINATION');
  const refundDue: Money = !ended ? null : m ? (r ? num(r.depositDue) : null) : num(lane?.termination?.refund_amount);
  const refundPaid = m ? r?.depositPaid ?? 0 : sumEvents(events, 'DEPOSIT_REFUND_POSTED');
  const otherDue = r?.otherDue ?? 0;
  const otherPaid = r?.otherPaid ?? 0;
  const landOwe: Money = ended
    ? m ? r?.owed ?? null : refundDue === null ? null : Math.max(0, refundDue - refundPaid)
    // Tiền đã ra qua phiếu hoàn mà chưa có thanh lý hiệu lực: không được lấy
    // cọc đang giữ (hay số 0 "chưa đến hạn") làm kết luận.
    : noTermination ? null
    : kind === 'expired' ? depositHeld
    : 0;
  const depositStillOwed = refundDue !== null && refundDue - refundPaid > 0.5;
  // refund_amount là cột GENERATED (cọc − khấu trừ) nên có thể âm: âm = không phải hoàn cọc (như SQL kẹp
  // GREATEST(depositDue, 0)) — hiển thị 0, không in số âm cạnh "Chủ nhà còn nợ khách".
  const refundShown: Money = refundDue === null ? null : Math.max(0, refundDue);
  const settled = num(lane?.termination?.total_deposit);

  // ── Chip trên thẻ hợp đồng ────────────────────────────────────────────
  const dang = (text: string): Chip => ({ text, tone: 'neutral' });
  const chips: Chip[] = [];
  if (loading) {
    chips.push({ ...dang('Đang tải cọc & công nợ…'), loading: true });
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
          // Còn nợ xét TRƯỚC "không phải hoàn cọc": phiếu có thể còn tiền thừa phải trả.
          : landOwe && landOwe > 0
            ? { text: `${depositStillOwed ? 'Chủ nhà chưa hoàn cọc' : 'Chủ nhà chưa trả khách'} ${fmtMoney(landOwe)}`, tone: 'red' }
          : refundDue <= 0
            ? { text: m && refundPaid + otherPaid > 0 ? `Không phải hoàn cọc · đã trả khách ${fmtMoney(refundPaid + otherPaid)}` : 'Không phải hoàn cọc', tone: 'neutral' }
          : { text: `Đã hoàn cọc ${fmtMoney(refundPaid)}${otherPaid > 0 ? ` · trả thêm ${fmtMoney(otherPaid)}` : ''}`, tone: 'green' }
      : kind === 'forfeit' ? { text: 'Chủ nhà không phải hoàn', tone: 'neutral' }
      : kind === 'room' ? { text: 'Cọc chuyển theo sang phòng mới', tone: 'purple' }
      : kind === 'expired' ? { text: `Chủ nhà đang giữ cọc ${money(depositHeld)} · chờ thanh lý`, tone: 'amber' }
      : { text: `Chủ nhà đang giữ cọc ${money(depositHeld)}`, tone: 'neutral' },
    );
    if (noTermination) {
      chips.push({ text: 'Có phiếu hoàn nhưng chưa có thanh lý hiệu lực', tone: 'amber' });
    }
    if (r && warnings.includes('DEPOSIT_LINE_MISMATCH')) {
      chips.push({
        text: `Phiếu hoàn lệch quyết toán: phiếu ghi cọc ${fmtMoney(r.depositOnVouchers)}, quyết toán ${money(r.depositDue === null ? null : Math.max(0, r.depositDue))}`,
        tone: 'amber',
      });
    }
  }

  // ── Dòng tóm tắt ─────────────────────────────────────────────────────
  const summary: Chip = loading
    ? { ...dang('Đang tải cọc & công nợ…'), loading: true }
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
          landOwe > 0 ? `Chủ nhà còn nợ khách ${fmtMoney(landOwe)} (${depositStillOwed ? 'chưa hoàn cọc' : 'chưa trả tiền thừa'})` : '',
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

  // Thừa đã trừ kỳ sau / khi thanh lý: nằm trong "Khách đã nộp" (tiền thật) nhưng không còn là thu dư. Vắng ở payload cũ ⇒ 0.
  const creditUsed = m ? num(m.room.creditUsed) ?? 0 : 0;
  const tenantRows: BalanceRow[] = m
    // F2 trên phòng đang xem: phát sinh ≈ đã nộp + cấn trừ + còn nợ − thu dư − thừa đã trừ kỳ sau / khi thanh lý.
    ? [
        row('Cọc theo HĐ', committed),
        row('Cọc đã đóng (thực thu)', depositPaid, { tone: depositShort && depositShort > 0 ? 'red' : 'green' }),
        row('Hoá đơn phát sinh', m.room.issued),
        row('Khách đã nộp', m.room.paidCash, { tone: 'green' }),
        ...(m.room.offset > 0 ? [row('Cấn trừ khi thanh lý', m.room.offset, { tone: 'purple' })] : []),
        ...(m.room.overpaid > 0 ? [row('Thu dư', m.room.overpaid, { tone: 'green' })] : []),
        ...(creditUsed > 0 ? [row('Tiền thừa đã trừ kỳ sau / khi thanh lý', creditUsed, { tone: 'neutral' })] : []),
        ...(kind === 'forfeit' ? [row('Hoá đơn còn nợ khi bỏ cọc', 'Đã huỷ', { tone: 'neutral' })] : []),
        row('Khách còn nợ', tenantOwe, { strong: true, tone: oweTone(tenantOwe) }),
      ]
    : [
        row('Cọc theo HĐ', committed),
        row('Cọc đã đóng (thực thu)', depositPaid, { tone: depositShort && depositShort > 0 ? 'red' : 'green' }),
        row('Hoá đơn phát sinh', add(invoicePaid, invoiceDebt)),
        row('Đã thu', invoicePaid, { tone: 'green' }),
        ...(kind === 'forfeit' ? [row('Hoá đơn còn nợ khi bỏ cọc', 'Đã huỷ', { tone: 'neutral' })] : []),
        row('Khách còn nợ', tenantOwe, { strong: true, tone: oweTone(tenantOwe) }),
      ];

  const landRows: BalanceRow[] = ended && m
    ? [
        row('Cọc chốt khi thanh lý', settled),
        row('Khấu trừ khi thanh lý', settled !== null && refundDue !== null ? Math.max(0, settled - refundDue) : null),
        row('Phải hoàn cọc', refundShown),
        row('Đã hoàn cọc', refundPaid, { tone: refundPaid > 0 ? 'green' : depositStillOwed ? 'red' : 'neutral' }),
        ...(otherDue > 0 || otherPaid > 0
          ? [
              row('Phải trả thêm (tiền thừa / tiền phòng)', otherDue),
              row('Đã trả thêm', otherPaid, { tone: otherPaid >= otherDue - 0.5 ? 'green' : 'red' }),
            ]
          : []),
        ...(r && r.offbook > 0 ? [row('Trong đó trả ngoài sổ tiền', r.offbook, { tone: 'purple' })] : []),
        row('Chủ nhà còn nợ khách', landOwe, { strong: true, tone: oweTone(landOwe) }),
      ]
    : ended
    ? [
        row('Cọc chốt khi thanh lý', settled),
        row('Khấu trừ khi thanh lý', settled !== null && refundDue !== null ? Math.max(0, settled - refundDue) : null),
        row('Phải hoàn cho khách', refundShown),
        row('Đã hoàn (đã ghi sổ chi)', refundPaid, { tone: refundPaid > 0 ? 'green' : refundDue ? 'red' : 'neutral' }),
        row('Chủ nhà còn nợ khách', landOwe, { strong: true, tone: oweTone(landOwe) }),
      ]
    : noTermination && r
    ? [
        row('Cọc đang giữ', depositHeld),
        row('Đã chi qua phiếu hoàn', r.depositPaid + r.otherPaid, { tone: 'amber' }),
        row('Chủ nhà còn nợ khách', landOwe, { strong: true, tone: 'neutral' }),
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

  const contractLine = m && m.contract.roomCount > 1
    ? `Cả HĐ (${m.contract.roomCount} phòng): đã nộp ${fmtMoney(m.contract.paidCash)} · còn nợ ${fmtMoney(m.contract.debt)}`
    : null;

  return {
    depositPaid, depositHeld, depositShort, invoicePaid, invoiceDebt, tenantOwe, landOwe,
    refundDue, refundPaid, chips, summary, tenantRows, landRows, contractLine,
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

  // ĐÃ THU theo năm = tiền thật thu hoá đơn + khách trả thêm khi thanh lý (cùng
  // phạm vi phòng với money.room.paidCash ⇒ Σ mọi năm = paidCash khi range null).
  const collections = payload.events.filter(
    (e) => e.type === 'INVOICE_COLLECTION_POSTED' || e.type === 'TERMINATION_EXTRA_RECEIPT_POSTED',
  );
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

/** `comm` = hoa hồng/thưởng; `offset` = trừ vào cọc / cấn trừ khi thanh lý. */
export type EventKind =
  | 'dep' | 'in' | 'inv' | 'owe' | 'mark' | 'out' | 'ref' | 'now' | 'future' | 'forfeit' | 'transfer'
  | 'comm' | 'offset';

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
  /** Chấm rỗng: phiếu chưa hoặc không còn hiệu lực (chờ duyệt, đã đảo). */
  hollow?: true;
  /** Số tiền gạch ngang: phiếu đã đảo. */
  struck?: true;
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
  /** Dòng nhỏ dưới 3 số tổng — "Cả HĐ (N phòng): …" khi số tổng chỉ là của phòng này. */
  kpiNote: string | null;
}

// Cùng ngày: nợ còn lại (kể cả "chưa hoàn cọc") đứng SAU mốc thanh lý sinh ra nó;
// trừ vào cọc nằm giữa hai mốc đó; hoa hồng đứng sau hoá đơn.
const ORDER: Record<EventKind, number> = {
  dep: 0, in: 1, inv: 2, comm: 3, mark: 4, transfer: 5, out: 6, forfeit: 6, offset: 7, ref: 8, owe: 8,
  now: 9, future: 10,
};

/** Cách vẽ mốc hoa hồng/thưởng theo trạng thái phiếu. */
const COMM_VIEW: Record<CommissionStage, Pick<DetailEvent, 'amtTone' | 'noteTone' | 'hollow' | 'struck'>> = {
  PENDING: { amtTone: 'neutral', noteTone: 'amber', hollow: true },
  UNPOSTED: { amtTone: 'neutral', noteTone: 'amber' },
  PAID: { amtTone: 'orange', noteTone: 'muted' },
  OFFBOOK: { amtTone: 'purple', noteTone: 'purple' },
  REVERSED: { amtTone: 'neutral', noteTone: 'red', hollow: true, struck: true },
};

const kyLbl = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

// Hai dòng cùng ngày cùng ORDER (vd "Khách bỏ cọc" và "Cọc chuyển thành doanh thu") xếp theo
// taxonomy của client, KHÔNG theo thứ tự type của RPC — khoá phá hoà của RPC chỉ để tất định.
// Chỉ payload mới: payload cũ giữ đúng thứ tự RPC cũ (date, type) như trước.
const TYPE_RANK = new Map<string, number>(LIFECYCLE_EVENT_TYPES.map((type, i) => [type, i]));
const typeRank = (type: string) => TYPE_RANK.get(type) ?? LIFECYCLE_EVENT_TYPES.length;

interface InvoiceLine {
  id: string;
  month: string;
  kind: InvoiceKind;
  status: string;
  date: string;
  issued: boolean;
  amount: number;
  carriedIn: number;
  depositPart: number;
  penalty: number;
  outstanding: number;
  carriedOpen: number;
  carriedPaid: number;
  sourceIds: string[];
  /** Phần khách trả thừa trên hoá đơn này đã trừ kỳ sau / khi thanh lý (lô tín dụng). */
  creditUsed: number;
  cash: number;
  cashDate: string | null;
  offset: number;
  /** Có phần cấn trừ khi bỏ cọc (via FORFEIT). */
  forfeit: boolean;
}

/**
 * F6 — hàng hoá đơn của RPC mới, MỘT HÀNG MỘT HOÁ ĐƠN (gom theo meta.invoiceId):
 * phát sinh mới (không nợ kéo, không cọc), tiền thật, cấn trừ khi thanh lý và
 * nợ còn lại đều do DB tính (H1). Ẩn hoá đơn chỉ có cọc, và hoá đơn thanh lý đã
 * cấn hết khi ngăn này có dòng gộp "Trừ vào cọc khi thanh lý".
 * `hasCoc` = HĐ có phiếu cấn cọc: cấn trừ khi thanh lý có thể đến từ khoản hoàn
 * cấn nợ hay tiền khách trả thêm, nên chỉ gọi "Trừ vào cọc" khi có phiếu cọc
 * (hoặc cấn khi bỏ cọc).
 */
function invoiceRows(events: LifecycleEvent[], leave: string | null, hasMerged: boolean, hasCoc: boolean): Omit<DetailEvent, 'key'>[] {
  const byId = new Map<string, InvoiceLine>();
  const lineOf = (e: LifecycleEvent, id: string): InvoiceLine => {
    const cu = byId.get(id);
    if (cu) return cu;
    const moi: InvoiceLine = {
      id, month: metaStr(e, 'billingMonth') ?? e.date.slice(0, 7), kind: 'MONTHLY', status: '',
      date: e.date.slice(0, 10), issued: false, amount: 0, carriedIn: 0, depositPart: 0, penalty: 0,
      outstanding: 0, carriedOpen: 0, carriedPaid: 0, sourceIds: [], creditUsed: 0, cash: 0, cashDate: null, offset: 0, forfeit: false,
    };
    byId.set(id, moi);
    return moi;
  };
  for (const e of events) {
    const id = metaStr(e, 'invoiceId');
    if (!id) continue;
    const date = e.date.slice(0, 10);
    if (e.type === 'INVOICE_ISSUED') {
      const g = lineOf(e, id);
      g.issued = true;
      g.date = date;
      g.month = metaStr(e, 'billingMonth') ?? g.month;
      g.kind = metaStr(e, 'kind') === 'SETTLEMENT' ? 'SETTLEMENT' : 'MONTHLY';
      g.status = metaStr(e, 'status') ?? '';
      g.amount = num(e.amount) ?? 0;
      g.carriedIn = num(e.meta?.carriedIn) ?? 0;
      g.depositPart = num(e.meta?.depositPart) ?? 0;
      g.penalty = num(e.meta?.penalty) ?? 0;
      g.outstanding = num(e.meta?.outstanding) ?? 0;
      g.carriedOpen = num(e.meta?.carriedOpen) ?? 0;
      g.carriedPaid = num(e.meta?.carriedPaid) ?? 0;
      g.creditUsed = num(e.meta?.creditUsed) ?? 0;
      const src = e.meta?.sourceInvoiceIds;
      g.sourceIds = Array.isArray(src) ? src.filter((x): x is string => typeof x === 'string') : [];
    } else if (e.type === 'INVOICE_COLLECTION_POSTED') {
      const g = lineOf(e, id);
      g.cash += num(e.amount) ?? 0;
      if (!g.cashDate || date > g.cashDate) g.cashDate = date;
    } else if (e.type === 'INVOICE_TERMINATION_OFFSET') {
      const g = lineOf(e, id);
      g.offset += num(e.amount) ?? 0;
      if (metaStr(e, 'via') === 'FORFEIT') g.forfeit = true;
      if (!g.issued) g.kind = metaStr(e, 'kind') === 'SETTLEMENT' ? 'SETTLEMENT' : 'MONTHLY';
    }
  }
  const all = [...byId.values()];
  /**
   * Kỳ của hoá đơn gánh nợ của `id` trong ngăn này. Nguồn cùng HĐ nhưng có thể
   * khác phòng (HĐ chuyển phòng: hoá đơn phòng mới gánh nợ phòng cũ) — RPC chỉ phát
   * hoá đơn của phòng đang xem ⇒ không thấy thì nói chung "phòng khác".
   */
  const carrierOf = (id: string) => all.find((g) => g.sourceIds.includes(id))?.month ?? null;
  const carrierText = (carrier: string | null) => (carrier ? `hoá đơn kỳ ${kyLbl(carrier)}` : 'hoá đơn ở phòng khác');

  const lines = all
    // Không còn gì để nói (hoá đơn chỉ có cọc: phần cọc nằm ở mục cọc).
    .filter((g) => !(Math.abs(g.amount) < 0.5 && g.cash < 0.5 && g.offset < 0.5 && g.outstanding <= 0.5))
    // Thanh lý đã cấn hết: dòng gộp đã nói đúng khoản này một lần.
    .filter((g) => !(hasMerged && g.kind === 'SETTLEMENT' && g.cash < 0.5 && g.offset > 0.5
      && g.offset >= g.amount - 0.5 && g.outstanding <= 0.5))
    .sort((a, b) => a.month.localeCompare(b.month) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const monthly = lines.filter((g) => g.kind === 'MONTHLY');

  return lines.map((g) => {
    const lbl = kyLbl(g.month);
    const i = monthly.indexOf(g);
    const title = g.kind === 'SETTLEMENT'
      ? g.penalty > 0.5 && g.penalty >= g.amount - 0.5 ? `Phí phạt thanh lý – ${lbl}`
        : g.penalty > 0.5 ? `Phạt + thu thêm khi thanh lý – ${lbl}`
        : `Thu thêm khi thanh lý – ${lbl}`
      : i === 0 ? `Tiền phòng tháng đầu tiên – ${lbl}`
      : leave && i === monthly.length - 1 ? `Tiền phòng tháng cuối – ${lbl}`
      : `Tiền phòng – ${lbl}`;
    const sub = `Hoá đơn kỳ ${lbl}`
      + (g.status === 'CANCELLED' ? ' · huỷ khi bỏ cọc, giữ tiền đã thu' : '')
      + (g.carriedIn > 0.5 ? ` · kèm nợ cũ ${fmtMoney(g.carriedIn)}` : '')
      + (g.depositPart > 0.5 ? ` · kèm cọc ${fmtMoney(g.depositPart)} (tính ở mục cọc)` : '')
      + (g.cash > 0.5 && g.cashDate ? ` · thu ngày ${fmtNgay(g.cashDate)}` : '')
      + (g.creditUsed > 0.5 ? ` · thừa ${fmtMoney(g.creditUsed)} đã trừ kỳ sau / khi thanh lý` : '');
    const carrier = carrierOf(g.id);
    const st: Pick<DetailEvent, 'note' | 'noteTone' | 'kind'> =
      g.outstanding > 0.5
        ? {
            note: (g.cash + g.offset + g.carriedPaid > 0.5 ? `Còn thiếu ${fmtMoney(g.outstanding)}` : 'Chưa thu')
              + (g.carriedOpen > 0.5 ? ` · đã cộng vào ${carrierText(carrier)}` : ''),
            noteTone: 'amber', kind: 'owe',
          }
      : g.offset > 0.5 && g.cash <= 0.5
        ? { note: hasCoc || g.forfeit ? 'Trừ vào cọc' : 'Cấn trừ khi thanh lý', noteTone: 'purple', kind: 'inv' }
      : g.offset > 0.5 ? { note: `Đã thu ${fmtMoney(g.cash)} · cấn trừ ${fmtMoney(g.offset)}`, noteTone: 'green', kind: 'inv' }
      : g.carriedPaid > 0.5 ? { note: `Đã thu cùng ${carrierText(carrier)}`, noteTone: 'green', kind: 'inv' }
      : !g.issued ? { note: `Đã thu ${fmtMoney(g.cash)}`, noteTone: 'green', kind: 'inv' }
      : { note: 'Đã thu', noteTone: 'green', kind: 'inv' };
    return { date: g.date, title, sub, amt: g.issued ? fmtMoney(g.amount) : '', amtTone: 'green', ...st };
  });
}

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
      // A2: gia hạn ghi đè end_date ⇒ in hạn gốc (originalEndDate của RPC mới).
      sub: `${c.number ?? '—'} · thời hạn ${termText(c.startDate, c.originalEndDate, c.endDate)}`,
      kind: 'in',
    });
  }

  // ── Cấn trừ khi thanh lý (RPC mới): một dòng gộp ở ngăn thanh lý ─────
  const moi = c.money !== undefined;
  const sum = (type: string, pick: (e: LifecycleEvent) => boolean = () => true) =>
    events.filter((e) => e.type === type && pick(e)).reduce((s, e) => s + (num(e.amount) ?? 0), 0);
  const viaForfeit = (e: LifecycleEvent) => metaStr(e, 'via') === 'FORFEIT';
  const cocVouchers = events.filter((e) => e.type === 'SETTLEMENT_OFFSET_POSTED');
  const coc = sum('SETTLEMENT_OFFSET_POSTED');
  const offMoveOut = sum('INVOICE_TERMINATION_OFFSET', (e) => !viaForfeit(e));
  // Chỉ ngăn mà nhịp ở phòng này kết thúc bằng thanh lý (không phải chuyển phòng).
  const hasMerged = moi && (kind === 'ontime' || kind === 'early') && (coc > 0.5 || offMoveOut > 0.5);

  // Hoá đơn: RPC mới ⇒ mỗi hoá đơn một hàng (F6); RPC cũ ⇒ gộp phát hành + đã thu theo KỲ.
  const coInvoiceId = events.some((e) => (e.type === 'INVOICE_ISSUED' || e.type === 'INVOICE_COLLECTION_POSTED') && metaStr(e, 'invoiceId'));
  if (coInvoiceId) for (const row of invoiceRows(events, leave, hasMerged, coc > 0.5)) push(row);
  const byMonth = new Map<string, { issued: number; paid: number; n: number; date: string; paidDate: string | null }>();
  for (const e of coInvoiceId ? [] : events) {
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

  if (hasMerged) {
    // F6: số = phiếu cấn cọc; không có phiếu ⇒ phần cấn trừ không phải tiền của
    // phòng (money.room.offset = Σ cấn trừ − khách trả thêm: CT gạch luôn phần khách
    // nộp thêm bằng phiếu thu, phần đó là tiền thật, đã ở dòng "Khách trả thêm").
    // Dòng phụ dựng từ CHỨNG TỪ THẬT (hoá đơn được cấn, khoản hoàn cấn nợ, khách
    // trả thêm), không gán tên cho phần chênh: chênh lớn ⇒ cảnh báo.
    const refundOffset = sum('TERMINATION_REFUND_OFFSET_POSTED');
    const extra = sum('TERMINATION_EXTRA_RECEIPT_POSTED');
    // Phần cấn trừ chưa có chứng từ giải thích (r của F6) — tính ở MỌI ca, kể cả
    // không có phiếu cấn cọc (cọc = 0): CT kép / CT không nguồn vẫn phải cảnh báo.
    const du = offMoveOut - coc - refundOffset - extra;
    const otherRoom = c.money ? c.money.contract.offset - c.money.room.offset : 0;
    const daTra = [...new Set(events
      .filter((e) => e.type === 'INVOICE_TERMINATION_OFFSET' && !viaForfeit(e))
      .sort((a, b) => (metaStr(a, 'billingMonth') ?? '').localeCompare(metaStr(b, 'billingMonth') ?? ''))
      .map((e) => `${metaStr(e, 'kind') === 'SETTLEMENT' ? 'thanh lý' : 'tiền phòng'} ${kyLbl(metaStr(e, 'billingMonth') ?? e.date.slice(0, 7))}`))];
    const codes = cocVouchers.map((e) => metaStr(e, 'code')).filter((x): x is string => !!x);
    const ngay = [...cocVouchers, ...events.filter((e) => e.type === 'INVOICE_TERMINATION_OFFSET')]
      .map((e) => e.date.slice(0, 10)).sort().pop() ?? leave ?? todayISO;
    const vuot = du > 5_000;
    push({
      date: coc > 0.5 ? cocVouchers.map((e) => e.date.slice(0, 10)).sort().pop()! : ngay,
      title: coc > 0.5 ? 'Trừ vào cọc khi thanh lý' : 'Cấn trừ khi thanh lý (không dùng cọc)',
      sub: [
        codes.length ? `Phiếu ${codes.join(', ')}` : '',
        daTra.length ? `trả hoá đơn ${daTra.slice(0, 3).join(', ')}${daTra.length > 3 ? ` +${daTra.length - 3}` : ''}` : '',
        refundOffset > 0.5 ? `cấn khoản hoàn ${fmtMoney(refundOffset)}` : '',
        extra > 0.5 ? `khách trả thêm ${fmtMoney(extra)}` : '',
        Math.abs(du) > 0.5 && Math.abs(du) <= 5_000 ? `lẻ ${fmtMoney(du)}` : '',
        otherRoom > 0.5 ? `gồm ${fmtMoney(otherRoom)} cấn hoá đơn ở phòng khác` : '',
      ].filter(Boolean).join(' · ') || '—',
      amt: fmtMoney(coc > 0.5 ? coc : c.money?.room.offset ?? Math.max(0, offMoveOut - extra)),
      amtTone: 'purple',
      note: vuot ? `Cấn trừ vượt các phiếu quyết toán ${fmtMoney(du)}` : coc > 0.5 ? 'Lấy từ cọc' : 'Cấn trừ, không phải tiền',
      noteTone: vuot ? 'amber' : 'purple',
      kind: 'offset',
    });
  }

  // Phiếu hoa hồng/thưởng cùng loại trên HĐ — "phiếu trùng cũ" chỉ có nghĩa khi ≥ 2.
  const commCount = new Map<string, Set<string>>();
  for (const e of events) {
    const cm = commissionEventOf(e.type);
    const id = metaStr(e, 'voucherId');
    if (!cm || !id) continue;
    commCount.set(cm.kind, (commCount.get(cm.kind) ?? new Set()).add(id));
  }

  const ordered = moi ? [...events].sort((a, b) => a.date.localeCompare(b.date) || typeRank(a.type) - typeRank(b.type)) : events;
  for (const e of ordered) {
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
          // refund_amount âm = không phải hoàn cọc: in 0 như "Phải hoàn cọc".
          amt: forfeit ? '' : money(amt === null ? null : Math.max(0, amt)),
          amtTone: 'ink',
          note: forfeit ? '' : 'Quyết toán hoàn',
          noteTone: 'muted',
          kind: forfeit ? 'forfeit' : eff ? 'out' : 'mark',
        });
        break;
      }
      case 'SETTLEMENT_OFFSET_POSTED':
        // RPC mới: đã nằm trong dòng gộp (ngăn thanh lý) — phòng cũ của HĐ
        // chuyển phòng chỉ liệt kê hoá đơn được cấn, không lặp phiếu.
        if (moi) break;
        push({ date, title: 'Cấn cọc khi thanh lý', sub: `Phiếu ${metaStr(e, 'code') ?? '—'}`, amt: money(amt), amtTone: 'ink', note: 'Trừ nợ vào cọc', noteTone: 'muted', kind: 'mark' });
        break;
      case 'DEPOSIT_FORFEIT_POSTED': {
        const offForfeit = sum('INVOICE_TERMINATION_OFFSET', viaForfeit);
        const phat = events
          .filter((x) => x.type === 'INVOICE_TERMINATION_OFFSET' && viaForfeit(x))
          .reduce((s, x) => s + (num(x.meta?.penalty) ?? 0), 0);
        const canHoaDon = offForfeit > 0.5
          ? ` · cấn hoá đơn ${fmtMoney(offForfeit)}${phat > 0.5 ? ` (gồm phạt ${fmtMoney(phat)})` : ''}` : '';
        push({ date, title: 'Cọc chuyển thành doanh thu', sub: `Phiếu ${metaStr(e, 'code') ?? '—'}${canHoaDon}`, amt: money(amt), amtTone: 'green', note: 'Doanh thu bỏ cọc', noteTone: 'red', kind: 'forfeit' });
        break;
      }
      case 'DEPOSIT_REFUND_POSTED':
        push({ date, title: 'Hoàn cọc cho khách', sub: `Phiếu chi ${metaStr(e, 'code') ?? '—'}`, amt: amt === null ? CHUA_DU_DU_LIEU : `−${fmtMoney(amt)}`, amtTone: 'orange', note: e.trusted ? 'Tiền đã ra két' : 'Trả ngoài sổ tiền', noteTone: 'muted', kind: 'ref' });
        break;
      case 'CUSTOMER_REFUND_POSTED':
        push({ date, title: 'Trả khách tiền thừa / tiền phòng', sub: `Phiếu chi ${metaStr(e, 'code') ?? '—'}`, amt: amt === null ? CHUA_DU_DU_LIEU : `−${fmtMoney(amt)}`, amtTone: 'orange', note: e.trusted ? 'Tiền đã ra két' : 'Trả ngoài sổ tiền', noteTone: 'muted', kind: 'ref' });
        break;
      case 'TERMINATION_EXTRA_RECEIPT_POSTED': {
        const bm = metaStr(e, 'billingMonth');
        push({ date, title: 'Khách trả thêm khi thanh lý', sub: `Phiếu thu ${metaStr(e, 'code') ?? '—'}${bm ? ` · hoá đơn kỳ ${kyLbl(bm)}` : ''}`, amt: money(amt), amtTone: 'green', note: 'Đã thu', noteTone: 'green', kind: 'inv' });
        break;
      }
      case 'ROOM_CHANGED_OUT':
        push({ date, title: `Chuyển sang phòng ${roomChangeTo ?? 'khác'}`, sub: 'Kết thúc ở phòng này · phòng trống từ hôm sau', amt: '', amtTone: 'ink', note: 'Cọc chuyển theo', noteTone: 'purple', kind: 'transfer' });
        break;
      case 'CONTRACT_CLOSED':
        if (!events.some((x) => x.type === 'TERMINATION_REQUESTED' && x.date.slice(0, 10) === date)) {
          push({ ...blank, date, title: 'Trả phòng', sub: kind === 'expired' ? 'Hết hạn hợp đồng' : 'Kết thúc ở phòng này', kind: 'out' });
        }
        break;
      default: {
        // RPC cũ: một type COMMISSION_PAID gom mọi phiếu, không có voucherId.
        if (e.type === 'COMMISSION_PAID' && !metaStr(e, 'voucherId')) {
          push({ date, title: 'Hoa hồng / thưởng', sub: metaStr(e, 'name') ?? `Phiếu ${metaStr(e, 'code') ?? '—'}`, amt: amt === null ? '' : `−${fmtMoney(amt)}`, amtTone: 'orange', note: '', noteTone: 'muted', kind: 'mark' });
          break;
        }
        // 10 type hoa hồng/thưởng: chỉ là mốc, KHÔNG cộng vào số tổng nào.
        const cm = commissionEventOf(e.type);
        if (!cm) break;
        const code = metaStr(e, 'code');
        const trungCu = e.meta?.legacyDup === true && (commCount.get(cm.kind)?.size ?? 0) >= 2;
        push({
          date,
          title: COMMISSION_KIND_LABEL[cm.kind],
          sub: [code ? `Phiếu ${code}` : '', metaStr(e, 'name') ?? '', trungCu ? 'phiếu trùng cũ' : '']
            .filter(Boolean).join(' · ') || '—',
          // Dấu trừ chỉ khi tiền đã ra (ghi sổ hoặc trả ngoài sổ).
          amt: amt === null ? '' : cm.stage === 'PAID' || cm.stage === 'OFFBOOK' ? `−${fmtMoney(amt)}` : fmtMoney(amt),
          note: STAGE_TEXT[cm.stage],
          ...COMM_VIEW[cm.stage],
          kind: 'comm',
        });
        break;
      }
    }
  }

  if ((kind === 'ontime' || kind === 'early') && bal.refundDue !== null && bal.landOwe !== null && bal.landOwe > 0 && leave) {
    const r = c.money?.refund;
    const conCoc = bal.refundDue - bal.refundPaid > 0.5;
    push({
      date: leave, title: conCoc ? 'Chưa hoàn cọc cho khách' : 'Chưa trả khách tiền thừa / tiền phòng',
      // Quyết toán không phải hoàn cọc (≤ 0) mà vẫn còn nợ ⇒ chỉ nói phần tiền thừa / tiền phòng (F3).
      sub: [
        bal.refundDue > 0.5 ? `Phải hoàn ${fmtMoney(bal.refundDue)} · đã hoàn ${fmtMoney(bal.refundPaid)}` : '',
        r && r.otherDue > 0 ? `tiền thừa ${fmtMoney(r.otherDue)}, đã trả ${fmtMoney(r.otherPaid)}` : '',
      ].filter(Boolean).join(' · '),
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
      ? bal.refundDue === null ? `Hoàn cọc: ${CHUA_DU_DU_LIEU}` : `Quyết toán hoàn ${fmtMoney(Math.max(0, bal.refundDue))}`
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
    kpiNote: bal.contractLine,
    kpis: [
      {
        label: 'ĐÃ THU',
        value: money(bal.invoicePaid),
        sub: moi ? 'Khách đã nộp · không gồm cọc, không gồm cấn trừ' : 'Tiền phòng + dịch vụ, không gồm cọc',
        tone: 'mint',
      },
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
        // Cọc đã hoàn đủ mà vẫn còn nợ ⇒ phần còn lại là tiền thừa / tiền phòng (F3), không phải cọc.
        sub: bal.landOwe && bal.landOwe > 0
          ? kind === 'expired' ? 'Cọc đang giữ · chờ thanh lý'
            : bal.refundDue !== null && bal.refundDue - bal.refundPaid <= 0.5 ? 'Tiền thừa / tiền phòng chưa trả'
            : 'Cọc chưa hoàn'
          : c.money?.refund?.warnings.includes('NO_EFFECTIVE_TERMINATION') ? 'Có phiếu hoàn, chưa có thanh lý hiệu lực'
          : kind === 'active' ? 'Chưa đến hạn hoàn cọc' : depNote,
        tone: bal.landOwe && bal.landOwe > 0 ? 'peach' : 'white',
      },
    ],
  };
}
