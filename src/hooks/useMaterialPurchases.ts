import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { friendlyError } from '@/lib/friendlyError';
import type { Material, MaterialPurchase, MaterialPurchaseItem } from '@/types/material';
import { confirmedRecordBatch, repeatableWrite } from '@/lib/recordWriteOutcome';
import { confirmedMaterialVoucherId, createMaterialVoucherOnce, materialLinesRewriteError, materialVoucherFailureMessage, sameVoucherHeader, materialVoucherMatchKeys } from '@/lib/materialVoucherOutcome';
import { useOrganization } from '@/contexts/OrganizationContext';
import { withOrg, withOrgAll } from '@/lib/orgPayload';

export interface MaterialPurchaseWithItems extends MaterialPurchase {
  supplier: { id: string; name: string } | null;
  items: (MaterialPurchaseItem & { material: Pick<Material, 'id' | 'name' | 'unit'> | null })[];
}
interface PurchaseInput {
  purchase_date: string;
  supplier_id: string | null;
  notes: string | null;
  items: Array<{ material_id: string; quantity: number; unit_price: number }>;
  /** Mã bản nháp của form tạo (không gửi lên máy chủ): các lần bấm của cùng bản nháp là cùng một phiếu. */
  draft?: string;
}
const KEY = ['material-purchases'] as const;
export const useMaterialPurchases = (filters: { from?: string; to?: string } = {}) => useQuery({
  queryKey: [...KEY, 'list', filters],
  queryFn: async (): Promise<MaterialPurchaseWithItems[]> => {
    // hermes-parity:begin w2c-material-purchases — Hermes chép vùng này (public.materials_purchases_v1)
    let q = supabase.from('material_purchases' as any).select('*, supplier:suppliers(id,name), items:material_purchase_items(*, material:materials(id,name,unit))').order('purchase_date', { ascending: false }).order('created_at', { ascending: false });
    if (filters.from) q = q.gte('purchase_date', filters.from);
    if (filters.to) q = q.lte('purchase_date', filters.to);
    // hermes-parity:end w2c-material-purchases
    const { data, error } = await q;
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách phiếu nhập. Tải lại để kiểm tra.');
    return data as unknown as MaterialPurchaseWithItems[];
  },
});
export const useCreateMaterialPurchase = () => {
  const qc = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    // Đợt 9 (cách D): không giữ dấu «chờ đối chiếu»; đầu phiếu và dòng mang mã do trình duyệt sinh (xem
    // `createMaterialVoucherOnce`). Kết quả chưa rõ báo rõ, form không khoá; bấm lại dùng lại đúng phiếu, đúng các mã dòng
    // nên tồn và giá vốn (trigger tính lại từ mọi dòng) không cộng hai lần.
    mutationFn: async (input: PurchaseInput): Promise<MaterialPurchase & { replayed: boolean }> => {
      const { getSessionUser } = await import('@/lib/authSession');
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      const headerPayload = withOrg({ purchase_date: input.purchase_date, supplier_id: input.supplier_id, notes: input.notes }, selectedOrganizationId);
      const compare = ['material_id', 'quantity', 'unit_price'] as const;
      const created = await repeatableWrite('tạo phiếu nhập', () => createMaterialVoucherOnce<MaterialPurchase>({
        headerTable: 'material_purchases', lineTable: 'material_purchase_items', parentColumn: 'purchase_id', noun: 'Phiếu nhập', operation: 'tạo phiếu nhập',
        userId: user.id, organizationId: selectedOrganizationId ?? '',
        matchKeys: materialVoucherMatchKeys(input.draft, [input.purchase_date, input.supplier_id, input.notes], input.items, compare),
        headerPayload, sameHeader: row => sameVoucherHeader(row, headerPayload, ['purchase_date', 'supplier_id', 'notes']),
        items: input.items, compare,
        buildLines: header => withOrgAll(input.items.map(row => ({ purchase_id: header.id, material_id: row.material_id, quantity: row.quantity, unit_price: row.unit_price })), header.organization_id as string | null | undefined),
      }));
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'material-purchase', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return { ...created.header, replayed: created.replayed };
    },
    onSuccess: purchase => { refresh(); toast.success(purchase.replayed ? `Phiếu nhập ${purchase.code ?? ''} đã được lưu ở lần bấm trước (mã ${purchase.id}); không ghi thêm.` : 'Đã tạo phiếu nhập kho'); },
    onError: error => { refresh(); toast.error('Chưa hoàn tất tạo phiếu nhập', { description: materialVoucherFailureMessage(error, 'tạo phiếu nhập') }); },
  });
};
/**
 * Một lượt SỬA phiếu nhập, CHẠY LẠI ĐƯỢC: đặt ngày / nhà cung cấp / ghi chú theo mã phiếu, xoá MỌI dòng cũ rồi chèn đúng
 * bộ dòng đang nhập. Production (đọc 26/11/2026): tổng phiếu (material_purchase_recompute_total) và tồn kho / giá vốn bình
 * quân (recompute_material_stock) do trigger TÍNH LẠI từ toàn bộ dòng đang có, không cộng dồn; phiếu nhập không sinh phiếu
 * chi hay bút toán nào. Nên chạy lại cùng nội dung cho cùng kết quả: không nhân đôi dòng, tồn và tổng không cộng hai lần.
 * Chưa nguyên tử (đợt 10): hỏng SAU khi đã xoá thì phiếu tạm không còn dòng nào (tồn kho tính như vậy) tới lần bấm
 * «Cập nhật» lại; câu báo nói rõ điều đó.
 */
