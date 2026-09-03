// Lớp dữ liệu cho tab "Hành động" của trang quản trị AI Copilot.
//
// VÌ SAO TÁCH KHỎI FILE .tsx
//   Ba thứ đáng đo ở đây không cần một cái DOM nào: hình dạng dữ liệu server
//   trả về, luật CAS revision, và câu tiếng Việt cho từng mã lỗi. Nhét chúng
//   vào component nghĩa là muốn đo phải dựng React — và bộ test của repo này
//   chạy dưới `node`, không có jsdom. Cái giá của việc "để trong component" là
//   không ai đo, rồi câu lỗi `copilot_policy_stale_revision` hiện nguyên xi mã
//   SQLSTATE cho người vận hành đọc.
//
// LUẬT NỀN: `supabase.rpc` KHÔNG BAO GIỜ NÉM.
//   Lỗi mạng, 5xx, RAISE của plpgsql — tất cả về dưới dạng `{ error }` trong
//   một promise ĐÃ FULFIL. Nên mọi hàm dưới đây kiểm `error` tường minh; một
//   `try/catch` quanh lời gọi là mã chết, và `mockRejectedValue` trong test là
//   một màu xanh giả.
import { supabase } from '@/integrations/supabase/client';

/** Trần số dòng sổ đọc về một lượt — server tự kẹp lại trong [1, 200]. */
export const SO_DONG_SO_MAC_DINH = 50;

export type MucRuiRoChinhSach = 'L3' | 'L4' | 'L5';

export interface ChinhSachHanhDong {
  revision: number;
  maxDirectRisk: MucRuiRoChinhSach;
  allowedRoles: string[];
  standingGrantsEnabled: boolean;
}

export interface DongSoHanhDong {
  id: string;
  createdAt: string | null;
  event: string;
  actionId: string | null;
  userId: string | null;
  errorCode: string | null;
  entityTable: string | null;
  entityId: string | null;
  /** G3: dòng của một KẾ HOẠCH mang thêm ba cột này (nullable ở mọi dòng cũ). */
  planId: string | null;
  stepNo: number | null;
  planVersion: number | null;
}

function chuoiHoacNull(gt: unknown): string | null {
  return typeof gt === 'string' && gt.length > 0 ? gt : null;
}

/** Số nguyên, hoặc `null`. `Number(null)` là `0`, nên `null` phải chặn TRƯỚC. */
function soHoacNull(gt: unknown): number | null {
  if (typeof gt === 'number') return Number.isFinite(gt) ? gt : null;
  if (typeof gt !== 'string' || gt.trim() === '') return null;
  const n = Number(gt);
  return Number.isFinite(n) ? n : null;
}

/**
 * Chuẩn hoá một dòng sổ.
 *
 * Server trả `to_jsonb(l) - ba digest`, tức nguyên bộ cột của bảng. Đọc theo
 * TÊN CỘT và chấp nhận thiếu: bảng sổ còn được G3/G5 nới thêm cột, và một trang
 * quản trị vỡ vì server trả THÊM dữ liệu là kiểu vỡ khó chịu nhất.
 */
export function chuanHoaDongSo(gt: unknown): DongSoHanhDong | null {
  if (!gt || typeof gt !== 'object' || Array.isArray(gt)) return null;
  const r = gt as Record<string, unknown>;
  const id = chuoiHoacNull(r.id);
  const event = chuoiHoacNull(r.event);
  if (!id || !event) return null;
  return {
    id,
    createdAt: chuoiHoacNull(r.created_at),
    event,
    actionId: chuoiHoacNull(r.action_id),
    userId: chuoiHoacNull(r.user_id),
    errorCode: chuoiHoacNull(r.error_code),
    entityTable: chuoiHoacNull(r.entity_table),
    entityId: chuoiHoacNull(r.entity_id),
    planId: chuoiHoacNull(r.plan_id),
    stepNo: soHoacNull(r.step_no),
    planVersion: soHoacNull(r.plan_version),
  };
}

/** Mảng jsonb → danh sách dòng; dòng hỏng bị BỎ, không làm chết cả bảng. */
export function chuanHoaSo(gt: unknown): DongSoHanhDong[] {
  if (!Array.isArray(gt)) return [];
  return gt.map(chuanHoaDongSo).filter((d): d is DongSoHanhDong => d !== null);
}

/** Payload của `get_copilot_action_policy_v1` → hình dạng dùng trong giao diện. */
export function chuanHoaChinhSach(gt: unknown): ChinhSachHanhDong | null {
  if (!gt || typeof gt !== 'object' || Array.isArray(gt)) return null;
  const r = gt as Record<string, unknown>;
  const revision = typeof r.revision === 'number' ? r.revision : Number(r.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) return null;
  const risk = r.max_direct_risk;
  if (risk !== 'L3' && risk !== 'L4' && risk !== 'L5') return null;
  const roles = Array.isArray(r.allowed_roles)
    ? r.allowed_roles.filter((x): x is string => typeof x === 'string')
    : [];
  if (roles.length === 0) return null;
  return {
    revision,
    maxDirectRisk: risk,
    allowedRoles: roles,
    standingGrantsEnabled: r.standing_grants_enabled === true,
  };
}

