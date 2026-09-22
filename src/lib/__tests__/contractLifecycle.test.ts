// =============================================================================
// contractLifecycle.test.ts — toán THUẦN của dải "Vòng đời hợp đồng của phòng".
//
// CA THẬT NEO CẢ FILE (plan §3.2, ảnh người dùng 22/09/2026):
// phòng 401/32PVC, hợp đồng HĐT-046775/28102024 —
//   khách NỘP           4.500.000  (phiếu thu PT2607068)
//   nội bộ CẤN          1.424.000
//   `contracts.deposit_paid` còn 3.076.000  ← SỐ RÒNG SAU CẤN
// Màn hình cũ lấy số ròng làm "thực thu" rồi trừ cam kết ⇒ bịa ra
// "còn thiếu 1.424.000đ" cho một người đã nộp đủ. Sau khi phiếu hoàn 3.076.000
// được duyệt, số ròng lại tụt tiếp.
//
// BA SỐ KHÁC NHAU, KHÔNG ĐƯỢC GỘP:
//   gross  — tổng tiền cọc khách từng nộp, có mã phiếu + ngày thu chứng minh
//   net    — cọc còn giữ (gross trừ các lần chi/cấn ra khỏi cọc)
//   snapshot — số cọc chốt trong bản ghi thanh lý (`contract_terminations`)
//
// Semantics được phản chiếu: `app_private.contract_deposit_sources_v1`
// (`20260908051659_invoice_deposit_classification.sql:383–450`). Hàm đó nằm ở
// schema private, frontend KHÔNG gọi được — nên file này chép LUẬT, và test
// dưới đây là chỗ khoá luật lại.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  LANE_ROLE, LANE_TAG,
  buildDepositSources, summariseDeposit, reconcilePostings,
  closeResidenceSegments, buildLifecycleLanes, sumEffectiveInvoices,
  parseResidenceSegments, mocNgayNghiepVu,
  type DepositItemRow, type DepositSourceInput, type DepositVoucherRow,
  type LifecycleContractRow, type PostingRow, type ResidenceSegmentRow,
  type TerminationRow, type InvoiceRow,
} from '@/lib/contractLifecycle';

// ── Định danh: (UUID, organization_id). KHÔNG BAO GIỜ mã hiển thị ───────────
// Production có nhiều phiếu trùng mã (vd nhiều PC2607070 ở các phòng khác
// nhau), nên fixture mô phỏng HÌNH DẠNG ca thật còn định danh dùng UUID.
const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const ORG_KHAC = '0a0a0a0a-0000-4000-8000-0000000000ff';
const PHONG_401 = '0b0b0b0b-0000-4000-8000-000000000401';
const PHONG_402 = '0b0b0b0b-0000-4000-8000-000000000402';
const HD = '0c0c0c0c-0000-4000-8000-000000000001';
const HD_TRUOC = '0c0c0c0c-0000-4000-8000-000000000000';
const HD_SAU = '0c0c0c0c-0000-4000-8000-000000000002';
const SO_THAT = '0d0d0d0d-0000-4000-8000-000000000001';
const SO_AO = '0d0d0d0d-0000-4000-8000-0000000000a0';
const PT_THU = '0f0f0f0f-0000-4000-8000-000000000001';
const PC_CAN = '0f0f0f0f-0000-4000-8000-000000000002';
const PC_HOAN = '0f0f0f0f-0000-4000-8000-000000000003';

const NGAY_NGHIEP_VU = '2026-09-22';
/**
 * HOM NAY la mot moc KHAC moc nghiep vu. Mo mot phieu cua nam ngoai thi "hom
 * nay" van la hom nay - lan hai thu nay lam moi doan da dong sau ngay phieu bi
 * doc thanh "ket thuc o tuong lai".
 */
const HOM_NAY = '2026-09-22';
/** Mot ngay nghiep vu nam SAU trong qua khu, de tach bach hai moc. */
const NGAY_CU = '2024-10-28';

// ── Khuôn dựng nhanh ────────────────────────────────────────────────────────

const phieu = (p: Partial<DepositVoucherRow> & { id: string }): DepositVoucherRow => ({
  organization_id: ORG,
  code: null,
  type: 'INCOME',
  approval_status: 'APPROVED',
  posting_status: 'POSTED',
  posting_mode: 'CASH',
  deleted_at: null,
  reversal_of_income_expense_id: null,
  account_id: SO_THAT,
  system_source: null,
  voucher_date: '2026-07-06',
  created_at: '2026-07-06T02:00:00Z',
  ...p,
});

const item = (p: Partial<DepositItemRow> & { id: string; income_expense_id: string }): DepositItemRow => ({
  organization_id: ORG,
  accounting_class: 'DEPOSIT',
  amount: null,
  unit_price: 0,
  quantity: 1,
  ...p,
});

const hopDong = (p: Partial<LifecycleContractRow> & { id: string }): LifecycleContractRow => ({
  organization_id: ORG,
  contract_number: null,
  room_id: PHONG_401,
  status: 'ACTIVE',
  signed_date: '2024-10-28',
  start_date: '2024-10-28',
  end_date: '2026-10-27',
  actual_end_date: null,
  total_deposit: 4_500_000,
  rent_price: 4_500_000,
  customer_name: 'Khách 401',
  ...p,
});

const doan = (p: Partial<ResidenceSegmentRow> & { contract_id: string }): ResidenceSegmentRow => ({
  contract_number: null,
  seg_index: 0,
  room_id: PHONG_401,
  room_name: '401',
  from_date: '2024-10-28',
  to_date: null,
  source_path: 'CONTRACT_START',
  transfer_id: null,
  trusted: true,
  diagnostic: null,
  ...p,
});

const DOC_DUOC = { readable: true } as const;

