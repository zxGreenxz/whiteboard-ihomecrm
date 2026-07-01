// =============================================
// useCollectionCycleReport — báo cáo Chu kỳ Thu → Bàn giao theo tòa quản lý.
// Gọi RPC manager_collection_cycle_report(manager, from, to) — SECURITY DEFINER:
//   summary   — đã thu kỳ · đã bàn giao kỳ · CHƯA THU hiện tại · tổng đã lên HĐ
//   buildings — theo từng tòa (tổng HĐ / đã thu / chưa thu / số HĐ chưa xong)
//   timeline  — mỗi mốc bàn giao: đã thu trong đoạn · net · CHƯA THU tại mốc
//               (point-in-time) + dòng "CURRENT" hiện tại.
// managerId rỗng ⇒ RPC lấy chính mình (self-view).
// =============================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CycleBuilding {
  building_id: string;
  name: string | null;
  total_billed: number;
  collected: number;
  outstanding: number;
  unpaid_count: number;
}

export interface CycleTimelineRow {
  type: 'HANDOVER' | 'CURRENT';
  code: string | null;
  confirmed_at: string | null;
  net: number | null;
  from_account: string | null;
  collected_in_segment: number;
  outstanding_as_of: number;
}

export interface CollectionCycleReport {
  manager: { id: string; name: string | null };
  from: string;
  to: string;
  building_count: number;
  summary: {
    collected_period: number;
    handed_over_period: number;
    outstanding_current: number;
    total_billed_current: number;
    collected_all: number;
  };
  buildings: CycleBuilding[];
  timeline: CycleTimelineRow[];
}

export const useCollectionCycleReport = (managerId: string, from: string, to: string) =>
  useQuery({
    queryKey: ['collection-cycle', managerId, from, to],
    enabled: !!from && !!to,
    queryFn: async (): Promise<CollectionCycleReport> => {
      const { data, error } = await (supabase as any).rpc('manager_collection_cycle_report', {
        p_manager_id: managerId || null,
        p_from: from,
        p_to: to,
      });
      if (error) throw new Error(error.message);
      return data as CollectionCycleReport;
    },
  });
