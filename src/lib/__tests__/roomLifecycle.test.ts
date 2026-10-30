import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { boChuThichSql } from '../../../scripts/lib/bo-chu-thich.mjs';
import {
  timelineDomain, datePercent, buildLanes, vacancyProblems,
  COMMISSION_STAGES, EVENT_LABEL, LIFECYCLE_EVENT_TYPES, RPC_EVENT_TYPES, STAGE_TEXT,
  commissionEventOf, eventLabel, eventLabelOf, termText,
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

// ── Định nghĩa SỐNG (lần CREATE cuối theo timestamp) — không ghim file migration.
const MIG_DIR = resolve(process.cwd(), 'supabase/migrations');
function liveDefinitionOf(schema: string, fnName: string): string | null {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, 'i');
  let hit: string | null = null;
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = boChuThichSql(readFileSync(join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n'));
    const at = sql.search(re);
    if (at >= 0) hit = sql.slice(at);
  }
  if (!hit) return null;
  // Cắt đúng thân hàm: từ CREATE tới dollar-quote đóng thân.
  const tag = /AS\s+(\$[a-z_]*\$)/i.exec(hit);
  if (!tag) return null;
  const open = hit.indexOf(tag[1]) + tag[1].length;
  const close = hit.indexOf(tag[1], open);
  return close > open ? hit.slice(0, close) : null;
}

/** Biểu thức ĐẦU của mỗi nhánh UNION ALL trong CTE `ev` = cột type của sự kiện. */
function typeLiteralsOfEvCte(body: string): string[] {
  const start = body.search(/\bev\s+AS\s*\(/i);
  const end = body.search(/\bev_loc\s+AS\s*\(/i);
  expect(start, 'không thấy CTE ev').toBeGreaterThanOrEqual(0);
  expect(end, 'không thấy CTE ev_loc').toBeGreaterThan(start);
  const out: string[] = [];
  for (const branch of body.slice(start, end).split(/\bUNION\s+ALL\b/i)) {
    const sel = branch.search(/\bSELECT\b/i);
    if (sel < 0) continue;
    let depth = 0;
    let expr = '';
    for (const ch of branch.slice(sel + 'SELECT'.length)) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) break;
      expr += ch;
    }
    for (const m of expr.matchAll(/'([A-Z][A-Z0-9_]*)'/g)) out.push(m[1]);
  }
  return out;
}

describe('EVENT_LABEL — bảng nhãn phủ đủ taxonomy', () => {
  // Hợp đồng payload "vòng đời tiền một nguồn": đúng 25 type. Thêm type mới vào
  // RPC mà quên thêm nhãn ⇒ test này đỏ, thay vì UI hiện mã máy cho người dùng.
  it('đủ 25 type, mỗi type có nhãn tiếng Việt + tông màu', () => {
    expect(LIFECYCLE_EVENT_TYPES).toHaveLength(25);
    for (const t of LIFECYCLE_EVENT_TYPES) {
      expect(EVENT_LABEL[t], `thiếu nhãn cho ${t}`).toBeDefined();
      expect(EVENT_LABEL[t].label).not.toMatch(/^[A-Z_]+$/); // nhãn người đọc, không phải mã máy
      expect(t.length).toBeLessThanOrEqual(40); // luật `code` của Hermes
    }
    expect([...RPC_EVENT_TYPES].sort()).toEqual([...LIFECYCLE_EVENT_TYPES].sort());
    expect(Object.keys(EVENT_LABEL).sort()).toEqual([...LIFECYCLE_EVENT_TYPES].sort());
  });

  it('mọi type mà THÂN SQL SỐNG của get_room_cash_lifecycle_v1 phát ra đều có nhãn', () => {
    const body = liveDefinitionOf('public', 'get_room_cash_lifecycle_v1');
    expect(body, 'không thấy định nghĩa sống').not.toBeNull();
    const literals = typeLiteralsOfEvCte(body!);
    expect(literals).toContain('CONTRACT_OPENED');
    for (const lit of literals) {
      if (lit.endsWith('_')) {
        // Tiền tố ghép với trạng thái (COMMISSION_ || stage): đủ 5 trạng thái.
        for (const st of COMMISSION_STAGES) expect(LIFECYCLE_EVENT_TYPES).toContain(`${lit}${st}`);
      } else {
        expect(LIFECYCLE_EVENT_TYPES, `type ${lit} của RPC không có nhãn`).toContain(lit);
      }
    }
    // Trạng thái hoa hồng do helper sống phát ra phải nằm trong COMMISSION_STAGES.
    const h2 = liveDefinitionOf('app_private', 'contract_commission_vouchers_v1');
    if (h2) {
      const stages = [...h2.matchAll(/\b(?:THEN|ELSE)\s+'([A-Z][A-Z_]*)'/g)].map((m) => m[1]);
      expect(stages.length).toBeGreaterThan(0);
      for (const st of stages) expect(COMMISSION_STAGES as readonly string[]).toContain(st);
    }
  });

  it('10 type hoa hồng/thưởng: nhãn nói loại + trạng thái, cờ statusInLabel, tông theo trạng thái', () => {
    expect(EVENT_LABEL.COMMISSION_REVERSED).toEqual({ label: 'Hoa hồng môi giới · đã đảo', tone: 'neutral', statusInLabel: true });
    expect(EVENT_LABEL.SALE_BONUS_PENDING).toEqual({ label: 'Thưởng Sale · chờ duyệt', tone: 'warn', statusInLabel: true });
    expect(EVENT_LABEL.COMMISSION_PAID.tone).toBe('out');
    expect(EVENT_LABEL.SALE_BONUS_OFFBOOK.label).toBe('Thưởng Sale · trả ngoài sổ tiền');
    for (const t of LIFECYCLE_EVENT_TYPES) {
      expect(!!EVENT_LABEL[t].statusInLabel, t).toBe(commissionEventOf(t) !== null);
    }
    // Cấn trừ không phải tiền vào.
    expect(EVENT_LABEL.INVOICE_TERMINATION_OFFSET.tone).toBe('neutral');
  });

  it('type lạ rơi về mã máy với tông neutral, không sập', () => {
    expect(eventLabel('LOAI_MOI_CHUA_CO')).toEqual({ label: 'LOAI_MOI_CHUA_CO', tone: 'neutral' });
  });

  it('COMMISSION_PAID của RPC cũ (không voucherId) giữ nhãn cũ, không khẳng định "đã chi"', () => {
    expect(eventLabelOf({ type: 'COMMISSION_PAID', meta: { code: 'PC-GIA', name: 'HH' } }))
      .toEqual({ label: 'Hoa hồng / thưởng', tone: 'out' });
    expect(eventLabelOf({ type: 'COMMISSION_PAID', meta: { voucherId: 'v1', code: 'PC-GIA', name: 'HH' } }).label)
      .toBe('Hoa hồng môi giới · đã chi');
  });
});

describe('commissionEventOf', () => {
  it('đọc đủ 10 type, trả null cho type khác', () => {
    let n = 0;
    for (const t of LIFECYCLE_EVENT_TYPES) {
      const cm = commissionEventOf(t);
      if (!cm) continue;
      n += 1;
      expect(t).toBe(`${cm.kind === 'sale' ? 'SALE_BONUS' : 'COMMISSION'}_${cm.stage}`);
      expect(STAGE_TEXT[cm.stage]).toBeTruthy();
    }
    expect(n).toBe(10);
    expect(commissionEventOf('COMMISSION_APPROVED')).toBeNull();
    expect(commissionEventOf('SALE_BONUS_')).toBeNull();
    expect(commissionEventOf('INVOICE_ISSUED')).toBeNull();
  });
});

describe('termText — thời hạn hợp đồng có gia hạn (A2)', () => {
  it('không gia hạn / RPC cũ ⇒ dạng cũ', () => {
    expect(termText('2026-05-01', null, '2026-08-30')).toBe('01/05/2026 → 30/08/2026');
    expect(termText('2026-05-01', undefined, '2026-08-30')).toBe('01/05/2026 → 30/08/2026');
  });
  it('hạn gốc < hạn hiện tại ⇒ in hạn gốc kèm "gia hạn tới"', () => {
    expect(termText('2026-05-01', '2026-08-30', '2027-02-28'))
      .toBe('01/05/2026 → 30/08/2026 · gia hạn tới 28/02/2027');
  });
  it('hạn gốc ≥ hạn hiện tại (gia hạn kiểu tạo HĐ mới) ⇒ không in "gia hạn tới"', () => {
    expect(termText('2026-05-01', '2026-08-30', '2026-08-30')).toBe('01/05/2026 → 30/08/2026');
  });
  it('giữ dấu nối riêng của từng màn; thiếu ngày ⇒ —', () => {
    expect(termText('2026-05-01', null, null, ' – ')).toBe('01/05/2026 – —');
  });
});
