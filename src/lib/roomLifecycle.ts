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

// ─────────────────────────────────────────────────────────────────────
// Hợp đồng payload "vòng đời tiền một nguồn" (29/10/2026): taxonomy sự kiện,
// meta theo type, khối tiền theo HĐ. Mọi trường MỚI đều tuỳ chọn — payload
// của RPC cũ (chưa áp migration) vẫn hợp lệ, client đọc được cả hai.
// ─────────────────────────────────────────────────────────────────────

/** Trạng thái phiếu hoa hồng/thưởng — nằm trong TÊN type vì Hermes bỏ meta. */
export const COMMISSION_STAGES = ['PENDING', 'UNPOSTED', 'PAID', 'OFFBOOK', 'REVERSED'] as const;
export type CommissionStage = (typeof COMMISSION_STAGES)[number];
/** COMMISSION_* = hoa hồng môi giới, SALE_BONUS_* = thưởng Sale. */
export type CommissionEventType = `${'COMMISSION' | 'SALE_BONUS'}_${CommissionStage}`;

/**
 * Đủ 25 type RPC phát ra (tên ≤ 40 ký tự — luật `code` của Hermes). Danh sách
 * chuẩn để test đối chiếu literal trong thân SQL sống; union suy ra từ mảng này.
 */
export const LIFECYCLE_EVENT_TYPES = [
  // Cư trú
  'CONTRACT_OPENED', 'ROOM_CHANGED_IN', 'ROOM_CHANGED_OUT', 'CONTRACT_CLOSED',
  // Cọc & thanh lý
  'DEPOSIT_RECEIVED', 'TERMINATION_REQUESTED',
  'SETTLEMENT_OFFSET_POSTED', 'DEPOSIT_FORFEIT_POSTED',
  'DEPOSIT_REFUND_POSTED', 'CUSTOMER_REFUND_POSTED',
  'TERMINATION_EXTRA_RECEIPT_POSTED', 'TERMINATION_REFUND_OFFSET_POSTED',
  // Hoá đơn
  'INVOICE_ISSUED', 'INVOICE_COLLECTION_POSTED', 'INVOICE_TERMINATION_OFFSET',
  // Hoa hồng môi giới / thưởng Sale: 2 loại × 5 trạng thái
  'COMMISSION_PENDING', 'COMMISSION_UNPOSTED', 'COMMISSION_PAID', 'COMMISSION_OFFBOOK', 'COMMISSION_REVERSED',
  'SALE_BONUS_PENDING', 'SALE_BONUS_UNPOSTED', 'SALE_BONUS_PAID', 'SALE_BONUS_OFFBOOK', 'SALE_BONUS_REVERSED',
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export interface LifecycleEvent {
  /** Một type trong LIFECYCLE_EVENT_TYPES; để rộng cho type lạ (eventLabel rơi về mặc định). */
  type: LifecycleEventType | (string & {});
  /** 'YYYY-MM-DD' */
  date: string;
  contractId: string | null;
  /** VND; null với mốc cư trú. Nghĩa theo từng type — xem LifecycleEventMetaMap. */
  amount: number | null;
  trusted: boolean;
  /** Kiểu chi tiết theo type ở LifecycleEventMetaMap (ép bằng LifecycleEventOf<K>). */
  meta: Record<string, unknown> | null;
}

// Meta khai bằng `type` (không phải interface): object type có chỉ mục ngầm nên
// gán được vào Record<string, unknown> ⇒ ép LifecycleEvent → LifecycleEventOf<K> hợp lệ.

/** CONTRACT_OPENED / ROOM_CHANGED_IN. */
export type SegmentOpenMeta = { segIndex: number; sourcePath: string | null };
/** ROOM_CHANGED_OUT / CONTRACT_CLOSED. */
export type SegmentCloseMeta = { segIndex: number };
/** DEPOSIT_RECEIVED — mã phiếu; voucherId chỉ RPC mới phát (khoá phá hoà). */
export type DepositReceivedMeta = { code: string | null; voucherId?: string };
/** TERMINATION_REQUESTED — amount = refund_amount; type 'FORFEIT' = bỏ cọc; terminationId chỉ RPC mới phát. */
export type TerminationRequestedMeta = { status: string; type: string | null; terminationId?: string };

export type InvoiceKind = 'MONTHLY' | 'SETTLEMENT';

/**
 * INVOICE_ISSUED — amount = phần phát sinh MỚI (không gồm nợ kéo đã khai nguồn,
 * không gồm dòng cọc/NON_PNL). billingMonth + status có từ RPC cũ; còn lại chỉ
 * RPC mới phát (vắng invoiceId ⇒ payload cũ, amount = total_amount).
 */
export type InvoiceIssuedMeta = {
  /** 'YYYY-MM' */
  billingMonth: string;
  status: string;
  invoiceId?: string;
  kind?: InvoiceKind;
  /** total_amount gốc. */
  total?: number;
  /** Nợ cũ kéo từ hoá đơn nguồn có trong tập (đã tính ở hoá đơn nguồn). */
  carriedIn?: number;
  /** Σ dòng không phải doanh thu (cọc, NON_PNL) — tính ở mục cọc. */
  depositPart?: number;
  /** Σ dòng PENALTY. */
  penalty?: number;
  /** Nợ thực còn lại của phần doanh thu; âm = thu dư; 0 với hoá đơn huỷ. */
  outstanding?: number;
  /** Dư nợ của hoá đơn này đã kéo sang hoá đơn gánh còn mở. */
  carriedOpen?: number;
  /** Phần nợ của hoá đơn này do hoá đơn sau gánh và đã trả xong. */
  carriedPaid?: number;
  /** Hoá đơn nguồn (trong tập) mà hoá đơn này gánh nợ; [] nếu không có. */
  sourceInvoiceIds?: string[];
};

/** INVOICE_COLLECTION_POSTED — amount = tiền thật (không cấn trừ, không phần cọc, không nợ được gánh hộ). */
export type InvoiceCollectionMeta = {
  billingMonth: string;
  invoiceId?: string;
  kind?: InvoiceKind;
  /** Phần tiền thật đã phân bổ cho dòng cọc trên hoá đơn (cọc trước). */
  depositPaid?: number;
};

/**
 * INVOICE_TERMINATION_OFFSET (mới) — amount = phần cấn trừ (payment received_amount = 0)
 * trả DOANH THU của hoá đơn; phần gạch dòng cọc trên hoá đơn nằm ở depositOffset.
 */
export type InvoiceTerminationOffsetMeta = {
  invoiceId: string;
  billingMonth: string;
  kind: InvoiceKind;
  /** FORFEIT = cấn khi bỏ cọc, MOVE_OUT = cấn khi thanh lý thường. */
  via: 'MOVE_OUT' | 'FORFEIT';
  penalty: number;
  /** Phần cấn trừ gạch dòng cọc chưa thu trên hoá đơn — không phải cấn trừ doanh thu. */
  depositOffset?: number;
};

/** SETTLEMENT_OFFSET_POSTED / DEPOSIT_FORFEIT_POSTED — voucherId chỉ RPC mới phát. */
export type TerminationVoucherMeta = { code: string | null; voucherId?: string };

/** DEPOSIT_REFUND_POSTED (Σ dòng cọc) / CUSTOMER_REFUND_POSTED (Σ dòng ngoài cọc). */
export type RefundVoucherMeta = {
  code: string | null;
  voucherId?: string;
  /** Trả qua sổ ảo (posting NOT_APPLICABLE) — trusted = false. */
  offbook?: boolean;
};

/** TERMINATION_EXTRA_RECEIPT_POSTED (mới) — khách trả thêm khi thanh lý, tiền thật. */
export type ExtraReceiptMeta = {
  voucherId: string;
  code: string | null;
  invoiceId: string | null;
  billingMonth: string | null;
};

/** TERMINATION_REFUND_OFFSET_POSTED (mới) — khoản hoàn cấn vào nợ, bút toán nội bộ. */
export type RefundOffsetMeta = { voucherId: string; code: string | null };

/** 10 type hoa hồng/thưởng. COMMISSION_PAID của RPC cũ chỉ có { code, name }. */
export type CommissionVoucherMeta = {
  code: string | null;
  name: string;
  voucherId?: string;
  kind?: 'broker' | 'sale';
  link?: 'direct' | 'deposit_claim';
  stage?: CommissionStage;
  approvalStatus?: string;
  postingStatus?: string | null;
  legacyDup?: boolean;
};

type BaseEventMetaMap = {
  CONTRACT_OPENED: SegmentOpenMeta;
  ROOM_CHANGED_IN: SegmentOpenMeta;
  ROOM_CHANGED_OUT: SegmentCloseMeta;
  CONTRACT_CLOSED: SegmentCloseMeta;
  DEPOSIT_RECEIVED: DepositReceivedMeta;
  TERMINATION_REQUESTED: TerminationRequestedMeta;
  SETTLEMENT_OFFSET_POSTED: TerminationVoucherMeta;
  DEPOSIT_FORFEIT_POSTED: TerminationVoucherMeta;
  DEPOSIT_REFUND_POSTED: RefundVoucherMeta;
  CUSTOMER_REFUND_POSTED: RefundVoucherMeta;
  TERMINATION_EXTRA_RECEIPT_POSTED: ExtraReceiptMeta;
  TERMINATION_REFUND_OFFSET_POSTED: RefundOffsetMeta;
  INVOICE_ISSUED: InvoiceIssuedMeta;
  INVOICE_COLLECTION_POSTED: InvoiceCollectionMeta;
  INVOICE_TERMINATION_OFFSET: InvoiceTerminationOffsetMeta;
};

export type LifecycleEventMetaMap = BaseEventMetaMap & Record<CommissionEventType, CommissionVoucherMeta>;

/** Sự kiện đã biết type ⇒ meta đúng kiểu. Type thiếu trong map ⇒ lỗi biên dịch ở đây. */
export type LifecycleEventOf<K extends LifecycleEventType> = Omit<LifecycleEvent, 'type' | 'meta'> & {
  type: K;
  meta: LifecycleEventMetaMap[K] | null;
};

/**
 * F2 — tiền của một phạm vi: cả HĐ (`contract`) hoặc phòng đang xem (`room`).
 * VND; không phụ thuộc p_from/p_to. Bất biến (lệch ≤ 1.000/hoá đơn do làm tròn):
 * issued ≈ paidCash + offset + debt − overpaid.
 */
export interface MoneyScope {
  /** Σ phát sinh mới (không nợ kéo, không cọc). */
  issued: number;
  /** Khách nộp bằng tiền thật: thu hoá đơn (trừ cấn trừ, trừ phần cọc) + khách trả thêm khi thanh lý. */
  paidCash: number;
  /** Cấn trừ khi thanh lý, không phải tiền (≥ 0). */
  offset: number;
  /** Khách còn nợ (≥ 0). */
  debt: number;
  /** Thu dư (≥ 0). */
  overpaid: number;
  invoiceCount: number;
  /** Số phòng có hoá đơn trong phạm vi (room: 0 hoặc 1). */
  roomCount: number;
  /** Σ dòng cọc/NON_PNL nằm trên hoá đơn. */
  depositOnInvoices: number;
}

export type RefundWarning = 'NO_EFFECTIVE_TERMINATION' | 'DEPOSIT_LINE_MISMATCH';

/** F3 — hoàn tiền khi thanh lý (phiếu termination.refund). */
export interface RefundMoney {
  /** refund_amount của thanh lý hiệu lực mới nhất (có thể ≤ 0); null = không có thanh lý hiệu lực. */
  depositDue: number | null;
  /** Σ dòng cọc trên phiếu đã trả (đã ghi sổ hoặc qua sổ ảo). */
  depositPaid: number;
  /** Σ dòng cọc trên mọi phiếu chưa huỷ. */
  depositOnVouchers: number;
  /** Σ dòng ngoài cọc (tiền thừa, tiền phòng) trên mọi phiếu chưa huỷ. */
  otherDue: number;
  otherPaid: number;
  /** Bên giữ cọc còn nợ khách; null khi depositDue null. */
  owed: number | null;
  /** Phần đã trả qua sổ ảo (NOT_APPLICABLE) — đã nằm trong depositPaid/otherPaid. */
  offbook: number;
  warnings: RefundWarning[];
}

export interface ContractMoney {
  contract: MoneyScope;
  room: MoneyScope;
  /** null = không có thanh lý hiệu lực lẫn phiếu hoàn nào. */
  refund: RefundMoney | null;
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
  /** Hạn gốc trước gia hạn (min old_end_date, lượt APPROVED/COMPLETED); null = chưa gia hạn. RPC cũ: vắng. */
  originalEndDate?: string | null;
  /** Một nguồn tiền F2/F3. RPC cũ: vắng ⇒ client giữ đường cũ. */
  money?: ContractMoney;
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

export interface EventLabelInfo {
  label: string;
  tone: EventTone;
  /**
   * Nhãn đã nói trạng thái phiếu (chờ duyệt / đã đảo / ngoài sổ…) ⇒ feed KHÔNG
   * gắn thêm "· chưa vào sổ thật" khi trusted=false — câu đó thừa, và sai nghĩa
   * với phiếu đã đảo.
   */
  statusInLabel?: true;
}

export type CommissionKind = 'broker' | 'sale';

export const COMMISSION_KIND_LABEL: Record<CommissionKind, string> = {
  broker: 'Hoa hồng môi giới',
  sale: 'Thưởng Sale',
};

/** Chữ trạng thái phiếu hoa hồng/thưởng — dùng chung cho ngăn kéo (ghi chú) và /thu-tien (nhãn). */
export const STAGE_TEXT: Record<CommissionStage, string> = {
  PENDING: 'Chờ duyệt',
  UNPOSTED: 'Đã duyệt, chưa ghi sổ',
  PAID: 'Đã chi',
  // NOT_APPLICABLE gồm cả sổ ảo lẫn trả qua lương ⇒ không gọi là "sổ ảo".
  OFFBOOK: 'Trả ngoài sổ tiền',
  REVERSED: 'Đã đảo',
};

const STAGE_TONE: Record<CommissionStage, EventTone> = {
  PENDING: 'warn', UNPOSTED: 'warn', PAID: 'out', OFFBOOK: 'neutral', REVERSED: 'neutral',
};

const COMMISSION_PREFIX: Record<CommissionKind, 'COMMISSION' | 'SALE_BONUS'> = {
  broker: 'COMMISSION',
  sale: 'SALE_BONUS',
};

/** Đọc loại + trạng thái từ TÊN type (Hermes bỏ meta nên trạng thái nằm trong tên). */
export function commissionEventOf(type: string): { kind: CommissionKind; stage: CommissionStage } | null {
  for (const kind of ['broker', 'sale'] as const) {
    const prefix = `${COMMISSION_PREFIX[kind]}_`;
    if (!type.startsWith(prefix)) continue;
    const stage = COMMISSION_STAGES.find((s) => s === type.slice(prefix.length));
    return stage ? { kind, stage } : null;
  }
  return null;
}

const COMMISSION_LABELS = Object.fromEntries(
  (['broker', 'sale'] as const).flatMap((kind) => COMMISSION_STAGES.map((stage) => [
    `${COMMISSION_PREFIX[kind]}_${stage}`,
    {
      label: `${COMMISSION_KIND_LABEL[kind]} · ${STAGE_TEXT[stage].toLowerCase()}`,
      tone: STAGE_TONE[stage],
      statusInLabel: true,
    },
  ])),
) as Record<CommissionEventType, EventLabelInfo>;

export const EVENT_LABEL: Record<LifecycleEventType, EventLabelInfo> = {
  CONTRACT_OPENED: { label: 'Mở hợp đồng', tone: 'neutral' },
  ROOM_CHANGED_IN: { label: 'Chuyển đến phòng này', tone: 'neutral' },
  ROOM_CHANGED_OUT: { label: 'Chuyển sang phòng khác', tone: 'neutral' },
  CONTRACT_CLOSED: { label: 'Rời phòng', tone: 'neutral' },
  DEPOSIT_RECEIVED: { label: 'Thu cọc', tone: 'in' },
  INVOICE_ISSUED: { label: 'Phát hành hoá đơn', tone: 'neutral' },
  // Chỉ còn tiền thật: phần cấn trừ đi INVOICE_TERMINATION_OFFSET.
  INVOICE_COLLECTION_POSTED: { label: 'Thu tiền hoá đơn', tone: 'in' },
  // Cấn trừ không phải tiền vào ⇒ neutral, không tô màu "tiền vào".
  INVOICE_TERMINATION_OFFSET: { label: 'Hoá đơn cấn trừ khi thanh lý', tone: 'neutral' },
  TERMINATION_REQUESTED: { label: 'Hồ sơ thanh lý', tone: 'warn' },
  SETTLEMENT_OFFSET_POSTED: { label: 'Trừ vào cọc khi thanh lý', tone: 'neutral' },
  DEPOSIT_FORFEIT_POSTED: { label: 'Bỏ cọc', tone: 'out' },
  DEPOSIT_REFUND_POSTED: { label: 'Hoàn cọc cho khách', tone: 'out' },
  CUSTOMER_REFUND_POSTED: { label: 'Trả khách tiền thừa / tiền phòng', tone: 'out' },
  TERMINATION_EXTRA_RECEIPT_POSTED: { label: 'Khách trả thêm khi thanh lý', tone: 'in' },
  TERMINATION_REFUND_OFFSET_POSTED: { label: 'Cấn khoản hoàn vào nợ', tone: 'neutral' },
  ...COMMISSION_LABELS,
};

/** Danh sách type RPC phát ra — dùng cho test "bảng nhãn không thiếu type nào". */
export const RPC_EVENT_TYPES: readonly string[] = LIFECYCLE_EVENT_TYPES;

export function eventLabel(type: string): EventLabelInfo {
  return (EVENT_LABEL as Record<string, EventLabelInfo>)[type] ?? { label: type, tone: 'neutral' };
}

/**
 * Nhãn của MỘT sự kiện. Khác `eventLabel` đúng một ca: COMMISSION_PAID của RPC
 * cũ (chưa áp migration, không có meta.voucherId) gom mọi phiếu hoa hồng/thưởng
 * kể cả chưa ghi sổ ⇒ giữ nhãn cũ, không khẳng định "đã chi". Gỡ ở S22.
 */
export function eventLabelOf(e: Pick<LifecycleEvent, 'type' | 'meta'>): EventLabelInfo {
  if (e.type === 'COMMISSION_PAID' && typeof e.meta?.voucherId !== 'string') {
    return { label: 'Hoa hồng / thưởng', tone: 'out' };
  }
  return eventLabel(e.type);
}

const ngay = (s: string | null | undefined): string => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');

/**
 * F5 — chữ thời hạn hợp đồng, dùng chung cho ngăn kéo Báo cáo LN và lane Thu tiền.
 * Gia hạn ghi đè `end_date` ngay trên hợp đồng ⇒ hạn gốc lấy `originalEndDate`
 * của RPC (min old_end_date các lượt hiệu lực). Không gia hạn, hoặc RPC cũ
 * (vắng khoá) ⇒ dạng cũ. 'Gia hạn tới' lấy end_date hiện tại (có HĐ end_date
 * nhỏ hơn new_end_date lớn nhất). `sep` giữ nguyên dấu nối riêng của từng màn.
 */
export function termText(
  start: string | null | undefined,
  originalEnd: string | null | undefined,
  end: string | null | undefined,
  sep = ' → ',
): string {
  const goc = originalEnd ? originalEnd.slice(0, 10) : null;
  const het = end ? end.slice(0, 10) : null;
  return goc && het && goc < het
    ? `${ngay(start)}${sep}${ngay(goc)} · gia hạn tới ${ngay(het)}`
    : `${ngay(start)}${sep}${ngay(end)}`;
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
