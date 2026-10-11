import { z } from 'zod';

export const COMMISSION_REASON_MIN = 8;
export const COMMISSION_REASON_MAX = 2000;
export const COMMISSION_REASON_MESSAGE = 'Nhập lý do cụ thể từ 8 đến 2.000 ký tự để lưu lịch sử hoa hồng.';
export function isCommissionReasonValid(reason: string | null | undefined): boolean {
  const length = reason?.trim().length ?? 0;
  return length >= COMMISSION_REASON_MIN && length <= COMMISSION_REASON_MAX;
}

const snapshotSchema = z.record(z.unknown()).nullable();
export const commissionInterventionSchema = z.object({
  id: z.string().uuid(), stage: z.string().min(1), reason: z.string().nullable(),
  actor_id: z.string().uuid().nullable(), actor_name: z.string().nullable(), at: z.string().datetime({ offset: true }),
  before: snapshotSchema, after: snapshotSchema, baseline: snapshotSchema,
});
export const commissionInterventionsSchema = z.array(commissionInterventionSchema);
export type CommissionIntervention = z.infer<typeof commissionInterventionSchema>;

export const COMMISSION_STAGE_LABELS: Record<string, string> = {
  CREATE: 'Lập phiếu hoa hồng', PREPARE: 'Xác nhận yêu cầu tạo hoa hồng',
  CREATE_OVERRIDE: 'Lập phiếu khác cấu hình', EDIT_PENDING: 'Sửa phiếu chờ duyệt',
  ASSIGN_MANAGER: 'Gán hoặc đổi quản lý nhận hoa hồng', ANNOTATE: 'Bổ sung hoặc sửa ghi chú, chứng từ',
  APPROVE: 'Duyệt phiếu', UNAPPROVE: 'Bỏ duyệt phiếu', CANCEL: 'Hủy phiếu', RESTORE: 'Khôi phục phiếu',
  BUILDING_CONFIG: 'Đổi cấu hình hoa hồng tòa nhà', CONTRACT_BASIS: 'Đổi căn cứ tính hoa hồng trên hợp đồng',
  CONFIG_CHANGED: 'Đổi cấu hình hoa hồng tòa nhà', CONTRACT_CHANGED: 'Đổi căn cứ tính hoa hồng trên hợp đồng',
  CREATE_WITH_SUPPORT: 'Lập hoa hồng có khấu trừ hỗ trợ thuê', CREATE_FROM_DEPOSIT: 'Lập thưởng Sale từ phiếu cọc',
  CREATE_TRANSFER: 'Lập hoa hồng chuyển phòng', AUTO_APPROVE: 'Tự động duyệt khi lập phiếu', AUTO_POST: 'Tự động ghi sổ khi lập phiếu',
  PUBLISHED_TIER: 'Công bố phiên bản cấu hình hoa hồng', PUBLISHED_SALE_CAP: 'Công bố giới hạn thưởng Sale',
  ADOPT_DEPOSIT_BONUS: 'Gắn thưởng Sale từ phiếu cọc vào hợp đồng',
  SETTLED_BY_SUPPORT: 'Đã cấn trừ toàn bộ vào hỗ trợ',
  REPREPARE: 'Lập lại yêu cầu tạo hoa hồng', REVERSE: 'Hoàn tác ghi sổ hoa hồng', POST: 'Ghi sổ thanh toán', REVIEW: 'Kiểm tra phiếu',
  NOT_APPLICABLE: 'Ghi nhận không phát sinh hoa hồng', REOPENED: 'Mở lại khoản hoa hồng',
};

export interface CommissionBasis {
  room_id?: string | null;
  rent_price?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

/** Compare the basis visible in the editor; the database repeats this check on the locked row. */
export function hasCommissionBasisChange(before: CommissionBasis, after: CommissionBasis): boolean {
  return (before.room_id ?? null) !== (after.room_id ?? null)
    || Number(before.rent_price ?? 0) !== Number(after.rent_price ?? 0)
    || (before.start_date?.slice(0, 10) ?? '') !== (after.start_date?.slice(0, 10) ?? '')
    || (before.end_date?.slice(0, 10) ?? '') !== (after.end_date?.slice(0, 10) ?? '');
}

const tiersSchema = z.array(z.object({ min_months: z.number(), max_months: z.number(), rate_percent: z.number() }));
export function hasCommissionTierChange(before: unknown, after: unknown): boolean {
  const oldTiers = tiersSchema.safeParse(before);
  const newTiers = tiersSchema.safeParse(after);
  if (!oldTiers.success || !newTiers.success) return JSON.stringify(before) !== JSON.stringify(after);
  // Preserve array order: overlapping tiers use the first match.
  return JSON.stringify(oldTiers.data) !== JSON.stringify(newTiers.data);
}