/** Ba nguồn của ca thật: nộp 4.500.000, cấn 1.424.000, hoàn 3.076.000. */
const CA_THAT_TRUOC_HOAN: DepositSourceInput = {
  reaches: [
    { contractId: HD, voucherId: PT_THU, via: 'direct' as const },
    { contractId: HD, voucherId: PC_CAN, via: 'direct' as const },
  ],
  vouchers: [
    phieu({ id: PT_THU, code: 'PT2607068', type: 'INCOME', voucher_date: '2026-07-06' }),
    phieu({ id: PC_CAN, code: 'PC2607069', type: 'EXPENSE', voucher_date: '2026-07-08' }),
  ],
  items: [
    item({ id: 'i1', income_expense_id: PT_THU, amount: 4_500_000 }),
    item({ id: 'i2', income_expense_id: PC_CAN, amount: 1_424_000 }),
  ],
  virtualAccountIds: [] as string[],
  organizationId: ORG,
};

const goiCoc = (i: DepositSourceInput) =>
  summariseDeposit(buildDepositSources(i).get(HD) ?? [], new Map());

// ═══════════════════════════════════════════════════════════════════════════
describe('buildDepositSources — phản chiếu contract_deposit_sources_v1', () => {
  it('ca 401/32PVC: gross 4.500.000, cấn 1.424.000, ròng 3.076.000 — ba số TÁCH BẠCH', () => {
    const t = goiCoc(CA_THAT_TRUOC_HOAN);
    expect(t.grossCollected).toBe(4_500_000);
    expect(t.offsetOut).toBe(1_424_000);
    expect(t.netHeld).toBe(3_076_000);
  });

  it('SAU khi phiếu hoàn 3.076.000 được duyệt, GROSS vẫn 4.500.000 (chỉ ròng tụt về 0)', () => {
    const sau = {
      ...CA_THAT_TRUOC_HOAN,
      reaches: [...CA_THAT_TRUOC_HOAN.reaches, { contractId: HD, voucherId: PC_HOAN, via: 'direct' as const }],
      vouchers: [
        ...CA_THAT_TRUOC_HOAN.vouchers,
        phieu({ id: PC_HOAN, code: 'PC2609095', type: 'EXPENSE', voucher_date: '2026-09-20' }),
      ],
      items: [...CA_THAT_TRUOC_HOAN.items, item({ id: 'i3', income_expense_id: PC_HOAN, amount: 3_076_000 })],
    };
    const t = goiCoc(sau);
    expect(t.grossCollected).toBe(4_500_000);
    expect(t.offsetOut).toBe(4_500_000);
    expect(t.netHeld).toBe(0);
  });

  it('mốc cọc mang CHỨNG CỨ: ngày thu + mã phiếu thu của từng lần nộp', () => {
    const t = goiCoc(CA_THAT_TRUOC_HOAN);
    const thu = t.evidence.filter((e) => e.direction === 'IN');
    expect(thu).toHaveLength(1);
    expect(thu[0]).toMatchObject({ code: 'PT2607068', date: '2026-07-06', amount: 4_500_000 });
  });

  it('cọc một phần: nộp 2.000.000 trên cam kết 4.500.000 — gross đúng 2.000.000, KHÔNG suy ra cam kết', () => {
    const t = goiCoc({
      ...CA_THAT_TRUOC_HOAN,
      reaches: [{ contractId: HD, voucherId: PT_THU, via: 'direct' }],
      vouchers: [phieu({ id: PT_THU, code: 'PT2607068' })],
      items: [item({ id: 'i1', income_expense_id: PT_THU, amount: 2_000_000 })],
    });
    expect(t.grossCollected).toBe(2_000_000);
    expect(t.netHeld).toBe(2_000_000);
  });

  it('SỔ ẢO tách hẳn khỏi thực thu — ghi nhận lịch sử không cộng vào gross', () => {
    const t = goiCoc({
      ...CA_THAT_TRUOC_HOAN,
      reaches: [
        { contractId: HD, voucherId: PT_THU, via: 'direct' },
        { contractId: HD, voucherId: PC_CAN, via: 'direct' },
      ],
      vouchers: [
        phieu({ id: PT_THU, code: 'PT-AO', account_id: SO_AO, posting_status: 'NOT_APPLICABLE' }),
        phieu({ id: PC_CAN, code: 'PT-THAT', type: 'INCOME' }),
      ],
      items: [
        item({ id: 'i1', income_expense_id: PT_THU, amount: 9_000_000 }),
        item({ id: 'i2', income_expense_id: PC_CAN, amount: 1_000_000 }),
      ],
      virtualAccountIds: [SO_AO],
    });
    expect(t.grossCollected).toBe(1_000_000);
    expect(t.historicalIn).toBe(9_000_000);
    expect(t.historicalNet).toBe(9_000_000);
  });

  it('phiếu HỖN HỢP chỉ cộng phần item DEPOSIT, không lấy total_amount', () => {
    const t = goiCoc({
      ...CA_THAT_TRUOC_HOAN,
      reaches: [{ contractId: HD, voucherId: PT_THU, via: 'direct' }],
      vouchers: [phieu({ id: PT_THU, code: 'PT-HON-HOP' })],
      items: [
        item({ id: 'i1', income_expense_id: PT_THU, amount: 4_500_000 }),
        item({ id: 'i2', income_expense_id: PT_THU, accounting_class: 'RENT', amount: 4_500_000 }),
        item({ id: 'i3', income_expense_id: PT_THU, accounting_class: 'SERVICE', amount: 300_000 }),
      ],
    });
    expect(t.grossCollected).toBe(4_500_000);
  });

  it('linked receipt (qua contract_deposit_links) được tính', () => {
    const t = goiCoc({
      ...CA_THAT_TRUOC_HOAN,
      reaches: [{ contractId: HD, voucherId: PT_THU, via: 'link' }],
      vouchers: [phieu({ id: PT_THU, code: 'PT-GIU-CHO' })],
      items: [item({ id: 'i1', income_expense_id: PT_THU, amount: 2_000_000 })],
    });
    expect(t.grossCollected).toBe(2_000_000);
  });

  it('NGUỒN TRÙNG: vừa gắn trực tiếp vừa có link — chỉ tính MỘT LẦN', () => {
    const i = {
      ...CA_THAT_TRUOC_HOAN,
      reaches: [
        { contractId: HD, voucherId: PT_THU, via: 'direct' as const },
        { contractId: HD, voucherId: PT_THU, via: 'link' as const },
      ],
      vouchers: [phieu({ id: PT_THU, code: 'PT2607068' })],
      items: [item({ id: 'i1', income_expense_id: PT_THU, amount: 4_500_000 })],
    };
    const nguon = buildDepositSources(i).get(HD) ?? [];
    expect(nguon).toHaveLength(1);
    expect(nguon[0].reach).toBe('both');
    expect(summariseDeposit(nguon, new Map()).grossCollected).toBe(4_500_000);
  });

  it('HỦY / XÓA / ĐẢO / CHƯA DUYỆT đều bị loại và nêu lý do', () => {
    const v = (id: string, p: Partial<DepositVoucherRow>) => phieu({ id, ...p });
    const i = {
      organizationId: ORG,
      reaches: ['v1', 'v2', 'v3', 'v4', 'v5'].map((x) => ({ contractId: HD, voucherId: x, via: 'direct' as const })),
      vouchers: [
        v('v1', { approval_status: 'CANCELLED' }),
        v('v2', { deleted_at: '2026-07-09T00:00:00Z' }),
        v('v3', { reversal_of_income_expense_id: PT_THU }),
        v('v4', { posting_status: 'REVERSED' }),
        v('v5', { approval_status: 'UNAPPROVED' }),
      ],
      items: ['v1', 'v2', 'v3', 'v4', 'v5'].map((x, n) =>
        item({ id: `i${n}`, income_expense_id: x, amount: 1_000_000 })),
      virtualAccountIds: [],
    };
    const t = summariseDeposit(buildDepositSources(i).get(HD) ?? [], new Map());
    expect(t.grossCollected).toBe(0);
    expect(t.netHeld).toBe(0);
    expect(t.excluded.map((e) => e.excludeReason)).toEqual([
      'đã huỷ', 'đã xoá', 'phiếu đảo bút toán', 'đã đảo bút toán', 'chưa duyệt',
    ]);
  });

  it('phiếu KHÔNG có item DEPOSIT nào thì không thành nguồn cọc', () => {
    const nguon = buildDepositSources({
      ...CA_THAT_TRUOC_HOAN,
      reaches: [{ contractId: HD, voucherId: PT_THU, via: 'direct' }],
      vouchers: [phieu({ id: PT_THU })],
      items: [item({ id: 'i1', income_expense_id: PT_THU, accounting_class: 'RENT', amount: 4_500_000 })],
    }).get(HD);
    expect(nguon ?? []).toHaveLength(0);
  });

  it('item dùng unit_price × quantity khi amount NULL (coalesce như SQL)', () => {
    const t = goiCoc({
      ...CA_THAT_TRUOC_HOAN,
      reaches: [{ contractId: HD, voucherId: PT_THU, via: 'direct' }],
      vouchers: [phieu({ id: PT_THU })],
      items: [item({ id: 'i1', income_expense_id: PT_THU, amount: null, unit_price: 1_500_000, quantity: 3 })],
    });
    expect(t.grossCollected).toBe(4_500_000);
  });

  it('CÁCH LY CÔNG TY: phiếu/item của org khác không bao giờ lọt vào tổng', () => {
    const t = goiCoc({
      ...CA_THAT_TRUOC_HOAN,
      reaches: [
        { contractId: HD, voucherId: PT_THU, via: 'direct' },
        { contractId: HD, voucherId: PC_CAN, via: 'direct' },
      ],
      vouchers: [
        phieu({ id: PT_THU }),
        phieu({ id: PC_CAN, organization_id: ORG_KHAC, type: 'INCOME' }),
      ],
      items: [
        item({ id: 'i1', income_expense_id: PT_THU, amount: 4_500_000 }),
        item({ id: 'i2', income_expense_id: PC_CAN, organization_id: ORG_KHAC, amount: 9_999_999 }),
        item({ id: 'i3', income_expense_id: PT_THU, organization_id: ORG_KHAC, amount: 7_777_777 }),
      ],
    });
    expect(t.grossCollected).toBe(4_500_000);
  });

  it('hơn 1.000 dòng: cộng đủ, không hụt ở ranh giới trang', () => {
    const n = 1_200;
    const ids = Array.from({ length: n }, (_, k) => `v-${String(k).padStart(5, '0')}`);
    const t = goiCoc({
      organizationId: ORG,
      reaches: ids.map((id) => ({ contractId: HD, voucherId: id, via: 'direct' as const })),
      vouchers: ids.map((id) => phieu({ id, code: id })),
      items: ids.map((id, k) => item({ id: `i-${k}`, income_expense_id: id, amount: 1_000 })),
      virtualAccountIds: [],
    });
    expect(t.grossCollected).toBe(1_200_000);
    expect(t.evidence).toHaveLength(n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reconcilePostings — bút toán KHÔNG đọc được là một trạng thái, không phải số 0', () => {
  const posting = (p: Partial<PostingRow> & { id: string; posting_subject_id: string }): PostingRow => ({
    organization_id: ORG,
    posting_subject_kind: 'VOUCHER',
    event_kind: 'POSTING',
    posting_generation: 1,
    reversal_of_id: null,
    source_kind: 'MANUAL',
    legacy_provenance: null,
    account_id: SO_THAT,
    ...p,
  });

  it('không đọc được postings ⇒ MỌI phiếu là "chưa xác minh", giữ nguyên trạng thái phiếu', () => {
    const r = reconcilePostings(
      [{ id: PT_THU, postingStatus: 'POSTED', postingMode: 'CASH' }],
      [],
      { readable: false, reason: 'Không đủ quyền đọc bút toán' },
    );
    expect(r.get(PT_THU)?.verification).toBe('unverified');
    expect(r.get(PT_THU)?.reason).toContain('quyền');
  });

  it('có bút toán hiệu lực ⇒ đã xác minh là tiền thật', () => {
    const r = reconcilePostings(
      [{ id: PT_THU, postingStatus: 'POSTED', postingMode: 'CASH' }],
      [posting({ id: 'p1', posting_subject_id: PT_THU })],
      DOC_DUOC,
    );
    expect(r.get(PT_THU)?.verification).toBe('verified');
  });

  it('bút toán đã bị ĐẢO ⇒ không còn hiệu lực, KHÔNG xếp vào thực thu', () => {
    const r = reconcilePostings(
      [{ id: PT_THU, postingStatus: 'POSTED', postingMode: 'CASH' }],
      [
        posting({ id: 'p1', posting_subject_id: PT_THU }),
        posting({ id: 'p2', posting_subject_id: PT_THU, event_kind: 'REVERSAL', reversal_of_id: 'p1' }),
      ],
      DOC_DUOC,
    );
    expect(r.get(PT_THU)?.verification).toBe('reversed');
  });

  it('POSTED mà đọc được postings nhưng KHÔNG thấy dòng nào ⇒ chưa xác minh, không tự xếp thực thu', () => {
    const r = reconcilePostings(
      [{ id: PT_THU, postingStatus: 'POSTED', postingMode: 'CASH' }],
      [posting({ id: 'p1', posting_subject_id: PC_CAN })],
      DOC_DUOC,
    );
    expect(r.get(PT_THU)?.verification).toBe('unverified');
  });

  it('phiếu sổ ảo (NON_CASH / NOT_APPLICABLE) KHÔNG bị đòi bút toán', () => {
    const r = reconcilePostings(
      [{ id: PT_THU, postingStatus: 'NOT_APPLICABLE', postingMode: 'NON_CASH' }],
      [],
      DOC_DUOC,
    );
    expect(r.get(PT_THU)?.verification).toBe('not-applicable');
  });

  it('dữ liệu LEGACY thiếu bút toán không bị coi là lỗi — vẫn là chưa xác minh, lý do nói rõ', () => {
    const r = reconcilePostings(
      [{ id: PT_THU, postingStatus: 'POSTED', postingMode: 'CASH', legacy: true }],
      [],
      DOC_DUOC,
    );
    expect(r.get(PT_THU)?.verification).toBe('unverified');
    expect(r.get(PT_THU)?.reason).toMatch(/lịch sử|legacy/i);
  });

  it('bút toán thế hệ mới thay thế thế hệ cũ đã đảo ⇒ vẫn hiệu lực', () => {
    const r = reconcilePostings(
      [{ id: PT_THU, postingStatus: 'POSTED', postingMode: 'CASH' }],
      [
        posting({ id: 'p1', posting_subject_id: PT_THU, posting_generation: 1 }),
        posting({ id: 'p2', posting_subject_id: PT_THU, event_kind: 'REVERSAL', reversal_of_id: 'p1' }),
        posting({ id: 'p3', posting_subject_id: PT_THU, posting_generation: 2 }),
      ],
      DOC_DUOC,
    );
    expect(r.get(PT_THU)?.verification).toBe('verified');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('parseResidenceSegments — biên kiểm tra kết quả RPC', () => {
  const tot = {
    contract_id: HD, contract_number: 'HD-B', seg_index: 0, room_id: PHONG_401,
    room_name: '401', from_date: '2024-10-28', to_date: null,
    source_path: 'CONTRACT_START', transfer_id: null, trusted: true, diagnostic: null,
  };

  it('nhận dòng đúng hình dạng', () => {
    const r = parseResidenceSegments([tot]);
    expect(r.rejected).toBe(0);
    expect(r.rows[0]).toMatchObject({ contract_id: HD, seg_index: 0, trusted: true });
  });

  it('LOẠI và ĐẾM dòng thiếu contract_id hoặc seg_index', () => {
    const r = parseResidenceSegments([tot, { ...tot, contract_id: null }, { ...tot, seg_index: 'x' }, 7, null]);
    expect(r.rows).toHaveLength(1);
    expect(r.rejected).toBe(4);
  });

  it('`trusted` lạ đọc thành KHÔNG tin cậy, không thành tin cậy', () => {
    expect(parseResidenceSegments([{ ...tot, trusted: 'true' }]).rows[0].trusted).toBe(false);
    expect(parseResidenceSegments([{ ...tot, trusted: undefined }]).rows[0].trusted).toBe(false);
  });

  it('data không phải mảng (null / object) ⇒ rỗng, không ném', () => {
    expect(parseResidenceSegments(null)).toEqual({ rows: [], rejected: 0 });
    expect(parseResidenceSegments({ a: 1 })).toEqual({ rows: [], rejected: 0 });
  });

  it('chuỗi rỗng ở cột ngày đọc thành null, không thành ngày rác', () => {
    const r = parseResidenceSegments([{ ...tot, from_date: '', to_date: '' }]);
    expect(r.rows[0].from_date).toBeNull();
    expect(r.rows[0].to_date).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('closeResidenceSegments — đóng đoạn cuối như adapter room cash lifecycle', () => {
  it('to_date NULL + hợp đồng TERMINATED ⇒ đóng tại actual_end_date', () => {
    const [s] = closeResidenceSegments(
      [doan({ contract_id: HD })],
      [hopDong({ id: HD, status: 'TERMINATED', actual_end_date: '2026-09-15', end_date: '2026-10-27' })],
      HOM_NAY,
    );
    expect(s.toDate).toBe('2026-09-15');
  });

  it('không có actual_end_date nhưng TERMINATED/EXPIRED ⇒ đóng tại end_date', () => {
    const [s] = closeResidenceSegments(
      [doan({ contract_id: HD })],
      [hopDong({ id: HD, status: 'EXPIRED', actual_end_date: null, end_date: '2026-08-31' })],
      HOM_NAY,
    );
    expect(s.toDate).toBe('2026-08-31');
  });

  it('hợp đồng còn hiệu lực ⇒ đoạn vẫn MỞ (null), không bịa ngày đóng', () => {
    const [s] = closeResidenceSegments(
      [doan({ contract_id: HD })],
      [hopDong({ id: HD, status: 'ACTIVE' })],
      HOM_NAY,
    );
    expect(s.toDate).toBeNull();
  });

  it('ngày đóng TRƯỚC ngày mở ⇒ kẹp về ngày mở, hạ trusted, gắn diagnostic', () => {
    const [s] = closeResidenceSegments(
      [doan({ contract_id: HD, from_date: '2026-03-01' })],
      [hopDong({ id: HD, status: 'TERMINATED', actual_end_date: '2026-01-01' })],
      HOM_NAY,
    );
    expect(s.toDate).toBe('2026-03-01');
    expect(s.trusted).toBe(false);
    expect(s.diagnostic).toBe('SEGMENT_END_BEFORE_START');
  });

  it('ngày đóng ở TƯƠNG LAI so với HÔM NAY ⇒ diagnostic, không im lặng nhận', () => {
    const [s] = closeResidenceSegments(
      [doan({ contract_id: HD })],
      [hopDong({ id: HD, status: 'TERMINATED', actual_end_date: '2027-01-01' })],
      HOM_NAY,
    );
    expect(s.diagnostic).toBe('SEGMENT_END_IN_FUTURE');
    expect(s.trusted).toBe(false);
  });

  it('giữ nguyên diagnostic có sẵn của projection (chuỗi chuyển phòng không tin cậy)', () => {
    const [s] = closeResidenceSegments(
      [doan({ contract_id: HD, trusted: false, diagnostic: 'SEGMENT_HISTORY_AMBIGUOUS: x' })],
      [hopDong({ id: HD })],
      HOM_NAY,
    );
    expect(s.trusted).toBe(false);
    expect(s.diagnostic).toContain('SEGMENT_HISTORY_AMBIGUOUS');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('buildLifecycleLanes — nhiều lane theo LỊCH SỬ PHÒNG', () => {
  const ketThuc = (p: Partial<TerminationRow> & { contract_id: string }): TerminationRow => ({
    id: `t-${p.contract_id}`,
    organization_id: ORG,
    termination_date: '2026-09-20',
    termination_type: 'NORMAL',
    refund_amount: 3_076_000,
    outstanding_debt: 0,
    total_deposit: 4_500_000,
    ...p,
  });

  type Nen = Omit<
    Parameters<typeof buildLifecycleLanes>[0],
    'targetContractId' | 'subject' | 'contracts' | 'segments'
  >;
  const nen: Nen = {
    organizationId: ORG,
    roomId: PHONG_401,
    businessDate: NGAY_NGHIEP_VU,
    todayISO: HOM_NAY,
    terminations: [] as TerminationRow[],
    depositByContract: new Map(),
    invoiceByContract: new Map(),
    reads: {
      contracts: { ok: true },
      segments: { ok: true },
      transfers: { ok: true },
      deposits: { ok: true },
      invoices: { ok: true },
      postings: { ok: true },
    },
  };

  it('ba hợp đồng trên một phòng: TRƯỚC · ĐÍCH · KẾ TIẾP, đúng thứ tự cư trú', () => {
    const v = buildLifecycleLanes({
      ...nen,
      targetContractId: HD,
      subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [
        hopDong({ id: HD_SAU, contract_number: 'HD-C', status: 'ACTIVE' }),
        hopDong({ id: HD, contract_number: 'HD-B', status: 'TERMINATED', actual_end_date: '2026-09-20' }),
        hopDong({ id: HD_TRUOC, contract_number: 'HD-A', status: 'TERMINATED', actual_end_date: '2024-10-01' }),
      ],
      segments: [
        doan({ contract_id: HD_TRUOC, contract_number: 'HD-A', from_date: '2023-01-01' }),
        doan({ contract_id: HD, contract_number: 'HD-B', from_date: '2024-10-28' }),
        doan({ contract_id: HD_SAU, contract_number: 'HD-C', from_date: '2026-09-21' }),
      ],
      terminations: [ketThuc({ contract_id: HD }), ketThuc({ contract_id: HD_TRUOC, termination_date: '2024-10-01' })],
    });
    expect(v.lanes.map((l) => l.contractId)).toEqual([HD_TRUOC, HD, HD_SAU]);
    expect(v.lanes.map((l) => l.role)).toEqual([
      LANE_ROLE.before, LANE_ROLE.refund, LANE_ROLE.after,
    ]);
    expect(v.lanes.map((l) => l.target)).toEqual([false, true, false]);
  });

  it('nhãn vai theo ĐÚNG loại phiếu — hoa hồng / thưởng / biến động', () => {
    const goi = (subject: Parameters<typeof buildLifecycleLanes>[0]['subject']) =>
      buildLifecycleLanes({
        ...nen, targetContractId: HD, subject,
        contracts: [hopDong({ id: HD, contract_number: 'HD-B' })],
        segments: [doan({ contract_id: HD })],
      }).lanes[0].role;
    expect(goi({ kind: 'voucher', voucherKind: 'commission' })).toBe(LANE_ROLE.commission);
    expect(goi({ kind: 'voucher', voucherKind: 'bonus' })).toBe(LANE_ROLE.bonus);
    expect(goi({ kind: 'movement' })).toBe(LANE_ROLE.movement);
  });

  it('phiếu CHƯA XÁC ĐỊNH LOẠI không được gắn nhãn "Hợp đồng của phiếu hoàn"', () => {
    const role = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'unknown' },
      contracts: [hopDong({ id: HD })],
      segments: [doan({ contract_id: HD })],
    }).lanes[0].role;
    expect(role).not.toBe(LANE_ROLE.refund);
    expect(role).toBe(LANE_ROLE.unknown);
  });

  it('GIA HẠN giữ nguyên ID ⇒ MỘT lane, không nhân đôi', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'movement' },
      contracts: [hopDong({ id: HD, contract_number: 'HD-B', end_date: '2027-10-27' })],
      // Hai đoạn cư trú cùng một hợp đồng (vd chuyển phòng rồi quay lại).
      segments: [
        doan({ contract_id: HD, seg_index: 0, from_date: '2024-10-28', to_date: '2025-06-01' }),
        doan({ contract_id: HD, seg_index: 1, from_date: '2025-09-01' }),
      ],
    });
    expect(v.lanes).toHaveLength(1);
    expect(v.lanes[0].contractId).toBe(HD);
  });

  it('CHUYỂN PHÒNG: chỉ lấy đoạn cư trú TRÊN PHÒNG NÀY, không tin contracts.room_id', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'movement' },
      // Hợp đồng đã chuyển sang 402 — `contracts.room_id` nay là 402.
      contracts: [
        hopDong({ id: HD, contract_number: 'HD-B', room_id: PHONG_402 }),
        hopDong({ id: HD_SAU, contract_number: 'HD-C', room_id: PHONG_401 }),
      ],
      segments: [
        doan({ contract_id: HD, seg_index: 0, room_id: PHONG_401, from_date: '2024-10-28', to_date: '2026-01-01' }),
        doan({ contract_id: HD, seg_index: 1, room_id: PHONG_402, from_date: '2026-01-01' }),
        doan({ contract_id: HD_SAU, room_id: PHONG_401, from_date: '2026-02-01' }),
      ],
    });
    expect(v.lanes.map((l) => l.contractId)).toEqual([HD, HD_SAU]);
    expect(v.lanes[0].segment).toMatchObject({ fromDate: '2024-10-28', toDate: '2026-01-01' });
  });

  it('hợp đồng ĐÃ THANH LÝ KHÔNG được gắn "HĐ hiện tại" dù raw segment còn mở', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, status: 'TERMINATED', actual_end_date: '2026-09-20' })],
      segments: [doan({ contract_id: HD, to_date: null })],
      terminations: [ketThuc({ contract_id: HD })],
    });
    expect(v.lanes[0].tag).toBe(LANE_TAG.terminated);
    expect(v.lanes.some((l) => l.tag === LANE_TAG.current)).toBe(false);
  });

  it('lane CUỐI chưa thanh lý ⇒ "HĐ hiện tại"; lane giữa chưa thanh lý ⇒ "Đang thuê"', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD_TRUOC, subject: { kind: 'movement' },
      contracts: [
        hopDong({ id: HD_TRUOC, contract_number: 'HD-A' }),
        hopDong({ id: HD_SAU, contract_number: 'HD-C' }),
      ],
      segments: [
        doan({ contract_id: HD_TRUOC, from_date: '2023-01-01', to_date: '2024-10-01' }),
        doan({ contract_id: HD_SAU, from_date: '2024-10-28' }),
      ],
    });
    expect(v.lanes.map((l) => l.tag)).toEqual([LANE_TAG.renting, LANE_TAG.current]);
  });

  it('TARGET CŨ + hợp đồng HIỆN TẠI mới hơn ⇒ giữ đủ chuỗi từ đích tới hiện tại', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD_TRUOC, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [
        hopDong({ id: HD_TRUOC, contract_number: 'HD-A', status: 'TERMINATED', actual_end_date: '2024-10-01' }),
        hopDong({ id: HD, contract_number: 'HD-B', status: 'TERMINATED', actual_end_date: '2026-09-20' }),
        hopDong({ id: HD_SAU, contract_number: 'HD-C' }),
      ],
      segments: [
        doan({ contract_id: HD_TRUOC, from_date: '2023-01-01' }),
        doan({ contract_id: HD, from_date: '2024-10-28' }),
        doan({ contract_id: HD_SAU, from_date: '2026-09-21' }),
      ],
      terminations: [ketThuc({ contract_id: HD_TRUOC }), ketThuc({ contract_id: HD })],
    });
    expect(v.lanes.map((l) => l.role)).toEqual([LANE_ROLE.refund, LANE_ROLE.after, LANE_ROLE.after]);
    expect(v.roomState.kind).toBe('occupied');
    expect(v.roomState.contractId).toBe(HD_SAU);
  });

  it('CÁCH LY CÔNG TY: hợp đồng/đoạn của org khác bị loại khỏi chuỗi', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'movement' },
      contracts: [
        hopDong({ id: HD, contract_number: 'HD-B' }),
        hopDong({ id: HD_SAU, contract_number: 'HD-LA', organization_id: ORG_KHAC }),
      ],
      segments: [
        doan({ contract_id: HD, from_date: '2024-10-28' }),
        doan({ contract_id: HD_SAU, from_date: '2026-01-01' }),
      ],
    });
    expect(v.lanes.map((l) => l.contractId)).toEqual([HD]);
  });

  it('đoạn CHỒNG LẤN ⇒ giữ nguyên thứ tự nhưng gắn diagnostic, không im lặng', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'movement' },
      contracts: [
        hopDong({ id: HD, contract_number: 'HD-B', status: 'TERMINATED', actual_end_date: '2026-03-01' }),
        hopDong({ id: HD_SAU, contract_number: 'HD-C' }),
      ],
      segments: [
        doan({ contract_id: HD, from_date: '2024-10-28' }),
        doan({ contract_id: HD_SAU, from_date: '2025-01-01' }),
      ],
    });
    expect(v.diagnostics.join(' ')).toMatch(/chồng lấn/i);
    expect(v.status.lanes.kind).toBe('insufficient');
  });

  it('ĐỌC LỖI khác RỖNG: segments lỗi ⇒ status error, KHÔNG kết luận phòng trống', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'movement' },
      contracts: [hopDong({ id: HD })],
      segments: [],
      reads: { ...nen.reads, segments: { ok: false, reason: 'Không đọc được lịch sử cư trú' } },
    });
    expect(v.status.lanes.kind).toBe('error');
    expect(v.roomState.kind).toBe('insufficient');
    expect(v.roomState.label).toContain('Chưa đủ dữ liệu');
  });

  it('phòng KHÔNG có hợp đồng nào và mọi nguồn đọc TỐT ⇒ vẫn không tự nhận là trống nếu thiếu chuỗi', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'movement' },
      contracts: [], segments: [],
    });
    expect(v.lanes).toHaveLength(0);
    expect(v.roomState.kind).toBe('insufficient');
  });

  it('mọi hợp đồng đã thanh lý, nguồn đầy đủ và tin cậy ⇒ phòng TRỐNG được khẳng định', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, contract_number: 'HD-B', status: 'TERMINATED', actual_end_date: '2026-09-20' })],
      segments: [doan({ contract_id: HD, to_date: '2026-09-20' })],
      terminations: [ketThuc({ contract_id: HD })],
    });
    expect(v.roomState.kind).toBe('vacant');
    expect(v.status.lanes.kind).toBe('sufficient');
  });

  it('mốc 2 dùng GROSS + chứng cứ, KHÔNG dùng deposit_paid và KHÔNG bịa "còn thiếu"', () => {
    const nguon = buildDepositSources(CA_THAT_TRUOC_HOAN).get(HD) ?? [];
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, contract_number: 'HĐT-046775/28102024' })],
      segments: [doan({ contract_id: HD })],
      depositByContract: new Map([[HD, summariseDeposit(nguon, new Map())]]),
    });
    const moc = v.lanes[0].steps[1];
    expect(moc.h).toBe('Cọc đã đóng · thực thu');
    expect(moc.v).toBe('4.500.000 đ');
    expect(moc.m).toBe('06/07/2026 · PT2607068');
    expect(JSON.stringify(v.lanes[0].steps)).not.toContain('còn thiếu');
  });

  it('không có nguồn cọc nào đọc được ⇒ mốc 2 ghi "Chưa đủ dữ liệu", KHÔNG hiện 0 đ', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD })],
      segments: [doan({ contract_id: HD })],
      depositByContract: new Map(),
      reads: { ...nen.reads, deposits: { ok: false, reason: 'Không đọc được phiếu cọc' } },
    });
    const moc = v.lanes[0].steps[1];
    expect(moc.v).toBe('Chưa đủ dữ liệu');
    expect(moc.v).not.toBe('0 đ');
    expect(v.status.deposit.kind).toBe('error');
  });

  it('mốc 4 của lane ĐÍCH đã thanh lý: quyết toán hoàn + nợ sau quyết toán', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, status: 'TERMINATED', actual_end_date: '2026-09-20' })],
      segments: [doan({ contract_id: HD, to_date: '2026-09-20' })],
      terminations: [ketThuc({ contract_id: HD, outstanding_debt: 120_000 })],
    });
    const moc = v.lanes[0].steps[3];
    expect(moc.h).toBe('Thanh lý · 20/09/2026');
    expect(moc.v).toBe('Quyết toán hoàn 3.076.000 đ');
    expect(moc.m).toBe('Nợ sau quyết toán: 120.000 đ');
  });

  it('mốc 4 khi CHƯA thanh lý: "Đến hôm nay · <mốc nghiệp vụ>"', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'movement' },
      contracts: [hopDong({ id: HD })],
      segments: [doan({ contract_id: HD })],
    });
    const moc = v.lanes[0].steps[3];
    expect(moc.h).toBe('Đến hôm nay · 22/09/2026');
    expect(moc.v).toBe('Đang thuê');
    expect(moc.m).toBe('Chưa thanh lý');
  });

  // -- Doc RONG ma thanh cong KHONG phai la "da chung minh bang 0" ---------
  it('cam kết cọc > 0 mà KHÔNG có nguồn nào và KHÔNG có nguồn bị loại ⇒ CHƯA CHỨNG MINH', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, total_deposit: 4_500_000 })],
      segments: [doan({ contract_id: HD })],
      depositByContract: new Map([[HD, summariseDeposit([], new Map())]]),
    });
    expect(v.lanes[0].steps[1].v).toBe('Chưa đủ dữ liệu');
    expect(v.lanes[0].steps[1].v).not.toBe('0 đ');
    expect(v.status.deposit.kind).toBe('insufficient');

    // KHÔNG được đổ cho quyền xem. Đo production 22/09/2026: 435 hợp đồng cam
    // kết cọc > 0, 30 trong số đó KHÔNG có nguồn DEPOSIT nào — phiếu không tồn
    // tại với bất kỳ ai. Nói "ngoài quyền xem của bạn" là đẩy người ta đi xin
    // một quyền vô ích và giấu mất câu trả lời thật.
    const ly = (v.status.deposit as { reason: string }).reason;
    expect(ly).not.toMatch(/quyền/i);
    expect(ly).toMatch(/chưa ghi nhận/);
    expect(v.lanes[0].steps[1].m).not.toMatch(/quyền/i);
    expect(v.lanes[0].steps[1].m).toMatch(/chưa ghi nhận/);
  });

  it('hợp đồng KHÔNG cam kết cọc và không có nguồn ⇒ 0 đ là sự thật, không báo thiếu', () => {
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, total_deposit: 0 })],
      segments: [doan({ contract_id: HD })],
      depositByContract: new Map([[HD, summariseDeposit([], new Map())]]),
    });
    expect(v.lanes[0].steps[1].v).toBe('0 đ');
    expect(v.status.deposit.kind).toBe('sufficient');
  });

  it('cam kết > 0 nhưng MỌI nguồn bị loại (đã huỷ) ⇒ 0 đ, vì có lý do chứng minh', () => {
    const nguon = buildDepositSources({
      organizationId: ORG,
      reaches: [{ contractId: HD, voucherId: PT_THU, via: 'direct' }],
      vouchers: [phieu({ id: PT_THU, code: 'PT-HUY', approval_status: 'CANCELLED' })],
      items: [item({ id: 'i1', income_expense_id: PT_THU, amount: 4_500_000 })],
      virtualAccountIds: [],
    }).get(HD) ?? [];
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, total_deposit: 4_500_000 })],
      segments: [doan({ contract_id: HD })],
      depositByContract: new Map([[HD, summariseDeposit(nguon, new Map())]]),
    });
    expect(v.lanes[0].steps[1].v).toBe('0 đ');
    expect(v.status.deposit.kind).toBe('sufficient');
  });

  it('nguồn cọc đọc được MỘT PHẦN ⇒ insufficient (không phải error), vẫn hiện số đã có', () => {
    const nguon = buildDepositSources(CA_THAT_TRUOC_HOAN).get(HD) ?? [];
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD })],
      segments: [doan({ contract_id: HD })],
      depositByContract: new Map([[HD, summariseDeposit(nguon, new Map())]]),
      reads: { ...nen.reads, deposits: { ok: 'partial', reason: 'Không đọc được 1/1 nguồn cọc liên kết' } },
    });
    expect(v.status.deposit.kind).toBe('insufficient');
    expect(v.status.deposit.kind).not.toBe('error');
    expect((v.status.deposit as { reason: string }).reason).toContain('1/1');
    expect(v.lanes[0].steps[1].v).toBe('4.500.000 đ');
  });

  // -- "Hom nay" khac "ngay nghiep vu" -------------------------------------
  it('mở phiếu CŨ: đoạn đóng sau ngày phiếu KHÔNG bị coi là "kết thúc ở tương lai"', () => {
    const v = buildLifecycleLanes({
      ...nen, businessDate: NGAY_CU, todayISO: HOM_NAY,
      targetContractId: HD, subject: { kind: 'movement' },
      contracts: [hopDong({ id: HD, contract_number: 'HD-B', status: 'TERMINATED', actual_end_date: '2026-03-01' })],
      segments: [doan({ contract_id: HD })],
      terminations: [ketThuc({ contract_id: HD, termination_date: '2026-03-01' })],
    });
    expect(v.lanes[0].diagnostics).toEqual([]);
    expect(v.lanes[0].trusted).toBe(true);
    expect(v.status.lanes.kind).toBe('sufficient');
    expect(v.roomState.kind).not.toBe('insufficient');
  });

  it('mốc "Đến hôm nay" lấy HÔM NAY, không lấy ngày phiếu/biến động', () => {
    const v = buildLifecycleLanes({
      ...nen, businessDate: NGAY_CU, todayISO: HOM_NAY,
      targetContractId: HD, subject: { kind: 'movement' },
      contracts: [hopDong({ id: HD })], segments: [doan({ contract_id: HD })],
    });
    expect(v.lanes[0].steps[3].h).toBe('Đến hôm nay · 22/09/2026');
    expect(v.lanes[0].steps[3].h).not.toContain('28/10/2024');
  });

  it('CỌC QUYẾT TOÁN là snapshot RIÊNG, không phải gross và không phải ròng', () => {
    const nguon = buildDepositSources(CA_THAT_TRUOC_HOAN).get(HD) ?? [];
    const v = buildLifecycleLanes({
      ...nen, targetContractId: HD, subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [hopDong({ id: HD, status: 'TERMINATED', actual_end_date: '2026-09-20' })],
      segments: [doan({ contract_id: HD, to_date: '2026-09-20' })],
      terminations: [ketThuc({ contract_id: HD, total_deposit: 4_500_000 })],
      depositByContract: new Map([[HD, summariseDeposit(nguon, new Map())]]),
    });
    expect(v.target?.deposit?.grossCollected).toBe(4_500_000);
    expect(v.target?.deposit?.netHeld).toBe(3_076_000);
    expect(v.target?.settlementDeposit).toBe(4_500_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('sumEffectiveInvoices — tiền thuê/phí, loại hóa đơn không hiệu lực', () => {
  const hd = (p: Partial<InvoiceRow> & { id: string }): InvoiceRow => ({
    contract_id: HD, organization_id: ORG, status: 'PAID',
    deleted_at: null, paid_amount: 1_000_000, total_amount: 1_000_000, remaining_amount: 0,
    ...p,
  });

  it('cộng đủ hóa đơn hiệu lực', () => {
    const t = sumEffectiveInvoices([hd({ id: 'a' }), hd({ id: 'b' })], ORG);
    expect(t.get(HD)?.paid).toBe(2_000_000);
  });

  it('loại hóa đơn DRAFT — nháp kỳ sau KHÔNG phải nợ (như 20260920194951:283)', () => {
    const t = sumEffectiveInvoices(
      [hd({ id: 'a' }),
       hd({ id: 'b', status: 'DRAFT', paid_amount: 0, total_amount: 3_000_000, remaining_amount: 3_000_000 })],
      ORG,
    );
    expect(t.get(HD)?.paid).toBe(1_000_000);
    expect(t.get(HD)?.debt).toBe(0);
  });

  it('loại hóa đơn CANCELLED và đã xoá mềm', () => {
    const t = sumEffectiveInvoices(
      [hd({ id: 'a' }), hd({ id: 'b', status: 'CANCELLED' }), hd({ id: 'c', deleted_at: '2026-01-01' })],
      ORG,
    );
    expect(t.get(HD)?.paid).toBe(1_000_000);
  });

  it('nợ còn lại lấy remaining_amount, thiếu thì tổng trừ đã trả', () => {
    const t = sumEffectiveInvoices(
      [hd({ id: 'a', paid_amount: 600_000, remaining_amount: 400_000 }),
       hd({ id: 'b', paid_amount: 0, remaining_amount: null, total_amount: 500_000 })],
      ORG,
    );
    expect(t.get(HD)?.debt).toBe(900_000);
  });

  it('CÁCH LY CÔNG TY: hóa đơn org khác không cộng vào', () => {
    const t = sumEffectiveInvoices([hd({ id: 'a' }), hd({ id: 'b', organization_id: ORG_KHAC })], ORG);
    expect(t.get(HD)?.paid).toBe(1_000_000);
  });
});

// ===========================================================================
describe('mocNgayNghiepVu — mốc ngày của hồ sơ đang mở', () => {
  it('lấy phần NGÀY của chuỗi ISO có giờ', () => {
    expect(mocNgayNghiepVu('2026-07-06T02:00:00Z', HOM_NAY)).toBe('2026-07-06');
  });

  it('rỗng/null thì lùi về HÔM NAY được truyền vào', () => {
    expect(mocNgayNghiepVu(null, HOM_NAY)).toBe(HOM_NAY);
    expect(mocNgayNghiepVu(undefined, HOM_NAY)).toBe(HOM_NAY);
    expect(mocNgayNghiepVu('', HOM_NAY)).toBe(HOM_NAY);
  });

  it('dùng NGUYÊN VẸN "hôm nay" được truyền vào, không để đồng hồ máy đè', () => {
    expect(mocNgayNghiepVu(null, '2026-01-01')).toBe('2026-01-01');
  });
});
