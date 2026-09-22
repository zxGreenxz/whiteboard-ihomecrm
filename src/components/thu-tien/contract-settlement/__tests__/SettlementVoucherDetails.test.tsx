// =============================================================================
// SettlementVoucherDetails — bảng quyết toán/căn cứ + GHI CHÚ GỐC của một phiếu
// trong hồ sơ khoản chi, lấy ĐÚNG nguồn mà trang Thu chi đang dùng.
//
// BÀI KIỂM NEO: ca 401/32PVC trên ảnh chủ 22/09/2026 — cọc 4.500.000 thu bằng
// PT2607068, cấn 1.424.000, hoàn 3.076.000. Trước đây modal chỉ in một câu giữ
// chỗ "Căn cứ hoàn khách tra khi mở phiếu" vì nó KHÔNG hề hỏi facts lúc mở.
//
// Cách kiểm: render cùng MỘT phiếu hai lần — một lần theo đúng cách trang Thu
// chi gọi (`VoucherNote`), một lần qua khu mới — rồi đòi hai bên nói cùng nội
// dung. Đó là định nghĩa của "khớp nguồn Thu chi"; so với chuỗi chép tay thì
// chỉ ghim được bản chép, không ghim được sự khớp.
//
// Ranh giới giả lập: hai hook đọc RPC. Phần được kiểm là NỐI DÂY + các hàm dựng
// bảng THẬT (`buildTerminationCard`, `buildTerminationHeaderLines`), không phải
// bản dựng lại.
// =============================================================================

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface KetQua { data: unknown; isLoading: boolean; isError: boolean }

const H = vi.hoisted(() => ({
  hoan: { data: null, isLoading: false, isError: false } as KetQua,
  hoaHong: { data: null, isLoading: false, isError: false } as KetQua,
  /** Mọi lượt gọi hook, để soi phiếu nào THỰC SỰ bị đem đi hỏi RPC. */
  goiHoan: [] as unknown[][],
  goiHoaHong: [] as unknown[][],
}));

vi.mock('@/hooks/useTerminationRefundFacts', () => ({
  TERMINATION_REFUND_FACTS_KEY: 'termination-refund-facts',
  useTerminationRefundFacts: (...a: unknown[]) => { H.goiHoan.push(a); return H.hoan; },
}));

vi.mock('@/hooks/useCommissionVoucher', () => ({
  useCommissionVoucherFacts: (...a: unknown[]) => { H.goiHoaHong.push(a); return H.hoaHong; },
}));

import { SettlementVoucherDetails } from '../SettlementVoucherDetails';
import { VoucherNote } from '@/components/income-expenses/VoucherNote';
import {
  buildTerminationCard,
  buildTerminationHeaderLines,
  type TerminationRefundFacts,
} from '@/lib/terminationRefundNote';
import type { CommissionVoucherFacts } from '@/lib/commissionVoucherNote';
import {
  CAN_CU_HOAN_TRA_KHI_MO_PHIEU,
  type SettlementRow,
} from '@/lib/contractSettlement';

// ── Định danh: UUID, KHÔNG BAO GIỜ mã phiếu ────────────────────────────────
// Production có nhiều phiếu trùng mã hiển thị, nên khoá luôn là (UUID, org).
const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const TOA = '0b0b0b0b-0000-4000-8000-000000000001';
const PHONG = '0b0b0b0b-0000-4000-8000-000000000401';
const HD = '0c0c0c0c-0000-4000-8000-000000000001';
const V_HOAN = '0f0f0f0f-0000-4000-8000-000000000001';
const V_HHMG_TAY = '0f0f0f0f-0000-4000-8000-000000000002';
const V_HOA_HONG = '0f0f0f0f-0000-4000-8000-000000000003';
const V_THUONG = '0f0f0f0f-0000-4000-8000-000000000004';
const V_GIU_CHO = '0f0f0f0f-0000-4000-8000-000000000005';
const V_TAY = '0f0f0f0f-0000-4000-8000-000000000006';

