// Máy trạm UỶ QUYỀN ĐỨNG (standing grant, G5-B) — điểm nối #4 của Mức 3.
//
// NĂM RPC Ở ĐÂY, ĐÚNG NĂM. `copilot_standing_grant_create_v1` /
// `copilot_standing_grant_revoke_v1` / `copilot_standing_grants_revoke_all_v1`
// GHI (cấp/thu hồi một hạn mức); hai hàm còn lại chỉ ĐỌC. `tooling/copilot-
// action-policy.json` khai ba hàm ghi vào `rpcAllowlist`, chỉ trỏ về ĐÚNG FILE
// NÀY — không tool nào trong `src/copilot/tools/` được phép cấp/thu hồi một
// hạn mức uỷ quyền đứng. Cấp một hạn mức là cấp cho CHÍNH COPILOT quyền tự
// duyệt sau này mà không cần ai bấm; một tool tự cấp được nó là một tool tự
// mở khoá cho chính mình.
//
// HAI ĐIỀU PHẢI ĐỌC TRƯỚC KHI SỬA FILE NÀY
//
//   1. `supabase.rpc` KHÔNG BAO GIỜ NÉM — cùng luật với `planClient.ts`/
//      `stepUpClient.ts`. Khác với hai file đó, NĂM RPC ở đây không có nhánh
//      "ghi-rồi-RETURN ok:false": mọi lỗi là RAISE thuần (không hàng nào bị
//      đụng trước khi RAISE — xem migration `20260903171622`), nên `docKetQua`
//      chỉ cần đọc MỘT đường (`error`), không phải hai như hai file kia.
//
//   2. TẠO HẠN MỨC ĐÒI TOKEN STEP-UP — LẤY-VÀ-XOÁ, CÙNG KỶ LUẬT VỚI
//      `KeHoachCard`. Nơi gọi (thẻ quản trị) tự mở `StepUpPinModal`, rồi gọi
//      `tieuTokenStepUp(organizationId)` NGAY TRƯỚC `taoGrant` — token không
//      bao giờ nằm trong tay component lâu hơn một lần bấm. Bốn hàm còn lại
//      (thu hồi/thu hồi tất cả/danh sách/báo cáo ngày) KHÔNG cần token: thu
//      hồi luôn dễ hơn cấp, và hai hàm đọc chỉ cần super admin.
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';

import { dienGiaiLoiKeHoach } from '../chatErrors';

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
  maLoi: string | null;
  thongBao: string | null;
  ban: Record<string, unknown> | null;
}

/** Đọc `{ data, error }` — chỉ MỘT đường lỗi (RAISE), xem quyết định 1 ở đầu file. */
function docKetQua(data: unknown, error: { message?: string } | null): KetQuaRpc {
  if (error) {
    const raw = (error.message ?? String(error)).trim();
    return { ok: false, maLoi: raw || null, thongBao: dienGiaiLoiKeHoach(raw), ban: null };
  }
  const ban = laBan(data);
  if (!ban || ban.ok !== true) {
    return {
      ok: false,
      maLoi: 'phan_hoi_khong_doc_duoc',
      thongBao: 'Server trả về hình dạng không đọc được.',
      ban: null,
    };
  }
  return { ok: true, maLoi: null, thongBao: null, ban };
}

// ─────────────────────────────────────────────────────────────────────────────
// TẠO — đòi step-up token
// ─────────────────────────────────────────────────────────────────────────────

/** Ràng buộc TUỲ CHỌN của một hạn mức — cả hai khoá đều có thể vắng mặt. */
export interface RangBuocGrant {
  /** Số tiền tối đa của MỘT lần dùng (khớp `canonical.amount` của bước). */
  maxAmount?: number;
  /** Danh sách toà nhà được phép (khớp `canonical.building_id` của bước). */
  buildingIds?: string[];
}

