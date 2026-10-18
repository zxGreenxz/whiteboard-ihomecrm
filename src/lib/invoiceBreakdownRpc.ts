import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { Database, Json } from '@/integrations/supabase/types';
import type { invoiceStatisticsRpcArgs } from '@/lib/invoiceReadArgs';

// Hợp đồng local cho migration 20261018055627 chưa áp TEST/production.
// Không sửa types.ts máy sinh bằng tay. Sau apply + gen:types, bỏ phần mở rộng này.
// Giữ tên/args cụ thể để TypeScript và surface scanner vẫn kiểm được hai caller.
type BreakdownFunction = {
  Args: ReturnType<typeof invoiceStatisticsRpcArgs> & { p_building_ids?: string[] };
  Returns: Json;
};
type BreakdownDatabase = Database & {
  public: { Functions: {
    invoice_change_breakdown_v1: BreakdownFunction;
    invoice_deposit_breakdown_v1: BreakdownFunction;
  } };
};
export const invoiceBreakdownClient = supabase as SupabaseClient<BreakdownDatabase>;
