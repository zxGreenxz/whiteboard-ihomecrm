// =============================================================================
// useLandlordSettlement — màn "Quyết toán vận hành" (toà vận hành cho chủ nhà,
// chủ chốt 21/10/2026) và link chỉ đọc /qt/:token cho chủ nhà.
//
// Mọi RPC quản trị chỉ chủ công ty / super admin gọi được — server là hàng rào thật
// (42501); giao diện chỉ hiển thị. Lỗi thì THROW để màn báo, không nuốt thành rỗng.
// Gói trả về đi qua zod (src/lib/landlordSettlement.ts): sai hình là lỗi, không đoán số.
// =============================================================================

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  closeReceiptSchema,
  landlordIhomeProfitSchema,
  landlordOperationOptionsSchema,
  landlordOperationsListSchema,
  linkCreateReceiptSchema,
  linkRevokeReceiptSchema,
  paymentReceiptSchema,
  reopenReceiptSchema,
  settlementMonthSchema,
  settlementOverviewSchema,
  settlementPublicSchema,
  shareLinksSchema,
  upsertReceiptSchema,
  voidReceiptSchema,
  type PaymentDirection,
} from '@/lib/landlordSettlement';

type LoiRpc = { code?: string; message: string; details?: string | null; hint?: string | null };

/**
 * Ranh giới kiểu cho RPC chưa có trong `types.ts` sinh tự động — migration
 * 20261021083438 chưa lên production nên generator chưa thấy các hàm này.
 * Khi migration đã áp production và `gen:types` chạy lại: đổi từng chỗ gọi sang
 * `supabase.rpc('<tên>', …)` có kiểu và XOÁ hàm bọc này (plan §8).
 * Tên RPC vẫn là chuỗi viết thẳng tại nơi gọi (check-rpc-name-literal).
 */
const goiRpcQuyetToan = (
  tenHam: string,
  args: Record<string, unknown>,
): PromiseLike<{ data: unknown; error: LoiRpc | null }> =>
  (supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: LoiRpc | null }>)(tenHam, args);

const KEY = 'landlord-settlement';

export const landlordSettlementKeys = {
  all: [KEY] as const,
  operations: () => [KEY, 'operations'] as const,
  options: (buildingId: string) => [KEY, 'options', buildingId] as const,
  month: (buildingId: string, month: string) => [KEY, 'month', buildingId, month] as const,
  overview: (buildingId: string) => [KEY, 'overview', buildingId] as const,
  links: (buildingId: string) => [KEY, 'links', buildingId] as const,
  ihome: (from: string, to: string) => [KEY, 'ihome', from, to] as const,
  public: (token: string, month: string | null) => [`${KEY}-public`, token, month ?? 'latest'] as const,
};

// ─────────────────────────────── đọc ───────────────────────────────

/** Toà đã cài vận hành + toà người dùng được phép cài (chỉ chủ công ty / super admin). */
export const useLandlordOperations = () =>
  useQuery({
    meta: { label: 'danh sách toà vận hành', errorDisplay: 'inline' },
    queryKey: landlordSettlementKeys.operations(),
    queryFn: async () => {
      const { data, error } = await goiRpcQuyetToan('landlord_operations_list_v1', {});
      if (error) throw error;
      return landlordOperationsListSchema.parse(data);
    },
    staleTime: 60_000,
  });

export const useLandlordOperationOptions = (buildingId: string | null) =>
  useQuery({
    meta: { label: 'cài đặt toà vận hành', errorDisplay: 'inline' },
    queryKey: landlordSettlementKeys.options(buildingId ?? ''),
    enabled: !!buildingId,
    queryFn: async () => {
      const { data, error } = await goiRpcQuyetToan('landlord_operation_options_v1', { p_building_id: buildingId });
      if (error) throw error;
      return landlordOperationOptionsSchema.parse(data);
    },
  });

/** month: 'YYYY-MM-01'. */
export const useLandlordSettlementMonth = (buildingId: string | null, month: string | null) =>
  useQuery({
    meta: { label: 'quyết toán tháng', errorDisplay: 'inline' },
    queryKey: landlordSettlementKeys.month(buildingId ?? '', month ?? ''),
    enabled: !!buildingId && !!month,
    queryFn: async () => {
      const { data, error } = await goiRpcQuyetToan('landlord_settlement_month_v1', {
        p_building_id: buildingId,
        p_month: month,
      });
      if (error) throw error;
      return settlementMonthSchema.parse(data);
    },
  });

