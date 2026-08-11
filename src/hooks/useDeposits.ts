import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { useToast } from '@/hooks/use-toast';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import type { Database } from '@/integrations/supabase/types';

type Deposit = Database['public']['Tables']['deposits']['Row'];
type DepositInsert = Database['public']['Tables']['deposits']['Insert'];

export interface DepositWithRelations extends Deposit {
  tenant?: {
    id: string;
    full_name: string;
    phone: string;
  };
  room?: {
    id: string;
    name: string;
    code: string | null;
    building?: { id: string; name: string } | null;
  };
}

export interface OrphanDepositVoucher {
  id: string;
  code: string | null;
  name: string;
  total_amount: number;
  voucher_date: string;
  approval_status: 'UNAPPROVED' | 'APPROVED' | 'CANCELLED';
}

/**
 * Phiếu thu CỌC mồ côi (chưa gắn HĐ) của một phòng — cùng predicate với
 * trigger trg_contract_link_orphan_deposits (migration 20260529000003):
 * cùng room, contract_id NULL, type INCOME, có item is_deposit,
 * voucher_date <= start_date + 7 ngày. Khi HĐ được INSERT các phiếu này
 * tự động gắn vào HĐ và recompute deposit_paid = Σ phiếu APPROVED.
 * ContractFormDialog dùng để: (1) báo user số cọc giữ chỗ đã thu,
 * (2) auto-voucher chỉ tạo cho PHẦN CHÊNH — tránh double-count deposit_paid.
 */
export const useOrphanDepositVouchers = (roomId?: string, startDate?: string) => {
  return useQuery({
    queryKey: ['orphan-deposit-vouchers', roomId, startDate],
    enabled: !!roomId,
    queryFn: async (): Promise<OrphanDepositVoucher[]> => {
      if (!roomId) return [];
      let query = supabase
        .from('income_expenses')
        .select(
          `id, code, name, total_amount, voucher_date, approval_status,
           income_expense_items!inner ( id, amount, income_expense_types!inner ( is_deposit ) )`,
        )
        .is('contract_id', null)
        .is('deleted_at', null)
        .eq('type', 'INCOME')
        .eq('room_id', roomId)
        .in('approval_status', ['APPROVED', 'UNAPPROVED'])
        .eq('income_expense_items.income_expense_types.is_deposit', true);

      if (startDate) {
        const d = new Date(startDate);
        if (!Number.isNaN(d.getTime())) {
          d.setDate(d.getDate() + 7);
          query = query.lte('voucher_date', d.toISOString().split('T')[0]);
        }
      }

      const { data, error } = await query;
      if (error) throw error;
      return ((data ?? []) as any[]).map((v) => {
        // Số CỌC = Σ item cọc (embed đã lọc is_deposit) — phiếu thuần cọc thì
        // bằng total_amount; phiếu trộn (hiếm, nhập tay) không đếm thừa phần khác.
        const depositSum = ((v.income_expense_items ?? []) as any[]).reduce(
          (s, it) => s + (Number(it.amount) || 0),
          0,
        );
        return {
          id: v.id,
          code: v.code ?? null,
          name: v.name,
          total_amount: depositSum || Number(v.total_amount) || 0,
          voucher_date: v.voucher_date,
          approval_status: v.approval_status,
        };
      });
    },
  });
};

export type ReservationStatus = 'UNAPPROVED' | 'APPROVED' | 'CANCELLED';

export interface ReservationDepositRow {
  id: string;
  code: string | null;
  name: string;
  payer_name: string | null;
  total_amount: number;
  voucher_date: string;
  approval_status: ReservationStatus;
  building_id: string;
  building_name: string;
  room_id: string | null;
  room_name: string | null;
}

/**
 * Cọc giữ chỗ TOÀN HỆ THỐNG — NGUỒN THỐNG NHẤT cho mọi đường tạo cọc giữ chỗ
 * (trang Phòng trống / Thu-chi / nút "Tạo đặt cọc"): phiếu thu CỌC mồ côi =
 * income_expenses type=INCOME, contract_id NULL, item có
 * income_expense_types.is_deposit=TRUE. Trường thống nhất chính là cờ
 * `is_deposit`. KHÁC useOrphanDepositVouchers ở chỗ: không giới hạn theo phòng
 * và KHÔNG dùng cửa sổ voucher_date+7 (cửa sổ đó chỉ dành cho auto-link HĐ).
 * Lấy cả CANCELLED để hiện "Đã huỷ"; phiếu đã chuyển HĐ (contract_id != NULL)
 * tự rớt khỏi danh sách (đã thành cọc HĐ — xem tab Đủ/Thiếu cọc).
 */
