// Máy trạm step-up PIN (G5-A) — bốn điều được đo:
//
//   1. `supabase.rpc` KHÔNG BAO GIỜ NÉM: mọi test mock `{ data, error }` của
//      một promise ĐÃ FULFIL, không `mockRejectedValue` (xem chú thích đầu
//      `planClient.ts` — `mockRejectedValue` ở đây là một màu xanh giả).
//   2. Token step-up KHÔNG BAO GIỜ RA KHỎI `xacThucPin` theo đường chuỗi — nó
//      chỉ nằm trong `confirmationStore`, lấy ra được đúng một lần bằng
//      `tieuTokenStepUp`.
//   3. HAI đường lỗi (Fix round 1). RAISE thuần (`error.message`, không hàng
//      nào bị đụng) và GHI-RỒI-RETURN (`data.ok === false`, có
//      `attempts_left`/`seconds_left` là TRƯỜNG jsonb riêng — không còn số
//      nhúng trong chuỗi kiểu `pin_invalid:3` như bản trước F1). `docKetQua`
//      phải đọc đúng CẢ HAI, không chỉ một.
//   4. `copilot_step_up_set_pin_v1`/`copilot_step_up_unlock_v1` PHẢI được gọi
//      TỪ FILE NÀY (Fix round 1, F4) — đây là điều `rpcAllowlist` của
//      `check-copilot-forbidden-actions.mjs` đòi, và gate đó chỉ soi
//      `src/copilot/plan/`, không soi `src/copilot/admin/`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

const { datPin, khoaYStepUp, moKhoaPinStepUp, tieuTokenStepUp, trangThaiPin, xacThucPin } =
  await import('../stepUpClient');
const { datNguCanhXacNhan, layXacNhanDangCho, xoaXacNhanDangCho } = await import('../../confirmationStore');

const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const TOKEN = 'f'.repeat(64);
const USER_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  rpc.mockReset();
  xoaXacNhanDangCho();
  datNguCanhXacNhan({ organizationId: ORG, threadId: null, generation: undefined });
});

describe('xacThucPin — thành công: token cất vào confirmationStore, KHÔNG trả ra ngoài', () => {
  it('gọi đúng RPC với p_pin/p_organization_id', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, step_up_token: TOKEN, expires_at: new Date(Date.now() + 300_000).toISOString() },
      error: null,
    });
    await xacThucPin('1357', ORG);
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_verify_v1', { p_pin: '1357', p_organization_id: ORG });
  });

  it('ok: true, và KHÔNG trường nào của kết quả trả về mang token', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, step_up_token: TOKEN, expires_at: new Date(Date.now() + 300_000).toISOString() },
      error: null,
    });
    const kq = await xacThucPin('1357', ORG);
    expect(kq.ok).toBe(true);
    expect(JSON.stringify(kq)).not.toContain(TOKEN);
  });

  it('token nằm trong khe `step_up` của confirmationStore, lấy ra được đúng một lần', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, step_up_token: TOKEN, expires_at: new Date(Date.now() + 300_000).toISOString() },
      error: null,
    });
    await xacThucPin('1357', ORG);
    expect(layXacNhanDangCho(Date.now(), khoaYStepUp(ORG), undefined, 'step_up')?.nonce).toBe(TOKEN);
    expect(tieuTokenStepUp(ORG)).toBe(TOKEN);
    // Đã tiêu — lần thứ hai phải rỗng.
    expect(tieuTokenStepUp(ORG)).toBeNull();
  });

  it('phản hồi thiếu step_up_token thì KHÔNG cất gì và báo lỗi đọc được hình dạng', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, khong_dung: true }, error: null });
    const kq = await xacThucPin('1357', ORG);
    expect(kq.ok).toBe(false);
    expect(tieuTokenStepUp(ORG)).toBeNull();
  });
});

describe('xacThucPin — hai đường lỗi tách biệt (Fix round 1)', () => {
  it('RAISE thuần (pre-write): unauthenticated/organization_required/not_permitted/pin_not_set → maLoi = mã, KHÔNG số nào đi kèm', async () => {
    for (const ma of ['unauthenticated', 'organization_required', 'not_permitted', 'pin_not_set']) {
      rpc.mockResolvedValueOnce({ data: null, error: { message: ma } });
      const kq = await xacThucPin('1234', ORG);
      expect(kq.ok, ma).toBe(false);
      expect(kq.maLoi, ma).toBe(ma);
      expect(kq.soLanConLai, ma).toBeNull();
      expect(kq.khoaConGiay, ma).toBeNull();
    }
  });

  it('GHI-RỒI-RETURN: sai PIN → data.ok=false, error_code=pin_invalid, attempts_left là TRƯỜNG số (không phải chuỗi nhúng)', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, error_code: 'pin_invalid', attempts_left: 3 }, error: null });
    const kq = await xacThucPin('0000', ORG);
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_invalid');
    expect(kq.soLanConLai).toBe(3);
    expect(kq.khoaConGiay).toBeNull();
    expect(kq.thongBao).toContain('PIN không đúng');
  });

  it('GHI-RỒI-RETURN: đang khoá → data.ok=false, error_code=pin_locked, seconds_left là TRƯỜNG số', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, error_code: 'pin_locked', seconds_left: 45 }, error: null });
    const kq = await xacThucPin('1234', ORG);
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_locked');
    expect(kq.khoaConGiay).toBe(45);
    expect(kq.soLanConLai).toBeNull();
  });

  it('KHÔNG còn đọc chuỗi kiểu pin_invalid:<n> qua error.message — đó là hình dạng CŨ trước Fix round 1', async () => {
    // Nếu server (do lỗi tái phát) lại RAISE 'pin_invalid:3' thay vì RETURN,
    // client phải đọc nó như MỘT MÃ TRẦN qua nhánh RAISE (không tách số nữa) —
    // không được ngầm hiểu số 3 là attempts_left, vì đó là hành vi ĐÃ NGỪNG.
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'pin_invalid:3' } });
    const kq = await xacThucPin('0000', ORG);
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_invalid:3');
    expect(kq.soLanConLai).toBeNull();
  });
});

