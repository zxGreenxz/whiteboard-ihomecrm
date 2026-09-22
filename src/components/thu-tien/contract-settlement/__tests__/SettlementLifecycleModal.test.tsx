// @vitest-environment jsdom
// =============================================================================
// SettlementLifecycleModal — BƯỚC GHI CHI: chứng từ và ngày chi.
//
// ── T1: hai lỗi đang sửa ────────────────────────────────────────────────────
// 1. Mở form chi thì modal `setChungTu(null)` rồi ĐỢI người dùng bấm "Dùng ảnh
//    có sẵn". Phiếu đã có ảnh chuyển khoản hợp lệ vẫn bắt bấm thêm một nút nữa
//    mới chi được — trong khi hộp thoại Thu chi tự nhận ảnh từ 27/08/2026.
// 2. Không dán được ảnh: chỉ có <input type="file">, không nối
//    `useClipboardImagePaste` như `IncomeExpensePostingDialog`.
//
// ⚠ RANH GIỚI PHẢI GIỮ: tự nhận ảnh CHỈ chuẩn bị chứng từ. Nó không duyệt,
// không ghi tiền, và không thay điều kiện chọn sổ quỹ. Bài kiểm dưới đây đòi
// đúng điều đó bằng cách soi `actions.approveAndPost` / `actions.post`.
//
// ── T1a: ngày chi mặc định ─────────────────────────────────────────────────
// `new Date().toISOString().slice(0, 10)` là NGÀY UTC. 01:00 ngày 22/09 giờ
// Việt Nam là 18:00 ngày 21/09 UTC ⇒ form tự điền 2026-09-21, sớm một ngày.
//
// Giả lập tới đâu: hai RPC chứng từ (`adopt…` / `useAttachPostingEvidence`),
// sổ quỹ, quyền. Phần được kiểm là NỐI DÂY thật trong modal + hàm dựng danh
// sách ảnh THẬT (`buildPostingEvidenceItems`), không phải bản dựng lại.
// =============================================================================

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000aa';

const H = vi.hoisted(() => ({
  adopt: vi.fn(),
  attach: vi.fn(),
  soCustodian: [] as { id: string; name: string }[],
  moiSo: [] as { id: string; organization_id?: string; is_virtual?: boolean }[],
  custodianState: { isLoading: false, isFetching: false, isError: false, refetch: vi.fn() },
  accountsState: { isLoading: false, isFetching: false, isError: false, refetch: vi.fn() },
  lifecycleState: 'ready',
  basisState: 'ready',
}));

vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useCustodianCashbooksV2: () => ({ data: H.soCustodian, ...H.custodianState }),
  useAttachPostingEvidence: () => H.attach,
  adoptVoucherAttachmentsAsEvidence: (...a: unknown[]) => H.adopt(...a),
}));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: H.moiSo, ...H.accountsState }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: USER } }) }));
vi.mock('@/hooks/income-expenses/supplements', () => ({
  useIncomeExpenseSupplements: () => ({
    data: [], isLoading: false, isError: false, refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (v: string) => v }));
vi.mock('@/components/ui/attachment-lightbox', () => ({
  AttachmentLightbox: ({ attachments, index }: { attachments: string[]; index: number | null }) => (
    <div data-testid="lightbox" data-mo={index === null ? '' : attachments[index] ?? ''} />
  ),
}));
vi.mock('../ContractLifecycleBand', async () => {
  const { useEffect } = await import('react');
  return { ContractLifecycleBand: ({ onReadStateChange }: { onReadStateChange?: (s: string) => void }) => {
    const state = H.lifecycleState;
    useEffect(() => { onReadStateChange?.(state); }, [onReadStateChange, state]);
    return <div data-testid="dai" />;
  } };
});
vi.mock('../SettlementVoucherDetails', async () => {
  const { useEffect } = await import('react');
  return { SettlementVoucherDetails: ({ onReadStateChange }: { onReadStateChange?: (s: string) => void }) => {
    const state = H.basisState;
    useEffect(() => { onReadStateChange?.(state); }, [onReadStateChange, state]);
    return <div data-testid="can-cu" />;
  } };
});
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { SettlementLifecycleModal } from '../SettlementLifecycleModal';
import {
  fmtMoney,
  type SettlementRow, type ViewStatus,
} from '@/lib/contractSettlement';
import type { useSettlementActions } from '@/hooks/useSettlementActions';

type Actions = ReturnType<typeof useSettlementActions>;

// ── Định danh: UUID, KHÔNG BAO GIỜ mã phiếu (production có mã trùng) ────────
const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const TOA = '0b0b0b0b-0000-4000-8000-000000000001';
const PHONG = '0b0b0b0b-0000-4000-8000-000000000401';
const HD = '0c0c0c0c-0000-4000-8000-000000000001';
const V_A = '0f0f0f0f-0000-4000-8000-00000000000a';
const V_B = '0f0f0f0f-0000-4000-8000-00000000000b';
const SO_A = '0d0d0d0d-0000-4000-8000-000000000001';
const EV_1 = '0e0e0e0e-0000-4000-8000-000000000001';
const EV_2 = '0e0e0e0e-0000-4000-8000-000000000002';
const ANH_1 = 'https://kho.test/bien-lai-1.png';
const ANH_2 = 'https://kho.test/bien-lai-2.png';
const TIEN = 3_076_000;

const phieu = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  key: `refund:${V_A}`, kind: 'refund', kindSource: 'system_source', kindConflict: false,
  voucherId: V_A, voucherCode: 'PC2609095', contractId: HD, contractNumber: 'HĐT-401/32PVC',
  terminationId: null, roomId: PHONG, buildingName: '32PVC', roomName: '401',
  customerName: 'Nguyễn Văn A', recipientName: 'Nguyễn Văn A', amount: TIEN,
  notes: null, systemSource: 'termination.refund', commissionKind: null,
  basis: { kind: 'not-applicable' }, status: 'pending',
  approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED', postingMode: 'CASH',
  bankAccount: '0123456789', attachments: [ANH_1], hasAttachment: true,
  bankName: 'Vietcombank', eventDate: '2026-09-05', origin: 'contract',
  eventLabel: 'Thanh lý', postedOn: null, bookName: null, issues: [],
  supplementPending: false, reviewState: null, reviewVersion: 0,
  approvalVersion: 1, postingVersion: 0, organizationId: ORG, buildingId: TOA,
  ...over,
});

type Kha = ReturnType<Actions['availabilityOf']>;

const dungActions = (kha: Partial<Kha> = {}): Actions => ({
  availabilityOf: () => ({
    approve: true, approveAndPost: true, post: true, cancel: false, cancelReason: null,
    editRecipient: false, requestSupplement: false, markSupplementDone: false,
    ...kha,
  }),
  approve: vi.fn().mockResolvedValue(undefined),
  approveAndPost: vi.fn().mockResolvedValue(undefined),
  post: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
  editRecipient: vi.fn().mockResolvedValue(undefined),
  requestSupplement: vi.fn().mockResolvedValue(undefined),
  markSupplementDone: vi.fn().mockResolvedValue(undefined),
  isBusy: false, permsLoaded: true,
} as unknown as Actions);

interface Man {
  actions: Actions;
  qc: QueryClient;
  dong: ReturnType<typeof vi.fn>;
  doiPhieu: (row: SettlementRow, view?: ViewStatus) => void;
  unmount: () => void;
}

function dungMan(row: SettlementRow, view: ViewStatus = 'pending', kha: Partial<Kha> = {}): Man {
  const actions = dungActions(kha);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dong = vi.fn();
  const khung = (r: SettlementRow, v: ViewStatus) => (
    <QueryClientProvider client={qc}>
      <SettlementLifecycleModal row={r} view={v} actions={actions} onClose={dong} />
    </QueryClientProvider>
  );
  const { rerender, unmount } = render(khung(row, view));
  return {
    actions, qc, dong, unmount,
    doiPhieu: (r, v = view) => rerender(khung(r, v)),
  };
}

