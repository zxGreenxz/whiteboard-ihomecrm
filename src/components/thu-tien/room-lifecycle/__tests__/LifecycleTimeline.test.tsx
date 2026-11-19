// @vitest-environment jsdom
// =============================================================================
// LifecycleTimeline — feed "Chu trình phòng" trên /thu-tien.
//
// Bất biến của đợt "vòng đời tiền một nguồn": type đã mang trạng thái phiếu
// trong nhãn (10 type hoa hồng/thưởng) thì KHÔNG gắn thêm "· chưa vào sổ thật"
// — với phiếu đã đảo câu đó sai nghĩa. Mốc chưa đáng tin khác vẫn giữ hậu tố.
// Số và mã GIẢ (repo public).
// =============================================================================

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LifecycleEvent, LifecyclePayload } from '@/lib/roomLifecycle';
import { LifecycleTimeline } from '../LifecycleTimeline';

afterEach(cleanup);

const HD = '00000000-0000-4000-8000-0000000000c1';

const su = (type: string, date: string, trusted: boolean, meta: Record<string, unknown> | null = null): LifecycleEvent => ({
  type, date, contractId: HD, amount: 1_000_000, trusted, meta,
});

const payload = (events: LifecycleEvent[]): LifecyclePayload => ({
  room: { id: 'r1', name: 'P-GIA', buildingId: 'b1', buildingName: 'Toà giả' },
  range: { from: null, to: null },
  contracts: [{
    id: HD, number: 'HD-GIA-01', status: 'ACTIVE', startDate: '2026-01-01', endDate: '2026-12-31',
    actualEndDate: null, rentPrice: 3_000_000, totalDeposit: 3_000_000, tenantName: 'Khách Giả',
  }],
  segments: [{
    contractId: HD, contractNumber: 'HD-GIA-01', segIndex: 0, fromDate: '2026-01-01', toDate: null,
    sourcePath: 'CONTRACT_START', trusted: true, diagnostic: null,
  }],
  events,
  vacancies: [],
  generatedAt: '2026-10-29T00:00:00Z',
});

const dong = (label: string) => screen.getByText(label).closest('.rl-item') as HTMLElement;

describe('LifecycleTimeline — hậu tố "chưa vào sổ thật"', () => {
  it('phiếu hoa hồng đã đảo: nhãn nói trạng thái, KHÔNG có hậu tố', () => {
    render(<LifecycleTimeline payload={payload([
      su('COMMISSION_REVERSED', '2026-03-02', false, { voucherId: 'v1', code: 'PC-GIA-1', name: 'HH giả' }),
    ])} />);
    expect(dong('Hoa hồng môi giới · đã đảo').textContent).not.toContain('chưa vào sổ thật');
  });

  it('mốc chưa đáng tin khác vẫn giữ hậu tố', () => {
    render(<LifecycleTimeline payload={payload([su('DEPOSIT_RECEIVED', '2026-01-01', false, { code: 'PT-GIA-1' })])} />);
    expect(dong('Thu cọc').textContent).toContain('· chưa vào sổ thật');
  });

  it('COMMISSION_PAID của RPC cũ (không voucherId) giữ nhãn cũ và hậu tố khi chưa ghi sổ', () => {
    render(<LifecycleTimeline payload={payload([su('COMMISSION_PAID', '2026-03-02', false, { code: 'PC-GIA-2', name: 'HH giả' })])} />);
    const el = dong('Hoa hồng / thưởng');
    expect(el.textContent).toContain('· chưa vào sổ thật');
    expect(el.className).toContain('tone-out');
  });
});

describe('LifecycleTimeline — tông màu', () => {
  it('hoa hồng đã chi mang tone-out; cấn trừ khi thanh lý là neutral (không phải tiền vào)', () => {
    render(<LifecycleTimeline payload={payload([
      su('COMMISSION_PAID', '2026-03-02', true, { voucherId: 'v3', code: 'PC-GIA-3', name: 'HH giả' }),
      su('INVOICE_TERMINATION_OFFSET', '2026-06-30', true, { invoiceId: 'i1', billingMonth: '2026-06', kind: 'SETTLEMENT', via: 'MOVE_OUT', penalty: 0 }),
      su('INVOICE_COLLECTION_POSTED', '2026-02-05', true, { invoiceId: 'i0', billingMonth: '2026-02', kind: 'MONTHLY', depositPaid: 0 }),
    ])} />);
    expect(dong('Hoa hồng môi giới · đã chi').className).toContain('tone-out');
    expect(dong('Hoá đơn cấn trừ khi thanh lý').className).toContain('tone-neutral');
    expect(dong('Thu tiền hoá đơn').className).toContain('tone-in');
  });

  it('chấm trên lane theo cùng nhãn: phiếu chờ duyệt tông warn', () => {
    const { container } = render(<LifecycleTimeline payload={payload([
      su('SALE_BONUS_PENDING', '2026-03-02', false, { voucherId: 'v4', code: 'PC-GIA-4', name: 'Thưởng giả' }),
    ])} />);
    const cham = container.querySelector('.rl-dot') as HTMLElement;
    expect(cham.className).toContain('tone-warn');
    expect(cham.getAttribute('title')).toContain('Thưởng Sale · chờ duyệt');
  });
});