describe('tieuTokenStepUp — không có gì trong khe thì trả null, không ném', () => {
  it('khe rỗng ⇒ null', () => {
    expect(tieuTokenStepUp(ORG)).toBeNull();
  });
});

describe('datPin', () => {
  it('không có PIN cũ: KHÔNG gửi p_current_pin', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, da_dat: true, updated_at: '2026-09-03T00:00:00Z' }, error: null });
    await datPin('1357');
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_set_pin_v1', { p_pin: '1357' });
  });

  it('có PIN cũ: gửi kèm p_current_pin', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, da_dat: true, updated_at: '2026-09-03T00:00:00Z' }, error: null });
    await datPin('1357', '2468');
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_set_pin_v1', { p_pin: '1357', p_current_pin: '2468' });
  });

  it('thành công trả updatedAt', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, da_dat: true, updated_at: '2026-09-03T00:00:00Z' }, error: null });
    const kq = await datPin('1357');
    expect(kq.ok).toBe(true);
    expect(kq.updatedAt).toBe('2026-09-03T00:00:00Z');
  });

  it('PIN yếu (RAISE, pre-write): mã pin_weak, câu tiếng Việt tương ứng', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'pin_weak' } });
    const kq = await datPin('1234');
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_weak');
    expect(kq.thongBao).toContain('dễ đoán');
  });

  it('không phải super admin (RAISE, pre-write): mã step_up_superadmin_only', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'step_up_superadmin_only' } });
    const kq = await datPin('1357');
    expect(kq.maLoi).toBe('step_up_superadmin_only');
  });

  it('PIN cũ sai (GHI-RỒI-RETURN qua helper dùng chung, Fix round 1 F2): data.ok=false, pin_invalid, attempts_left là số', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, error_code: 'pin_invalid', attempts_left: 4 }, error: null });
    const kq = await datPin('1357', '0000');
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_invalid');
  });

  it('đang khoá do đổi PIN sai nhiều lần: data.ok=false, pin_locked, khoaConGiay là số', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, error_code: 'pin_locked', seconds_left: 900 }, error: null });
    const kq = await datPin('1357', '0000');
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('pin_locked');
    expect(kq.khoaConGiay).toBe(900);
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

describe('moKhoaPinStepUp (Fix round 1, F4 — RPC PHẢI gọi từ file này)', () => {
  it('gọi đúng RPC copilot_step_up_unlock_v1 với p_user_id/p_reason', async () => {
    rpc.mockResolvedValueOnce({ data: { da_mo_khoa: true, user_id: USER_ID }, error: null });
    const kq = await moKhoaPinStepUp(USER_ID, 'người dùng báo bị khoá nhầm');
    expect(rpc).toHaveBeenCalledWith('copilot_step_up_unlock_v1', {
      p_user_id: USER_ID,
      p_reason: 'người dùng báo bị khoá nhầm',
    });
    expect(kq.ok).toBe(true);
    expect(kq.daMoKhoa).toBe(true);
    expect(kq.userId).toBe(USER_ID);
  });

  it('server RAISE lỗi ⇒ KHÔNG ném (cùng luật supabase.rpc), trả ok:false với câu tiếng Việt', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'step_up_superadmin_only' } });
    const kq = await moKhoaPinStepUp(USER_ID, 'lý do');
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('step_up_superadmin_only');
    expect(kq.thongBao).toContain('Chỉ super admin');
  });

  it('thiếu lý do (RAISE reason_required) ⇒ câu tiếng Việt đúng', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'reason_required' } });
    const kq = await moKhoaPinStepUp(USER_ID, '');
    expect(kq.maLoi).toBe('reason_required');
    expect(kq.thongBao).toContain('lý do');
  });

  it('người dùng chưa từng đặt PIN ⇒ pin_not_set', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'pin_not_set' } });
    const kq = await moKhoaPinStepUp(USER_ID, 'lý do hợp lệ');
    expect(kq.maLoi).toBe('pin_not_set');
  });
});