export const useReservationDeposits = (buildingIds?: string[]) => {
  return useQuery({
    queryKey: ['reservation-deposits', buildingIds ?? []],
    queryFn: async (): Promise<ReservationDepositRow[]> => {
      // PAGED: phiếu cọc giữ chỗ tích luỹ mãi → phân trang (order voucher_date + id).
      const data = await fetchAllRows<any>(
        (from, to) => {
          let query = supabase
            .from('income_expenses')
            .select(
              `id, code, name, payer_name, total_amount, voucher_date,
               approval_status, building_id, room_id,
               building:buildings!income_expenses_building_id_fkey ( id, name ),
               room:rooms!income_expenses_room_id_fkey ( id, name ),
               income_expense_items!inner ( id, amount, income_expense_types!inner ( is_deposit ) )`,
            )
            .is('contract_id', null)
            .is('deleted_at', null)
            .eq('type', 'INCOME')
            .in('approval_status', ['APPROVED', 'UNAPPROVED', 'CANCELLED'])
            .eq('income_expense_items.income_expense_types.is_deposit', true)
            .order('voucher_date', { ascending: false })
            .order('id', { ascending: true });
          if (buildingIds && buildingIds.length > 0) {
            query = query.in('building_id', buildingIds);
          }
          return query.range(from, to);
        },
        { label: 'deposits.reservation' },
      );
      if (data === null) throw new Error('Lỗi tải cọc giữ chỗ');

      // !inner có thể nhân dòng nếu phiếu có >1 item cọc → dedupe theo id.
      const seen = new Set<string>();
      const rows: ReservationDepositRow[] = [];
      for (const v of (data ?? []) as any[]) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        // Số CỌC = Σ item cọc (embed đã lọc is_deposit) — không đếm thừa phần
        // không-cọc nếu phiếu trộn nhập tay.
        const depositSum = ((v.income_expense_items ?? []) as any[]).reduce(
          (s: number, it: any) => s + (Number(it.amount) || 0),
          0,
        );
        rows.push({
          id: v.id,
          code: v.code ?? null,
          name: v.name,
          payer_name: v.payer_name ?? null,
          total_amount: depositSum || Number(v.total_amount) || 0,
          voucher_date: v.voucher_date,
          approval_status: v.approval_status,
          building_id: v.building?.id ?? v.building_id ?? '',
          building_name: v.building?.name ?? '—',
          room_id: v.room?.id ?? v.room_id ?? null,
          room_name: v.room?.name ?? null,
        });
      }
      return rows;
    },
  });
};

export interface ReservationDepositSummary {
  holdingAmount: number;
  approvedCount: number;
  unapprovedCount: number;
  cancelledCount: number;
}

/** Tổng cọc giữ chỗ — RPC SQL aggregate (miễn nhiễm cap-1000). */
export const useReservationDepositSummary = (buildingIds?: string[]) => {
  return useQuery({
    queryKey: ['reservation-deposits', 'summary', buildingIds ?? []],
    queryFn: async (): Promise<ReservationDepositSummary> => {
      const { data, error } = await supabase.rpc('get_reservation_deposit_summary', {
        p_building_ids: buildingIds && buildingIds.length ? buildingIds : undefined,
      });
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        holdingAmount: Number(d.holding_amount) || 0,
        approvedCount: Number(d.approved_count) || 0,
        unapprovedCount: Number(d.unapproved_count) || 0,
        cancelledCount: Number(d.cancelled_count) || 0,
      };
    },
  });
};

export const useDeposits = (filters?: {
  status?: string;
  tenant_id?: string;
}) => {
  return useQuery({
    queryKey: ['deposits', filters],
    queryFn: async (): Promise<DepositWithRelations[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from('deposits')
        .select(`
          *,
          tenant:tenants!deposits_tenant_id_fkey (
            id, full_name, phone
          ),
          room:rooms!deposits_room_id_fkey (
            id, name, code,
            building:buildings!rooms_building_id_fkey ( id, name )
          )
        `)
        .order('created_at', { ascending: false });

      if (filters?.status) {
        query = query.eq('status', filters.status as any);
      }
      if (filters?.tenant_id) {
        query = query.eq('tenant_id', filters.tenant_id);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as DepositWithRelations[];
    },
  });
};

export const useCreateDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    // `user_id` do CHÍNH hook này điền từ phiên đăng nhập (ngay dưới), nên đòi
    // caller truyền vào là mô tả sai hợp đồng: hoặc họ để trống và TypeScript kêu,
    // hoặc họ tự điền và có hai nguồn cho cùng một giá trị.
    mutationFn: async (data: Omit<DepositInsert, 'user_id'>) => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      const { data: deposit, error } = await supabase
        .from('deposits')
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast({
        title: 'Đặt cọc đã được tạo thành công',
        description: 'Thông tin đặt cọc đã được lưu.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi tạo đặt cọc',
        description: error.message,
      });
    },
  });
};

// Update deposit
export const useUpdateDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, ...data }: Partial<Deposit> & { id: string }) => {
      const { data: deposit, error } = await supabase
        .from('deposits')
        .update(data)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return deposit;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast({
        title: 'Đặt cọc đã được cập nhật thành công',
        description: 'Thông tin đặt cọc đã được cập nhật.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi cập nhật đặt cọc',
        description: error.message,
      });
    },
  });
};

// Delete deposit
export const useDeleteDeposit = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('deposits')
        .delete()
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast({
        title: 'Đặt cọc đã được xóa thành công',
        description: 'Phiếu đặt cọc đã được xóa.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi xóa đặt cọc',
        description: error.message,
      });
    },
  });
};
