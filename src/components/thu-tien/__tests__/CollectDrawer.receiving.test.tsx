// @vitest-environment jsdom
// Ngăn thu tiền (đợt 1 sửa phiếu, 25/09/2026): hoàn tác phải gõ lý do thật,
// thu lặp cùng số tiền trong 30 phút phải hỏi lại, thiếu sổ tiền mặt riêng thì
// bàn phím tiền mặt bị chặn kèm câu hướng dẫn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollectDrawer } from '../CollectDrawer';
import type { InvoiceWithRelations } from '@/types/invoice';

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  undo: vi.fn(),
  recent: vi.fn(),
  blockTm: null as string | null,
}));

vi.mock('@/hooks/useQuickCollect', () => ({
  useQuickCollect: () => ({
    collect: mocks.collect,
    receiving: { loading: false, error: null, books: { TM: [{ id: 'cash', name: 'Hiệp Thu' }], TK: [], TT: [] } },
    receivingBlockFor: (m: string) => (m === 'TM' ? mocks.blockTm : null),
    changeAccountNameFor: () => 'Hiệp Thối',
    isCollecting: false,
  }),
}));
vi.mock('@/hooks/useDeletePayment', () => ({
  useDeletePayment: () => ({ mutate: mocks.undo, isPending: false }),
  useCollectionReversalEligibility: () => ({ data: {} }),
  COLLECTION_BLOCK_TEXT: {},
}));
vi.mock('@/hooks/useCollectionTenders', () => ({ fetchRecentInvoiceCollections: mocks.recent }));
vi.mock('@/hooks/useCollectionReport', () => ({ useInvoiceItemsLite: () => ({ data: [], isLoading: false, isError: false }) }));
vi.mock('@/hooks/useUpdateInvoiceNote', () => ({ useUpdateInvoiceNote: () => ({ mutate: vi.fn() }) }));
vi.mock('@/hooks/useInvoices', () => ({ useInvoice: () => ({ data: undefined, isLoading: false, isError: false }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => false }));
vi.mock('@/lib/receiptUpload', () => ({ uploadReceiptToStorage: vi.fn() }));
vi.mock('@/lib/paymentRecordRpc', () => ({ deriveInvoiceDepositDue: () => 0 }));
vi.mock('../InvoiceDetailCard', () => ({ InvoiceDetailCard: () => null }));
vi.mock('../CollectKeypad', () => ({ CollectKeypad: () => <div>BÀN PHÍM</div> }));
// Form thu báo một khoản thu hợp lệ 2.000 đ tiền mặt lên ngăn. Báo SAU một nhịp:
// effect của con chạy trước effect "làm mới khi đổi hoá đơn" của ngăn cha.
vi.mock('../CollectPayForm', async () => {
  const { useEffect } = await import('react');
  return {
    CollectPayForm: ({ onChange }: { onChange: (state: unknown) => void }) => {
      useEffect(() => {
        const t = setTimeout(() => onChange({
          total: 2000,
          overpay: 0,
          keepAsCredit: false,
          canSubmit: true,
          payload: {
            lines: [{ method: 'TM', amount: 2000, accountId: 'cash' }],
            keepAsCredit: false,
            changeAmount: 0,
            paymentDate: '2026-09-25',
            receiptFile: null,
          },
        }), 0);
        return () => clearTimeout(t);
      }, [onChange]);
      return null;
    },
  };
});

/** Nút xanh "Thu …" khi form đã báo khoản thu hợp lệ. */
async function nutThu() {
  const btn = (await screen.findByRole('button', { name: /^Thu / })) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  return btn;
}

const invoice = {
  id: 'inv',
  status: 'APPROVED',
  paid_amount: 0,
  total_amount: 2000,
  notes: null,
  building_id: 'toa',
  invoice_items: [],
  payments: [],
} as unknown as InvoiceWithRelations;
const props = { invoice, show: true, mode: 'view' as const, canRecordPayment: true, prev: null, next: null, onClose: () => {}, onNavigate: () => {} };

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.blockTm = null;
  mocks.collect.mockResolvedValue({ ok: ['inv'], failures: [] });
  mocks.recent.mockResolvedValue([]);
});

