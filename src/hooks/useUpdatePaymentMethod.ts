// =============================================
// useUpdatePaymentMethod
// Đổi phương thức thanh toán (TM/TT/TK) của 1 phiếu thu đã tồn tại
// và đồng bộ sổ quỹ tương ứng trong income_expenses.
//
// Resolution sổ quỹ giống RecordPaymentDialog.accountIdForMethod:
//   - TM: sổ "...Thu" của user tạo phiếu → fallback "Chung"
//   - TT: building.default_account_id_tt  → fallback account name = building.name
//   - TK: building.default_account_id_tk  → fallback account name = building.name
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

type PaymentMethod = 'TM' | 'TT' | 'TK';

interface UpdatePaymentMethodData {
  payment_id: string;
  new_method: PaymentMethod;
}

export const useUpdatePaymentMethod = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ payment_id, new_method }: UpdatePaymentMethodData) => {
      // 1. Lấy payment + invoice + building config
      const { data: payment, error: pErr } = await (supabase as any)
        .from('payments')
        .select(`
          id, user_id, payment_method, invoice_id, collection_id,
          invoice:invoice_id (
            id,
            building:building_id (
              id, name, default_account_id_tt, default_account_id_tk
            )
          )
        `)
        .eq('id', payment_id)
        .single();
      if (pErr || !payment) throw pErr ?? new Error('Không tìm thấy phiếu thu');

      if (payment.collection_id) {
        throw new Error(
          'Lần thu V5 đã khóa phương thức và sổ quỹ. Hãy hoàn tác toàn bộ collection rồi ghi nhận lại đúng phương thức.',
        );
      }

      if (payment.payment_method === new_method) {
        return { skipped: true as const };
      }

      const building = payment.invoice?.building ?? null;
      const buildingName: string = (building?.name ?? '').toString().trim();
      const buildingDefaultTT: string | null = building?.default_account_id_tt ?? null;
      const buildingDefaultTK: string | null = building?.default_account_id_tk ?? null;

      // 2. Resolve sổ quỹ mới
      let newAccountId: string | null = null;

      if (new_method === 'TM') {
        // Sổ "...Thu" của user đã tạo phiếu (joey/nathan/…)
        const { data: ownThu } = await (supabase as any)
          .from('accounts')
          .select('id, name, is_virtual')
          .eq('user_id', payment.user_id)
          .eq('is_virtual', false)
          .is('deleted_at', null);
        newAccountId =
          (ownThu as any[] | null)?.find(
            (a) =>
              typeof a?.name === 'string' &&
              a.name.trim().toLowerCase().endsWith('thu'),
          )?.id ?? null;

        if (!newAccountId) {
          // Fallback: sổ "Chung"
          const { data: chung } = await (supabase as any)
            .from('accounts')
            .select('id, name, is_virtual')
            .ilike('name', 'chung')
            .eq('is_virtual', false)
            .is('deleted_at', null)
            .limit(1);
          newAccountId = (chung as any[] | null)?.[0]?.id ?? null;
        }
      } else {
        // TT/TK: ưu tiên cài đặt toà nhà, sau đó match-by-name
        newAccountId = new_method === 'TT' ? buildingDefaultTT : buildingDefaultTK;

        if (newAccountId) {
          const { data: configured } = await (supabase as any)
            .from('accounts')
            .select('id')
            .eq('id', newAccountId)
            .eq('is_virtual', false)
            .is('deleted_at', null)
            .maybeSingle();
          if (!configured) newAccountId = null;
        }

        if (!newAccountId && buildingName) {
          const { data: matched } = await (supabase as any)
            .from('accounts')
            .select('id, name, is_virtual')
            .eq('name', buildingName)
            .eq('is_virtual', false)
            .is('deleted_at', null)
            .limit(1);
          newAccountId = (matched as any[] | null)?.[0]?.id ?? null;
        }
      }

      if (!newAccountId) {
        throw new Error(
          `Không tìm được sổ quỹ cho phương thức ${new_method}. ` +
            `Vào Cài đặt toà nhà để cấu hình sổ quỹ mặc định.`,
        );
      }

      // 3. Tìm phiếu Thu/Chi đã gắn với payment này (qua payment_id link).
      const { data: voucher, error: vErr } = await (supabase as any)
        .from('income_expenses')
        .select('id, account_id')
        .eq('payment_id', payment_id)
        .limit(1)
        .maybeSingle();
      if (vErr) throw vErr;

      // 4. Đổi sổ quỹ trên phiếu thu trước (nếu có voucher liên kết) — qua RPC
      //    ie_compat_update_pending_v2 (Stage-7 drain: client hết UPDATE trực
      //    tiếp income_expenses; account_id là trục tiền — server chỉ cho sửa
      //    khi phiếu còn Chờ duyệt và chưa ghi sổ).
      if (voucher) {
        const { error: updVErr } = await supabase.rpc(
          'ie_compat_update_pending_v2',
          {
            p_id: voucher.id,
            p_patch: { account_id: newAccountId },
            p_items: null,
          },
        );
        if (updVErr) throw updVErr;
      }

      // 5. UPDATE payment_method trên payment.
      const { data: updated, error: updPErr } = await (supabase as any)
        .from('payments')
        .update({ payment_method: new_method })
        .eq('id', payment_id)
        .select('id')
        .single();
      if (updPErr) throw updPErr;
      if (!updated) {
        throw new Error('Bạn không có quyền sửa phiếu thu này.');
      }

      return {
        skipped: false as const,
        payment_id,
        new_method,
        voucher_id: voucher?.id ?? null,
        new_account_id: newAccountId,
        voucher_found: !!voucher,
      };
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['invoice-payments-summary'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });

      if (res && !res.skipped) {
        toast({
          title: 'Đã đổi phương thức thanh toán',
          description: res.voucher_found
            ? `Đã chuyển khoản thu sang sổ quỹ ${res.new_method}.`
            : 'Payment đã đổi, nhưng không tìm thấy phiếu thu liên kết để chuyển sổ quỹ.',
        });
      }
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Không thể đổi phương thức',
        description: error.message,
      });
    },
  });
};
