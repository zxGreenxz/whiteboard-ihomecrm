import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { friendlyError } from '@/lib/friendlyError';
import type { Material, MaterialAdjustment, MaterialAdjustmentItem } from '@/types/material';
import { todayISO } from '@/lib/collect';
import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { repeatableWrite } from '@/lib/recordWriteOutcome';
import { createMaterialVoucherOnce, materialVoucherFailureMessage, sameVoucherHeader, materialVoucherMatchKeys } from '@/lib/materialVoucherOutcome';
import { useOrganization } from '@/contexts/OrganizationContext';
import { withOrg, withOrgAll } from '@/lib/orgPayload';
export interface MaterialAdjustmentWithItems extends MaterialAdjustment {
  items: (MaterialAdjustmentItem & { material: Pick<Material, 'id' | 'name' | 'unit'> | null })[];
}
const KEY = ['material-adjustments'] as const;
export const useMaterialAdjustments = () => useQuery({
  queryKey: [...KEY, 'list'],
  queryFn: async (): Promise<MaterialAdjustmentWithItems[]> => {
    // hermes-parity:begin w2c-material-adjustments — Hermes chép vùng này (public.materials_adjustments_v1)
    const { data, error } = await supabase.from('material_adjustments' as any).select('*, items:material_adjustment_items(*, material:materials(id,name,unit))').order('adjustment_date', { ascending: false }).order('created_at', { ascending: false });
    // hermes-parity:end w2c-material-adjustments
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách phiếu kiểm kê. Tải lại để kiểm tra.');
    return data as unknown as MaterialAdjustmentWithItems[];
  },
});
interface AdjustmentInput {
  adjustment_date: string;
  type: 'IN' | 'OUT';
  reason: string | null;
  items: Array<{ material_id: string; quantity: number }>;
  /** Mã bản nháp của form tạo (không gửi lên máy chủ): các lần bấm của cùng bản nháp là cùng một phiếu. */
  draft?: string;
}
type CreatedAdjustment = MaterialAdjustment & { /** Lần bấm trước đã ghi trọn phiếu này; lần này không ghi thêm. */ replayed: boolean };
const adjustmentLabel = (row: { code?: string | null; id: string }) => `Phiếu kiểm kê${row.code ? ` ${row.code}` : ''} (mã ${row.id})`;

export const useCreateMaterialAdjustment = () => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    // Đợt 9 (cách D): không giữ dấu «chờ đối chiếu»; đầu phiếu và dòng mang mã do trình duyệt sinh (xem
    // `createMaterialVoucherOnce`). Bấm lại dùng lại đúng phiếu, đúng các mã dòng: tồn (trigger tính lại) không cộng hai lần.
    mutationFn: async (input: AdjustmentInput): Promise<CreatedAdjustment> => {
      const { getSessionUser } = await import('@/lib/authSession');
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      const headerPayload = withOrg({ adjustment_date: input.adjustment_date, type: input.type, reason: input.reason }, selectedOrganizationId);
      const compare = ['material_id', 'quantity'] as const;
      const created = await repeatableWrite('tạo phiếu kiểm kê', () => createMaterialVoucherOnce<MaterialAdjustment>({
        headerTable: 'material_adjustments', lineTable: 'material_adjustment_items', parentColumn: 'adjustment_id', noun: 'Phiếu kiểm kê', operation: 'tạo phiếu kiểm kê',
        userId: user.id, organizationId: selectedOrganizationId ?? '',
        matchKeys: materialVoucherMatchKeys(input.draft, [input.adjustment_date, input.type, input.reason], input.items, compare),
        headerPayload, sameHeader: row => sameVoucherHeader(row, headerPayload, ['adjustment_date', 'type', 'reason']),
        items: input.items, compare,
        buildLines: header => withOrgAll(input.items.map(row => ({ adjustment_id: header.id, material_id: row.material_id, quantity: row.quantity })), header.organization_id as string | null | undefined),
      }));
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'material-adjustment', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return { ...created.header, replayed: created.replayed };
    },
    onSuccess: adjustment => { refresh(); toast.success(adjustment.replayed ? `${adjustmentLabel(adjustment)} đã được lưu ở lần bấm trước; không ghi thêm.` : 'Đã tạo phiếu kiểm kê'); },
    onError: error => { refresh(); toast.error('Chưa hoàn tất tạo phiếu kiểm kê', { description: materialVoucherFailureMessage(error, 'tạo phiếu kiểm kê') }); },
  });
};

interface SetStockInput { material_id: string; target_quantity: number; reason?: string }
/** Làm tròn số lượng tới 6 chữ số thập phân: phần chênh không mang sai số dấu phẩy động (0,3 − 0,1) lên máy chủ. */
const roundQuantity = (value: number) => Math.round(value * 1e6) / 1e6;

/** Tồn hiện tại của vật tư trên máy chủ (`materials.on_hand`, trigger tính lại từ mọi dòng). Đọc hỏng ⇒ lỗi, không đoán. */
async function readServerStock(materialId: string): Promise<number> {
  const { data, error } = await supabase.from('materials' as any).select('id, on_hand').eq('id', materialId).maybeSingle();
  if (error) throw error;
  if (!data) throw new FinancialWorkflowError('Không tìm thấy vật tư này trên máy chủ (đã xoá hoặc tài khoản không xem được). Tải lại danh sách vật tư rồi kiểm kê lại.', 'failure', []);
  const row = data as unknown as { id?: unknown; on_hand?: unknown };
  const raw = row.on_hand;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (row.id !== materialId || !Number.isFinite(value)) throw new FinancialWorkflowError('Chưa đọc được tồn kho hiện tại của vật tư.', 'unknown', []);
  return value;
}

