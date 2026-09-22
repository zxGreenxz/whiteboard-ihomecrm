// @vitest-environment jsdom
// =============================================================================
// SettlementLifecycleModal — BƯỚC GHI CHI: chứng từ.
//
// ── Hai lỗi đang sửa ────────────────────────────────────────────────────────
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
// Giả lập tới đâu: hai RPC chứng từ (`adopt…` / `useAttachPostingEvidence`),
// sổ quỹ, quyền. Phần được kiểm là NỐI DÂY thật trong modal + hàm dựng danh
// sách ảnh THẬT (`buildPostingEvidenceItems`), không phải bản dựng lại.
// =============================================================================

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000aa';

const H = vi.hoisted(() => ({
  adopt: vi.fn(),
  attach: vi.fn(),
  soCustodian: [] as { id: string; name: string }[],
  moiSo: [] as { id: string; organization_id?: string; is_virtual?: boolean }[],
}));

vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useCustodianCashbooksV2: () => ({ data: H.soCustodian }),
  useAttachPostingEvidence: () => H.attach,
  adoptVoucherAttachmentsAsEvidence: (...a: unknown[]) => H.adopt(...a),
}));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: H.moiSo }) }));
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
vi.mock('../ContractLifecycleBand', () => ({ ContractLifecycleBand: () => <div data-testid="dai" /> }));
vi.mock('../SettlementVoucherDetails', () => ({ SettlementVoucherDetails: () => <div data-testid="can-cu" /> }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { SettlementLifecycleModal } from '../SettlementLifecycleModal';
import { fmtMoney, type SettlementRow, type ViewStatus } from '@/lib/contractSettlement';
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

const dungActions = (): Actions => ({
  availabilityOf: () => ({
    approve: true, approveAndPost: true, post: true, cancel: false, cancelReason: null,
    editRecipient: false, requestSupplement: false, markSupplementDone: false,
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

function dungMan(row: SettlementRow, view: ViewStatus = 'pending'): Man {
  const actions = dungActions();
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
const chonSo = () => fireEvent.change(screen.getByRole('combobox'), { target: { value: SO_A } });
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

beforeEach(() => {
  H.adopt.mockReset().mockResolvedValue({ evidenceIds: [EV_1], skipped: [] });
  H.attach.mockReset().mockResolvedValue({
    url: ANH_2, evidenceIds: [EV_1, EV_2], skipped: [], attachedToVoucher: true,
  });
  H.soCustodian = [{ id: SO_A, name: 'Sổ tiền mặt 32PVC' }];
  H.moiSo = [{ id: SO_A, organization_id: ORG, is_virtual: false }];
});
afterEach(cleanup);

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