const GHI_CHU_GOC = 'Hoàn cọc thanh lý phòng 401.\nKhách đã ký biên bản bàn giao.';

const ve = (node: ReactElement) => renderToStaticMarkup(node);

/** Bóc chữ khỏi markup để so NỘI DUNG, không so cách bọc thẻ. */
const chu = (html: string) =>
  html
    .replace(/<[^>]*>/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const demLan = (s: string, mau: string) => s.split(mau).length - 1;

// ── Facts ca THẬT 401/32PVC ─────────────────────────────────────────────────
const hopDong401 = (): CommissionVoucherFacts => ({
  contract_id: HD, contract_number: 'HĐT-401/32PVC', room_name: '401', building_name: '32PVC',
  status: 'TERMINATED', start_date: '2026-07-06', end_date: '2026-09-05',
  expected_move_out_date: null, seq_in_year: 3,
  rent_price: 4_500_000, months: 2, total_deposit: 4_500_000, deposit_paid: 4_500_000,
  deposit_enough: true,
  deposit_vouchers: [{
    id: '0f0f0f0f-0000-4000-8000-0000000000aa', code: 'PT2607068',
    voucher_date: '2026-07-06', type: 'INCOME',
    deposit_amount: 4_500_000, total_amount: 4_500_000, is_combined: false,
  }],
  today: '2026-09-22', seven_days_date: '2026-07-13', seven_days_ok: true,
  rep_name: 'Khách 401', rep_phone: '0900000401',
  commission_kind: null, total_amount: null, rate_percent: null,
});

const factsHoan = (over: Partial<TerminationRefundFacts> = {}): TerminationRefundFacts => ({
  voucher: {
    id: V_HOAN, code: 'PC2607069', total_amount: 3_076_000, voucher_date: '2026-09-05',
    approval_status: 'APPROVED', account_id: '0d0d0d0d-0000-4000-8000-000000000001',
    notes: GHI_CHU_GOC,
  },
  contract: hopDong401(),
  end_date: '2026-09-05',
  termination: {
    termination_date: '2026-09-05', actual_move_out_date: '2026-09-05',
    outstanding_debt: 0, early_termination_fee: 1_424_000, deposit_used: 4_500_000,
    rent_refund_amount: 0, total_deductions: 1_424_000, refund_amount: 3_076_000,
    status: 'COMPLETED', notes: null,
  },
  excess_rent: 0,
  shortfall_mode: null,
  settlement_items: [
    { description: 'Tiền điện (1.204 → 1.560)', amount: 1_224_000, type: 'SERVICE' },
    { description: 'Tiền nước', amount: 200_000, type: 'OTHER' },
  ],
  refund_items: [
    { description: 'Trả lại khách (cọc sau khấu trừ)', amount: 3_076_000,
      type_name: 'Hoàn cọc thanh lý', is_deposit: true },
  ],
  ...over,
});

const factsHoaHong = (): CommissionVoucherFacts => ({
  ...hopDong401(),
  status: 'ACTIVE',
  commission_kind: 'broker', total_amount: 2_250_000, rate_percent: 50,
});

// ── Dòng read model ─────────────────────────────────────────────────────────
const dong = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  key: `refund:${V_HOAN}`, kind: 'refund', kindSource: 'system_source', kindConflict: false,
  voucherId: V_HOAN, voucherCode: 'PC2607069', contractId: HD,
  contractNumber: 'HĐT-401/32PVC', terminationId: null, roomId: PHONG,
  buildingName: '32PVC', roomName: '401', customerName: 'Khách 401',
  recipientName: 'Khách 401', amount: 3_076_000,
  basis: { kind: 'not-found', reason: CAN_CU_HOAN_TRA_KHI_MO_PHIEU },
  status: 'approved', approvalStatus: 'APPROVED', postingStatus: 'UNPOSTED',
  postingMode: null, bankAccount: '0123456789', bankName: 'VCB',
  attachments: [], hasAttachment: false,
  eventDate: '2026-09-05', origin: 'contract', eventLabel: 'Thanh lý',
  paidDate: null, bookName: null, issues: [], supplementPending: false,
  reviewState: null, reviewVersion: 1, approvalVersion: 1, postingVersion: 1,
  organizationId: ORG, buildingId: TOA,
  notes: GHI_CHU_GOC,
  systemSource: 'termination.refund',
  commissionKind: null,
  ...over,
});