const moFormChi = () => fireEvent.click(screen.getByRole('button', { name: /^Duyệt & Chi/ }));
const nutXacNhan = () =>
  screen.getByRole('button', { name: `Xác nhận đã chi đủ ${fmtMoney(TIEN)}` }) as HTMLButtonElement;
/**
 * Ô "Sổ chi" là `<select>` THẬT. Phải trỏ đúng phần tử đó: từ T4, khối Người
 * nhận tiền có thêm `BankSelect` — trigger của nó cũng mang `role="combobox"`,
 * nên `getByRole('combobox')` trần sẽ vỡ vì tìm thấy hai phần tử.
 */
const chonSo = () => fireEvent.change(
  document.querySelector('select.cs-in') as HTMLSelectElement, { target: { value: SO_A } },
);
const anhNho = () => [...document.querySelectorAll('.cs-anh')] as HTMLElement[];
const oTaiAnh = () => document.querySelector('.cs-tai') as HTMLElement;
const chuTrenMan = () => (document.body.textContent ?? '');
const tepAnh = (ten = 'bien-lai.png') =>
  new File(['anh'], ten, { type: 'image/png' });

/** Dán ảnh THẬT: sự kiện paste trên window khi con trỏ đang trong vùng ảnh. */
const dan = (data: { files?: File[]; items?: unknown[]; text?: boolean }) => {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      files: data.files ?? [],
      items: data.items ?? (data.text ? [{ kind: 'string', type: 'text/plain' }] : []),
    },
  });
  act(() => { window.dispatchEvent(ev); });
  return ev;
};

/**
 * `BankSelect` → `SearchableSelect` → Radix Popover + cmdk. Ba API trình duyệt
 * dưới đây jsdom KHÔNG có; thiếu chúng thì dropdown ném ngay lúc mở, không phải
 * lỗi của màn này. Cùng bộ vá với `AddressCascadingDropdowns.test.tsx`.
 */
beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { value: () => false });
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => undefined });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { value: () => undefined });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => undefined });
});

