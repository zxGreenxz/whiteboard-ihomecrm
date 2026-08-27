import { describe, it, expect } from 'vitest';
import {
  timelineDomain, datePercent, buildLanes, vacancyProblems,
  EVENT_LABEL, RPC_EVENT_TYPES,
  type LifecycleSegment, type LifecycleContract,
} from '../roomLifecycle';

const TODAY = '2026-08-28';

const seg = (over: Partial<LifecycleSegment>): LifecycleSegment => ({
  contractId: 'c1',
  contractNumber: 'HD-1',
  segIndex: 0,
  fromDate: '2026-01-01',
  toDate: '2026-06-01',
  sourcePath: 'TRANSFER_ROOM_COMPLETED',
  trusted: true,
  diagnostic: null,
  ...over,
});

const contract = (id: string): LifecycleContract => ({
  id, number: `HD-${id}`, status: 'ACTIVE',
  startDate: '2026-01-01', endDate: '2026-12-31', actualEndDate: null,
  rentPrice: 5_000_000, totalDeposit: 5_000_000, tenantName: 'Khách A',
});

describe('timelineDomain', () => {
  it('không có gì để vẽ ⇒ null, không vẽ trục ma', () => {
    expect(timelineDomain({ segments: [], events: [] }, TODAY)).toBeNull();
  });

  it('segment mở kéo miền tới hôm nay', () => {
    const d = timelineDomain(
      { segments: [seg({ toDate: null })], events: [] },
      TODAY,
    )!;
    expect(d.max).toBeGreaterThanOrEqual(new Date(TODAY).getTime());
  });

  it('một mốc duy nhất vẫn ra miền dương (cửa sổ 30 ngày)', () => {
    const d = timelineDomain(
      {
        segments: [],
        events: [{ type: 'DEPOSIT_RECEIVED', date: '2026-03-15', contractId: 'c1', amount: 1, trusted: true, meta: null }],
      },
      TODAY,
    )!;
    expect(d.max - d.min).toBeGreaterThan(0);
  });
});

describe('datePercent', () => {
  const d = timelineDomain(
    { segments: [seg({ fromDate: '2026-01-01', toDate: '2026-12-31' })], events: [] },
    TODAY,
  )!;

  it('đơn điệu theo thời gian', () => {
    const dates = ['2026-01-01', '2026-03-01', '2026-06-15', '2026-12-31'];
    const ps = dates.map((x) => datePercent(x, d));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
  });

  it('điểm ngoài miền bị clamp 0..100, không văng khỏi khung', () => {
    expect(datePercent('2020-01-01', d)).toBe(0);
    expect(datePercent('2030-01-01', d)).toBe(100);
  });
});

describe('buildLanes', () => {
  it('mỗi hợp đồng một lane; thanh trong lane không chồng nhau, xếp theo thời gian', () => {
    const segments = [
      seg({ contractId: 'c1', segIndex: 1, fromDate: '2026-06-01', toDate: null }),
      seg({ contractId: 'c1', segIndex: 0, fromDate: '2026-01-01', toDate: '2026-06-01' }),
      seg({ contractId: 'c2', segIndex: 0, fromDate: '2025-01-01', toDate: '2025-12-01' }),
    ];
    const domain = timelineDomain({ segments, events: [] }, TODAY)!;
    const lanes = buildLanes(
      { segments, contracts: [contract('c1'), contract('c2')] },
      domain, TODAY,
    );
    expect(lanes).toHaveLength(2);
    // lane xếp theo mốc vào sớm nhất: c2 (2025) trước c1 (2026)
    expect(lanes[0].contractId).toBe('c2');
    for (const lane of lanes) {
      for (let i = 1; i < lane.bars.length; i++) {
        const prev = lane.bars[i - 1];
        const cur = lane.bars[i];
        expect(cur.left).toBeGreaterThanOrEqual(prev.left + prev.width - 0.51); // nửa mở chạm mép được
      }
      for (const b of lane.bars) {
        expect(b.width).toBeGreaterThanOrEqual(0.5); // thanh 1 ngày vẫn thấy được
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.left + b.width).toBeLessThanOrEqual(100.01);
      }
    }
  });

  it('fromDate null (không biết mốc vào) ⇒ thanh neo mép trái và đánh dấu openStarted', () => {
    const segments = [seg({ fromDate: null, toDate: '2026-06-01', trusted: false })];
    const domain = timelineDomain({ segments, events: [] }, TODAY)!;
    const lanes = buildLanes({ segments, contracts: [contract('c1')] }, domain, TODAY);
    expect(lanes[0].bars[0].openStarted).toBe(true);
    expect(lanes[0].bars[0].left).toBe(0);
  });
});

describe('vacancyProblems — client XÁC MINH số server, không tin mù', () => {
  it('vacancy hợp lệ giữa hai segment ⇒ không vấn đề', () => {
    const p = vacancyProblems({
      segments: [
        seg({ contractId: 'c1', toDate: '2026-03-01' }),
        seg({ contractId: 'c2', fromDate: '2026-04-01', toDate: null }),
      ],
      vacancies: [{ fromDate: '2026-03-01', toDate: '2026-04-01', days: 31 }],
    });
    expect(p).toEqual([]);
  });

  it('vacancy chồng segment đáng tin ⇒ báo vấn đề', () => {
    const p = vacancyProblems({
      segments: [seg({ fromDate: '2026-01-01', toDate: '2026-06-01' })],
      vacancies: [{ fromDate: '2026-02-01', toDate: '2026-03-01', days: 28 }],
    });
    expect(p.length).toBeGreaterThan(0);
  });

  it('vacancy ngược mốc / days âm ⇒ báo vấn đề', () => {
    const p = vacancyProblems({
      segments: [],
      vacancies: [{ fromDate: '2026-05-01', toDate: '2026-04-01', days: -30 }],
    });
    expect(p.length).toBeGreaterThanOrEqual(2);
  });

  it('vacancy đuôi mở (toDate null, trống tới nay) không chồng segment đã đóng', () => {
    const p = vacancyProblems({
      segments: [seg({ toDate: '2026-06-01' })],
      vacancies: [{ fromDate: '2026-06-01', toDate: null, days: 88 }],
    });
    expect(p).toEqual([]);
  });
});

describe('EVENT_LABEL — bảng nhãn phủ đủ taxonomy', () => {
  // RPC get_room_cash_lifecycle_v1 phát đúng 12 type này. Thêm type mới vào RPC
  // mà quên thêm nhãn ⇒ test này đỏ, thay vì UI hiện mã máy cho người dùng.
  const RPC_TYPES = [
    'CONTRACT_OPENED', 'ROOM_CHANGED_IN', 'ROOM_CHANGED_OUT', 'CONTRACT_CLOSED',
    'DEPOSIT_RECEIVED', 'INVOICE_ISSUED', 'INVOICE_COLLECTION_POSTED',
    'TERMINATION_REQUESTED', 'SETTLEMENT_OFFSET_POSTED', 'DEPOSIT_FORFEIT_POSTED',
    'DEPOSIT_REFUND_POSTED', 'COMMISSION_PAID',
  ];

  it('đủ 12 type, mỗi type có nhãn tiếng Việt + tông màu', () => {
    for (const t of RPC_TYPES) {
      expect(EVENT_LABEL[t], `thiếu nhãn cho ${t}`).toBeDefined();
      expect(EVENT_LABEL[t].label).not.toMatch(/^[A-Z_]+$/); // nhãn người đọc, không phải mã máy
    }
    expect(RPC_EVENT_TYPES.sort()).toEqual(RPC_TYPES.slice().sort());
  });
});