beforeEach(() => {
  H.hoan = { data: null, isLoading: false, isError: false };
  H.hoaHong = { data: null, isLoading: false, isError: false };
  H.goiHoan.length = 0;
  H.goiHoaHong.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. CÙNG MỘT PHIẾU: Thu chi và modal phải nói cùng nội dung
// ═══════════════════════════════════════════════════════════════════════════

describe('cùng một phiếu hoàn — modal khớp nguồn Thu chi', () => {
  /** Đúng bộ mốc trên ảnh chủ: phiếu cọc, ngày thu, từng khoản cấn, tổng hoàn. */
  const MOC = [
    'PT2607068',                  // mã phiếu thu cọc
    '06/07/2026',                 // ngày thu cọc
    '4.500.000 đ',                // cọc đã thu
    'Tiền điện (1.204 → 1.560)',  // khoản khấu trừ 1
    '1.224.000 đ',
    'Tiền nước',                  // khoản khấu trừ 2
    '200.000 đ',
    '1.424.000 đ',                // tổng khấu trừ
    '3.076.000 đ',                // tổng hoàn
  ];

  it('bảng quyết toán, ngày/mã phiếu cọc, từng khoản khấu trừ và tổng hoàn giống hệt Thu chi', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };

    // Đúng cách IncomeExpenseDetailDialog gọi (Thu chi).
    const thuChi = chu(ve(
      <VoucherNote
        voucher={{
          id: V_HOAN, system_source: 'termination.refund', contract_id: HD,
          commission_kind: null, supplements: [],
        }}
        fallbackNotes={GHI_CHU_GOC}
      />,
    ));
    const modal = chu(ve(<SettlementVoucherDetails row={dong()} />));

    for (const m of MOC) {
      expect(thuChi, `Thu chi phải có "${m}"`).toContain(m);
      expect(modal, `modal phải có "${m}"`).toContain(m);
    }
    // Ghi chú gốc: cùng nội dung, GIỮ XUỐNG DÒNG.
    expect(thuChi).toContain('Hoàn cọc thanh lý phòng 401.');
    expect(thuChi).toContain('Khách đã ký biên bản bàn giao.');
    expect(modal).toContain('Hoàn cọc thanh lý phòng 401.');
    expect(modal).toContain('Khách đã ký biên bản bàn giao.');
  });

  it('số tiền của fixture đúng bằng phép toán chung, không phải chuỗi chép tay', () => {
    const facts = factsHoan();
    const card = buildTerminationCard(facts)!;
    expect(card.totalDeductions).toBe(1_424_000);
    expect(card.net).toBe(3_076_000);
    expect(card.warning).toBeNull();
    expect(buildTerminationHeaderLines(facts).join('\n')).toContain('4.500.000');
    expect(buildTerminationHeaderLines(facts).join('\n')).toContain('PT2607068');
  });

  it('không còn câu giữ chỗ "Căn cứ hoàn khách tra khi mở phiếu" trong thân modal', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    const html = chu(ve(<SettlementVoucherDetails row={dong()} />));
    expect(html).not.toContain('Căn cứ hoàn khách tra khi mở phiếu');
    expect(html).toContain('QUYẾT TOÁN THANH LÝ');
  });

  it('hỏi facts theo UUID phiếu đang mở, không theo mã phiếu', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    ve(<SettlementVoucherDetails row={dong()} />);
    expect(H.goiHoan.some((a) => a[0] === V_HOAN)).toBe(true);
    expect(H.goiHoan.some((a) => a[0] === 'PC2607069')).toBe(false);
  });

  it('không hỏi facts khi modal chưa mở', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    ve(<SettlementVoucherDetails row={dong()} enabled={false} />);
    expect(H.goiHoan.every((a) => a[1] === false)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. BỐN TRẠNG THÁI ĐỌC PHẢI KHÁC NHAU — luật quan trọng nhất
// ═══════════════════════════════════════════════════════════════════════════

describe('đang tải / lỗi / không đủ nguồn / đã có căn cứ phải khác nhau', () => {
  const trangThai = (html: string) => /data-state="([a-z]+)"/.exec(html)?.[1] ?? null;

  it('đang tải KHÁC lỗi KHÁC thiếu nguồn KHÁC đã có căn cứ', () => {
    H.hoan = { data: null, isLoading: true, isError: false };
    const dangTai = ve(<SettlementVoucherDetails row={dong()} />);

    H.hoan = { data: null, isLoading: false, isError: true };
    const loi = ve(<SettlementVoucherDetails row={dong()} />);

    H.hoan = { data: null, isLoading: false, isError: false };
    const thieu = ve(<SettlementVoucherDetails row={dong()} />);

    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    const du = ve(<SettlementVoucherDetails row={dong()} />);

    expect(trangThai(dangTai)).toBe('loading');
    expect(trangThai(loi)).toBe('error');
    expect(trangThai(thieu)).toBe('insufficient');
    expect(trangThai(du)).toBeNull();
    expect(new Set([chu(dangTai), chu(loi), chu(thieu), chu(du)]).size).toBe(4);
  });

  it('căn cứ thiếu KHÔNG được hiện thành 0 đ hay "đã khớp"', () => {
    for (const ket of [
      { data: null, isLoading: true, isError: false },
      { data: null, isLoading: false, isError: true },
      { data: null, isLoading: false, isError: false },
    ] as KetQua[]) {
      H.hoan = ket;
      // Bỏ CHÍNH câu cảnh báo ra trước khi soi: nó cố ý chứa cụm "0 đ hay đã
      // khớp" vì đó là lời hứa nói với người đọc. Thứ phải cấm là CON SỐ 0 đ
      // và LỜI KHẲNG ĐỊNH đã khớp, không phải cụm từ trong câu phủ định.
      const html = chu(ve(<SettlementVoucherDetails row={dong()} />))
        .replace(/Chưa kết luận được[^\n]*/g, '');
      expect(html).not.toContain('0 đ');
      expect(html).not.toMatch(/đã khớp/i);
    }
  });

  it('lỗi và thiếu nguồn nói rõ là chưa kết luận được, không phải phiếu sạch', () => {
    // Đang tải KHÔNG cần câu này — nó chưa phải một kết luận hỏng, và "Đang
    // tải căn cứ…" đã tự nói đúng thứ đang xảy ra.
    for (const ket of [
      { data: null, isLoading: false, isError: true },
      { data: null, isLoading: false, isError: false },
    ] as KetQua[]) {
      H.hoan = ket;
      expect(chu(ve(<SettlementVoucherDetails row={dong()} />))).toContain('Chưa kết luận được');
    }
    H.hoan = { data: null, isLoading: true, isError: false };
    expect(chu(ve(<SettlementVoucherDetails row={dong()} />))).toContain('Đang tải căn cứ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. HHMG THỦ CÔNG — thiếu metadata, KHÔNG được bịa dấu nguồn
// ═══════════════════════════════════════════════════════════════════════════

describe('HHMG tạo tay thiếu metadata', () => {
  const hhmgTay = (over: Partial<SettlementRow> = {}) => dong({
    key: `commission:${V_HHMG_TAY}`, kind: 'commission', kindSource: 'accounting_item',
    voucherId: V_HHMG_TAY, voucherCode: 'PC2606169', amount: 2_250_000,
    systemSource: null, commissionKind: null,
    basis: { kind: 'matched', amount: 2_250_000 },
    eventLabel: 'Ký mới', notes: 'Chi HHMG cho môi giới Bình.',
    ...over,
  });

  it('KHÔNG gọi RPC ghi chú tự sinh cho phiếu thiếu commission_kind', () => {
    ve(<SettlementVoucherDetails row={hhmgTay()} />);
    expect(H.goiHoaHong.every((a) => a[0] === null)).toBe(true);
    expect(H.goiHoan.every((a) => a[0] === null)).toBe(true);
  });

  it('trình bày căn cứ số tiền theo kỳ ký từ read model, và giữ ghi chú gốc', () => {
    const html = chu(ve(<SettlementVoucherDetails row={hhmgTay()} />));
    expect(html).toContain('2.250.000đ');            // moTaCanCu của basis matched
    expect(html).toContain('Chi HHMG cho môi giới Bình.');
    expect(html).toContain('Ghi chú gốc của phiếu');
  });

  it('nói thẳng là ghi chú chi tiết tự sinh không dùng được cho phiếu này', () => {
    const html = chu(ve(<SettlementVoucherDetails row={hhmgTay()} />));
    expect(html).toContain('commission_kind');
    expect(html.toLowerCase()).toContain('tự sinh');
  });

  it('thiếu căn cứ kỳ ký thì nói thiếu, không hiện 0 đ', () => {
    const html = chu(ve(<SettlementVoucherDetails row={hhmgTay({
      basis: { kind: 'not-found', reason: 'Toà chưa cấu hình bậc hoa hồng cho hợp đồng này' },
    })} />));
    expect(html).toContain('Toà chưa cấu hình bậc hoa hồng');
    expect(html).not.toContain('0 đ');
  });

  it('không ghi ngược dấu nguồn suy ra vào phiếu — chỉ đọc, không có nút/ô nhập', () => {
    const html = ve(<SettlementVoucherDetails row={hhmgTay()} />);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. BỐN LOẠI PHIẾU + PHIẾU TẠO TAY
// ═══════════════════════════════════════════════════════════════════════════

describe('hoàn khách / thưởng sale / hoa hồng / giữ chỗ / phiếu tạo tay', () => {
  it('hoa hồng có dấu broker dùng nguồn ghi chú hợp đồng của Thu chi', () => {
    H.hoaHong = { data: factsHoaHong(), isLoading: false, isError: false };
    const row = dong({
      key: `commission:${V_HOA_HONG}`, kind: 'commission', kindSource: 'commission_kind',
      voucherId: V_HOA_HONG, amount: 2_250_000,
      systemSource: null, commissionKind: 'broker',
      basis: { kind: 'matched', amount: 2_250_000 }, notes: 'Chi hoa hồng đợt 1.',
    });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(H.goiHoaHong.some((a) => a[0] === V_HOA_HONG)).toBe(true);
    expect(html).toContain('401/32PVC');
    expect(html).toContain('Chi hoa hồng đợt 1.');
  });

  it('thưởng sale có dấu sale cũng đi qua nguồn hợp đồng, không báo thiếu metadata', () => {
    H.hoaHong = { data: { ...factsHoaHong(), commission_kind: 'sale' }, isLoading: false, isError: false };
    const row = dong({
      key: `bonus:${V_THUONG}`, kind: 'bonus', kindSource: 'commission_kind',
      voucherId: V_THUONG, amount: 1_000_000,
      systemSource: null, commissionKind: 'sale',
      basis: { kind: 'not-applicable' }, notes: 'Thưởng nóng cho Sale Hà.',
    });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(H.goiHoaHong.some((a) => a[0] === V_THUONG)).toBe(true);
    expect(html).not.toContain('không mang dấu');
    expect(html).toContain('Thưởng nóng cho Sale Hà.');
  });

  it('hoàn giữ chỗ KHÔNG có hồ sơ thanh lý — không hỏi RPC thanh lý, vẫn giữ ghi chú gốc', () => {
    const row = dong({
      key: `refund:${V_GIU_CHO}`, kind: 'refund', voucherId: V_GIU_CHO,
      systemSource: 'reservation.refund', origin: 'reservation',
      eventLabel: 'Kết thúc giữ chỗ', contractId: null, contractNumber: null,
      notes: 'Hoàn tiền giữ chỗ do khách đổi ý.',
      basis: { kind: 'not-found', reason: CAN_CU_HOAN_TRA_KHI_MO_PHIEU },
    });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(H.goiHoan.every((a) => a[0] === null)).toBe(true);
    expect(html).toContain('Hoàn tiền giữ chỗ do khách đổi ý.');
    expect(html).toContain('termination.refund');
  });

  // ── Lời hứa "tra khi mở phiếu" KHÔNG được vọng vào modal đang mở ──────────
  // `basisOf` trả câu đó cho MỌI phiếu hoàn, vô điều kiện. Ở danh sách nó đúng;
  // trong hộp thoại đã mở thì chỗ tra duy nhất là hồ sơ tự sinh — thứ mà nhánh
  // này tồn tại chính vì phiếu không có.
  it('phiếu hoàn giữ chỗ: KHÔNG hứa lại "tra khi mở phiếu" bên trong modal đang mở', () => {
    const row = dong({
      key: `refund:${V_GIU_CHO}`, voucherId: V_GIU_CHO,
      systemSource: 'reservation.refund', origin: 'reservation',
      basis: { kind: 'not-found', reason: CAN_CU_HOAN_TRA_KHI_MO_PHIEU },
    });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(html).not.toContain(CAN_CU_HOAN_TRA_KHI_MO_PHIEU);
    expect(html).toContain('Đã tra lúc mở phiếu');
    expect(html).toContain('không có hồ sơ quyết toán tự sinh');
  });

  it('phiếu hoàn tạo tay cũng vậy — không dựa vào system_source để quyết', () => {
    const row = dong({
      key: `refund:${V_TAY}`, voucherId: V_TAY, systemSource: null,
      basis: { kind: 'not-found', reason: CAN_CU_HOAN_TRA_KHI_MO_PHIEU },
    });
    expect(chu(ve(<SettlementVoucherDetails row={row} />)))
      .not.toContain(CAN_CU_HOAN_TRA_KHI_MO_PHIEU);
  });

  it('lý do not-found KHÁC vẫn hiện NGUYÊN VĂN — so hằng số, không dò chuỗi', () => {
    const row = dong({
      systemSource: null,
      basis: { kind: 'not-found', reason: 'Toà chưa cấu hình bậc hoa hồng cho hợp đồng này' },
    });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(html).toContain('Toà chưa cấu hình bậc hoa hồng cho hợp đồng này');
    expect(html).not.toContain('Đã tra lúc mở phiếu');
  });

  // ── Phiếu mang CẢ HAI dấu ─────────────────────────────────────────────────
  // `VoucherNote.tsx` xét hoa hồng TRƯỚC hoàn thanh lý. Hai chỗ cùng quyết một
  // việc mà quyết khác nhau thì banner nói về truy vấn này còn bảng vẽ truy vấn
  // kia — và một RPC lỗi sẽ ẩn mất bảng vốn tải được.
  it('mang cả hai dấu: theo đúng thứ tự của VoucherNote, hoa hồng thắng', () => {
    H.hoan = { data: null, isLoading: false, isError: true };
    H.hoaHong = { data: factsHoaHong(), isLoading: false, isError: false };
    const row = dong({
      key: `commission:${V_HOA_HONG}`, kind: 'commission', voucherId: V_HOA_HONG,
      systemSource: 'termination.refund', commissionKind: 'broker',
      basis: { kind: 'matched', amount: 2_250_000 },
    });
    const html = ve(<SettlementVoucherDetails row={row} />);
    // RPC thanh lý hỏng KHÔNG được ẩn bảng hoa hồng.
    expect(html).not.toContain('data-state="error"');
    expect(chu(html)).toContain('401/32PVC');
    // …và phía thua không được tốn một lượt gọi RPC.
    expect(H.goiHoan.every((a) => a[0] === null)).toBe(true);
    expect(H.goiHoaHong.some((a) => a[0] === V_HOA_HONG)).toBe(true);
  });

  // Hai vị ngữ chung đòi CẢ dấu nguồn LẪN hợp đồng. Gộp hai nguyên nhân thành
  // một câu là nói sai với người đang cầm tiền.
  it('có dấu nguồn nhưng chưa gắn hợp đồng: nói đúng là thiếu hợp đồng, KHÔNG nói là thiếu dấu', () => {
    const row = dong({
      key: `commission:${V_HOA_HONG}`, kind: 'commission', kindSource: 'commission_kind',
      voucherId: V_HOA_HONG, commissionKind: 'broker', systemSource: null,
      contractId: null, contractNumber: null, notes: 'Chi hoa hồng.',
      basis: { kind: 'not-found', reason: 'Phiếu chưa gắn hợp đồng' },
    });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(html).toContain('CHƯA GẮN HỢP ĐỒNG');
    expect(html).not.toContain('không mang dấu commission_kind');
    expect(H.goiHoaHong.every((a) => a[0] === null)).toBe(true);
  });

  it('phiếu hoàn có dấu termination.refund nhưng chưa gắn hợp đồng cũng nói đúng nguyên nhân', () => {
    const row = dong({ contractId: null, contractNumber: null });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(html).toContain('CHƯA GẮN HỢP ĐỒNG');
    expect(H.goiHoan.every((a) => a[0] === null)).toBe(true);
  });

  it('phiếu tạo tay chưa xác định loại nói rõ là chưa biết, không đoán bảng nào', () => {
    const row = dong({
      key: `unknown:${V_TAY}`, kind: 'unknown', kindSource: 'none', kindConflict: false,
      voucherId: V_TAY, systemSource: null, commissionKind: null, contractId: null,
      eventLabel: '—', notes: 'Chi hộ khách phòng 401.',
      basis: { kind: 'not-found', reason: 'Chưa xác định loại nên chưa tra được căn cứ' },
    });
    const html = chu(ve(<SettlementVoucherDetails row={row} />));
    expect(H.goiHoan.every((a) => a[0] === null)).toBe(true);
    expect(H.goiHoaHong.every((a) => a[0] === null)).toBe(true);
    expect(html).toContain('Chưa xác định');
    expect(html).toContain('Chi hộ khách phòng 401.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. GHI CHÚ GỐC: rỗng, nhiều dòng, và KHÔNG lặp / KHÔNG lẫn với bổ sung
// ═══════════════════════════════════════════════════════════════════════════

describe('Ghi chú gốc của phiếu', () => {
  it('ghi chú rỗng nói thẳng là không có, không để trống lửng', () => {
    H.hoan = { data: factsHoan({ voucher: { ...factsHoan().voucher, notes: null } }), isLoading: false, isError: false };
    const html = chu(ve(<SettlementVoucherDetails row={dong({ notes: null })} />));
    expect(html).toContain('Ghi chú gốc của phiếu');
    expect(html).toContain('Phiếu không có ghi chú gốc');
  });

  it('ghi chú chỉ toàn khoảng trắng cũng coi là không có', () => {
    const html = chu(ve(<SettlementVoucherDetails row={dong({ notes: '   \n  ' })} />));
    expect(html).toContain('Phiếu không có ghi chú gốc');
  });

  it('ghi chú nhiều dòng giữ nguyên xuống dòng', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    const html = ve(<SettlementVoucherDetails row={dong({
      notes: 'Dòng 1\nDòng 2\nDòng 3',
    })} />);
    expect(html).toContain('whitespace-pre-line');
    const t = chu(html);
    for (const d of ['Dòng 1', 'Dòng 2', 'Dòng 3']) expect(t).toContain(d);
  });

  it('ghi chú gốc hiện ĐÚNG MỘT LẦN, kể cả khi đã có bảng quyết toán', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    const html = chu(ve(<SettlementVoucherDetails row={dong()} />));
    expect(demLan(html, 'Khách đã ký biên bản bàn giao.')).toBe(1);
    expect(demLan(html, 'Ghi chú gốc của phiếu')).toBe(1);
  });

  it('KHÔNG dựng lại Lịch sử bổ sung — phần đó là của modal, tránh hiện hai lần', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    const html = ve(<SettlementVoucherDetails row={dong()} />);
    expect(html).not.toContain('voucher-supplement-note');
    expect(chu(html)).not.toContain('Lịch sử bổ sung');
    expect(chu(html)).not.toContain('Người bổ sung');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. DỮ LIỆU LỆCH PHẢI CÓ CẢNH BÁO
// ═══════════════════════════════════════════════════════════════════════════

describe('dữ liệu lệch', () => {
  it('số phiếu chi khác số tính lại thì cảnh báo, không im lặng và không sửa số phiếu', () => {
    const facts = factsHoan({
      voucher: { ...factsHoan().voucher, total_amount: 2_000_000 },
    });
    expect(buildTerminationCard(facts)!.warning).not.toBeNull();

    H.hoan = { data: facts, isLoading: false, isError: false };
    const html = chu(ve(<SettlementVoucherDetails row={dong({ amount: 2_000_000 })} />));
    expect(html).toContain('khác số tính lại');
    expect(html).toContain('3.076.000 đ');
  });

  it('hồ sơ thanh lý rỗng: có dòng đầu nhưng KHÔNG bịa khung tổng hợp bằng 0', () => {
    H.hoan = { data: factsHoan({ termination: null }), isLoading: false, isError: false };
    expect(buildTerminationCard(factsHoan({ termination: null }))).toBeNull();
    const html = chu(ve(<SettlementVoucherDetails row={dong()} />));
    expect(html).toContain('QUYẾT TOÁN THANH LÝ');
    expect(html).not.toContain('Tổng khấu trừ');
  });

  // Đọc ĐƯỢC mà THIẾU là ca thứ ba, không phải "đọc xong là đủ". Không nói ra
  // thì người duyệt đọc mấy dòng đầu như một bản quyết toán hoàn chỉnh.
  it('đọc được phiếu nhưng thiếu hồ sơ thanh lý phải báo thiếu, không im lặng', () => {
    H.hoan = { data: factsHoan({ termination: null }), isLoading: false, isError: false };
    const html = ve(<SettlementVoucherDetails row={dong()} />);
    expect(html).toContain('data-state="insufficient"');
    const t = chu(html);
    expect(t).toContain('KHÔNG thấy hồ sơ quyết toán thanh lý');
    expect(t).toContain('không dựng được khung tổng hợp');
    expect(t).toContain('Chưa kết luận được');
    // Chỉ thiếu hồ sơ thanh lý ⇒ KHÔNG được kể oan là thiếu cả hợp đồng.
    expect(t).not.toContain('thông tin hợp đồng');
  });

  // `termination` và `contract` đến từ HAI nguồn rời trong RPC (bảng
  // contract_terminations và commission_contract_facts_v1), NULL được độc lập.
  it('đọc được phiếu nhưng thiếu THÔNG TIN HỢP ĐỒNG cũng phải báo thiếu', () => {
    H.hoan = { data: factsHoan({ contract: null }), isLoading: false, isError: false };
    const html = ve(<SettlementVoucherDetails row={dong()} />);
    expect(html).toContain('data-state="insufficient"');
    const t = chu(html);
    expect(t).toContain('thông tin hợp đồng');
    expect(t).toContain('Chưa kết luận được');
    // Đúng cái triệu chứng mà người dùng sẽ nhìn thấy trên bảng.
    expect(t).toContain('—/—');
  });

  it('thiếu CẢ HAI thì kể cả hai, không chỉ nói một cái', () => {
    H.hoan = {
      data: factsHoan({ termination: null, contract: null }), isLoading: false, isError: false,
    };
    const t = chu(ve(<SettlementVoucherDetails row={dong()} />));
    expect(t).toContain('hồ sơ quyết toán thanh lý');
    expect(t).toContain('thông tin hợp đồng');
  });

  it('hồ sơ đầy đủ thì KHÔNG treo cờ thiếu', () => {
    H.hoan = { data: factsHoan(), isLoading: false, isError: false };
    const html = ve(<SettlementVoucherDetails row={dong()} />);
    expect(html).not.toContain('data-state="insufficient"');
  });
});
