// Máy trạm của KẾ HOẠCH THỰC THI (G3) — lập, duyệt, chạy tuần tự, đọc, huỷ.
//
// Ở ĐÂY LÀ TOÀN BỘ LOGIC; `tools/planTools.ts` chỉ KHAI BÁO hai tool và gọi
// xuống đây. Tách như vậy không phải cho gọn: `duyetKeHoach` (hàm tiêu nonce cấp
// kế hoạch) nằm trong file này và KHÔNG được xuất hiện trong bất kỳ thân
// `execute` nào của tool. Một tool gọi được nó nghĩa là mô hình tự duyệt được kế
// hoạch của chính mình — đúng cái ranh giới mà cả kiến trúc nonce dựng lên để
// chặn. `scripts/check-copilot-forbidden-actions.mjs` ghim điều đó bằng một
// allowlist theo TÊN FILE (`tooling/copilot-action-policy.json` →
// `rpcAllowlist.copilot_plan_approve_v1`).
//
// BA ĐIỀU PHẢI ĐỌC TRƯỚC KHI SỬA FILE NÀY
//
//   1. `supabase.rpc` KHÔNG BAO GIỜ NÉM. Lỗi mạng, 5xx, exception của Postgres —
//      tất cả về dưới dạng `{ error }` của một promise ĐÃ FULFIL. `try/catch`
//      quanh nó là mã chết, và `mockRejectedValue` trong test là màu xanh giả.
//
//   2. HTTP 200 KHÔNG CÓ NGHĨA LÀ THÀNH CÔNG. Migration `20260903100253` chọn
//      GHI-rồi-RETURN cho ba nhánh phải để lại bằng chứng (kế hoạch hết hạn,
//      bước mất quyền lúc duyệt, bước hỏng lúc chạy) — xem "quyết định 4" ở đầu
//      file đó. Nên hợp đồng trả về của MỌI RPC ghi mang đúng hai trường phân
//      biệt: `ok boolean` và `error_code text|null`. File này rẽ theo `ok`, và
//      `error` chỉ còn là một đường về THỨ HAI cho các nhánh RAISE.
//
//      Hệ quả thực tế: `if (!error) return 'đã chạy xong'` là một câu báo thành
//      công giả cho một bước vừa FAILED.
//
//   3. NONCE CẤP KẾ HOẠCH KHÔNG BAO GIỜ RA KHỎI ĐÂY THEO ĐƯỜNG CHUỖI. Server
//      phát nó ĐÚNG MỘT LẦN trong kết quả của `copilot_plan_create_v1`;
//      `taoKeHoach` cất thẳng vào `confirmationStore` (bộ nhớ, loại `ke_hoach`)
//      và trả về một bản kế hoạch dựng lại từ danh sách trường TƯỜNG MINH —
//      không phải `data` nguyên bản. Đó là lý do một trường bí mật mới do server
//      thêm vào cũng không tự động chảy ra ngoài.
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';

import { dienGiaiLoiKeHoach } from '../chatErrors';
import { datXacNhanDangCho, tieuXacNhan, xoaXacNhanDangCho } from '../confirmationStore';
import type { ActionId, MucRuiRo } from './actionCatalog';

/** `tool` của phiếu đồng ý cấp kế hoạch — chuỗi server đòi, không đổi được. */
export const TOOL_KE_HOACH = 'lap_ke_hoach';

/** Khoá tra phiếu đồng ý của MỘT kế hoạch trong `confirmationStore`. */
export function khoaYKeHoach(planId: string): string {
  return `ke_hoach:${planId}`;
}

export type TrangThaiKeHoach =
  | 'DRAFT'
  | 'APPROVED'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export type TrangThaiBuoc =
  | 'PENDING'
  | 'DONE'
  | 'FAILED'
  | 'BLOCKED'
  | 'SKIPPED'
  | 'UNKNOWN_EFFECT';

/** Trạng thái mà kế hoạch KHÔNG rời khỏi nữa — điều kiện dừng của vòng poll. */
export const TRANG_THAI_KET_THUC: readonly TrangThaiKeHoach[] = [
  'DONE',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
];

export function keHoachDaKetThuc(trangThai: string | null | undefined): boolean {
  return TRANG_THAI_KET_THUC.includes(String(trangThai) as TrangThaiKeHoach);
}

export interface BuocKeHoach {
  stepNo: number;
  actionId: string;
  labelVi: string;
  risk: MucRuiRo;
  executorKind: string;
  status: TrangThaiBuoc;
  preview: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  errorCode: string | null;
  refStep: number | null;
  executedAt: string | null;
}