export const useLandlordSettlementOverview = (buildingId: string | null) =>
  useQuery({
    meta: { label: 'tổng quyết toán', errorDisplay: 'inline' },
    queryKey: landlordSettlementKeys.overview(buildingId ?? ''),
    enabled: !!buildingId,
    queryFn: async () => {
      const { data, error } = await goiRpcQuyetToan('landlord_settlement_overview_v1', { p_building_id: buildingId });
      if (error) throw error;
      return settlementOverviewSchema.parse(data);
    },
  });

export const useLandlordShareLinks = (buildingId: string | null, enabled = true) =>
  useQuery({
    meta: { label: 'link cho chủ nhà', errorDisplay: 'inline' },
    queryKey: landlordSettlementKeys.links(buildingId ?? ''),
    enabled: !!buildingId && enabled,
    queryFn: async () => {
      const { data, error } = await goiRpcQuyetToan('landlord_share_links_v1', { p_building_id: buildingId });
      if (error) throw error;
      return shareLinksSchema.parse(data);
    },
  });

/**
 * Phần chủ nhà theo toà × tháng cho dòng "Lợi nhuận của iHome" trên Báo cáo LN (tháng chốt = số đã chốt,
 * tháng mở = số tạm tính). Chỉ toà người gọi xem được. from/to: 'YYYY-MM-01'.
 */
export const useLandlordIhomeProfit = (from: string | null, to: string | null) =>
  useQuery({
    meta: { label: 'lợi nhuận của iHome', errorDisplay: 'inline' },
    queryKey: landlordSettlementKeys.ihome(from ?? '', to ?? ''),
    enabled: !!from && !!to,
    queryFn: async () => {
      const { data, error } = await goiRpcQuyetToan('landlord_ihome_profit_v1', { p_from: from, p_to: to });
      if (error) throw error;
      return landlordIhomeProfitSchema.parse(data);
    },
    staleTime: 30_000,
  });

/**
 * Link chỉ đọc của chủ nhà — không cần đăng nhập. `null` = link sai hoặc đã thu hồi
 * (server trả NULL, không phân biệt hai trường hợp để không lộ link nào từng có).
 * month: 'YYYY-MM-01' hoặc null = tháng mới nhất.
 */
export const useLandlordSettlementPublic = (token: string, month: string | null) =>
  useQuery({
    meta: { label: 'quyết toán vận hành', errorDisplay: 'inline' },
    queryKey: landlordSettlementKeys.public(token, month),
    enabled: token.length > 0,
    queryFn: async () => {
      const { data, error } = await goiRpcQuyetToan('landlord_settlement_public_v1', {
        p_token: token,
        p_month: month,
      });
      if (error) throw error;
      return data === null ? null : settlementPublicSchema.parse(data);
    },
    staleTime: 60_000,
  });

// ─────────────────────────────── ghi ───────────────────────────────

function useInvalidateLandlord() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: landlordSettlementKeys.all });
}

export interface UpsertLandlordOperationInput {
  buildingId: string;
  landlordName: string;
  managerPercent: number;
  /** 'YYYY-MM-01' */
  effectiveFrom: string;
  landlordAccountIds: string[];
  note: string | null;
  isActive: boolean;
  /** Dương: chủ nhà còn phải trả quản lý từ trước tháng áp dụng; âm: ngược lại. Nguyên đồng. */
  openingBalance: number;
  /** Đã đối chiếu số dư đầu kỳ với chủ nhà (chưa xác nhận thì không chốt được tháng). */
  openingConfirmed: boolean;
  /** 'YYYY-MM-01' — % / sổ mới áp từ tháng này (null: server lấy ngay sau tháng chốt gần nhất). */
  termsFrom: string | null;
  /** Số cọc trước kỳ ở sổ chủ nhà mà màn đã hiện — server chỉ nhận xác nhận khi đúng số này. */
  openingSeenPreStart: number | null;
  /** updated_at của cấu hình lúc hộp NẠP nháp — người khác lưu sau đó thì server từ chối (40001). */
  expectedUpdatedAt: string | null;
}