/** Mã lỗi của hai RPC chính sách → câu người vận hành đọc và làm được gì đó. */
export function dienGiaiLoiChinhSach(loi: unknown): string {
  const cau = loi instanceof Error ? loi.message : String(loi ?? '');
  if (cau.includes('copilot_policy_stale_revision')) {
    return 'Chính sách vừa đổi bởi người khác, tải lại rồi thử lại.';
  }
  if (cau.includes('policy_reason_required')) {
    return 'Phải nhập cả lý do và liên kết bằng chứng trước khi đổi chính sách.';
  }
  if (cau.includes('copilot_policy_not_permitted')) {
    return 'Chỉ super admin mới đổi được chính sách hành động.';
  }
  if (cau.includes('copilot_policy_risk_invalid')) {
    return 'Trần rủi ro phải là L3, L4 hoặc L5.';
  }
  if (cau.includes('copilot_policy_roles_invalid')) {
    return 'Danh sách vai không hợp lệ (chỉ superadmin/owner/manager/staff, và không được rỗng).';
  }
  if (cau.includes('copilot_policy_missing')) {
    return 'Chưa có hàng chính sách trong cơ sở dữ liệu — migration G2-A chưa chạy?';
  }
  if (cau.includes('unauthenticated')) return 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.';
  return `Không đổi được chính sách: ${cau}`;
}

/** Đọc sổ hành động của một công ty. Không có công ty ⇒ không đọc gì. */
export async function docSoHanhDong(
  organizationId: string | null | undefined,
  soDong: number = SO_DONG_SO_MAC_DINH,
): Promise<DongSoHanhDong[]> {
  if (!organizationId) return [];
  const { data, error } = await supabase.rpc('copilot_action_ledger_list_v1', {
    p_organization_id: organizationId,
    p_limit: soDong,
  });
  if (error) throw new Error(error.message ?? String(error));
  return chuanHoaSo(data);
}

/** Đọc van chính sách. `null` = server trả hình dạng không đọc được. */
export async function docChinhSachHanhDong(): Promise<ChinhSachHanhDong | null> {
  const { data, error } = await supabase.rpc('get_copilot_action_policy_v1');
  if (error) throw new Error(error.message ?? String(error));
  return chuanHoaChinhSach(data);
}

export interface DoiChinhSachInput {
  expectedRevision: number;
  maxDirectRisk?: MucRuiRoChinhSach;
  allowedRoles?: string[];
  reason: string;
  evidenceLink: string;
}

/**
 * Đổi van chính sách theo CAS revision.
 *
 * KHÔNG có `standing_grants_enabled` ở đây, và đó là chủ ý: standing grant là
 * cơ chế của Mức 3 (G4) — chưa có đường thu hồi nào đo được, nên chưa có nút.
 * Trường vẫn tồn tại trong RPC; thiếu nó ở đây nghĩa là NULL, tức server giữ
 * nguyên giá trị cũ.
 */
export async function doiChinhSachHanhDong(input: DoiChinhSachInput): Promise<ChinhSachHanhDong | null> {
  const { data, error } = await supabase.rpc('set_copilot_action_policy_v1', {
    p_expected_revision: input.expectedRevision,
    ...(input.maxDirectRisk ? { p_max_direct_risk: input.maxDirectRisk } : {}),
    ...(input.allowedRoles ? { p_allowed_roles: input.allowedRoles } : {}),
    p_reason: input.reason,
    p_evidence_link: input.evidenceLink,
  });
  if (error) throw new Error(error.message ?? String(error));
  return chuanHoaChinhSach(data);
}

// ── PIN step-up (G5-A, điểm nối #3) — mở khoá NGƯỜI KHÁC ────────────────────
//
// `trangThaiPin`/`datPin` của CHÍNH người gọi nằm ở `stepUpClient.ts` (dùng
// chung với `KeHoachCard`); ở ĐÂY chỉ có `moKhoaPinStepUp`, vì mở khoá cho một
// người dùng KHÁC là việc riêng của super admin, không phải một thao tác tự
// phục vụ.

export interface KetQuaMoKhoaPin {
  daMoKhoa: boolean;
  userId: string;
}

export function chuanHoaMoKhoaPin(gt: unknown): KetQuaMoKhoaPin | null {
  if (!gt || typeof gt !== 'object' || Array.isArray(gt)) return null;
  const r = gt as Record<string, unknown>;
  const userId = chuoiHoacNull(r.user_id);
  if (!userId || r.da_mo_khoa !== true) return null;
  return { daMoKhoa: true, userId };
}