describe('CollectDrawer — thu trùng', () => {
  it('không có khoản thu trùng: thu luôn, không hỏi', async () => {
    render(<CollectDrawer {...props} />);
    fireEvent.click(await nutThu());
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(1));
    expect(mocks.recent).toHaveBeenCalledWith(['inv']);
    expect(mocks.collect.mock.lastCall?.[0]).toMatchObject({
      invoice,
      lines: [{ method: 'TM', amount: 2000, accountId: 'cash' }],
      accountOverrides: { TM: 'cash' },
    });
  });

  it('vừa thu cùng số tiền trong 30 phút: hỏi lại, chỉ thu khi bấm "Vẫn thu tiếp"', async () => {
    mocks.recent.mockResolvedValue([
      {
        id: 'c1',
        invoice_id: 'inv',
        status: 'ACTIVE',
        actor_id: 'u1',
        gross_amount: 2000,
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        collector_name: 'Hiển',
      },
    ]);
    render(<CollectDrawer {...props} />);
    fireEvent.click(await nutThu());
    expect(await screen.findByText(/Hoá đơn này vừa được thu 2\.000 đ lúc \d\d:\d\d bởi Hiển\. Vẫn thu tiếp\?/)).toBeTruthy();
    expect(mocks.collect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Vẫn thu tiếp' }));
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(1));
  });

  it('bấm "Không thu" thì không ghi gì', async () => {
    mocks.recent.mockResolvedValue([
      { id: 'c1', invoice_id: 'inv', status: 'ACTIVE', actor_id: 'u1', gross_amount: 2000, created_at: new Date().toISOString(), collector_name: 'Hiển' },
    ]);
    render(<CollectDrawer {...props} />);
    fireEvent.click(await nutThu());
    fireEvent.click(await screen.findByRole('button', { name: 'Không thu' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Vẫn thu tiếp' })).toBeNull());
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('không đọc được lịch sử thu: vẫn hỏi chứ không lặng lẽ bỏ qua', async () => {
    mocks.recent.mockRejectedValue(new Error('mất mạng'));
    render(<CollectDrawer {...props} />);
    fireEvent.click(await nutThu());
    expect(await screen.findByText(/Không kiểm tra được các khoản thu gần đây.*mất mạng/)).toBeTruthy();
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});

describe('CollectDrawer — hoàn tác phải có lý do', () => {
  const paid = {
    ...invoice,
    paid_amount: 1000,
    payments: [{ id: 'p1', amount: 1000, payment_date: '2026-09-25', collection_id: 'c1', reversed_at: null }],
  } as unknown as InvoiceWithRelations;

  it('mở ô lý do, chỉ cho xác nhận khi đủ 8 ký tự, gửi đúng lý do đã gõ', () => {
    render(<CollectDrawer {...props} invoice={paid} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }));
    const xacNhan = screen.getByRole('button', { name: 'Xác nhận hoàn tác' }) as HTMLButtonElement;
    expect(xacNhan.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do hoàn tác' }), { target: { value: 'ngắn' } });
    expect(xacNhan.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Lý do hoàn tác' }), { target: { value: '  Thu trùng với anh Hiển  ' } });
    expect(xacNhan.disabled).toBe(false);
    fireEvent.click(xacNhan);
    expect(mocks.undo).toHaveBeenCalledWith(
      { payment_id: 'p1', collection_id: 'c1', reason: 'Thu trùng với anh Hiển' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});

describe('CollectDrawer — bàn phím tiền mặt', () => {
  it('thiếu sổ tiền mặt riêng: thay bàn phím bằng câu hướng dẫn', () => {
    mocks.blockTm = 'Người thu chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền.';
    render(<CollectDrawer {...props} mode="keypad" />);
    expect(screen.queryByText('BÀN PHÍM')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(mocks.blockTm);
  });

  it('có sổ tiền mặt riêng: hiện bàn phím', () => {
    render(<CollectDrawer {...props} mode="keypad" />);
    expect(screen.getByText('BÀN PHÍM')).toBeTruthy();
  });
});
