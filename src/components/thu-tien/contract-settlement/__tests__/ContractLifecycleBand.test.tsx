// =============================================================================
// ContractLifecycleBand — dải vòng đời, dùng CHUNG cho hồ sơ khoản chi và hồ sơ
// biến động.
//
// BÀI KIỂM NEO: ca 401/32PVC trong ảnh người dùng 22/09/2026.
// Khách nộp 4.500.000 (PT2607068), nội bộ cấn 1.424.000, nên
// `contracts.deposit_paid` còn 3.076.000. Bản đang chạy lấy số RÒNG đó làm
// "thực thu" rồi trừ cam kết ⇒ in ra "còn thiếu 1.424.000 đ" cho một người đã
// nộp đủ. Đây là câu nói dối phải biến mất.
//
// Render bằng `renderToStaticMarkup` như các bài component khác trong kho —
// dải này thuần hiển thị, không có tương tác.
// =============================================================================

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ ket: { data: null as unknown, isLoading: false, isError: false } }));

vi.mock('@/hooks/useContractLifecycle', () => ({
  useContractLifecycle: () => H.ket,
}));

import { ContractLifecycleBand } from '../ContractLifecycleBand';
import {
  LANE_ROLE, LANE_TAG, buildDepositSources, buildLifecycleLanes, summariseDeposit,
} from '@/lib/contractLifecycle';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const PHONG = '0b0b0b0b-0000-4000-8000-000000000401';
const HD = '0c0c0c0c-0000-4000-8000-000000000001';
const HD_SAU = '0c0c0c0c-0000-4000-8000-000000000002';
const PT = '0f0f0f0f-0000-4000-8000-000000000001';
const PC = '0f0f0f0f-0000-4000-8000-000000000002';
const SO = '0d0d0d0d-0000-4000-8000-000000000001';
const NGAY = '2026-09-22';

const ve = (node: ReactElement) => renderToStaticMarkup(node);

const phieu = (id: string, code: string, type: string, date: string) => ({
  id, code, type, organization_id: ORG, approval_status: 'APPROVED',
  posting_status: 'POSTED', posting_mode: 'CASH', deleted_at: null,
  reversal_of_income_expense_id: null, account_id: SO, system_source: null,
  voucher_date: date, created_at: `${date}T02:00:00Z`,
});

/** Đúng ba nguồn của ca thật. */
const cocCaThat = () => summariseDeposit(
  buildDepositSources({
    organizationId: ORG,
    reaches: [
      { contractId: HD, voucherId: PT, via: 'direct' },
      { contractId: HD, voucherId: PC, via: 'direct' },
    ],
    vouchers: [
      phieu(PT, 'PT2607068', 'INCOME', '2026-07-06'),
      phieu(PC, 'PC2607069', 'EXPENSE', '2026-07-08'),
    ],
    items: [
      { id: 'i1', income_expense_id: PT, organization_id: ORG, accounting_class: 'DEPOSIT', amount: 4_500_000, unit_price: 0, quantity: 1 },
      { id: 'i2', income_expense_id: PC, organization_id: ORG, accounting_class: 'DEPOSIT', amount: 1_424_000, unit_price: 0, quantity: 1 },
    ],
    virtualAccountIds: [],
  }).get(HD) ?? [],
  new Map(),
);

const DOC_TOT = {
  contracts: { ok: true as const }, segments: { ok: true as const },
  transfers: { ok: true as const }, deposits: { ok: true as const },
  invoices: { ok: true as const }, postings: { ok: true as const },
};