export interface KeHoach {
  planId: string;
  planVersion: number;
  planDigest: string;
  planStatus: TrangThaiKeHoach;
  organizationId: string | null;
  maxRisk: MucRuiRo | null;
  stepCount: number;
  expiresAt: string | null;
  executeDeadline: string | null;
  failureReason: string | null;
  /**
   * G5-B — điểm nối #4. Danh sách id hạn mức uỷ quyền đứng đã phủ kế hoạch
   * này khi nó TỰ DUYỆT ngay lúc lập (`copilot_plan_create_v1` trả
   * `tu_duyet_theo_uy_quyen`, không phải `consent_nonce`). `null`/mảng rỗng =
   * kế hoạch đi đường DRAFT/bấm/PIN như trước G5-B — KHÔNG suy ra từ
   * `planStatus === 'APPROVED'` một mình, vì bấm tay/PIN cũng cho ra trạng
   * thái đó.
   *
   * Từ 05/09 `copilot_plan_summary_v1` (đường `get` đi qua) cũng trả
   * `standing_grant_ids`, nên đọc lại một kế hoạch cũ — F5, đổi thiết bị —
   * vẫn biết nó tiêu uỷ quyền nào. Hai tên khoá là hai đường ghi khác nhau
   * của cùng một sự thật, không phải hai sự thật: `create` trả tên riêng còn
   * `get` chiếu qua bản tóm tắt đã redact.
   */
  standingGrantIds: string[] | null;
  steps: BuocKeHoach[];
}

