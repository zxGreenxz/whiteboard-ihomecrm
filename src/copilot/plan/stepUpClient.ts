// Máy trạm STEP-UP PIN (G5-A) — xác thực PIN, phát/tiêu token, đặt PIN, đọc
// trạng thái, mở khoá người khác. Đây là điểm nối #3 của Mức 3: một kế hoạch
// L5 dưới trần L5 cần một lớp xác thực THỨ HAI trước khi
// `copilot_plan_approve_v1` chịu duyệt.
//
// BA ĐIỀU PHẢI ĐỌC TRƯỚC KHI SỬA FILE NÀY
//
//   1. `supabase.rpc` KHÔNG BAO GIỜ NÉM — cùng luật với `planClient.ts`. NĂM
//      RPC ở đây đi HAI đường lỗi khác nhau, và `docKetQua` phải đọc CẢ HAI
//      (cùng khuôn `docPhanHoi` của `planClient.ts`):
//        (a) RAISE thuần — pre-write, không hàng nào bị đụng (unauthenticated,
//            organization_required, not_permitted, pin_not_set, pin_format,
//            pin_weak, step_up_superadmin_only, reason_required…). Lỗi về
//            trong `error.message`.
//        (b) GHI-RỒI-RETURN — nhánh có UPDATE/ledger đứng trước (khoá PIN,
//            đếm lần sai). Trả `{ok:false, error_code, attempts_left?,
//            seconds_left?}` trong `data`. Fix round 1 (F1): bản trước RAISE
//            NGAY SAU một UPDATE trong CÙNG giao dịch — Postgres cuộn ngược
//            UPDATE đó theo RAISE, nên khoá PIN không bao giờ được ghi xuống
//            đĩa. `copilot_step_up_verify_v1`/`copilot_step_up_set_pin_v1`
//            giờ RETURN thay vì RAISE cho hai nhánh này; KHÔNG còn số nào
//            nhúng trong chuỗi `error.message` (không còn `pin_invalid:<n>`
//            kiểu cũ) — số lần còn lại/giây khoá nay là TRƯỜNG jsonb riêng.
//
//   2. TOKEN KHÔNG BAO GIỜ RA KHỎI ĐÂY THEO ĐƯỜNG CHUỖI CHO MÔ HÌNH. Server
//      phát nó ĐÚNG MỘT LẦN trong kết quả của `copilot_step_up_verify_v1`;
//      `xacThucPin` cất thẳng vào `confirmationStore` (bộ nhớ, loại `step_up`)
//      và KHÔNG trả token ra ngoài hàm — nơi gọi (`KeHoachCard`) chỉ biết
//      "đã xác thực xong hay chưa", không cầm token trong tay. Muốn dùng token
//      để duyệt kế hoạch phải gọi `tieuTokenStepUp`, hàm lấy-và-xoá trong MỘT
//      bước — cùng kỷ luật với `tieuXacNhan` cho nonce cấp kế hoạch.
//
//   3. `copilot_step_up_set_pin_v1`/`copilot_step_up_unlock_v1` PHẢI gọi TỪ
//      ĐÂY, không phải từ `hanhDongCopilot.ts` (Fix round 1, F4). Cả hai nằm
//      trong `rpcAllowlist` của `check-copilot-forbidden-actions.mjs`, và
//      `SCAN_ROOTS` của gate đó chỉ soi `src/copilot/tools/` +
//      `src/copilot/plan/` — đặt lời gọi RPC ở `src/copilot/admin/` là đặt nó
//      ngoài tầm soi, khiến allowlist không đo được gì (một allowlist trỏ vào
//      file không thật sự gọi RPC là allowlist chết). `HanhDongTab.tsx` import
//      `moKhoaPinStepUp` từ ĐÂY; `hanhDongCopilot.ts` chỉ còn giữ phần THUẦN
//      (đọc sổ, đổi chính sách) không liên quan PIN.
import { supabase } from '@/integrations/supabase/client';

import { dienGiaiLoiKeHoach } from '../chatErrors';
import { datXacNhanDangCho, tieuXacNhan } from '../confirmationStore';

/** `tool` của token step-up trong `confirmationStore` — không đổi được. */
const TOOL_STEP_UP = 'step_up';

/** Khoá tra token step-up của MỘT tổ chức trong `confirmationStore`. */
export function khoaYStepUp(organizationId: string): string {
  return `step_up:${organizationId}`;
}

function laBan(gt: unknown): Record<string, unknown> | null {
  return gt && typeof gt === 'object' && !Array.isArray(gt) ? (gt as Record<string, unknown>) : null;
}