export interface ThamSoTaoGrant {
  organizationId: string;
  actionId: string;
  constraints: RangBuocGrant;
  maxPerDay: number;
  /** ISO 8601 — server ép ≤ 30 ngày kể từ lúc tạo. */
  expiresAt: string;
  reason: string;
  /** Token step-up hex64, lấy từ `tieuTokenStepUp(organizationId)`. */
  stepUpToken: string;
}

export interface Grant {
  grantId: string;
  actionId: string;
  maxPerDay: number;
  expiresAt: string | null;
}

export interface KetQuaTaoGrant {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  grant: Grant | null;
  knownGrantId?: string;
}

function rangBuocSangJson(r: RangBuocGrant): Json {
  const ra: Record<string, unknown> = {};
  if (r.maxAmount !== undefined) ra.max_amount = r.maxAmount;
  if (r.buildingIds !== undefined) ra.building_ids = r.buildingIds;
  return ra as Json;
}

export async function taoGrant(thamSo: ThamSoTaoGrant): Promise<KetQuaTaoGrant> {
  const { data, error } = await supabase.rpc('copilot_standing_grant_create_v1', {
    p_organization_id: thamSo.organizationId,
    p_action_id: thamSo.actionId,
    p_constraints: rangBuocSangJson(thamSo.constraints),
    p_max_per_day: thamSo.maxPerDay,
    p_expires_at: thamSo.expiresAt,
    p_reason: thamSo.reason,
    p_step_up_token: thamSo.stepUpToken,
  });
  const kq = docKetQua(data, error);
  if (!kq.ok) return { ok: false, maLoi: kq.maLoi, thongBao: kq.thongBao, grant: null };
  const ban = kq.ban ?? {};
  const grantId = chuoi(ban.grant_id);
  const actionId = chuoi(ban.action_id);
  const maxPerDay = ban.max_per_day;
  const expiresAt = chuoi(ban.expires_at);
  if (!grantId || actionId !== thamSo.actionId || typeof maxPerDay !== 'number' || !Number.isSafeInteger(maxPerDay) || maxPerDay !== thamSo.maxPerDay || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    return {
      ok: false,
      maLoi: 'phan_hoi_khong_doc_duoc',
      thongBao: 'Server trả về hình dạng không đọc được.',
      grant: null,
      ...(grantId ? {knownGrantId: grantId} : {}),
    };
  }
  return {
    ok: true,
    maLoi: null,
    thongBao: null,
    grant: {
      grantId,
      actionId,
      maxPerDay,
      expiresAt,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THU HỒI — không cần step-up
// ─────────────────────────────────────────────────────────────────────────────

export interface KetQuaThaoTacGrant {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
}

export async function thuHoiGrant(grantId: string, reason: string): Promise<KetQuaThaoTacGrant> {
  const { data, error } = await supabase.rpc('copilot_standing_grant_revoke_v1', {
    p_grant_id: grantId,
    p_reason: reason,
  });
  const kq = docKetQua(data, error);
  if (kq.ok && kq.ban?.grant_id !== grantId) return {ok:false,maLoi:'phan_hoi_khong_doc_duoc',thongBao:'Chưa xác nhận được hạn mức đã thu hồi. Đọc lại trạng thái trước khi thực hiện tiếp.'};
  return { ok: kq.ok, maLoi: kq.maLoi, thongBao: kq.thongBao };
}

export interface KetQuaThuHoiTatCa {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  soLuongThuHoi: number | null;
}

/** Kill switch riêng của uỷ quyền đứng: thu hồi MỌI hạn mức còn hiệu lực của một tổ chức. */
export async function thuHoiTatCaGrant(
  organizationId: string,
  reason: string,
): Promise<KetQuaThuHoiTatCa> {
  const { data, error } = await supabase.rpc('copilot_standing_grants_revoke_all_v1', {
    p_organization_id: organizationId,
    p_reason: reason,
  });
  const kq = docKetQua(data, error);
  if (!kq.ok) return { ok: false, maLoi: kq.maLoi, thongBao: kq.thongBao, soLuongThuHoi: null };
  return { ok: true, maLoi: null, thongBao: null, soLuongThuHoi: typeof kq.ban?.revoked_count === 'number' ? kq.ban.revoked_count : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// ĐỌC — danh sách + báo cáo ngày
// ─────────────────────────────────────────────────────────────────────────────

export interface DongGrant {
  grantId: string;
  actionId: string;
  labelVi: string;
  constraints: RangBuocGrant;
  maxPerDay: number;
  usedToday: number;
  usedOn: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  reason: string;
  granterUserId: string | null;
  createdAt: string | null;
}

function rangBuocTuJson(gt: unknown): RangBuocGrant {
  const r = laBan(gt);
  if (!r) return {};
  const ra: RangBuocGrant = {};
  const maxAmount = so(r.max_amount);
  if (maxAmount !== null) ra.maxAmount = maxAmount;
  if (Array.isArray(r.building_ids)) {
    const ids = r.building_ids.filter((x): x is string => typeof x === 'string');
    ra.buildingIds = ids;
  }
  return ra;
}

function dateValue(value: unknown, dateOnly = false): boolean {
 if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
 return dateOnly ? /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value : /^\d{4}-\d{2}-\d{2}T/.test(value);
}
function validConstraints(value: unknown): boolean {
 const row = laBan(value);
 return !!row && (row.max_amount === undefined || typeof row.max_amount === 'number' && Number.isFinite(row.max_amount) && row.max_amount > 0) &&
  (row.building_ids === undefined || Array.isArray(row.building_ids) && row.building_ids.every(id => typeof id === 'string' && !!id));
}
function chuanHoaDongGrant(gt: unknown): DongGrant | null {
  const r = laBan(gt);
  if (!r) return null;
  const grantId = chuoi(r.grant_id);
  const actionId = chuoi(r.action_id);
  if (!grantId || !actionId || typeof r.max_per_day !== 'number' || !Number.isSafeInteger(r.max_per_day) || r.max_per_day < 1 || typeof r.used_today !== 'number' || !Number.isSafeInteger(r.used_today) || r.used_today < 0 || !validConstraints(r.constraints) || !dateValue(r.expires_at) || !dateValue(r.created_at) || !chuoi(r.granter_user_id) || typeof r.reason !== 'string' || !(r.used_on === null || dateValue(r.used_on, true)) || !(r.revoked_at === null || dateValue(r.revoked_at)) || !(r.revoked_by === null || !!chuoi(r.revoked_by))) return null;
  return {
    grantId,
    actionId,
    labelVi: chuoi(r.label_vi) ?? actionId,
    constraints: rangBuocTuJson(r.constraints),
    maxPerDay: r.max_per_day,
    usedToday: r.used_today,
    usedOn: chuoi(r.used_on),
    expiresAt: chuoi(r.expires_at),
    revokedAt: chuoi(r.revoked_at),
    revokedBy: chuoi(r.revoked_by),
    reason: chuoi(r.reason) ?? '',
    granterUserId: chuoi(r.granter_user_id),
    createdAt: chuoi(r.created_at),
  };
}

export interface KetQuaDsGrant {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  danhSach: DongGrant[];
}

/**
 * `copilot_standing_grants_list_v1` trả THẲNG một mảng jsonb (không bọc
 * `{ok, error_code}` — nó là RPC đọc, cùng khuôn `copilot_action_ledger_list_v1`),
 * nên đọc kết quả tách khỏi `docKetQua` (hàm đó giả định một object có `ok`).
 */
export async function dsGrant(organizationId: string): Promise<KetQuaDsGrant> {
  const { data, error } = await supabase.rpc('copilot_standing_grants_list_v1', {
    p_organization_id: organizationId,
  });
  if (error) {
    const raw = (error.message ?? String(error)).trim();
    return { ok: false, maLoi: raw || null, thongBao: dienGiaiLoiKeHoach(raw), danhSach: [] };
  }
  if (!Array.isArray(data)) return {ok:false,maLoi:'phan_hoi_khong_doc_duoc',thongBao:'Chưa xác nhận được danh sách hạn mức. Đọc lại trước khi thay đổi.',danhSach:[]};
  const rows = data.map(chuanHoaDongGrant);
  if (rows.some(row => row === null)) return {ok:false,maLoi:'phan_hoi_khong_doc_duoc',thongBao:'Chưa xác nhận được đầy đủ hạn mức. Đọc lại trước khi thay đổi.',danhSach:[]};
  return { ok: true, maLoi: null, thongBao: null, danhSach: rows as DongGrant[] };
}

export interface DongBaoCaoNgay {
  planId: string;
  approvedAt: string | null;
  planStatus: string;
  maxRisk: string;
  stepCount: number;
  standingGrantIds: string[];
}

export interface KetQuaBaoCaoNgay {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  ngay: string | null;
  ke: DongBaoCaoNgay[];
  tongTien: number | null;
}

export async function baoCaoNgayGrant(
  organizationId: string,
  ngay?: string,
): Promise<KetQuaBaoCaoNgay> {
  // p_date là tham số BẮT BUỘC theo types.ts sinh từ catalog (không DEFAULT) —
  // thiếu ngày thì lấy ngày hiện tại theo giờ Việt Nam (YYYY-MM-DD).
  const ngayBaoCao =
    ngay ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const { data, error } = await supabase.rpc('copilot_standing_grants_daily_report_v1', {
    p_organization_id: organizationId,
    p_date: ngayBaoCao,
  });
  if (error) {
    const raw = (error.message ?? String(error)).trim();
    return {
      ok: false,
      maLoi: raw || null,
      thongBao: dienGiaiLoiKeHoach(raw),
      ngay: null,
      ke: [],
      tongTien: null,
    };
  }
  const ban = laBan(data);
  if (!ban || !Array.isArray(ban.plans) || typeof ban.total_amount !== 'number' || !Number.isFinite(ban.total_amount) || ban.total_amount < 0 || typeof ban.plan_count !== 'number' || !Number.isSafeInteger(ban.plan_count) || ban.plan_count !== ban.plans.length || ban.date !== ngayBaoCao || !dateValue(ban.date, true)) {
    return {
      ok: false,
      maLoi: 'phan_hoi_khong_doc_duoc',
      thongBao: 'Server trả về hình dạng không đọc được.',
      ngay: null,
      ke: [],
      tongTien: null,
    };
  }
  const ke = Array.isArray(ban.plans)
    ? ban.plans
        .map((p): DongBaoCaoNgay | null => {
          const r = laBan(p);
          if (!r) return null;
          const planId = chuoi(r.plan_id);
          if (!planId || typeof r.step_count !== 'number' || !Number.isSafeInteger(r.step_count) || r.step_count < 0 || !Array.isArray(r.standing_grant_ids) || r.standing_grant_ids.some(id => typeof id !== 'string' || !id) || !chuoi(r.plan_status) || !chuoi(r.max_risk) || !dateValue(r.approved_at)) return null;
          return {
            planId,
            approvedAt: chuoi(r.approved_at),
            planStatus: chuoi(r.plan_status) ?? '—',
            maxRisk: chuoi(r.max_risk) ?? '—',
            stepCount: r.step_count,
            standingGrantIds: Array.isArray(r.standing_grant_ids)
              ? r.standing_grant_ids.filter((x): x is string => typeof x === 'string')
              : [],
          };
        })
        .filter((d): d is DongBaoCaoNgay => d !== null)
    : [];
  if (ke.length !== ban.plans.length) return {ok:false,maLoi:'phan_hoi_khong_doc_duoc',thongBao:'Chưa xác nhận được đầy đủ báo cáo hạn mức. Đọc lại dữ liệu.',ngay:null,ke:[],tongTien:null};
  return {
    ok: true,
    maLoi: null,
    thongBao: null,
    ngay: chuoi(ban.date),
    ke,
    tongTien: so(ban.total_amount),
  };
}