beforeEach(() => {
  H.adopt.mockReset().mockResolvedValue({ evidenceIds: [EV_1], skipped: [] });
  H.attach.mockReset().mockResolvedValue({
    url: ANH_2, evidenceIds: [EV_1, EV_2], skipped: [], attachedToVoucher: true,
  });
  H.soCustodian = [{ id: SO_A, name: 'Sổ tiền mặt 32PVC' }];
  H.moiSo = [{ id: SO_A, organization_id: ORG, is_virtual: false }];
  H.custodianState = { isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };
  H.accountsState = { isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };
  H.lifecycleState = 'ready';
  H.basisState = 'ready';
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Task 3 — lệnh của đúng hồ sơ và trạng thái nguồn đọc', () => {
  it.each(['custodian', 'accounts'] as const)('cached sổ %s đang refetch vẫn khóa ghi chi tới khi nguồn xong', async (source) => {
    const state = H[source === 'custodian' ? 'custodianState' : 'accountsState'];
    state.isFetching = true;
    const man = dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    chonSo();
    expect(nutXacNhan().disabled).toBe(true);
    expect(chuTrenMan()).toContain('Đang tải sổ quỹ');
    state.isFetching = false;
    man.doiPhieu(phieu());
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
  });
  it.each(['lifecycle', 'basis'] as const)('nguồn đối chiếu %s đang tải hoặc lỗi chặn duyệt cho tới khi đọc thành công', (source) => {
    const state = source === 'lifecycle' ? 'lifecycleState' : 'basisState';
    H[state] = 'loading';
    const man = dungMan(phieu());
    const approve = () => screen.getByRole('button', { name: 'Duyệt Chờ Chi' }) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    H[state] = 'error';
    man.doiPhieu(phieu());
    expect(approve().disabled).toBe(true);
    fireEvent.click(approve());
    expect(man.actions.approve).not.toHaveBeenCalled();
    H[state] = 'ready';
    man.doiPhieu(phieu());
    expect(approve().disabled).toBe(false);
  });

  it('nguồn đối chiếu thiếu một phần giữ cảnh báo, không thay chính sách duyệt', () => {
    H.lifecycleState = 'insufficient';
    H.basisState = 'insufficient';
    dungMan(phieu());
    expect((screen.getByRole('button', { name: 'Duyệt Chờ Chi' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('yêu cầu bổ sung rồi đánh dấu xong trong cùng modal là hai lệnh có hai khoá', async () => {
    const man = dungMan(phieu(), 'pending', { requestSupplement: true, markSupplementDone: true });
    fireEvent.change(screen.getByPlaceholderText('Cần bổ sung gì…'), { target: { value: 'Bổ sung ảnh chuyển khoản' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cần bổ sung' }));
    await waitFor(() => expect(man.actions.requestSupplement).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByPlaceholderText('Cần bổ sung gì…') as HTMLTextAreaElement).value).toBe(''));
    man.doiPhieu(phieu({ supplementPending: true, issues: ['SUPPLEMENT_PENDING'] }), 'review');
    fireEvent.change(screen.getByPlaceholderText('Đã bổ sung gì…'), { target: { value: 'Đã đối chiếu ảnh' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Xác nhận & Chuyển Chờ Duyệt/ }));
    await waitFor(() => expect(man.actions.markSupplementDone).toHaveBeenCalledTimes(1));
    const request = vi.mocked(man.actions.requestSupplement).mock.calls[0][0];
    const done = vi.mocked(man.actions.markSupplementDone).mock.calls[0][0];
    expect(done.voucherId).toBe(V_A);
    expect(done.idempotencyKey).not.toBe(request.idempotencyKey);
  });

  it('mất phản hồi giữ khoá khi thử lại cùng nội dung, đổi nội dung tạo lệnh mới', async () => {
    const man = dungMan(phieu(), 'pending', { requestSupplement: true });
    const request = vi.mocked(man.actions.requestSupplement);
    request.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout'));
    const input = screen.getByPlaceholderText('Cần bổ sung gì…');
    fireEvent.change(input, { target: { value: 'Thiếu biên lai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cần bổ sung' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Cần bổ sung' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(request.mock.calls[1][0]).toEqual(request.mock.calls[0][0]);
    fireEvent.change(input, { target: { value: 'Thiếu số tài khoản' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cần bổ sung' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2][0].idempotencyKey).not.toBe(request.mock.calls[1][0].idempotencyKey);
  });

  it('ghi chi phiếu A về muộn không đóng hoặc xoá form của phiếu B', async () => {
    const man = dungMan(phieu());
    let finish!: () => void;
    vi.mocked(man.actions.approveAndPost).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
    fireEvent.click(nutXacNhan());
    await waitFor(() => expect(man.actions.approveAndPost).toHaveBeenCalledTimes(1));
    man.doiPhieu(phieu({ voucherId: V_B, key: `refund:${V_B}` }));
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(2));
    await act(async () => { finish(); });
    expect(man.dong).not.toHaveBeenCalled();
    expect(nutXacNhan()).toBeTruthy();
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
  });

  it('duyệt phiếu A về muộn không đóng modal đã chuyển sang phiếu B', async () => {
    const man = dungMan(phieu());
    let finish!: () => void;
    vi.mocked(man.actions.approve).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt Chờ Chi' }));
    man.doiPhieu(phieu({ voucherId: V_B, key: `refund:${V_B}` }));
    await act(async () => { finish(); });
    expect(man.dong).not.toHaveBeenCalled();
  });

  it('từ chối phiếu A về muộn không đóng modal phiếu B', async () => {
    const man = dungMan(phieu(), 'pending', { cancel: true });
    let finish!: () => void;
    vi.mocked(man.actions.cancel).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Từ chối phiếu' }));
    fireEvent.change(screen.getByPlaceholderText('Lý do từ chối (tối thiểu 8 ký tự)…'), { target: { value: 'Không đúng căn cứ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận' }));
    expect(man.actions.cancel).toHaveBeenCalledOnce();
    man.doiPhieu(phieu({ voucherId: V_B, key: `refund:${V_B}` }));
    await act(async () => { finish(); });
    expect(man.dong).not.toHaveBeenCalled();
  });

  it('bổ sung phiếu A về muộn không xoá draft B; phiếu B có khoá lệnh mới', async () => {
    const man = dungMan(phieu(), 'pending', { requestSupplement: true });
    let finish!: () => void;
    const request = vi.mocked(man.actions.requestSupplement);
    request.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByPlaceholderText('Cần bổ sung gì…'), { target: { value: 'Thiếu biên lai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cần bổ sung' }));
    man.doiPhieu(phieu({ voucherId: V_B, key: `refund:${V_B}` }));
    fireEvent.change(screen.getByPlaceholderText('Cần bổ sung gì…'), { target: { value: 'Thiếu biên lai' } });
    await act(async () => { finish(); });
    expect((screen.getByPlaceholderText('Cần bổ sung gì…') as HTMLTextAreaElement).value).toBe('Thiếu biên lai');
    fireEvent.click(screen.getByRole('button', { name: 'Cần bổ sung' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][0].voucherId).toBe(V_B);
    expect(request.mock.calls[1][0].idempotencyKey).not.toBe(request.mock.calls[0][0].idempotencyKey);
  });

  it('đổi phiếu dọn lý do và xác nhận đối chiếu của hồ sơ cũ', () => {
    const man = dungMan(phieu({ supplementPending: true, issues: ['SUPPLEMENT_PENDING'] }), 'review', { markSupplementDone: true });
    fireEvent.change(screen.getByPlaceholderText('Đã bổ sung gì…'), { target: { value: 'Chỉ đúng cho A' } });
    fireEvent.click(screen.getByRole('checkbox'));
    man.doiPhieu(phieu({ voucherId: V_B, key: `refund:${V_B}`, supplementPending: true, issues: ['SUPPLEMENT_PENDING'] }), 'review');
    expect((screen.getByPlaceholderText('Đã bổ sung gì…') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it.each(['loading', 'error'] as const)('không duyệt hoặc mở chi khi xác minh phiếu %s', (validationState) => {
    const man = dungMan(phieu({ validationState } as Partial<SettlementRow>));
    const approve = screen.getByRole('button', { name: 'Duyệt Chờ Chi' }) as HTMLButtonElement;
    const post = screen.getByRole('button', { name: /^Duyệt & Chi/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(post.disabled).toBe(true);
    fireEvent.click(approve);
    fireEvent.click(post);
    expect(man.actions.approve).not.toHaveBeenCalled();
    expect(H.adopt).not.toHaveBeenCalled();
  });

  it.each(['custodian', 'accounts'] as const)('nguồn sổ %s đang tải không bị nói thành không giữ sổ', async (source) => {
    H[source === 'custodian' ? 'custodianState' : 'accountsState'].isLoading = true;
    dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    expect(chuTrenMan()).toContain('Đang tải sổ quỹ');
    expect(chuTrenMan()).not.toContain('Bạn không giữ sổ quỹ nào');
    chonSo();
    expect(nutXacNhan().disabled).toBe(true);
  });

  it.each(['custodian', 'accounts'] as const)('nguồn sổ %s lỗi chặn ghi, cho thử lại cả hai nguồn', async (source) => {
    H[source === 'custodian' ? 'custodianState' : 'accountsState'].isError = true;
    dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    expect(chuTrenMan()).not.toContain('Bạn không giữ sổ quỹ nào');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại sổ quỹ' }));
    expect(H.custodianState.refetch).toHaveBeenCalledTimes(1);
    expect(H.accountsState.refetch).toHaveBeenCalledTimes(1);
    chonSo();
    expect(nutXacNhan().disabled).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// T1 — tự nhận ảnh có sẵn, dán ảnh, và ranh giới "chuẩn bị ≠ ghi tiền"
// ═══════════════════════════════════════════════════════════════════════════

describe('T1 — chứng từ của bước ghi chi', () => {
  it('mở bước ghi chi là TỰ nhận ảnh có sẵn, không còn nút dùng ảnh', async () => {
    dungMan(phieu());
    moFormChi();

    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    expect(H.adopt).toHaveBeenCalledWith(V_A);
    expect(screen.queryByRole('button', { name: /[Dd]ùng ảnh/ })).toBeNull();
    // Chuẩn bị chứng từ KHÔNG được chạm vào tiền.
    expect(nutXacNhan()).toBeTruthy();
  });

  it('có ảnh hợp lệ thì chọn sổ là xác nhận được ngay, payload đúng phiếu và chứng từ', async () => {
    const man = dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    // Ảnh đã có KHÔNG thay thế điều kiện chọn sổ quỹ.
    expect(nutXacNhan().disabled).toBe(true);
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));

    fireEvent.click(nutXacNhan());
    await waitFor(() => expect(man.actions.approveAndPost).toHaveBeenCalledTimes(1));
    const input = (man.actions.approveAndPost as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input).toMatchObject({
      subjectKind: 'VOUCHER', subjectId: V_A, cashbookId: SO_A,
      evidenceIds: [EV_1], expectedApprovalVersion: 1, expectedPostingVersion: 0,
    });
    expect(typeof input.idempotencyKey).toBe('string');
    expect(input.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('tự nhận ảnh KHÔNG duyệt và KHÔNG ghi tiền', async () => {
    const man = dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    expect(man.actions.approveAndPost).not.toHaveBeenCalled();
    expect(man.actions.post).not.toHaveBeenCalled();
    expect(man.actions.approve).not.toHaveBeenCalled();
  });

  it('adopt trả rỗng: nói rõ lý do, khoá xác nhận, vẫn còn đường tải/dán lại', async () => {
    H.adopt.mockResolvedValue({ evidenceIds: [], skipped: [] });
    dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(chuTrenMan()).toContain('Không nhận được ảnh trên phiếu làm chứng từ'));
    chonSo();
    expect(nutXacNhan().disabled).toBe(true);
    expect(screen.getByText(/Tải hoặc Dán Ảnh/)).toBeTruthy();
  });

  it('một ảnh bị từ chối KHÔNG phủ nhận ảnh còn lại, và nói đúng lý do từng ảnh', async () => {
    H.adopt.mockResolvedValue({
      evidenceIds: [EV_1],
      skipped: [{ url: ANH_2, reason: 'FILE_THUOC_TO_CHUC_KHAC' }],
    });
    dungMan(phieu({ attachments: [ANH_1, ANH_2] }));
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(chuTrenMan()).toContain('File thuộc tổ chức khác'));
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
  });

  it('ảnh mất trong kho và ảnh đã dùng lần trước có câu riêng, không gộp một câu chung', async () => {
    H.adopt.mockResolvedValue({
      evidenceIds: [],
      skipped: [
        { url: ANH_1, reason: 'FILE_KHONG_CON_TRONG_STORAGE' },
        { url: ANH_2, reason: 'ATTACHED' },
      ],
    });
    dungMan(phieu({ attachments: [ANH_1, ANH_2] }));
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(chuTrenMan()).toContain('File không còn trong kho lưu trữ'));
    expect(chuTrenMan()).toContain('Đã dùng cho lần ghi sổ trước');
  });

  it('tải ảnh bổ sung khi đã có ảnh: cùng đường xử lý, ảnh mới thấy ngay, làm mới hồ sơ', async () => {
    const man = dungMan(phieu());
    const lamMoi = vi.spyOn(man.qc, 'invalidateQueries');
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    const o = oTaiAnh().querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(o, { target: { files: [tepAnh()] } });

    await waitFor(() => expect(H.attach).toHaveBeenCalledTimes(1));
    expect(H.attach.mock.calls[0][1]).toMatchObject({ voucherId: V_A, organizationId: ORG });
    await waitFor(() => expect(anhNho().length).toBe(2));

    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
    fireEvent.click(nutXacNhan());
    await waitFor(() => expect(man.actions.approveAndPost).toHaveBeenCalledTimes(1));
    expect((man.actions.approveAndPost as ReturnType<typeof vi.fn>).mock.calls[0][0].evidenceIds)
      .toEqual([EV_1, EV_2]);

    expect(lamMoi.mock.calls.some((c) => {
      const k = (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey;
      return Array.isArray(k) && k[0] === 'contract-settlement';
    })).toBe(true);
  });

  it('ảnh vừa tải rồi refetch trả về cùng URL thì danh sách KHÔNG nhân đôi', async () => {
    const man = dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    const o = oTaiAnh().querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(o, { target: { files: [tepAnh()] } });
    await waitFor(() => expect(anhNho().length).toBe(2));

    // Refetch: `contract-settlement` trả phiếu đã có CẢ ảnh vừa tải.
    man.doiPhieu(phieu({ attachments: [ANH_1, ANH_2] }));
    await waitFor(() => expect(anhNho().length).toBe(2));
  });

  it('dán ảnh đi ĐÚNG đường của tải ảnh; dán văn bản thì không đụng tới', async () => {
    dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    expect(chuTrenMan()).toMatch(/Ctrl\/Cmd\+V|Ctrl\+V/);
    fireEvent.mouseEnter(oTaiAnh());

    const evVanBan = dan({ text: true });
    expect(H.attach).not.toHaveBeenCalled();
    expect(evVanBan.defaultPrevented).toBe(false);

    dan({ files: [tepAnh('dan.png')] });
    await waitFor(() => expect(H.attach).toHaveBeenCalledTimes(1));
    expect((H.attach.mock.calls[0][0] as File).name).toBe('dan.png');
  });

  it('đang xử lý ảnh thì khoá nút xác nhận', async () => {
    let moKhoa: (v: unknown) => void = () => {};
    H.attach.mockImplementation(() => new Promise((r) => { moKhoa = r; }));
    dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));

    const o = oTaiAnh().querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(o, { target: { files: [tepAnh()] } });
    await waitFor(() => expect(nutXacNhan().disabled).toBe(true));

    await act(async () => {
      moKhoa({ url: ANH_2, evidenceIds: [EV_1, EV_2], skipped: [], attachedToVoucher: true });
    });
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
  });

  it('bấm xác nhận hai lần chỉ ghi sổ MỘT lần', async () => {
    const man = dungMan(phieu());
    let xong: () => void = () => {};
    (man.actions.approveAndPost as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((r) => { xong = r; }),
    );
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));

    const nut = nutXacNhan();
    fireEvent.click(nut);
    fireEvent.click(nut);
    await act(async () => { await Promise.resolve(); });
    expect(man.actions.approveAndPost).toHaveBeenCalledTimes(1);
    await act(async () => { xong(); });
  });

  it('thử lại sau khi ghi sổ hỏng giữ NGUYÊN khoá idempotency của cùng lần chi', async () => {
    const man = dungMan(phieu());
    const ghi = man.actions.approveAndPost as ReturnType<typeof vi.fn>;
    ghi.mockRejectedValueOnce(new Error('mạng rớt')).mockResolvedValueOnce(undefined);
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));

    fireEvent.click(nutXacNhan());
    await waitFor(() => expect(ghi).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
    fireEvent.click(nutXacNhan());
    await waitFor(() => expect(ghi).toHaveBeenCalledTimes(2));
    expect(ghi.mock.calls[1][0].idempotencyKey).toBe(ghi.mock.calls[0][0].idempotencyKey);
  });

  it('kết quả adopt về SAU khi đã đổi phiếu không được gắn sang phiếu khác', async () => {
    let traKetQua: (v: unknown) => void = () => {};
    H.adopt.mockImplementation(() => new Promise((r) => { traKetQua = r; }));
    const man = dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    // Đổi sang phiếu khác (mở từ hồ sơ biến động) — modal KHÔNG unmount.
    man.doiPhieu(phieu({ key: `refund:${V_B}`, voucherId: V_B, voucherCode: 'PC2609096', attachments: [] }));
    await act(async () => { traKetQua({ evidenceIds: [EV_1], skipped: [] }); });

    moFormChi();
    await act(async () => { await Promise.resolve(); });
    expect(H.adopt).toHaveBeenCalledTimes(1); // phiếu B không có ảnh ⇒ không adopt
    chonSo();
    // Chứng từ của phiếu A tuyệt đối không được làm phiếu B chi được.
    expect(nutXacNhan().disabled).toBe(true);
    expect(chuTrenMan()).toContain('cần ít nhất 1 chứng từ');
  });

  /**
   * ĐÂY LÀ CA NEO CỦA plan §3.1 "kết quả upload/adopt sau khi đổi phiếu không
   * được gắn sang phiếu khác" — và nó phải đi ĐƯỜNG UPLOAD.
   *
   * Vì sao ca adopt ở trên KHÔNG chứng minh được điều đó: nó cho kết quả của
   * phiếu A về TRƯỚC khi bấm mở form phiếu B, nên `xoaChungTu()` trong
   * `moFormChi` dọn sạch dấu vết dù hàng rào định danh có tồn tại hay không;
   * đường adopt lại còn được `luotNhanAnh` gác thêm một lớp. Đường upload thì
   * KHÔNG có bộ đếm lượt nào — `conDungPhieu` là hàng rào DUY NHẤT.
   *
   * Nên thứ tự ở đây là: form phiếu B đã mở và đã chọn sổ RỒI, lần tải của
   * phiếu A mới về. Bỏ hàng rào định danh là nút xác nhận của phiếu B sáng lên
   * và ghi tiền phiếu B kèm chứng từ của phiếu A.
   */
  it('tải ảnh của phiếu A về khi form phiếu B ĐANG MỞ thì không gắn sang phiếu B', async () => {
    let traKetQua: (v: unknown) => void = () => {};
    H.attach.mockImplementation(() => new Promise((r) => { traKetQua = r; }));
    const man = dungMan(phieu());
    const lamMoi = vi.spyOn(man.qc, 'invalidateQueries');
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    const o = oTaiAnh().querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(o, { target: { files: [tepAnh()] } });
    await waitFor(() => expect(H.attach).toHaveBeenCalledTimes(1));

    // Doi sang phieu KHONG co anh, roi mo form chi va chon so cho no.
    man.doiPhieu(phieu({ key: `refund:${V_B}`, voucherId: V_B, voucherCode: 'PC2609096', attachments: [] }));
    moFormChi();
    await act(async () => { await Promise.resolve(); });
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(true));
    lamMoi.mockClear();

    // GIO moi toi luot tai cua phieu A ve.
    await act(async () => {
      traKetQua({ url: ANH_2, evidenceIds: [EV_1], skipped: [], attachedToVoucher: true });
    });

    expect(nutXacNhan().disabled).toBe(true);
    expect(chuTrenMan()).toContain('cần ít nhất 1 chứng từ');
    expect(anhNho()).toHaveLength(0); // anh cua phieu A khong duoc moc tren phieu B
    expect(lamMoi.mock.calls.some((c) => {
      const k = (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey;
      return Array.isArray(k) && k[0] === 'contract-settlement';
    })).toBe(false);
  });

  it('bấm "Chưa chi, quay lại" thì dọn luôn ảnh mờ của lần chi vừa bỏ dở', async () => {
    H.adopt.mockResolvedValue({
      evidenceIds: [], skipped: [{ url: ANH_1, reason: 'ATTACHED' }],
    });
    dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(chuTrenMan()).toContain('Đã dùng cho lần ghi sổ trước'));

    fireEvent.click(screen.getByRole('button', { name: 'Chưa chi, quay lại' }));
    expect(chuTrenMan()).not.toContain('ảnh mờ là ảnh không tính cho lần chi này');
    expect(chuTrenMan()).not.toContain('Đã dùng cho lần ghi sổ trước');
  });

  it('đóng modal giữa lúc tải ảnh: kết quả về sau không làm mới hồ sơ nữa, không nổ', async () => {
    let moKhoa: (v: unknown) => void = () => {};
    H.attach.mockImplementation(() => new Promise((r) => { moKhoa = r; }));
    const man = dungMan(phieu());
    const lamMoi = vi.spyOn(man.qc, 'invalidateQueries');
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    const o = oTaiAnh().querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(o, { target: { files: [tepAnh()] } });
    await waitFor(() => expect(H.attach).toHaveBeenCalledTimes(1));

    man.unmount();
    lamMoi.mockClear();
    await act(async () => {
      moKhoa({ url: ANH_2, evidenceIds: [EV_1, EV_2], skipped: [], attachedToVoucher: true });
    });
    expect(lamMoi.mock.calls.some((c) => {
      const k = (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey;
      return Array.isArray(k) && k[0] === 'contract-settlement';
    })).toBe(false);
  });

  it('đổi phiếu giữa lúc tải ảnh thì phiếu mới KHÔNG kẹt ở "đang tải"', async () => {
    H.attach.mockImplementation(() => new Promise(() => {})); // treo mãi
    const man = dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    const o = oTaiAnh().querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(o, { target: { files: [tepAnh()] } });
    await waitFor(() => expect(nutXacNhan().disabled).toBe(true));

    man.doiPhieu(phieu({ key: `refund:${V_B}`, voucherId: V_B, attachments: [ANH_1] }));
    H.adopt.mockResolvedValue({ evidenceIds: [EV_2], skipped: [] });
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(2));

    expect(screen.getByText(/Tải hoặc Dán Ảnh/)).toBeTruthy();
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
  });

  it('phiếu chưa có ảnh nào thì không gọi adopt, và vẫn có đủ đường tải/dán', async () => {
    dungMan(phieu({ attachments: [], hasAttachment: false }));
    moFormChi();
    await act(async () => { await Promise.resolve(); });

    expect(H.adopt).not.toHaveBeenCalled();
    expect(screen.getByText(/Tải hoặc Dán Ảnh/)).toBeTruthy();
    expect(nutXacNhan()).toBeTruthy();
  });

  it('ảnh có sẵn và ảnh mới đều là thumbnail bấm phóng to được', async () => {
    dungMan(phieu({ attachments: [ANH_1, ANH_2] }));
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    const anh = anhNho();
    expect(anh.length).toBe(2);
    fireEvent.click(anh[1]);
    await waitFor(() =>
      expect(screen.getByTestId('lightbox').getAttribute('data-mo')).toBe(ANH_2));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T1a — ngày chi mặc định theo giờ Việt Nam
// ═══════════════════════════════════════════════════════════════════════════

describe('T1a — ngày chi mặc định', () => {
  const oNgay = () => document.querySelector('input[type="date"]') as HTMLInputElement;

  it('01:00 ngày 22/09 giờ Việt Nam (18:00 21/09 UTC) phải điền 2026-09-22', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T18:00:00Z'));
    dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    expect(oNgay().value).toBe('2026-09-22');
  });

  it('00:00 · 06:59 · 07:00 giờ VN và lúc giao tháng/giao năm đều đúng ngày nghiệp vụ', async () => {
    for (const [moc, mong] of [
      // 23:59 ngày 21/09 giờ VN — vẫn là hôm qua, không được nhảy sớm.
      ['2026-09-21T16:59:00Z', '2026-09-21'],
      ['2026-09-21T17:00:00Z', '2026-09-22'], // 00:00 giờ VN
      ['2026-09-21T23:59:00Z', '2026-09-22'], // 06:59 giờ VN — vùng chết của bản UTC
      ['2026-09-22T00:00:00Z', '2026-09-22'], // 07:00 giờ VN
      ['2026-09-30T17:00:00Z', '2026-10-01'], // giao tháng
      ['2026-12-31T17:00:00Z', '2027-01-01'], // giao năm
    ] as const) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(moc));
      dungMan(phieu());
      moFormChi();
      await waitFor(() => expect(H.adopt).toHaveBeenCalled());
      expect(oNgay().value, `mốc ${moc}`).toBe(mong);
      cleanup();
      vi.useRealTimers();
      H.adopt.mockClear();
    }
  });

  it('ngày người dùng chọn giữ nguyên qua refetch và qua tải ảnh, và gửi đúng postedOn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T18:00:00Z'));
    const man = dungMan(phieu());
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    fireEvent.change(oNgay(), { target: { value: '2026-09-18' } });
    expect(oNgay().value).toBe('2026-09-18');

    man.doiPhieu(phieu({ postingVersion: 0, bookName: null }));
    expect(oNgay().value).toBe('2026-09-18');

    const o = oTaiAnh().querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(o, { target: { files: [tepAnh()] } });
    await waitFor(() => expect(H.attach).toHaveBeenCalledTimes(1));
    expect(oNgay().value).toBe('2026-09-18');

    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
    fireEvent.click(nutXacNhan());
    await waitFor(() => expect(man.actions.approveAndPost).toHaveBeenCalledTimes(1));
    expect((man.actions.approveAndPost as ReturnType<typeof vi.fn>).mock.calls[0][0].postedOn)
      .toBe('2026-09-18');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T4 — ngân hàng có tìm kiếm, lưu nhất quán và QR
//
// Hai lỗi đang sửa:
// 1. Ô ngân hàng là input chữ tự do và khởi tạo RỖNG, trong khi Thu chi đã có
//    `BankSelect` gõ-để-tìm trên danh mục VietQR dùng chung. Vì khởi tạo rỗng,
//    "đã sửa" bị suy ra từ `nganHang.trim() !== ''` — phiếu có sẵn ngân hàng
//    mở lên là đã coi như sửa.
// 2. QR dựng từ `row.*`. Lưu thông tin người nhận chỉ xảy ra ở làn Cần rà soát;
//    làn Chờ duyệt duyệt/chi thẳng, BỎ QUA draft vừa gõ ⇒ QR (và lệnh duyệt)
//    chạy trên dữ liệu cũ trong khi người dùng tin là đã sửa xong.
//
// ⚠ Định danh phiếu là (UUID, organization_id). Mã phiếu KHÔNG phải định danh:
// production có nhiều phiếu trùng mã.
//
// ⚠ Ngoài phạm vi (plan §7): hai phiên cùng sửa ghi đè nhau. `editRecipient`
// gọi RPC không có khoá phiên bản. Ở đây chỉ bảo đảm draft của PHIÊN NÀY được
// lưu và QR khớp bản đã lưu — không có bài nào hứa chống ghi đè liên phiên.
// ═══════════════════════════════════════════════════════════════════════════

const SUA_DUOC: Partial<Kha> = { editRecipient: true };
const STK_MOI = '999888777';

const oTen = () => screen.getByPlaceholderText('Tên người nhận') as HTMLInputElement;
const oStk = () => screen.getByPlaceholderText('Số tài khoản') as HTMLInputElement;
const oBank = () => screen.getByRole('combobox', { name: 'Ngân hàng người nhận' }) as HTMLButtonElement;
const moBank = () => { fireEvent.click(oBank()); };
const oTim = () => screen.getByPlaceholderText('Gõ tên ngân hàng...') as HTMLInputElement;
const timBank = (s: string) => fireEvent.change(oTim(), { target: { value: s } });
const nutLuu = () =>
  screen.queryByRole('button', { name: /Lưu thông tin nhận tiền/ }) as HTMLButtonElement | null;
const anhQR = () => document.querySelector('.cs-qr img') as HTMLImageElement | null;
const srcQR = () => anhQR()?.getAttribute('src') ?? null;
const nutDuyetChi = () =>
  screen.queryByRole('button', { name: /^Duyệt & Chi/ }) as HTMLButtonElement | null;
const nutDuyetChoChi = () =>
  screen.queryByRole('button', { name: 'Duyệt Chờ Chi' }) as HTMLButtonElement | null;

/**
 * BẢN ĐỌC LẠI CỦA SERVER sau một lần lưu — cha đẩy `row` mới xuống.
 *
 * ⚠ Phải gọi tay ở mọi bài lưu-thành-công, và đó là CHỦ Ý. `editRecipient` chỉ
 * resolve SAU `await lamMoi()` (`useSettlementActions.ts`), nên ở đời thật lúc
 * lời hứa đó về thì `row` đã là bản mới. Modal KHÔNG còn giữ ảnh chụp giá trị
 * vừa gõ để lấp vào khoảng giữa: ảnh chụp ấy không sớm hơn được nhịp nào (vì
 * refetch đã xong trước), nó chỉ CHE mất chuyện server ghi khác thứ client gửi.
 * Bắt bài kiểm dựng đúng thứ tự thật là cách duy nhất để lệch đó lộ ra.
 */
const docLai = (man: Man, over: Partial<SettlementRow>) => man.doiPhieu(phieu(over));

describe('T4 — chọn ngân hàng, lưu và QR', () => {
  // ── Prefill: chuẩn hoá qua danh mục chung, KHÔNG coi là đã sửa ────────────

  it('phiếu đã có ngân hàng nhận diện được: prefill shortName và KHÔNG tự coi là đã sửa', () => {
    dungMan(phieu(), 'pending', SUA_DUOC);

    expect(oBank().textContent).toContain('Vietcombank');
    expect(nutLuu()).toBeNull();                      // chưa đụng gì ⇒ không có gì để lưu
    expect(nutDuyetChi()?.disabled).toBe(false);      // và không bị chặn duyệt/chi
  });

  it('chữ cũ viết khác chuẩn vẫn là CÙNG ngân hàng, mở lên không thành "đã sửa"', () => {
    dungMan(phieu({ bankName: 'VIETTINBANK' }), 'pending', SUA_DUOC);

    expect(oBank().textContent).toContain('VietinBank');
    expect(nutLuu()).toBeNull();
  });

  it('dữ liệu cũ không nhận diện được thì GIỮ NGUYÊN trên màn để người dùng chọn lại', () => {
    dungMan(phieu({ bankName: 'NH TMCP SO 1 CN Q7' }), 'pending', SUA_DUOC);

    // Không âm thầm xoá trắng: chuỗi cũ phải đọc được ở đâu đó trên màn.
    expect(chuTrenMan()).toContain('NH TMCP SO 1 CN Q7');
    expect(nutLuu()).toBeNull();                      // giữ nguyên ≠ đã sửa
    expect(anhQR()).toBeNull();
    expect(chuTrenMan()).toMatch(/không khớp danh mục/i);
  });

  it('phiếu không có ngân hàng: chỉ đường bổ sung, không dựng QR, không coi là đã sửa', () => {
    dungMan(phieu({ bankName: null }), 'pending', SUA_DUOC);

    expect(nutLuu()).toBeNull();
    expect(anhQR()).toBeNull();
    expect(chuTrenMan()).toMatch(/chưa có ngân hàng/i);
  });

  it('thiếu số tài khoản thì nói đúng thứ còn thiếu, không đổ lỗi cho ngân hàng', () => {
    dungMan(phieu({ bankAccount: null }), 'pending', SUA_DUOC);

    expect(anhQR()).toBeNull();
    expect(chuTrenMan()).toMatch(/chưa có số tài khoản/i);
  });

  // ── Làn Chờ duyệt: sửa xong mà chưa lưu thì KHÔNG được duyệt/chi ──────────

  it('làn Chờ duyệt sửa thông tin rồi duyệt/chi: chặn cho tới khi lưu, và lưu patch THƯA', async () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    fireEvent.change(oStk(), { target: { value: STK_MOI } });

    expect(nutLuu()).not.toBeNull();
    expect(nutDuyetChi()?.disabled).toBe(true);
    expect(nutDuyetChoChi()?.disabled).toBe(true);
    fireEvent.click(nutDuyetChoChi()!);
    fireEvent.click(nutDuyetChi()!);
    expect(man.actions.approve).not.toHaveBeenCalled();
    expect(man.actions.approveAndPost).not.toHaveBeenCalled();

    fireEvent.click(nutLuu()!);
    await waitFor(() => expect(man.actions.editRecipient).toHaveBeenCalledTimes(1));
    // Chỉ gửi khoá ĐÃ ĐỔI: tên và ngân hàng không đụng tới thì không có trong patch.
    expect((man.actions.editRecipient as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toEqual({ voucherId: V_A, bankAccount: STK_MOI });

    docLai(man, { bankAccount: STK_MOI });
    expect(nutLuu()).toBeNull();
    expect(nutDuyetChi()?.disabled).toBe(false);
  });

  it('lưu xong mới dựng QR, và QR mang đúng BIN/STK/tên/số tiền/mã phiếu ĐÃ LƯU', async () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    const cu = srcQR();
    expect(cu).toContain('970436-0123456789');

    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    expect(anhQR()).toBeNull();                       // chưa lưu ⇒ không có QR nào

    fireEvent.click(nutLuu()!);
    await waitFor(() => expect(man.actions.editRecipient).toHaveBeenCalledTimes(1));
    docLai(man, { bankAccount: STK_MOI });
    await waitFor(() => expect(anhQR()).not.toBeNull());

    // `sanitizeTransferText` của VietQR bỏ dấu + hạ chữ thường — giữ nguyên
    // hành vi đó, đây là hàm dùng chung đã có bộ kiểm riêng.
    const moi = srcQR()!;
    expect(moi).toContain(`970436-${STK_MOI}`);
    expect(moi).toContain(`amount=${TIEN}`);
    expect(moi).toContain('addInfo=pc2609095');
    expect(moi).toContain('accountName=nguyen+van+a');

    // Một lượt refetch nữa với CÙNG dữ liệu: QR giữ nguyên, không lại thành "đã sửa".
    docLai(man, { bankAccount: STK_MOI });
    expect(srcQR()).toBe(moi);
    expect(nutLuu()).toBeNull();
  });

  /**
   * ⚠ BÀI GHIM VIỆC BỎ ẢNH CHỤP CLIENT.
   *
   * RPC/trigger có thể ghi KHÁC thứ gửi lên (chuẩn hoá, cắt bớt). Bản cũ giữ
   * `daLuu` — ảnh chụp giá trị người dùng vừa gõ — và ưu tiên nó cho tới khi
   * đổi phiếu hoặc đóng modal, nên QR và khối chỉ-đọc in con số CLIENT trong
   * khi phiếu thật giữ con số khác, và màn hình không bao giờ tự sửa lại.
   *
   * Đây KHÔNG phải ca ghi đè liên phiên (plan §7 miễn ca đó) — chỉ có MỘT phiên,
   * và lệch sinh ra ngay trong chính lượt ghi của phiên ấy.
   */
  it('server ghi KHÁC thứ vừa gõ: không dựng QR theo bản client, màn hình tự lộ ra là chưa khớp', async () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    const GO_THUA = `${STK_MOI}0000`;

    fireEvent.change(oStk(), { target: { value: GO_THUA } });
    fireEvent.click(nutLuu()!);
    await waitFor(() => expect(man.actions.editRecipient).toHaveBeenCalledTimes(1));

    // Phiếu thật chỉ giữ 999888777. Màn phải theo con số ĐÓ.
    docLai(man, { bankAccount: STK_MOI });

    expect(anhQR()).toBeNull();                       // KHÔNG dựng QR theo bản client
    expect(chuTrenMan()).toMatch(/chưa lưu/i);        // và nói thẳng là chưa khớp
    expect(nutDuyetChi()?.disabled).toBe(true);
    // Thứ người dùng gõ vẫn còn nguyên để họ đối chiếu rồi sửa — không bị nuốt.
    expect(oStk().value).toBe(GO_THUA);
  });

  it('mở lại phiếu từ đầu vẫn ra đúng QR đã lưu', () => {
    dungMan(phieu({ bankAccount: STK_MOI, bankName: 'VIETTINBANK' }), 'pending', SUA_DUOC);
    expect(srcQR()).toContain(`970415-${STK_MOI}`);
  });

  it('draft chưa lưu KHÔNG thể bị hiểu nhầm là QR của thông tin mới', async () => {
    dungMan(phieu(), 'pending', SUA_DUOC);
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
    expect(anhQR()).not.toBeNull();

    // Sửa tài khoản NGAY KHI form chi đang mở — đúng thế kẹt của bản cũ: khối
    // Người nhận tiền và form chi cùng nằm trên một cột, sửa được song song.
    fireEvent.change(oStk(), { target: { value: STK_MOI } });

    expect(anhQR()).toBeNull();
    expect(chuTrenMan()).toMatch(/chưa lưu/i);
    expect(nutXacNhan().disabled).toBe(true);
  });

  it('lưu lỗi thì giữ nguyên form, nói lỗi, và vẫn chặn duyệt/chi', async () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    (man.actions.editRecipient as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('permission denied for function'));

    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    fireEvent.click(nutLuu()!);
    await waitFor(() => expect(chuTrenMan()).toMatch(/permission denied for function/));

    expect(oStk().value).toBe(STK_MOI);               // không nuốt mất thứ vừa gõ
    expect(nutLuu()).not.toBeNull();
    expect(anhQR()).toBeNull();
    expect(nutDuyetChi()?.disabled).toBe(true);
  });

  /**
   * Lưu hỏng rồi người dùng BỎ CUỘC, gõ lại đúng số cũ. Lúc đó draft = bản đã
   * lưu ⇒ hàng rào tiền tự mở đúng (không có gì chưa lưu cả), QR cũ về.
   *
   * ⚠ Câu lỗi phải TẮT THEO. Nó chỉ bị dọn khi lưu lần nữa hoặc đổi phiếu, nên
   * bản cũ để lại một dòng đỏ "Chưa lưu thì không duyệt/chi được" ngay cạnh
   * những cái nút vừa mở khoá — câu đó khi ấy là sai, và người đọc phải chọn
   * tin cái nút hay tin dòng chữ.
   *
   * Hàng rào tiền (`doiNguoiNhan`) KHÔNG đổi, chỉ đổi điều kiện hiện chữ.
   */
  it('lưu hỏng rồi gõ lại đúng số cũ: hết chặn thì câu lỗi cũng phải tắt theo', async () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    (man.actions.editRecipient as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('permission denied for function'));

    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    fireEvent.click(nutLuu()!);
    await waitFor(() => expect(chuTrenMan()).toMatch(/permission denied for function/));
    expect(chuTrenMan()).toMatch(/Chưa lưu thì không duyệt\/chi được/);

    // Gõ lại nguyên số cũ của phiếu.
    fireEvent.change(oStk(), { target: { value: '0123456789' } });

    expect(nutLuu()).toBeNull();                      // không còn gì để lưu
    expect(nutDuyetChi()?.disabled).toBe(false);      // hàng rào tiền mở đúng
    expect(srcQR()).toContain('970436-0123456789');   // QR cũ về
    expect(chuTrenMan()).not.toMatch(/Chưa lưu thì không duyệt\/chi được/);
    expect(chuTrenMan()).not.toMatch(/permission denied for function/);
  });

  it('bấm Lưu hai lần chỉ ghi MỘT lần', async () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    let xong: () => void = () => {};
    (man.actions.editRecipient as ReturnType<typeof vi.fn>)
      .mockImplementation(() => new Promise<void>((r) => { xong = r; }));

    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    const nut = nutLuu()!;
    fireEvent.click(nut);
    fireEvent.click(nut);
    await act(async () => { await Promise.resolve(); });

    expect(man.actions.editRecipient).toHaveBeenCalledTimes(1);
    await act(async () => { xong(); });
  });

  // ── Làn Cần rà soát: cùng một đường lưu ───────────────────────────────────

  it('làn Cần rà soát: Xác nhận & Chuyển Chờ Duyệt đi CÙNG đường lưu và cùng patch thưa', async () => {
    const man = dungMan(
      phieu({ bankAccount: null, issues: ['MISSING_PAYMENT_INFO'], hasAttachment: false, attachments: [] }),
      'review', SUA_DUOC,
    );
    expect(anhQR()).toBeNull();
    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Xác nhận & Chuyển Chờ Duyệt/ }));

    await waitFor(() => expect(man.actions.editRecipient).toHaveBeenCalledTimes(1));
    expect((man.actions.editRecipient as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toEqual({ voucherId: V_A, bankAccount: STK_MOI });
    // Lưu xong là QR dựng được NGAY TRÊN LÀN NÀY — làn Cần rà soát không có
    // form chi, nên QR phải sống ở khối Người nhận tiền mới với tới được.
    docLai(man, {
      bankAccount: STK_MOI, issues: ['MISSING_PAYMENT_INFO'],
      hasAttachment: false, attachments: [],
    });
    await waitFor(() => expect(srcQR()).toContain(`970436-${STK_MOI}`));
  });

  it('lưu lỗi ở làn Cần rà soát thì KHÔNG đóng yêu cầu bổ sung', async () => {
    const man = dungMan(
      phieu({ supplementPending: true, issues: ['SUPPLEMENT_PENDING'] }),
      'review', { editRecipient: true, markSupplementDone: true },
    );
    (man.actions.editRecipient as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('42501'));

    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Xác nhận & Chuyển Chờ Duyệt/ }));

    await waitFor(() => expect(man.actions.editRecipient).toHaveBeenCalledTimes(1));
    expect(man.actions.markSupplementDone).not.toHaveBeenCalled();
  });

  // ── Tên dễ nhầm ───────────────────────────────────────────────────────────

  it('các tên dễ nhầm ra đúng ngân hàng và đúng BIN', () => {
    for (const [tho, ten, bin] of [
      ['VIETTINBANK', 'VietinBank', '970415'],
      ['Vietcombank', 'Vietcombank', '970436'],
      ['MB', 'MB Bank', '970422'],
      ['SACOMBANK CN Q7', 'Sacombank', '970403'],
      ['Timo by Ban Viet Bank', 'Timo', '963388'],
      ['BVBank', 'BVBank (Bản Việt)', '970454'],
    ] as const) {
      dungMan(phieu({ bankName: tho }), 'pending', SUA_DUOC);
      expect(oBank().textContent, tho).toContain(ten);
      expect(srcQR(), tho).toContain(`${bin}-0123456789`);
      cleanup();
    }
  });

  // ── Ảnh QR hỏng ───────────────────────────────────────────────────────────

  it('ảnh QR tải lỗi có trạng thái lỗi và nút thử lại', async () => {
    dungMan(phieu(), 'pending', SUA_DUOC);
    fireEvent.error(anhQR()!);

    await waitFor(() => expect(chuTrenMan()).toMatch(/Không tải được ảnh QR/i));
    expect(anhQR()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Thử lại ảnh QR/ }));
    await waitFor(() => expect(anhQR()).not.toBeNull());
    expect(srcQR()).toContain('970436-0123456789');
  });

  // ── Ranh giới với các đợt trước ───────────────────────────────────────────

  it('lớp nâng z-index cho dropdown chỉ sống đúng lúc hộp thoại mở', () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    expect(document.body.classList.contains('cs-modal-mo')).toBe(true);
    man.unmount();
    expect(document.body.classList.contains('cs-modal-mo')).toBe(false);
  });

  it('phiếu ĐÃ CHI không mời chuyển khoản lần nữa', () => {
    dungMan(phieu({ status: 'paid', approvalStatus: 'APPROVED', postingStatus: 'POSTED' }), 'paid');
    expect(anhQR()).toBeNull();
  });

  it('đổi sang phiếu khác thì draft người nhận KHÔNG theo sang phiếu mới', async () => {
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    expect(nutLuu()).not.toBeNull();

    man.doiPhieu(phieu({
      key: `refund:${V_B}`, voucherId: V_B, voucherCode: 'PC2609096',
      bankAccount: '111222333', bankName: 'Sacombank', recipientName: 'Trần Thị B',
    }));

    expect(oStk().value).toBe('111222333');
    expect(oTen().value).toBe('Trần Thị B');
    expect(oBank().textContent).toContain('Sacombank');
    expect(nutLuu()).toBeNull();
    expect(srcQR()).toContain('970403-111222333');

    fireEvent.click(nutDuyetChi()!);
    await waitFor(() => expect(H.adopt).toHaveBeenCalledWith(V_B));
  });

  // ── Bắc cầu T1a (plan §3.5): lưu người nhận KHÔNG đụng vào ngày chi ───────

  it('ngày chi người dùng tự chọn GIỮ NGUYÊN sau khi lưu thông tin người nhận (T1a)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T18:00:00Z'));
    const man = dungMan(phieu(), 'pending', SUA_DUOC);
    moFormChi();
    await waitFor(() => expect(H.adopt).toHaveBeenCalledTimes(1));

    const oNgay = () => document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(oNgay(), { target: { value: '2026-09-18' } });
    fireEvent.change(oStk(), { target: { value: STK_MOI } });
    fireEvent.click(nutLuu()!);
    await waitFor(() => expect(man.actions.editRecipient).toHaveBeenCalledTimes(1));
    docLai(man, { bankAccount: STK_MOI });
    expect(nutLuu()).toBeNull();

    expect(oNgay().value).toBe('2026-09-18');
    chonSo();
    await waitFor(() => expect(nutXacNhan().disabled).toBe(false));
    fireEvent.click(nutXacNhan());
    await waitFor(() => expect(man.actions.approveAndPost).toHaveBeenCalledTimes(1));
    expect((man.actions.approveAndPost as ReturnType<typeof vi.fn>).mock.calls[0][0].postedOn)
      .toBe('2026-09-18');
  });

  /**
   * ⚠⚠ BÀI DUY NHẤT MỞ DROPDOWN THẬT — VÀ PHẢI LUÔN LÀ BÀI CUỐI FILE ⚠⚠
   *
   * Đo thật trên chính kho này (22/09/2026): mở popover Radix + cmdk với 54
   * option trong jsdom để lại thứ gì đó không dọn được — THÂN bài chỉ tốn
   * ~110 ms, nhưng thời gian vitest tính cho bài đó và cho MỌI bài chạy sau nó
   * tăng dần: lần mở 1 ≈ 1,6 s · lần 2 ≈ 11 s · lần 3 ≈ 16 s, và một bài KHÔNG
   * hề mở dropdown chạy sau ba lần đó cũng mất 18 s. DOM sạch sau `cleanup()`
   * (3 node, body rỗng) nên đây không phải rò node DOM.
   *
   * Vì thế: gộp mọi thứ cần dropdown thật vào ĐÚNG một bài, đặt cuối file để
   * không bài nào khác phải trả giá, và cho hạn giờ riêng. Thêm một bài mở
   * dropdown nữa là kéo cả file vào vùng hay đỏ giả vì quá 5 giây.
   *
   * Không hạ xuống mock: đây là chỗ DUY NHẤT chứng minh dropdown dùng chung
   * thật sự dựng ra ngoài modal, tìm được theo alias, chọn được bằng chuột và
   * bàn phím, không đóng modal, và ghi xuống đúng `shortName`.
   *
   * KHÔNG chứng minh được ở đây (jsdom không có bố cục thật): dropdown có bị
   * che/cắt không, và bề ngang điện thoại. Phải kiểm bằng trình duyệt thật.
   */
  it('dropdown thật: portal ngoài modal, tìm theo alias, chuột và bàn phím, không đóng modal', async () => {
    const man = dungMan(phieu({ bankName: null }), 'pending', SUA_DUOC);

    // ── Lượt 1: chuột ────────────────────────────────────────────────────
    moBank();
    const modal = document.querySelector('.cs-modal') as HTMLElement;
    // Portal THẬT: nội dung không nằm trong modal nên không bị `overflow` cắt.
    expect(modal.contains(oTim())).toBe(false);
    // GHIM BỘ CHỌN CSS nâng z-index của dropdown (contract-settlement.css).
    // Radix chèn thêm một <div> giữa `body` và thẻ bọc popper, nên luật phải là
    // bộ chọn hậu duệ; viết thành con trực tiếp là luật chết không ai hay.
    expect(document.querySelector('body.cs-modal-mo [data-radix-popper-content-wrapper]'))
      .not.toBeNull();
    // Alias không dấu: "viettin" là lỗi chính tả phổ biến của VietinBank trong
    // dữ liệu thật — không được ra Vietcombank.
    timBank('viettin');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['VietinBank']);

    fireEvent.click(screen.getByRole('option', { name: 'VietinBank' }));
    expect(man.dong).not.toHaveBeenCalled();           // chọn option KHÔNG đóng modal
    expect(document.querySelector('.cs-modal')).not.toBeNull();
    expect(oBank().textContent).toContain('VietinBank');

    // Giá trị lưu là shortName của danh mục chung ⇒ QR ra đúng BIN VietinBank.
    fireEvent.click(nutLuu()!);
    await waitFor(() => expect(man.actions.editRecipient).toHaveBeenCalledTimes(1));
    expect((man.actions.editRecipient as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toEqual({ voucherId: V_A, bankName: 'VietinBank' });
    docLai(man, { bankName: 'VietinBank' });
    await waitFor(() => expect(srcQR()).toContain('970415-0123456789'));

    // ── Lượt 2: bàn phím ─────────────────────────────────────────────────
    moBank();
    timBank('viet');
    const ds = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(ds.length).toBeGreaterThan(1);
    fireEvent.keyDown(oTim(), { key: 'ArrowDown' });
    fireEvent.keyDown(oTim(), { key: 'Enter' });
    expect(oBank().textContent).toContain(ds[1]);      // mũi tên xuống đổi được lựa chọn
    expect(man.dong).not.toHaveBeenCalled();
  }, 120_000);
});