export const useUpsertLandlordOperation = () => {
  const invalidate = useInvalidateLandlord();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: UpsertLandlordOperationInput) => {
      const { data, error } = await goiRpcQuyetToan('landlord_operation_upsert_v1', {
        p_building_id: input.buildingId,
        p_landlord_name: input.landlordName,
        p_manager_percent: input.managerPercent,
        p_effective_from: input.effectiveFrom,
        p_landlord_account_ids: input.landlordAccountIds,
        p_note: input.note,
        p_is_active: input.isActive,
        p_opening_balance: input.openingBalance,
        p_opening_confirmed: input.openingConfirmed,
        p_terms_from: input.termsFrom,
        p_opening_seen_pre_start: input.openingSeenPreStart,
        p_expected_updated_at: input.expectedUpdatedAt,
      });
      if (error) throw error;
      const receipt = upsertReceiptSchema.parse(data);
      if (receipt.building_id !== input.buildingId) throw new TypeError('Chưa xác nhận được cài đặt toà');
      return receipt;
    },
    onSuccess: () => invalidate(),
  });
};

export const useCloseLandlordMonth = () => {
  const invalidate = useInvalidateLandlord();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { buildingId: string; month: string; expectedHash: string; note: string | null }) => {
      const { data, error } = await goiRpcQuyetToan('landlord_settlement_close_v1', {
        p_building_id: input.buildingId,
        p_month: input.month,
        p_expected_hash: input.expectedHash,
        p_note: input.note,
      });
      if (error) throw error;
      return closeReceiptSchema.parse(data);
    },
    onSettled: () => invalidate(),
  });
};

export const useReopenLandlordMonth = () => {
  const invalidate = useInvalidateLandlord();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { buildingId: string; month: string; reason: string }) => {
      const { data, error } = await goiRpcQuyetToan('landlord_settlement_reopen_v1', {
        p_building_id: input.buildingId,
        p_month: input.month,
        p_reason: input.reason,
      });
      if (error) throw error;
      return reopenReceiptSchema.parse(data);
    },
    onSettled: () => invalidate(),
  });
};

export interface AddLandlordPaymentInput {
  buildingId: string;
  /** 'YYYY-MM-DD' */
  paidOn: string;
  direction: PaymentDirection;
  amount: number;
  note: string | null;
  /** Sinh một lần khi mở hộp thoại; bấm lại sau lỗi mạng giữ nguyên khoá. */
  idempotencyKey: string;
}

export const useAddLandlordPayment = () => {
  const invalidate = useInvalidateLandlord();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: AddLandlordPaymentInput) => {
      const { data, error } = await goiRpcQuyetToan('landlord_settlement_add_payment_v1', {
        p_building_id: input.buildingId,
        p_paid_on: input.paidOn,
        p_direction: input.direction,
        p_amount: input.amount,
        p_note: input.note,
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return paymentReceiptSchema.parse(data);
    },
    // lỗi mạng vẫn có thể là server ĐÃ ghi ⇒ nạp lại danh sách cả khi lỗi để thấy khoản đã ghi
    onSettled: () => invalidate(),
  });
};

export const useVoidLandlordPayment = () => {
  const invalidate = useInvalidateLandlord();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { paymentId: string; reason: string }) => {
      const { data, error } = await goiRpcQuyetToan('landlord_settlement_void_payment_v1', {
        p_payment_id: input.paymentId,
        p_reason: input.reason,
      });
      if (error) throw error;
      return voidReceiptSchema.parse(data);
    },
    onSuccess: () => invalidate(),
  });
};

export const useCreateLandlordShareLink = () => {
  const invalidate = useInvalidateLandlord();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { buildingId: string; label: string | null }) => {
      const { data, error } = await goiRpcQuyetToan('landlord_share_link_create_v1', {
        p_building_id: input.buildingId,
        p_label: input.label,
      });
      if (error) throw error;
      return linkCreateReceiptSchema.parse(data);
    },
    onSuccess: () => invalidate(),
  });
};

export const useRevokeLandlordShareLink = () => {
  const invalidate = useInvalidateLandlord();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { token: string }) => {
      const { data, error } = await goiRpcQuyetToan('landlord_share_link_revoke_v1', { p_token: input.token });
      if (error) throw error;
      return linkRevokeReceiptSchema.parse(data);
    },
    onSuccess: () => invalidate(),
  });
};