function chuoi(gt: unknown): string | null {
  return typeof gt === 'string' && gt.length > 0 ? gt : null;
}

function so(gt: unknown): number | null {
  if (typeof gt === 'number') return Number.isFinite(gt) ? gt : null;
  if (typeof gt !== 'string' || gt.trim() === '') return null;
  const n = Number(gt);
  return Number.isFinite(n) ? n : null;
}

interface KetQuaRpc {
  ok: boolean;
  ma: string | null;
  soLanConLai: number | null;
  khoaConGiay: number | null;
  thongBao: string | null;
  ban: Record<string, unknown> | null;
}

/**
 * Đọc `{ data, error }` của năm RPC step-up — hai đường lỗi (xem quyết định 1
 * ở đầu file): RAISE thuần (`error`) và GHI-RỒI-RETURN (`data.ok === false`).
 * Đường thứ hai KHÔNG còn số nhúng trong chuỗi (Fix round 1) — `attempts_left`/
 * `seconds_left` là trường jsonb riêng, đọc thẳng, không cần tách chuỗi.
 */
function docKetQua(data: unknown, error: { message?: string } | null): KetQuaRpc {
  if (error) {
    const raw = (error.message ?? String(error)).trim();
    return {
      ok: false,
      ma: raw || null,
      soLanConLai: null,
      khoaConGiay: null,
      thongBao: dienGiaiLoiKeHoach(raw),
      ban: null,
    };
  }
  const ban = laBan(data);
  if (ban && ban.ok === false) {
    const ma = chuoi(ban.error_code);
    return {
      ok: false,
      ma,
      soLanConLai: so(ban.attempts_left),
      khoaConGiay: so(ban.seconds_left),
      thongBao: dienGiaiLoiKeHoach(ma ?? 'phan_hoi_khong_doc_duoc'),
      ban: null,
    };
  }
  return { ok: true, ma: null, soLanConLai: null, khoaConGiay: null, thongBao: null, ban };
}

export interface KetQuaXacThucPin {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  /** Số lần thử còn lại TRƯỚC lần khoá kế tiếp — trường `attempts_left` của RETURN. */
  soLanConLai: number | null;
  /** Số giây còn lại của lần khoá hiện tại — trường `seconds_left` của RETURN. */
  khoaConGiay: number | null;
}

/**
 * Xác thực PIN, phát token và cất NGAY vào `confirmationStore` — không trả
 * token ra ngoài. Gọi `tieuTokenStepUp(organizationId)` ngay trước khi duyệt
 * kế hoạch để lấy-và-xoá nó.
 */
export async function xacThucPin(pin: string, organizationId: string): Promise<KetQuaXacThucPin> {
  const { data, error } = await supabase.rpc('copilot_step_up_verify_v1', {
    p_pin: pin,
    p_organization_id: organizationId,
  });
  const kq = docKetQua(data, error);
  if (!kq.ok) {
    return { ok: false, maLoi: kq.ma, thongBao: kq.thongBao, soLanConLai: kq.soLanConLai, khoaConGiay: kq.khoaConGiay };
  }
  const token = chuoi(kq.ban?.step_up_token);
  const hetHan = chuoi(kq.ban?.expires_at);
  if (!token) {
    return {
      ok: false,
      maLoi: 'phan_hoi_khong_doc_duoc',
      thongBao: 'Server trả về hình dạng không đọc được.',
      soLanConLai: null,
      khoaConGiay: null,
    };
  }
  const conLai = hetHan ? new Date(hetHan).getTime() - Date.now() : 5 * 60_000;
  datXacNhanDangCho(
    {
      kind: 'step_up',
      tool: TOOL_STEP_UP,
      nonce: token,
      canonical: null,
      preview: {},
      intentKey: khoaYStepUp(organizationId),
      organizationId,
    },
    Math.max(conLai, 1000),
  );
  return { ok: true, maLoi: null, thongBao: null, soLanConLai: null, khoaConGiay: null };
}

/**
 * Lấy-và-xoá token step-up của một tổ chức. `null` = chưa xác thực hoặc token
 * đã hết hạn/đã dùng — nơi gọi phải mở lại modal PIN, không được coi im lặng
 * là "không cần token".
 */
export function tieuTokenStepUp(organizationId: string): string | null {
  const x = tieuXacNhan(Date.now(), khoaYStepUp(organizationId), undefined, 'step_up');
  return x ? x.nonce : null;
}