const viewCaThat = () => buildLifecycleLanes({
  organizationId: ORG, roomId: PHONG, targetContractId: HD, businessDate: NGAY,
  subject: { kind: 'voucher', voucherKind: 'refund' },
  contracts: [{
    id: HD, organization_id: ORG, contract_number: 'HĐT-046775/28102024',
    room_id: PHONG, status: 'TERMINATED', signed_date: '2024-10-28',
    start_date: '2024-10-28', end_date: '2026-10-27', actual_end_date: '2026-09-20',
    total_deposit: 4_500_000, rent_price: 4_500_000, customer_name: 'Nguyễn Văn A',
  }],
  segments: [{
    contract_id: HD, contract_number: 'HĐT-046775/28102024', seg_index: 0,
    room_id: PHONG, room_name: '401', from_date: '2024-10-28', to_date: null,
    source_path: 'CONTRACT_START', transfer_id: null, trusted: true, diagnostic: null,
  }],
  terminations: [{
    id: 't1', contract_id: HD, organization_id: ORG, termination_date: '2026-09-20',
    termination_type: 'NORMAL', refund_amount: 3_076_000, outstanding_debt: 0,
    total_deposit: 4_500_000,
  }],
  depositByContract: new Map([[HD, cocCaThat()]]),
  invoiceByContract: new Map([[HD, { paid: 54_000_000, debt: 0 }]]),
  reads: DOC_TOT,
});

const props = {
  organizationId: ORG, roomId: PHONG, contractId: HD, businessDate: NGAY,
  subject: { kind: 'voucher' as const, voucherKind: 'refund' as const },
  sourceLabel: 'Phiếu đang xem', sourceText: 'PC2609095',
};

beforeEach(() => { H.ket = { data: null, isLoading: false, isError: false }; });