/**
 * Đợt 9 (cách C): đặt tồn theo số kiểm đếm. Phiếu kiểm kê là phép CỘNG DỒN vào tồn (một phiếu IN/OUT theo phần chênh) nên
 * KHÔNG BAO GIỜ gửi lại số chênh cũ: mỗi lần bấm đọc tồn hiện tại TRÊN MÁY CHỦ rồi tính lại phần chênh (không dùng số tồn
 * của màn). Phiếu ghi bằng mã do trình duyệt sinh, khoá theo vật tư: lần bấm lại sau một lần chưa rõ dùng lại đúng phiếu và
 * đúng mã dòng của lần trước, nên dòng cũ tới máy chủ trễ cũng chỉ thành MỘT dòng. Dòng đã có từ trước (lần bấm trước, lệnh
 * cũ tới trễ) ⇒ tồn đọc lúc đầu có thể chưa gồm nó: đọc lại tồn, về đúng số kiểm đếm thì xong, lệch thì báo mã phiếu trước
 * và KHÔNG ghi thêm trong lần bấm này (lần bấm sau là lượt mới, đọc tồn đã gồm phiếu đó).
 */
async function setStockOnce(input: SetStockInput, userId: string, selectedOrganizationId: string | null): Promise<CreatedAdjustment | null> {
  const materialId = input.material_id;
  const target = input.target_quantity;
  const organizationId = selectedOrganizationId ?? '';
  const matchKeys = [`set:${materialId}`];
  const before = await readServerStock(materialId);
  const delta = roundQuantity(target - before);
  if (delta === 0) {
    // Tồn đã khớp (có thể nhờ lần bấm trước): không ghi gì; lần đặt tồn sau của vật tư này là lượt mới.
    const memory = await import('@/lib/clientRecordCreate');
    const prior = memory.pickClientId('material_adjustments', userId, organizationId, matchKeys);
    if (prior.reused) memory.forgetUnconfirmed('material_adjustments', userId, organizationId, prior.id);
    return null;
  }
  const type = delta > 0 ? 'IN' : 'OUT';
  const quantity = Math.abs(delta);
  const headerPayload = withOrg({ adjustment_date: todayISO(), type, reason: input.reason ?? 'Kiểm kê — đặt lại tồn' }, selectedOrganizationId);
  const created = await createMaterialVoucherOnce<MaterialAdjustment>({
    headerTable: 'material_adjustments', lineTable: 'material_adjustment_items', parentColumn: 'adjustment_id', noun: 'Phiếu kiểm kê', operation: 'điều chỉnh tồn kho',
    userId, organizationId, matchKeys, headerPayload,
    // Phiếu của lần bấm trước khác chiều (IN/OUT) ⇒ không dùng lại: báo mã phiếu đó, lần bấm sau đọc tồn lại từ đầu.
    sameHeader: row => row.type === type,
    items: [{ material_id: materialId, quantity }], compare: ['material_id', 'quantity'],
    buildLines: header => withOrgAll([{ adjustment_id: header.id, material_id: materialId, quantity }], header.organization_id as string | null | undefined),
  });
  const adjustment = created.header;
  if (!created.linesFromRead) return { ...adjustment, replayed: false };
  let after: number;
  try { after = await readServerStock(materialId); }
  catch (error) {
    throw new RepeatableWriteUnknownError('kiểm tra tồn kho sau khi đặt', error, [{ id: adjustment.id, label: `${adjustmentLabel(adjustment)} đã lưu` }],
      `${adjustmentLabel(adjustment)} đã được lưu. Bấm lại để kiểm tra: máy đọc lại tồn hiện tại và chỉ ghi phần chênh còn thiếu.`);
  }
  if (roundQuantity(after - target) === 0) return { ...adjustment, replayed: created.replayed };
  throw new FinancialAlreadyRecordedError(
    `${adjustmentLabel(adjustment)} của lần bấm trước đã được lưu, nhưng tồn hiện tại là ${after}, khác số kiểm đếm ${target} (có phiếu khác ghi sau đó). Bấm lại nếu vẫn muốn đặt tồn về ${target}: máy đọc lại tồn và chỉ ghi phần chênh mới.`,
    [adjustment.id],
  );
}

export const useSetMaterialStock = (options: { silent?: boolean } = {}) => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async (input: SetStockInput): Promise<CreatedAdjustment | null> => {
      const { getSessionUser } = await import('@/lib/authSession');
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      const result = await repeatableWrite('điều chỉnh tồn kho', () => setStockOnce(input, user.id, selectedOrganizationId));
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'material-adjustment', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần đặt tồn sau gỡ lại. */ }
      return result;
    },
    onSuccess: data => { refresh(); if (!options.silent) { if (data?.replayed) toast.success(`Tồn kho đã được cập nhật ở lần bấm trước (${adjustmentLabel(data)}); không ghi thêm.`); else if (data) toast.success('Đã cập nhật tồn kho theo kiểm kê'); else toast.info('Tồn đã khớp — không cần điều chỉnh'); } },
    onError: error => { refresh(); if (!options.silent) toast.error('Chưa hoàn tất điều chỉnh tồn kho', { description: materialVoucherFailureMessage(error, 'điều chỉnh tồn kho') }); },
  });
};
export const useDeleteMaterialAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.from('material_adjustments' as any).delete().eq('id', id).select('id').single();
      if (error) throw error;
      if ((data as { id?: string } | null)?.id !== id) throw new Error('Chưa xác nhận được phiếu kiểm kê đã xóa. Tải lại danh sách để kiểm tra.');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); toast.success('Đã xoá phiếu kiểm kê'); },
    onError: error => { const feedback = friendlyError(error, 'Chưa xóa được phiếu kiểm kê', { operation: 'xóa phiếu kiểm kê' }); toast.error(feedback.title, { description: feedback.description }); },
  });
};