/** Mã lỗi của `copilot_step_up_unlock_v1` → câu người vận hành đọc được. */
export function dienGiaiLoiMoKhoaPin(loi: unknown): string {
  const cau = loi instanceof Error ? loi.message : String(loi ?? '');
  if (cau.includes('step_up_superadmin_only')) {
    return 'Chỉ super admin mới mở khoá được PIN của người khác.';
  }
  if (cau.includes('reason_required')) return 'Phải nhập lý do (ít nhất 3 ký tự) trước khi mở khoá.';
  if (cau.includes('user_required')) return 'Thiếu mã người dùng cần mở khoá.';
  if (cau.includes('pin_not_set')) return 'Người dùng này chưa từng đặt PIN step-up.';
  if (cau.includes('unauthenticated')) return 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.';
  return `Không mở khoá được: ${cau}`;
}

/** Mở khoá PIN step-up của MỘT người dùng khác. Chỉ super admin, bắt buộc lý do. */
export async function moKhoaPinStepUp(userId: string, reason: string): Promise<KetQuaMoKhoaPin | null> {
  const { data, error } = await supabase.rpc('copilot_step_up_unlock_v1', {
    p_user_id: userId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message ?? String(error));
  return chuanHoaMoKhoaPin(data);
}

/** Nhãn tiếng Việt cho từng loại sự kiện trong sổ. */
const NHAN_SU_KIEN: Readonly<Record<string, string>> = {
  policy_changed: 'Đổi chính sách',
  action_gate_denied: 'Cổng hành động từ chối',
  action_previewed: 'Lập bản xem trước',
  action_executed: 'Đã thực thi',
  action_failed: 'Thực thi lỗi',
  // Bảy sự kiện kế hoạch của G3 — chúng đã nằm trong CHECK của bảng sổ từ G2-A,
  // nhưng cho tới G3-TS không nhãn nào tồn tại, nên trang quản trị hiện mã trần
  // (`step_blocked`) cho đúng những dòng mà người trực sự cố cần đọc nhanh nhất.
  plan_created: 'Lập kế hoạch',
  plan_approved: 'Người dùng duyệt kế hoạch',
  step_done: 'Bước đã chạy',
  step_failed: 'Bước hỏng',
  step_blocked: 'Bước bị chặn',
  plan_cancelled: 'Huỷ kế hoạch',
  plan_expired: 'Kế hoạch quá hạn',
  // Bốn sự kiện PIN step-up (G5-A) — hai đầu (đặt/mở khoá) không thuộc tổ chức
  // nào, xem cột "Người dùng" thay vì cột công ty ở bảng sổ chung.
  step_up_pin_set: 'Đặt/đổi PIN step-up',
  step_up_verified: 'Xác thực PIN thành công',
  step_up_locked: 'Khoá PIN (sai quá 5 lần)',
  step_up_unlocked: 'Mở khoá PIN (super admin)',
};

/** Bảy sự kiện thuộc về đường KẾ HOẠCH — nguồn của mục "Kế hoạch gần đây". */
export const SU_KIEN_KE_HOACH: readonly string[] = [
  'plan_created',
  'plan_approved',
  'step_done',
  'step_failed',
  'step_blocked',
  'plan_cancelled',
  'plan_expired',
];

/**
 * Lọc các dòng sổ thuộc đường kế hoạch.
 *
 * Lọc theo DANH SÁCH TÊN, không theo tiền tố `plan_`/`step_`: một tiền tố sẽ
 * lặng lẽ nuốt mọi sự kiện tương lai có tên bắt đầu như thế (kể cả sự kiện của
 * một cơ chế khác), và mục "Kế hoạch gần đây" sẽ kể một câu chuyện lẫn lộn mà
 * không ai thấy sai.
 */
export function locSuKienKeHoach(dong: readonly DongSoHanhDong[]): DongSoHanhDong[] {
  return dong.filter((d) => SU_KIEN_KE_HOACH.includes(d.event));
}

export function nhanSuKien(event: string): string {
  return NHAN_SU_KIEN[event] ?? event;
}

/** `2026-09-03T04:39:56Z` → `03/09/2026 04:39`. Chuỗi lạ thì trả nguyên xi. */
export function dinhDangThoiGian(gt: string | null): string {
  if (!gt) return '—';
  const t = new Date(gt);
  if (Number.isNaN(t.getTime())) return gt;
  const hai = (n: number) => String(n).padStart(2, '0');
  return `${hai(t.getDate())}/${hai(t.getMonth() + 1)}/${t.getFullYear()} ${hai(t.getHours())}:${hai(t.getMinutes())}`;
}
