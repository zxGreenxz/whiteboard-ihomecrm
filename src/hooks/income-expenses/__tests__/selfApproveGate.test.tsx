// @vitest-environment jsdom
// Câu 25 (21/10/2026): web chỉ HỎI máy chủ ở hộp "Xác nhận duyệt phiếu" — khoá nút + giải thích,
// và hỏi lại NGAY TRƯỚC khi lưu đổi sổ/ảnh hay duyệt; không tự so ngưỡng/quyền.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
import {
  SELF_APPROVE_CHECK_FAILED,
  checkSelfApproveBeforeApprove,
  readSelfApproveGate,
  selfApproveBlockedMessage,
  selfApproveGateKey,
  useSelfApproveGate,
} from '../selfApproveGate';

const VOUCHER = 'voucher-1';
const blockedGate = { voucherId: VOUCHER, selfApproveBlocked: true, reason: 'ie_self_approve_over_threshold', threshold: 600000 };
const freeGate = { ...blockedGate, selfApproveBlocked: false, reason: null, threshold: null };

function moiClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}
function wrapper(client = moiClient()) {
  const Wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, Wrap };
}

afterEach(() => {
  cleanup();
  rpc.mockReset();
});

describe('readSelfApproveGate', () => {
  it('gọi đúng cổng (tên viết thẳng) với đúng phiếu và trả nguyên câu trả lời của máy chủ', async () => {
    rpc.mockResolvedValue({ data: blockedGate, error: null });
    await expect(readSelfApproveGate(VOUCHER)).resolves.toEqual(blockedGate);
    expect(rpc).toHaveBeenCalledWith('ie_self_approve_gate_v1', { p_voucher_id: VOUCHER });
  });

  it('câu trả lời về phiếu khác hoặc sai hình ⇒ lỗi, không đoán', async () => {
    rpc.mockResolvedValue({ data: { ...blockedGate, voucherId: 'khac' }, error: null });
    await expect(readSelfApproveGate(VOUCHER)).rejects.toBeInstanceOf(TypeError);
    rpc.mockResolvedValue({ data: { selfApproveBlocked: 'true' }, error: null });
    await expect(readSelfApproveGate(VOUCHER)).rejects.toThrow();
  });

  it('lỗi máy chủ giữ nguyên mã', async () => {
    const error = { code: '42501', message: 'Chưa đăng nhập' };
    rpc.mockResolvedValue({ data: null, error });
    await expect(readSelfApproveGate(VOUCHER)).rejects.toBe(error);
  });
});

describe('selfApproveBlockedMessage', () => {
  it('nói rõ ngưỡng do máy chủ trả và vì sao không tự duyệt được', () => {
    expect(selfApproveBlockedMessage(600000)).toBe(
      'Phiếu chi từ 600.000 đ trở lên cần người có quyền duyệt thu chi duyệt. Bạn là người lập phiếu nên không tự duyệt được.',
    );
    expect(selfApproveBlockedMessage(null)).toContain('từ ngưỡng tự duyệt trở lên');
  });
});

describe('useSelfApproveGate (hiển thị trong hộp xác nhận)', () => {
  it('không hỏi khi hộp chưa mở (enabled=false) hoặc chưa có phiếu', async () => {
    const { Wrap } = wrapper();
    const a = renderHook(() => useSelfApproveGate(VOUCHER, false), { wrapper: Wrap });
    const b = renderHook(() => useSelfApproveGate(null, true), { wrapper: Wrap });
    expect(a.result.current).toEqual({ blocked: false, message: null });
    expect(b.result.current).toEqual({ blocked: false, message: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('máy chủ báo chặn ⇒ khoá kèm câu giải thích', async () => {
    rpc.mockResolvedValue({ data: blockedGate, error: null });
    const { Wrap } = wrapper();
    const { result } = renderHook(() => useSelfApproveGate(VOUCHER, true), { wrapper: Wrap });
    await waitFor(() => expect(result.current.blocked).toBe(true));
    expect(result.current.message).toBe(selfApproveBlockedMessage(600000));
  });

  it('máy chủ không chặn, hoặc đọc cổng lỗi ⇒ không khoá (bước kiểm trước khi lưu mới là chốt)', async () => {
    rpc.mockResolvedValueOnce({ data: freeGate, error: null });
    const ok = wrapper();
    const free = renderHook(() => useSelfApproveGate(VOUCHER, true), { wrapper: ok.Wrap });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(free.result.current).toEqual({ blocked: false, message: null });

    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const loi = wrapper();
    const broken = renderHook(() => useSelfApproveGate('voucher-2', true), { wrapper: loi.Wrap });
    await waitFor(() => expect(loi.client.getQueryState(selfApproveGateKey('voucher-2'))?.status).toBe('error'));
    expect(broken.result.current).toEqual({ blocked: false, message: null });
  });
});

describe('checkSelfApproveBeforeApprove (ngay trước khi lưu/duyệt)', () => {
  it('bị chặn ⇒ ok=false, reason=blocked; câu trả lời vào cache nên hộp đang mở tự hiện ghi chú', async () => {
    rpc.mockResolvedValueOnce({ data: freeGate, error: null });
    const client = moiClient();
    const { Wrap } = wrapper(client);
    const { result } = renderHook(() => useSelfApproveGate(VOUCHER, true), { wrapper: Wrap });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(result.current.blocked).toBe(false);
    // Phiếu vừa bị sửa lên quá ngưỡng sau khi hộp đã mở: bước kiểm trước khi lưu hỏi LẠI máy chủ.
    rpc.mockResolvedValueOnce({ data: blockedGate, error: null });
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toEqual({
      ok: false, reason: 'blocked', message: selfApproveBlockedMessage(600000),
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.blocked).toBe(true));
  });

  it('không chặn ⇒ ok=true; luôn hỏi mới, không dùng câu trả lời đã nhớ', async () => {
    const client = moiClient();
    rpc.mockResolvedValue({ data: freeGate, error: null });
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toEqual({ ok: true, reason: null, message: null });
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toEqual({ ok: true, reason: null, message: null });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('máy chủ chưa có hàm cổng (migration chưa áp) ⇒ ok=true: writer vẫn tự chặn', async () => {
    const client = moiClient();
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toEqual({ ok: true, reason: null, message: null });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'function does not exist' } });
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toEqual({ ok: true, reason: null, message: null });
  });

  it('lỗi khác (mạng, quyền, sai hình) ⇒ chưa biết thì chưa lưu: ok=false, reason=unverified', async () => {
    const client = moiClient();
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toEqual({
      ok: false, reason: 'unverified', message: SELF_APPROVE_CHECK_FAILED,
    });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Chưa đăng nhập' } });
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toMatchObject({ ok: false, reason: 'unverified' });
    rpc.mockResolvedValueOnce({ data: { ...blockedGate, voucherId: 'khac' }, error: null });
    await expect(checkSelfApproveBeforeApprove(client, VOUCHER)).resolves.toMatchObject({ ok: false, reason: 'unverified' });
  });
});
