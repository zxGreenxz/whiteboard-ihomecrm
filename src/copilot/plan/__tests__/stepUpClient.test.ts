// Máy trạm step-up PIN (G5-A) — ba điều được đo:
//
//   1. `supabase.rpc` KHÔNG BAO GIỜ NÉM: mọi test mock `{ data, error }` của
//      một promise ĐÃ FULFIL, không `mockRejectedValue` (xem chú thích đầu
//      `planClient.ts` — `mockRejectedValue` ở đây là một màu xanh giả).
//   2. Token step-up KHÔNG BAO GIỜ RA KHỎI `xacThucPin` theo đường chuỗi — nó
//      chỉ nằm trong `confirmationStore`, lấy ra được đúng một lần bằng
//      `tieuTokenStepUp`.
//   3. Số lần thử còn lại / số giây khoá được TÁCH ra từ thông điệp RAISE
//      (`pin_invalid:3`, `pin_locked:45`) chứ không phải đoán.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

const { datPin, khoaYStepUp, tieuTokenStepUp, trangThaiPin, xacThucPin } = await import('../stepUpClient');
const { datNguCanhXacNhan, layXacNhanDangCho, xoaXacNhanDangCho } = await import('../../confirmationStore');

const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const TOKEN = 'f'.repeat(64);

beforeEach(() => {
  rpc.mockReset();
  xoaXacNhanDangCho();
  datNguCanhXacNhan({ organizationId: ORG, threadId: null, generation: undefined });
});

describe('xacThucPin — thành công: token cất vào confirmationStore, KHÔNG trả ra ngoài', () => {
  it('gọi đúng RPC với p_pin/p_organization_id', async () => {
    rpc.mockResolvedValueOnce({ data: { step_up_token: TOKEN, expires_at: new Date(Date.now() + 300_000).toISOString() }, error: null });
    await xacThucPin('1357', ORG);
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_verify_v1', { p_pin: '1357', p_organization_id: ORG });
  });

  it('ok: true, và KHÔNG trường nào của kết quả trả về mang token', async () => {
    rpc.mockResolvedValueOnce({ data: { step_up_token: TOKEN, expires_at: new Date(Date.now() + 300_000).toISOString() }, error: null });
    const kq = await xacThucPin('1357', ORG);
    expect(kq.ok).toBe(true);
    expect(JSON.stringify(kq)).not.toContain(TOKEN);
  });

  it('token nằm trong khe `step_up` của confirmationStore, lấy ra được đúng một lần', async () => {
    rpc.mockResolvedValueOnce({ data: { step_up_token: TOKEN, expires_at: new Date(Date.now() + 300_000).toISOString() }, error: null });
    await xacThucPin('1357', ORG);
    expect(layXacNhanDangCho(Date.now(), khoaYStepUp(ORG), undefined, 'step_up')?.nonce).toBe(TOKEN);
    expect(tieuTokenStepUp(ORG)).toBe(TOKEN);
    // Đã tiêu — lần thứ hai phải rỗng.
    expect(tieuTokenStepUp(ORG)).toBeNull();
  });

  it('phản hồi thiếu step_up_token thì KHÔNG cất gì và báo lỗi đọc được hình dạng', async () => {
    rpc.mockResolvedValueOnce({ data: { khong_dung: true }, error: null });
    const kq = await xacThucPin('1357', ORG);
    expect(kq.ok).toBe(false);
    expect(tieuTokenStepUp(ORG)).toBeNull();
  });
});

describe('xacThucPin — ba tầng lỗi tách biệt', () => {
  it('sai PIN: pin_invalid:<n> → maLoi pin_invalid, soLanConLai = n, khoaConGiay = null', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'pin_invalid:3' } });
    const kq = await xacThucPin('0000', ORG);
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_invalid');
    expect(kq.soLanConLai).toBe(3);
    expect(kq.khoaConGiay).toBeNull();
    expect(kq.thongBao).toContain('PIN không đúng');
  });

  it('đang khoá: pin_locked:<n> → maLoi pin_locked, khoaConGiay = n, soLanConLai = null', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'pin_locked:45' } });
    const kq = await xacThucPin('1234', ORG);
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_locked');
    expect(kq.khoaConGiay).toBe(45);
    expect(kq.soLanConLai).toBeNull();
  });

  it('chưa từng đặt PIN: pin_not_set → không số nào đi kèm', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'pin_not_set' } });
    const kq = await xacThucPin('1234', ORG);
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_not_set');
    expect(kq.soLanConLai).toBeNull();
    expect(kq.khoaConGiay).toBeNull();
  });

  it('không thuộc tổ chức: not_permitted', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'not_permitted' } });
    const kq = await xacThucPin('1234', ORG);
    expect(kq.maLoi).toBe('not_permitted');
  });
});

describe('tieuTokenStepUp — không có gì trong khe thì trả null, không ném', () => {
  it('khe rỗng ⇒ null', () => {
    expect(tieuTokenStepUp(ORG)).toBeNull();
  });
});

describe('datPin', () => {
  it('không có PIN cũ: KHÔNG gửi p_current_pin', async () => {
    rpc.mockResolvedValueOnce({ data: { da_dat: true, updated_at: '2026-09-03T00:00:00Z' }, error: null });
    await datPin('1357');
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_set_pin_v1', { p_pin: '1357' });
  });

  it('có PIN cũ: gửi kèm p_current_pin', async () => {
    rpc.mockResolvedValueOnce({ data: { da_dat: true, updated_at: '2026-09-03T00:00:00Z' }, error: null });
    await datPin('1357', '2468');
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_set_pin_v1', { p_pin: '1357', p_current_pin: '2468' });
  });

  it('thành công trả updatedAt', async () => {
    rpc.mockResolvedValueOnce({ data: { da_dat: true, updated_at: '2026-09-03T00:00:00Z' }, error: null });
    const kq = await datPin('1357');
    expect(kq.ok).toBe(true);
    expect(kq.updatedAt).toBe('2026-09-03T00:00:00Z');
  });

  it('PIN yếu: mã pin_weak, câu tiếng Việt tương ứng', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'pin_weak' } });
    const kq = await datPin('1234');
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_weak');
    expect(kq.thongBao).toContain('dễ đoán');
  });

  it('không phải super admin: mã step_up_superadmin_only', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'step_up_superadmin_only' } });
    const kq = await datPin('1357');
    expect(kq.maLoi).toBe('step_up_superadmin_only');
  });
});

describe('trangThaiPin', () => {
  it('chưa đặt PIN', async () => {
    rpc.mockResolvedValueOnce({ data: { da_dat: false, locked_until: null, failed_attempts: 0 }, error: null });
    const kq = await trangThaiPin();
    expect(kq.ok).toBe(true);
    expect(kq.trangThai).toEqual({ daDat: false, lockedUntil: null, failedAttempts: 0 });
  });

  it('đã đặt, đang khoá', async () => {
    rpc.mockResolvedValueOnce({
      data: { da_dat: true, locked_until: '2026-09-03T01:00:00Z', failed_attempts: 5 },
      error: null,
    });
    const kq = await trangThaiPin();
    expect(kq.trangThai).toEqual({ daDat: true, lockedUntil: '2026-09-03T01:00:00Z', failedAttempts: 5 });
  });

  it('gọi RPC không tham số', async () => {
    rpc.mockResolvedValueOnce({ data: { da_dat: false, locked_until: null, failed_attempts: 0 }, error: null });
    await trangThaiPin();
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_status_v1');
  });
});