/** Bước đang chờ chạy sớm nhất, hoặc `null`. */
export function buocKeTiep(ke: KeHoach | null): BuocKeHoach | null {
  if (!ke) return null;
  return ke.steps.find((b) => b.status === 'PENDING') ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ĐỌC KẾT QUẢ — một chỗ duy nhất biết hợp đồng `ok`/`error_code`
// ─────────────────────────────────────────────────────────────────────────────

interface PhanHoi {
  ban: Record<string, unknown> | null;
  maLoi: string | null;
  thongDiep: string | null;
}

function laBan(gt: unknown): Record<string, unknown> | null {
  return gt && typeof gt === 'object' && !Array.isArray(gt) ? (gt as Record<string, unknown>) : null;
}

function chuoi(gt: unknown): string | null {
  return typeof gt === 'string' && gt.length > 0 ? gt : null;
}

/**
 * Số, hoặc `null` — và `null` PHẢI ra `null`.
 *
 * `Number(null)` là `0`, và `0` là một `stepNo` hợp lệ về mặt kiểu. Bản đầu
 * viết `Number.isFinite(Number(gt))` nên `next_step_no: null` (nghĩa là "hết
 * bước rồi") biến thành bước số 0, vòng chạy tuần tự gọi thêm một lời execute
 * cho một bước không tồn tại. Test `chayTuanTu` bắt được đúng chỗ này.
 */
function so(gt: unknown): number | null {
  if (typeof gt === 'number') return Number.isFinite(gt) ? gt : null;
  if (typeof gt !== 'string' || gt.trim() === '') return null;
  const n = Number(gt);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mã ngắn bóc từ thông điệp của Postgres.
 *
 * `RAISE EXCEPTION 'plan_version_stale: dang o 2, nguoi goi mong 1'` về đây
 * nguyên câu; nơi gọi cần một MÃ để rẽ nhánh, còn người dùng cần cả câu để
 * `dienGiaiLoiKeHoach` khớp. Giữ cả hai, đừng bắt nơi gọi tự cắt.
 */
export function maNganTuThongDiep(thongDiep: string): string {
  const khop = thongDiep.match(/[a-z][a-z0-9_]{3,}/);
  return khop ? khop[0] : thongDiep.trim();
}

/**
 * Đọc một cặp `{ data, error }` theo hợp đồng RETURN của G3.
 *
 * HAI đường hỏng, một hình dạng ra: `error` (nhánh RAISE) và `data.ok === false`
 * (nhánh ghi-rồi-RETURN). Bỏ sót nhánh thứ hai là báo thành công cho một bước
 * vừa FAILED — xem chú thích số 2 ở đầu file.
 */
export function docPhanHoi(data: unknown, error: { message?: string } | null): PhanHoi {
  if (error) {
    const thongDiep = error.message ?? String(error);
    return { ban: null, maLoi: maNganTuThongDiep(thongDiep), thongDiep };
  }
  const ban = laBan(data);
  if (!ban) {
    return {
      ban: null,
      maLoi: 'phan_hoi_khong_doc_duoc',
      thongDiep: 'Server trả về hình dạng không đọc được.',
    };
  }
  if (ban.ok !== true) {
    const ma = chuoi(ban.error_code) ?? 'phan_hoi_khong_doc_duoc';
    return { ban, maLoi: ma, thongDiep: ma };
  }
  return { ban, maLoi: null, thongDiep: null };
}

/**
 * `data` → `KeHoach`, dựng từ danh sách trường TƯỜNG MINH.
 *
 * KHÔNG `{ ...data }`. Nonce cấp kế hoạch nằm cùng khối với các trường này ở
 * kết quả của `create`, và một phép sao chép nông sẽ mang nó theo vào mọi chỗ
 * cầm `KeHoach` — kể cả chuỗi tool trả cho mô hình.
 */
export function chuanHoaKeHoach(gt: unknown): KeHoach | null {
  const r = laBan(gt);
  if (!r) return null;
  const planId = chuoi(r.plan_id);
  const planVersion = so(r.plan_version);
  const planStatus = chuoi(r.plan_status);
  if (!planId || planVersion === null || !planStatus) return null;
  const steps = Array.isArray(r.steps)
    ? r.steps
        .map((b) => chuanHoaBuoc(b))
        .filter((b): b is BuocKeHoach => b !== null)
        .sort((a, b) => a.stepNo - b.stepNo)
    : [];
  return {
    planId,
    planVersion,
    planDigest: chuoi(r.plan_digest) ?? '',
    planStatus: planStatus as TrangThaiKeHoach,
    organizationId: chuoi(r.organization_id),
    maxRisk: (chuoi(r.max_risk) as MucRuiRo | null) ?? null,
    stepCount: so(r.step_count) ?? steps.length,
    expiresAt: chuoi(r.expires_at),
    executeDeadline: chuoi(r.execute_deadline),
    failureReason: chuoi(r.failure_reason),
    standingGrantIds:
      mangChuoi(r.tu_duyet_theo_uy_quyen) ?? mangChuoi(r.standing_grant_ids),
    steps,
  };
}

/**
 * Mảng chuỗi khác rỗng, hoặc `null` — dùng cho `tu_duyet_theo_uy_quyen` (kết
 * quả `create`) và `standing_grant_ids` (bản tóm tắt mà `get` chiếu qua).
 */
function mangChuoi(gt: unknown): string[] | null {
  if (!Array.isArray(gt)) return null;
  const ra = gt.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return ra.length > 0 ? ra : null;
}

function chuanHoaBuoc(gt: unknown): BuocKeHoach | null {
  const r = laBan(gt);
  if (!r) return null;
  const stepNo = so(r.step_no);
  const actionId = chuoi(r.action_id);
  if (stepNo === null || !actionId) return null;
  return {
    stepNo,
    actionId,
    labelVi: chuoi(r.label_vi) ?? actionId,
    risk: (chuoi(r.risk) as MucRuiRo | null) ?? 'L3',
    executorKind: chuoi(r.executor_kind) ?? 'nonce_abi_v1',
    status: (chuoi(r.status) as TrangThaiBuoc | null) ?? 'PENDING',
    preview: laBan(r.preview) ?? {},
    outcome: laBan(r.outcome),
    errorCode: chuoi(r.error_code),
    refStep: so(r.ref_step),
    executedAt: chuoi(r.executed_at),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LẬP KẾ HOẠCH
// ─────────────────────────────────────────────────────────────────────────────

export interface BuocDeXuat {
  hanh_dong: ActionId;
  du_lieu: Record<string, unknown>;
}

export interface ThamSoTaoKeHoach {
  organizationId: string;
  clientRequestId: string;
  buoc: readonly BuocDeXuat[];
  threadId?: string | null;
  generation?: number;
}

export interface KetQuaTaoKeHoach {
  keHoach: KeHoach | null;
  /** Kế hoạch trả lại từ một lời gọi TRÙNG `client_request_id` (không có nonce mới). */
  daTonTai: boolean;
  maLoi: string | null;
  thongBao: string | null;
}

/** Hash chuỗi ổn định (djb2) — dùng dựng `client_request_id` cho một lượt chat. */
export function khoaYeuCau(phan: readonly (string | number)[]): string {
  const s = phan.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `plan_${(h >>> 0).toString(36)}_${s.length}`;
}

/**
 * Lập kế hoạch: gọi `copilot_plan_create_v1`, cất nonce, trả bản đã lược bỏ.
 *
 * TTL của khe nhớ lấy từ `expires_at` của SERVER, không phải một hằng số 5 phút
 * chép lại ở client: hai con số song song sẽ lệch nhau ở lần đầu server đổi hạn,
 * và cái lệch đó hiện ra dưới dạng "bấm Duyệt thì báo phiếu đồng ý đã quá hạn".
 */
export async function taoKeHoach(thamSo: ThamSoTaoKeHoach): Promise<KetQuaTaoKeHoach> {
  const { data, error } = await supabase.rpc('copilot_plan_create_v1', {
    p_organization_id: thamSo.organizationId,
    p_client_request_id: thamSo.clientRequestId,
    p_steps: thamSo.buoc.map((b) => ({ hanh_dong: b.hanh_dong, du_lieu: b.du_lieu })) as Json,
  });
  const phanHoi = docPhanHoi(data, error);
  if (phanHoi.maLoi) {
    return {
      keHoach: null,
      daTonTai: false,
      maLoi: phanHoi.maLoi,
      thongBao: dienGiaiLoiKeHoach(phanHoi.thongDiep ?? phanHoi.maLoi),
    };
  }
  const ban = phanHoi.ban as Record<string, unknown>;
  const keHoach = chuanHoaKeHoach(ban);
  if (!keHoach) {
    return {
      keHoach: null,
      daTonTai: false,
      maLoi: 'phan_hoi_khong_doc_duoc',
      thongBao: dienGiaiLoiKeHoach('phan_hoi_khong_doc_duoc'),
    };
  }

  const nonce = chuoi(ban.consent_nonce);
  const daTonTai = ban.da_ton_tai === true;
  const tuDuyet = keHoach.standingGrantIds !== null;
  if (nonce) {
    const conSong = keHoach.expiresAt ? Date.parse(keHoach.expiresAt) - Date.now() : NaN;
    datXacNhanDangCho(
      {
        kind: 'ke_hoach',
        tool: TOOL_KE_HOACH,
        nonce,
        // `canonical` của khe này KHÔNG phải payload của một hành động: kế hoạch
        // được nhận diện bằng cặp (id, digest), và digest là thứ `approve` so ba
        // vế. Giữ đúng hai trường đó, không hơn.
        canonical: { plan_id: keHoach.planId, plan_digest: keHoach.planDigest },
        preview: { ke_hoach: keHoach as unknown },
        organizationId: thamSo.organizationId,
        threadId: thamSo.threadId ?? null,
        ...(thamSo.generation === undefined ? {} : { generation: thamSo.generation }),
        intentKey: khoaYKeHoach(keHoach.planId),
      },
      Number.isFinite(conSong) && conSong > 0 ? conSong : 5 * 60_000,
    );
  } else if (tuDuyet) {
    // ĐIỂM NỐI #4 (G5-B). Không nonce nào phát ra — kế hoạch đã APPROVED ngay
    // lúc lập vì mọi bước được một hạn mức uỷ quyền đứng còn hiệu lực phủ.
    // `KeHoachCard` vẫn cần đọc được kế hoạch này từ khe nhớ để tự vẽ (nó
    // KHÔNG có đường nào khác tới `KeHoach` vừa dựng), nên khe vẫn được đặt —
    // chỉ khác `nonce: ''`: không có cú bấm nào để tiêu nó, và
    // `KeHoachCard` không bao giờ gọi `duyetKeHoach` cho một kế hoạch đã
    // APPROVED (nút Duyệt chỉ hiện khi `planStatus === 'DRAFT'`). TTL lấy từ
    // `executeDeadline` (30 phút, đã APPROVED) chứ không phải `expiresAt` (5
    // phút, hạn của DRAFT) — dùng nhầm hạn 5 phút sẽ làm thẻ biến mất khỏi
    // khe nhớ giữa lúc các bước còn đang chạy.
    const conSong = keHoach.executeDeadline
      ? Date.parse(keHoach.executeDeadline) - Date.now()
      : NaN;
    datXacNhanDangCho(
      {
        kind: 'ke_hoach',
        tool: TOOL_KE_HOACH,
        nonce: '',
        canonical: { plan_id: keHoach.planId, plan_digest: keHoach.planDigest },
        preview: { ke_hoach: keHoach as unknown },
        organizationId: thamSo.organizationId,
        threadId: thamSo.threadId ?? null,
        ...(thamSo.generation === undefined ? {} : { generation: thamSo.generation }),
        intentKey: khoaYKeHoach(keHoach.planId),
      },
      Number.isFinite(conSong) && conSong > 0 ? conSong : 30 * 60_000,
    );
  }

  return { keHoach, daTonTai, maLoi: null, thongBao: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// DUYỆT — chỗ DUY NHẤT tiêu nonce cấp kế hoạch
// ─────────────────────────────────────────────────────────────────────────────

export type LoaiDongY = 'click' | 'step_up' | 'standing_grant';

export interface KetQuaDuyet {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  planStatus: TrangThaiKeHoach | null;
  planVersion: number | null;
  /**
   * Loại đồng ý mà máy chủ ĐÃ ghi cho kế hoạch này: `click` (chỉ bấm duyệt),
   * `step_up` (kèm token PIN), `standing_grant` (server tự duyệt theo uỷ quyền
   * đứng — đường đó không đi qua hàm này). Đọc từ vỏ trả về của
   * `copilot_plan_approve_v1`, nơi nó cùng một biến với giá trị ghi vào hàng
   * `copilot_plans` và vào dòng sổ — nên đây là sự thật của máy chủ, không phải
   * suy đoán của client từ việc "có truyền token hay không".
   */
  consentKind: LoaiDongY | null;
  executeDeadline: string | null;
}

/**
 * Duyệt kế hoạch. CHỈ `KeHoachCard` gọi, sau một cú bấm thật của người dùng.
 *
 * Nonce lấy-và-xoá trong MỘT bước (`tieuXacNhan`): tách ra thì tồn tại một
 * khoảng mà nonce đã đọc nhưng chưa xoá, và hai cú bấm nhanh cầm cùng một nonce.
 * Không có nonce trong khe ⇒ không gọi RPC. Đó là lý do một dòng chữ do mô hình
 * sinh ra ("kế hoạch đã được người dùng duyệt") không mở được cửa này: nó không
 * đặt được gì vào `confirmationStore`.
 *
 * `stepUpToken` (G5-A, điểm nối #3): CHỈ cần cho kế hoạch có bước L5 dưới trần
 * L5. Nơi gọi lấy nó từ `stepUpClient.tieuTokenStepUp(organizationId)` NGAY
 * TRƯỚC khi gọi hàm này — cùng kỷ luật lấy-và-xoá với nonce cấp kế hoạch, nên
 * token cũng không nằm lâu hơn một lần bấm trong bộ nhớ của trình duyệt.
 */
export async function duyetKeHoach(
  planId: string,
  expectedVersion: number,
  planDigest: string,
  stepUpToken?: string,
): Promise<KetQuaDuyet> {
  const x = tieuXacNhan(Date.now(), khoaYKeHoach(planId), undefined, 'ke_hoach');
  if (!x) {
    return {
      ok: false,
      maLoi: 'confirmation_not_found',
      thongBao: dienGiaiLoiKeHoach('confirmation_not_found'),
      planStatus: null,
      planVersion: null,
      consentKind: null,
      executeDeadline: null,
    };
  }
  const { data, error } = await supabase.rpc('copilot_plan_approve_v1', {
    p_plan_id: planId,
    p_consent_nonce: x.nonce,
    p_plan_digest: planDigest,
    p_expected_plan_version: expectedVersion,
    ...(stepUpToken ? { p_step_up_token: stepUpToken } : {}),
  });
  const phanHoi = docPhanHoi(data, error);
  const ban = phanHoi.ban ?? {};
  return {
    ok: phanHoi.maLoi === null,
    maLoi: phanHoi.maLoi,
    thongBao: phanHoi.maLoi ? dienGiaiLoiKeHoach(phanHoi.thongDiep ?? phanHoi.maLoi) : null,
    planStatus: (chuoi(ban.plan_status) as TrangThaiKeHoach | null) ?? null,
    planVersion: so(ban.plan_version),
    consentKind: (chuoi(ban.consent_kind) as LoaiDongY | null) ?? null,
    executeDeadline: chuoi(ban.execute_deadline),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THỰC THI
// ─────────────────────────────────────────────────────────────────────────────

/** Hạn chờ MỘT bước ở phía client. Server không có hạn nào cho một lời gọi. */
export const HAN_MOI_BUOC_MS = 30_000;

export interface KetQuaBuoc {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  stepNo: number;
  stepStatus: TrangThaiBuoc | null;
  planStatus: TrangThaiKeHoach | null;
  planVersion: number | null;
  nextStepNo: number | null;
  /** `true` khi kết quả này ĐỌC LẠI từ server sau một lần quá hạn chờ. */
  doLaiSauHetGio?: boolean;
}

export async function thucThiBuoc(
  planId: string,
  stepNo: number,
  expectedVersion: number,
  organizationId: string,
): Promise<KetQuaBuoc> {
  const { data, error } = await supabase.rpc('copilot_plan_execute_step_v1', {
    p_plan_id: planId,
    p_step_no: stepNo,
    p_expected_plan_version: expectedVersion,
    p_organization_id: organizationId,
  });
  const phanHoi = docPhanHoi(data, error);
  const ban = phanHoi.ban ?? {};
  const buoc = laBan(ban.step) ?? {};
  return {
    ok: phanHoi.maLoi === null,
    maLoi: phanHoi.maLoi,
    thongBao: phanHoi.maLoi ? dienGiaiLoiKeHoach(phanHoi.thongDiep ?? phanHoi.maLoi) : null,
    stepNo,
    stepStatus: (chuoi(buoc.status) as TrangThaiBuoc | null) ?? null,
    planStatus: (chuoi(ban.plan_status) as TrangThaiKeHoach | null) ?? null,
    planVersion: so(ban.plan_version),
    nextStepNo: so(ban.next_step_no),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ĐỐI SOÁT (G5-C2, nhóm B) — bước `UNKNOWN_EFFECT` sau khi thực thi.
// ─────────────────────────────────────────────────────────────────────────────

export interface KetQuaDoiSoat {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  stepStatus: TrangThaiBuoc | null;
  planStatus: TrangThaiKeHoach | null;
  planVersion: number | null;
  nextStepNo: number | null;
}

/** Một lần hỏi `copilot_plan_reconcile_step_v1` — KHÔNG tự lặp lại. */
export async function doiSoatBuoc(
  planId: string,
  stepNo: number,
  expectedVersion: number,
): Promise<KetQuaDoiSoat> {
  const { data, error } = await supabase.rpc('copilot_plan_reconcile_step_v1', {
    p_plan_id: planId,
    p_step_no: stepNo,
    p_expected_plan_version: expectedVersion,
  });
  const phanHoi = docPhanHoi(data, error);
  const ban = phanHoi.ban ?? {};
  const buoc = laBan(ban.step) ?? {};
  return {
    ok: phanHoi.maLoi === null,
    maLoi: phanHoi.maLoi,
    thongBao: phanHoi.maLoi ? dienGiaiLoiKeHoach(phanHoi.thongDiep ?? phanHoi.maLoi) : null,
    stepStatus: (chuoi(buoc.status) as TrangThaiBuoc | null) ?? null,
    planStatus: (chuoi(ban.plan_status) as TrangThaiKeHoach | null) ?? null,
    planVersion: so(ban.plan_version),
    nextStepNo: so(ban.next_step_no),
  };
}

/** Số lần hỏi lại tối đa sau một bước `UNKNOWN_EFFECT`, cách nhau `NHIP_DOI_SOAT_MS`. */
export const SO_LAN_DOI_SOAT_TOI_DA = 5;
export const NHIP_DOI_SOAT_MS = 3_000;

export const TEXT_CHO_HIEU_UNG_NGOAI = 'đang chờ hiệu ứng ngoài';

function doi(ms: number): Promise<void> {
  return new Promise((giaiQuyet) => setTimeout(giaiQuyet, ms));
}

/**
 * Hỏi lại tối đa `SO_LAN_DOI_SOAT_TOI_DA` lần, cách nhau `NHIP_DOI_SOAT_MS`, cho
 * tới khi bước rời khỏi `UNKNOWN_EFFECT` (DONE/FAILED) hoặc hết lượt.
 *
 * Hết lượt mà VẪN `UNKNOWN_EFFECT` KHÔNG phải lỗi — worker ngoài tiến trình DB
 * (Zalo/Network Center) có thể mất hơn 15 giây. Trả về nguyên trạng, để lại
 * `TEXT_CHO_HIEU_UNG_NGOAI` cho người gọi tự quyết định hỏi tiếp hay không.
 */
export async function doiSoatChoToiDa(
  planId: string,
  stepNo: number,
  expectedVersion: number,
  tuyChon: { soLan?: number; nhipMs?: number; signal?: AbortSignal } = {},
): Promise<KetQuaDoiSoat> {
  const soLan = tuyChon.soLan ?? SO_LAN_DOI_SOAT_TOI_DA;
  const nhip = tuyChon.nhipMs ?? NHIP_DOI_SOAT_MS;
  let cuoi: KetQuaDoiSoat = {
    ok: true,
    maLoi: null,
    thongBao: null,
    stepStatus: 'UNKNOWN_EFFECT',
    planStatus: null,
    planVersion: expectedVersion,
    nextStepNo: null,
  };
  for (let i = 0; i < soLan; i += 1) {
    if (tuyChon.signal?.aborted) return cuoi;
    await doi(nhip);
    if (tuyChon.signal?.aborted) return cuoi;
    cuoi = await doiSoatBuoc(planId, stepNo, cuoi.planVersion ?? expectedVersion);
    if (!cuoi.ok || cuoi.stepStatus !== 'UNKNOWN_EFFECT') return cuoi;
  }
  return cuoi;
}

/** Ký hiệu "hết giờ chờ" — không phải một lỗi, và tuyệt đối không phải FAILED. */
const HET_GIO = Symbol('het_gio');

async function choToiDa<T>(viec: PromiseLike<T>, ms: number): Promise<T | typeof HET_GIO> {
  let hen: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      viec,
      new Promise<typeof HET_GIO>((giaiQuyet) => {
        hen = setTimeout(() => giaiQuyet(HET_GIO), ms);
      }),
    ]);
  } finally {
    if (hen !== undefined) clearTimeout(hen);
  }
}

export type LyDoDung = 'xong' | 'loi' | 'het_gio' | 'huy' | 'cho_hieu_ung_ngoai';

export interface KetQuaChay {
  buoc: KetQuaBuoc[];
  keHoach: KeHoach | null;
  ketThuc: LyDoDung;
  maLoi: string | null;
  thongBao: string | null;
}

/**
 * Chạy các bước còn lại, TUẦN TỰ, trong MỘT lời gọi tool.
 *
 * VÌ SAO KHÔNG ĐOÁN KHI HẾT GIỜ CHỜ
 *   30 giây trôi qua mà chưa có phản hồi KHÔNG có nghĩa là bước hỏng: một lời
 *   gọi có thể đã ghi xong ở server rồi mất phản hồi trên đường về. Đoán
 *   "FAILED" ở đây sẽ báo cho người dùng rằng không có gì được ghi trong khi
 *   phiếu đã nằm trong sổ, và đoán "DONE" thì ngược lại. Cách duy nhất đúng là
 *   HỎI: `copilot_plan_get_v1` trả trạng thái thật của đúng bước đó, và vòng lặp
 *   đi tiếp hay dừng theo câu trả lời ấy — chứ không theo phỏng đoán.
 */
export async function chayTuanTu(
  planId: string,
  organizationId: string,
  tuyChon: { signal?: AbortSignal; hanMoiBuocMs?: number } = {},
): Promise<KetQuaChay> {
  const han = tuyChon.hanMoiBuocMs ?? HAN_MOI_BUOC_MS;
  const dau = await docKeHoach(planId);
  if (!dau.keHoach) {
    return { buoc: [], keHoach: null, ketThuc: 'loi', maLoi: dau.maLoi, thongBao: dau.thongBao };
  }
  let ke: KeHoach = dau.keHoach;
  const daChay: KetQuaBuoc[] = [];

  if (ke.planStatus !== 'APPROVED') {
    return {
      buoc: [],
      keHoach: ke,
      ketThuc: 'loi',
      maLoi: 'plan_not_approved',
      thongBao: dienGiaiLoiKeHoach('plan_not_approved'),
    };
  }

  let version = ke.planVersion;
  let stepNo: number | null = buocKeTiep(ke)?.stepNo ?? null;
  let ketThuc: LyDoDung = 'xong';
  let maLoi: string | null = null;
  let thongBao: string | null = null;

  while (stepNo !== null) {
    if (tuyChon.signal?.aborted) {
      ketThuc = 'huy';
      break;
    }
    const kq = await choToiDa(thucThiBuoc(planId, stepNo, version, organizationId), han);

    if (kq === HET_GIO) {
      const doc = await docKeHoach(planId);
      if (!doc.keHoach) {
        ketThuc = 'het_gio';
        maLoi = doc.maLoi;
        thongBao = doc.thongBao;
        break;
      }
      ke = doc.keHoach;
      version = ke.planVersion;
      const that = ke.steps.find((b) => b.stepNo === stepNo);
      daChay.push({
        ok: that?.status === 'DONE',
        maLoi: that?.errorCode ?? null,
        thongBao: that?.errorCode ? dienGiaiLoiKeHoach(that.errorCode) : null,
        stepNo,
        stepStatus: that?.status ?? null,
        planStatus: ke.planStatus,
        planVersion: ke.planVersion,
        nextStepNo: buocKeTiep(ke)?.stepNo ?? null,
        doLaiSauHetGio: true,
      });
      // Bước đã xong thật trong lúc ta chờ ⇒ đi tiếp với phiên bản MỚI đọc được.
      if (that?.status === 'DONE' && ke.planStatus === 'APPROVED') {
        stepNo = buocKeTiep(ke)?.stepNo ?? null;
        continue;
      }
      ketThuc = 'het_gio';
      maLoi = that?.errorCode ?? 'het_gio_cho_buoc';
      thongBao = dienGiaiLoiKeHoach(maLoi);
      break;
    }

    daChay.push(kq);
    if (kq.planVersion !== null) version = kq.planVersion;
    if (!kq.ok) {
      ketThuc = 'loi';
      maLoi = kq.maLoi;
      thongBao = kq.thongBao;
      break;
    }

    // G5-C2 (nhóm B) — bước vừa thực thi XONG (ok=true) nhưng mang hiệu ứng
    // NGOÀI hệ (Zalo/Network Center) còn chưa rõ kết quả. `thucThiBuoc` đã trả
    // `nextStepNo=null` cho trường hợp này (kế hoạch không nhảy sang DONE khi
    // còn một bước UNKNOWN_EFFECT — xem engine), nên vòng lặp KHÔNG tự đi
    // tiếp: hỏi lại tối đa `SO_LAN_DOI_SOAT_TOI_DA` lần, cách nhau
    // `NHIP_DOI_SOAT_MS`, rồi dừng lại đúng nghĩa "đang chờ", không phải lỗi.
    if (kq.stepStatus === 'UNKNOWN_EFFECT') {
      const soat = await doiSoatChoToiDa(planId, stepNo, version, { signal: tuyChon.signal });
      if (soat.planVersion !== null) version = soat.planVersion;
      daChay.push({
        ok: soat.ok,
        maLoi: soat.maLoi,
        thongBao: soat.thongBao,
        stepNo,
        stepStatus: soat.stepStatus,
        planStatus: soat.planStatus,
        planVersion: soat.planVersion,
        nextStepNo: soat.nextStepNo,
      });
      if (!soat.ok) {
        ketThuc = 'loi';
        maLoi = soat.maLoi;
        thongBao = soat.thongBao;
        break;
      }
      if (soat.stepStatus === 'UNKNOWN_EFFECT') {
        ketThuc = 'cho_hieu_ung_ngoai';
        maLoi = null;
        thongBao = TEXT_CHO_HIEU_UNG_NGOAI;
        break;
      }
      stepNo = soat.nextStepNo;
      continue;
    }

    stepNo = kq.nextStepNo;
  }

  // Trạng thái CUỐI đọc từ server, không dựng lại từ các mảnh phản hồi: người
  // dùng nhìn thẻ này để biết cái gì đã vào sổ, và đó không phải chỗ để suy diễn.
  const cuoi = await docKeHoach(planId);
  return { buoc: daChay, keHoach: cuoi.keHoach ?? ke, ketThuc, maLoi, thongBao };
}

// ─────────────────────────────────────────────────────────────────────────────
// ĐỌC / HUỶ
// ─────────────────────────────────────────────────────────────────────────────

export interface KetQuaDoc {
  keHoach: KeHoach | null;
  maLoi: string | null;
  thongBao: string | null;
}

export async function docKeHoach(planId: string): Promise<KetQuaDoc> {
  const { data, error } = await supabase.rpc('copilot_plan_get_v1', { p_plan_id: planId });
  const phanHoi = docPhanHoi(data, error);
  if (phanHoi.maLoi) {
    return {
      keHoach: null,
      maLoi: phanHoi.maLoi,
      thongBao: dienGiaiLoiKeHoach(phanHoi.thongDiep ?? phanHoi.maLoi),
    };
  }
  const keHoach = chuanHoaKeHoach(phanHoi.ban);
  if (!keHoach) {
    return {
      keHoach: null,
      maLoi: 'phan_hoi_khong_doc_duoc',
      thongBao: dienGiaiLoiKeHoach('phan_hoi_khong_doc_duoc'),
    };
  }
  return { keHoach, maLoi: null, thongBao: null };
}

export interface KetQuaHuy {
  ok: boolean;
  maLoi: string | null;
  thongBao: string | null;
  planStatus: TrangThaiKeHoach | null;
  planVersion: number | null;
  soBuocBoQua: number | null;
}

/**
 * Huỷ kế hoạch. Dọn luôn khe nhớ: một phiếu đồng ý cho một kế hoạch đã huỷ chỉ
 * còn là một cái nút chết chờ người dùng bấm vào một lỗi.
 */
export async function huyKeHoach(
  planId: string,
  expectedVersion: number,
  reason: string,
): Promise<KetQuaHuy> {
  const { data, error } = await supabase.rpc('copilot_plan_cancel_v1', {
    p_plan_id: planId,
    p_expected_plan_version: expectedVersion,
    p_reason: reason,
  });
  const phanHoi = docPhanHoi(data, error);
  const ban = phanHoi.ban ?? {};
  if (phanHoi.maLoi === null) xoaXacNhanDangCho('ke_hoach');
  return {
    ok: phanHoi.maLoi === null,
    maLoi: phanHoi.maLoi,
    thongBao: phanHoi.maLoi ? dienGiaiLoiKeHoach(phanHoi.thongDiep ?? phanHoi.maLoi) : null,
    planStatus: (chuoi(ban.plan_status) as TrangThaiKeHoach | null) ?? null,
    planVersion: so(ban.plan_version),
    soBuocBoQua: so(ban.skipped),
  };
}