// ═══════════════════════════════════════════════════════════════════════════
describe('ContractLifecycleBand — mốc cọc', () => {
  it('ca 401/32PVC: hiện 4.500.000 đ kèm ngày thu và mã phiếu thu', () => {
    H.ket = { data: viewCaThat(), isLoading: false, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toContain('Cọc đã đóng · thực thu');
    expect(html).toContain('4.500.000 đ');
    expect(html).toContain('PT2607068');
    expect(html).toContain('06/07/2026');
  });

  it('KHÔNG BAO GIỜ in "còn thiếu" cho khách đã nộp đủ (bug của bản cũ)', () => {
    H.ket = { data: viewCaThat(), isLoading: false, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).not.toContain('còn thiếu');
    expect(html).not.toContain('Cam kết');
  });

  it('1.424.000 vẫn phải thấy — nhưng là khoản CẤN, không phải khoản thiếu', () => {
    H.ket = { data: viewCaThat(), isLoading: false, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toContain('1.424.000 đ');
    expect(html).toMatch(/Cấn/);
    expect(html).toContain('còn giữ 3.076.000 đ');
  });

  it('mốc thanh lý hiện quyết toán hoàn 3.076.000 đ', () => {
    H.ket = { data: viewCaThat(), isLoading: false, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toContain('Quyết toán hoàn 3.076.000 đ');
    expect(html).toContain('Nợ sau quyết toán');
  });
});

describe('ContractLifecycleBand — nhiều lane và chân dải', () => {
  it('vẽ đủ chuỗi lane với vai của từng hợp đồng', () => {
    const v = buildLifecycleLanes({
      organizationId: ORG, roomId: PHONG, targetContractId: HD, businessDate: NGAY,
      subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [
        { id: HD, organization_id: ORG, contract_number: 'HD-B', room_id: PHONG, status: 'TERMINATED', signed_date: '2024-10-28', start_date: '2024-10-28', end_date: '2026-10-27', actual_end_date: '2026-09-20', total_deposit: 4_500_000, rent_price: 4_500_000, customer_name: 'Khách B' },
        { id: HD_SAU, organization_id: ORG, contract_number: 'HD-C', room_id: PHONG, status: 'ACTIVE', signed_date: '2026-09-21', start_date: '2026-09-21', end_date: '2027-09-20', actual_end_date: null, total_deposit: 5_000_000, rent_price: 5_000_000, customer_name: 'Khách C' },
      ],
      segments: [
        { contract_id: HD, contract_number: 'HD-B', seg_index: 0, room_id: PHONG, room_name: '401', from_date: '2024-10-28', to_date: null, source_path: 'CONTRACT_START', transfer_id: null, trusted: true, diagnostic: null },
        { contract_id: HD_SAU, contract_number: 'HD-C', seg_index: 0, room_id: PHONG, room_name: '401', from_date: '2026-09-21', to_date: null, source_path: 'CONTRACT_START', transfer_id: null, trusted: true, diagnostic: null },
      ],
      terminations: [{ id: 't1', contract_id: HD, organization_id: ORG, termination_date: '2026-09-20', termination_type: 'NORMAL', refund_amount: 3_076_000, outstanding_debt: 0, total_deposit: 4_500_000 }],
      depositByContract: new Map([[HD, cocCaThat()]]),
      invoiceByContract: new Map(),
      reads: DOC_TOT,
    });
    H.ket = { data: v, isLoading: false, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toContain(LANE_ROLE.refund);
    expect(html).toContain(LANE_ROLE.after);
    expect(html).toContain(LANE_TAG.terminated);
    expect(html).toContain(LANE_TAG.current);
    expect(html).toContain('HD-B');
    expect(html).toContain('HD-C');
  });

  it('chân dải có "Phòng hiện tại" và nhãn nguồn theo từng modal', () => {
    H.ket = { data: viewCaThat(), isLoading: false, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toContain('Phòng hiện tại');
    expect(html).toContain('Phiếu đang xem');
    expect(html).toContain('PC2609095');

    const html2 = ve(
      <ContractLifecycleBand {...props} sourceLabel="Nguồn" sourceText="HĐT-046775/28102024"
        subject={{ kind: 'movement' }} />,
    );
    expect(html2).toContain('Nguồn');
  });
});

describe('ContractLifecycleBand — lỗi và thiếu dữ liệu KHÁC số 0', () => {
  it('đang tải: không in số nào', () => {
    H.ket = { data: null, isLoading: true, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toContain('Đang tra');
    expect(html).not.toContain('0 đ');
  });

  it('lỗi đọc: nói rõ là lỗi, không hiện "phòng trống" và không hiện 0 đ', () => {
    H.ket = { data: null, isLoading: false, isError: true };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toMatch(/không đọc được|lỗi/i);
    expect(html).not.toContain('Trống');
    expect(html).not.toContain('0 đ');
  });

  it('nguồn cọc không đọc được ⇒ mốc cọc ghi "Chưa đủ dữ liệu", không phải 0 đ', () => {
    const v = buildLifecycleLanes({
      organizationId: ORG, roomId: PHONG, targetContractId: HD, businessDate: NGAY,
      subject: { kind: 'voucher', voucherKind: 'refund' },
      contracts: [{ id: HD, organization_id: ORG, contract_number: 'HD-B', room_id: PHONG, status: 'ACTIVE', signed_date: '2024-10-28', start_date: '2024-10-28', end_date: '2026-10-27', actual_end_date: null, total_deposit: 4_500_000, rent_price: 4_500_000, customer_name: 'Khách B' }],
      segments: [{ contract_id: HD, contract_number: 'HD-B', seg_index: 0, room_id: PHONG, room_name: '401', from_date: '2024-10-28', to_date: null, source_path: 'CONTRACT_START', transfer_id: null, trusted: true, diagnostic: null }],
      terminations: [],
      depositByContract: new Map(),
      invoiceByContract: new Map(),
      reads: { ...DOC_TOT, deposits: { ok: false, reason: 'Không đọc được phiếu cọc' } },
    });
    H.ket = { data: v, isLoading: false, isError: false };
    const html = ve(<ContractLifecycleBand {...props} />);
    expect(html).toContain('Chưa đủ dữ liệu');
  });
});

describe('ContractLifecycleBand — nhãn hoàn lấy từ ĐÚNG phiếu hoàn', () => {
  it('phiếu HOA HỒNG không được gắn dòng "Còn hoàn"', () => {
    H.ket = { data: viewCaThat(), isLoading: false, isError: false };
    const html = ve(
      <ContractLifecycleBand {...props}
        subject={{ kind: 'voucher', voucherKind: 'commission' }}
        ghiChuHoan={{ text: 'Còn hoàn: 1.000.000 đ', mau: 'red' }} />,
    );
    expect(html).not.toContain('Còn hoàn');
  });

  it('phiếu HOÀN vẫn hiện dòng còn/đã hoàn', () => {
    H.ket = { data: viewCaThat(), isLoading: false, isError: false };
    const html = ve(
      <ContractLifecycleBand {...props}
        ghiChuHoan={{ text: 'Còn hoàn: 3.076.000 đ', mau: 'red' }} />,
    );
    expect(html).toContain('Còn hoàn: 3.076.000 đ');
  });
});
