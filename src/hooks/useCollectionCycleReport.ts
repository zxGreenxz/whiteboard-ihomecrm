import {financialReadNumber,financialReadRows} from '@/lib/financialReadValidation';
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
    meta:{errorDisplay:'inline',label:'chu kỳ thu và bàn giao'},
    queryKey: ['collection-cycle', managerId, from, to],
    enabled: !!from && !!to,
    queryFn: async (): Promise<CollectionCycleReport> => {
      const { data, error } = await supabase.rpc('manager_collection_cycle_report', {
        p_manager_id: managerId || undefined,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      const row=data as unknown as CollectionCycleReport | null;
      if(!row || !row.summary || typeof row.summary!=='object') throw new TypeError('Chưa đọc được đầy đủ báo cáo chu kỳ thu và bàn giao.');
      return {
        ...row,
        building_count: financialReadNumber(row.building_count),
        summary: {
          collected_period: financialReadNumber(row.summary.collected_period),
          handed_over_period: financialReadNumber(row.summary.handed_over_period),
          outstanding_current: financialReadNumber(row.summary.outstanding_current),
          total_billed_current: financialReadNumber(row.summary.total_billed_current),
          collected_all: financialReadNumber(row.summary.collected_all),
        },
        buildings: financialReadRows(row.buildings).map(building=>({
          ...building,
          total_billed: financialReadNumber(building.total_billed),
          collected: financialReadNumber(building.collected),
          outstanding: financialReadNumber(building.outstanding),
          unpaid_count: financialReadNumber(building.unpaid_count),
        })),
        timeline: financialReadRows(row.timeline).map(event=>({
          ...event,
          net: event.type==='CURRENT' && event.net===null ? null : financialReadNumber(event.net),
          collected_in_segment: financialReadNumber(event.collected_in_segment),
          outstanding_as_of: financialReadNumber(event.outstanding_as_of),
        })),
      };
    },
  });