export interface KetQuaDatPin {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  updatedAt: string | null;
  /** Đang khoá (do gõ sai PIN cũ nhiều lần) — trường `seconds_left` khi có. */
  khoaConGiay: number | null;
}

/**
 * Đặt/đổi PIN của CHÍNH người gọi. Chỉ super admin (v1).
 *
 * BẮT BUỘC re-auth `supabase.auth.signInWithPassword` NGAY TRƯỚC khi gọi hàm
 * này — RPC không kiểm được điều đó (không có cách nào từ trong Postgres biết
 * phiên vừa được làm mới bằng mật khẩu), nên đây là ranh giới CLIENT. Nơi gọi
 * (thẻ PIN trong trang quản trị) phải tự thực hiện bước đó trước.
 */
export async function datPin(pin: string, currentPin?: string): Promise<KetQuaDatPin> {
  const { data, error } = await supabase.rpc('copilot_step_up_set_pin_v1', {
    p_pin: pin,
    ...(currentPin ? { p_current_pin: currentPin } : {}),
  });
  const kq = docKetQua(data, error);
  if (!kq.ok) {
    return { ok: false, maLoi: kq.ma, thongBao: kq.thongBao, updatedAt: null, khoaConGiay: kq.khoaConGiay };
  }
  return { ok: true, maLoi: null, thongBao: null, updatedAt: chuoi(kq.ban?.updated_at), khoaConGiay: null };
}

export interface TrangThaiPin {
  daDat: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
}

export interface KetQuaTrangThaiPin {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  trangThai: TrangThaiPin | null;
}

/** Trạng thái PIN của CHÍNH người gọi — không tham số, không đọc được của người khác. */
export async function trangThaiPin(): Promise<KetQuaTrangThaiPin> {
  const { data, error } = await supabase.rpc('copilot_step_up_status_v1');
  const kq = docKetQua(data, error);
  if (!kq.ok) return { ok: false, maLoi: kq.ma, thongBao: kq.thongBao, trangThai: null };
  const ban = kq.ban ?? {};
  return {
    ok: true,
    maLoi: null,
    thongBao: null,
    trangThai: {
      daDat: ban.da_dat === true,
      lockedUntil: chuoi(ban.locked_until),
      failedAttempts: so(ban.failed_attempts) ?? 0,
    },
  };
}

export interface KetQuaMoKhoaPin {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  daMoKhoa: boolean;
  userId: string | null;
}

/**
 * Mở khoá PIN step-up của MỘT người dùng khác. Chỉ super admin, bắt buộc lý
 * do >= 3 ký tự. Gọi RPC TỪ ĐÂY, không từ `hanhDongCopilot.ts` — xem quyết
 * định 3 ở đầu file.
 */
export async function moKhoaPinStepUp(userId: string, reason: string): Promise<KetQuaMoKhoaPin> {
  const { data, error } = await supabase.rpc('copilot_step_up_unlock_v1', {
    p_user_id: userId,
    p_reason: reason,
  });
  const kq = docKetQua(data, error);
  if (!kq.ok) return { ok: false, maLoi: kq.ma, thongBao: kq.thongBao, daMoKhoa: false, userId: null };
  const ban = kq.ban ?? {};
  return {
    ok: true,
    maLoi: null,
    thongBao: null,
    daMoKhoa: ban.da_mo_khoa === true,
    userId: chuoi(ban.user_id),
  };
}

export interface KetQuaResetPin {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  daReset: boolean;
}

/**
 * XOÁ HẲN PIN step-up của MỘT người dùng khác (khác `moKhoaPinStepUp` — hàm
 * đó chỉ mở khoá đếm/lock, giữ nguyên PIN). Dùng khi PIN đã MẤT: người đó
 * không thể tự đổi PIN qua `datPin` vì luồng đó luôn đòi PIN cũ khớp trước
 * khi ghi đè. Chỉ super admin, bắt buộc lý do >= 3 ký tự. Gọi RPC TỪ ĐÂY,
 * không từ `hanhDongCopilot.ts` — xem quyết định 3 ở đầu file.
 */
export async function resetPinStepUp(userId: string, reason: string): Promise<KetQuaResetPin> {
  const { data, error } = await supabase.rpc('copilot_step_up_reset_pin_v1', {
    p_user_id: userId,
    p_reason: reason,
  });
  const kq = docKetQua(data, error);
  if (!kq.ok) return { ok: false, maLoi: kq.ma, thongBao: kq.thongBao, daReset: false };
  const ban = kq.ban ?? {};
  return {
    ok: true,
    maLoi: null,
    thongBao: null,
    daReset: ban.da_reset === true,
  };
}
