// Máy trạm STEP-UP PIN (G5-A) — xác thực PIN, phát/tiêu token, đặt PIN, đọc
// trạng thái. Đây là điểm nối #3 của Mức 3: một kế hoạch L5 dưới trần L5 cần
// một lớp xác thực THỨ HAI trước khi `copilot_plan_approve_v1` chịu duyệt.
//
// HAI ĐIỀU PHẢI ĐỌC TRƯỚC KHI SỬA FILE NÀY
//
//   1. `supabase.rpc` KHÔNG BAO GIỜ NÉM — cùng luật với `planClient.ts`. Bốn
//      RPC ở đây chỉ RAISE trên mọi nhánh lỗi (không có hợp đồng `ok`/
//      `error_code` kiểu ghi-rồi-RETURN của `copilot_plan_approve_v1`), nên đọc
//      kết quả ở đây ĐƠN GIẢN hơn planClient: `error` có nghĩa là hỏng,
//      `data` có nghĩa là xong.
//
//   2. TOKEN KHÔNG BAO GIỜ RA KHỎI ĐÂY THEO ĐƯỜNG CHUỖI CHO MÔ HÌNH. Server
//      phát nó ĐÚNG MỘT LẦN trong kết quả của `copilot_step_up_verify_v1`;
//      `xacThucPin` cất thẳng vào `confirmationStore` (bộ nhớ, loại `step_up`)
//      và KHÔNG trả token ra ngoài hàm — nơi gọi (`KeHoachCard`) chỉ biết
//      "đã xác thực xong hay chưa", không cầm token trong tay. Muốn dùng token
//      để duyệt kế hoạch phải gọi `tieuTokenStepUp`, hàm lấy-và-xoá trong MỘT
//      bước — cùng kỷ luật với `tieuXacNhan` cho nonce cấp kế hoạch.
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

/**
 * Tách mã lỗi gốc khỏi số đi kèm sau dấu `:` — `pin_invalid:3` → `{ ma:
 * 'pin_invalid', so: 3 }`. Bốn RPC ở đây chỉ RAISE nên mọi lỗi đến qua
 * `error.message`, và hai mã (`pin_invalid`, `pin_locked`) mang số ngay trong
 * thông điệp thay vì một trường riêng — tách ra để giao diện hiện số, không
 * bắt người dùng tự đọc mã kỹ thuật.
 */
function tachSo(msg: string): { ma: string; so: number | null } {
  const m = /^([a-z_]+):(-?\d+)$/.exec(msg.trim());
  if (!m) return { ma: msg.trim(), so: null };
  return { ma: m[1] ?? msg.trim(), so: Number(m[2]) };
}

interface KetQuaRpc {
  ok: boolean;
  ma: string | null;
  soLanConLai: number | null;
  khoaConGiay: number | null;
  thongBao: string | null;
  ban: Record<string, unknown> | null;
}

/** Đọc `{ data, error }` của bốn RPC step-up — chúng chỉ RAISE, không có `ok`/`error_code`. */
function docKetQua(data: unknown, error: { message?: string } | null): KetQuaRpc {
  if (error) {
    const raw = (error.message ?? String(error)).trim();
    const { ma, so: soDiKem } = tachSo(raw);
    return {
      ok: false,
      ma,
      soLanConLai: ma === 'pin_invalid' ? soDiKem : null,
      khoaConGiay: ma === 'pin_locked' ? soDiKem : null,
      thongBao: dienGiaiLoiKeHoach(raw),
      ban: null,
    };
  }
  return { ok: true, ma: null, soLanConLai: null, khoaConGiay: null, thongBao: null, ban: laBan(data) };
}

export interface KetQuaXacThucPin {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  /** Từ `pin_invalid:<n>` — số lần thử còn lại TRƯỚC lần khoá kế tiếp. */
  soLanConLai: number | null;
  /** Từ `pin_locked:<n>` — số giây còn lại của lần khoá hiện tại. */
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
  if (!kq.ok) return { ok: false, maLoi: kq.ma, thongBao: kq.thongBao, updatedAt: null };
  return { ok: true, maLoi: null, thongBao: null, updatedAt: chuoi(kq.ban?.updated_at) };
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