async function replaceMaterialPurchase(id: string, input: PurchaseInput): Promise<void> {
  // Khớp 0 dòng (đã xoá / không có quyền sửa) ⇒ PGRST116: từ chối rõ, chưa xoá dòng nào.
  const { data: header, error } = await supabase.from('material_purchases' as any).update({ purchase_date: input.purchase_date, supplier_id: input.supplier_id, notes: input.notes }).eq('id', id).select('id, organization_id').single();
  if (error) throw error;
  confirmedMaterialVoucherId(header, id);
  try {
    const { data: removed, error: removeError } = await supabase.from('material_purchase_items' as any).delete().eq('purchase_id', id).select('id');
    if (removeError) throw removeError;
    // Biên nhận xoá sai dạng ⇒ chưa rõ: dừng, không chèn dòng mới lên trên.
    confirmedRecordBatch(removed, Array.isArray(removed) ? removed.length : 0, 'xóa dòng phiếu nhập cũ');
  } catch (removeError) {
    throw materialLinesRewriteError(null, 'Cập nhật', removeError);
  }
  if (input.items.length === 0) return;
  const lines = input.items.map(row => ({ purchase_id: id, material_id: row.material_id, quantity: row.quantity, unit_price: row.unit_price }));
  const headerOrg = (header as unknown as { organization_id?: string | null } | null)?.organization_id;
  try {
    const { data, error: lineError } = await supabase.from('material_purchase_items' as any).insert(withOrgAll(lines, headerOrg)).select('id');
    if (lineError) throw lineError;
    confirmedRecordBatch(data, input.items.length, 'lưu dòng phiếu nhập mới');
  } catch (lineError) {
    throw materialLinesRewriteError('Đã xoá các dòng cũ của phiếu nhập', 'Cập nhật', lineError);
  }
}
export const useUpdateMaterialPurchase = () => {
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); };
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: PurchaseInput }) => {
      // Đợt 8 (luật 5, cách A): đường SỬA không giữ dấu; kết quả chưa rõ báo rõ, form không khoá, bấm lại ghi lại.
      // Đường TẠO phiếu nhập (cùng namespace, khoá `create`) không giữ dấu từ đợt 9 (cách D, mã do trình duyệt sinh).
      await repeatableWrite('cập nhật phiếu nhập', () => replaceMaterialPurchase(id, input));
      try {
        const { forgetLegacyPending } = await import('@/lib/legacyPendingExit');
        await forgetLegacyPending({ namespace: 'material-purchase', businessKey: `update:${id}` });
      } catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần sửa sau gỡ lại. */ }
    },
    onSuccess: () => { refresh(); toast.success('Đã cập nhật phiếu nhập'); },
    onError: error => { refresh(); toast.error('Chưa hoàn tất cập nhật phiếu nhập', { description: materialVoucherFailureMessage(error, 'cập nhật phiếu nhập') }); },
  });
};
export const useDeleteMaterialPurchase = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.from('material_purchases' as any).delete().eq('id', id).select('id').single();
      if (error) throw error;
      if ((data as { id?: string } | null)?.id !== id) throw new Error('Chưa xác nhận được phiếu nhập đã xóa. Tải lại danh sách để kiểm tra.');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['materials'] }); toast.success('Đã xoá phiếu nhập'); },
    onError: error => { const feedback = friendlyError(error, 'Chưa xóa được phiếu nhập', { operation: 'xóa phiếu nhập' }); toast.error(feedback.title, { description: feedback.description }); },
  });
};
