import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { COMMISSION_REASON_MESSAGE, isCommissionReasonValid } from '@/lib/commissionAudit';

export type CommissionInterventionStage = 'EDIT_PENDING' | 'ASSIGN_MANAGER' | 'ANNOTATE' | 'UNAPPROVE' | 'RESTORE';

export async function interveneCommission(voucherId: string, stage: CommissionInterventionStage, reason: string | undefined, payload: Json) {
  if (reason !== undefined && !isCommissionReasonValid(reason)) throw new Error(COMMISSION_REASON_MESSAGE);
  const { data, error } = await supabase.rpc('intervene_commission_v1', {
    p_voucher_id: voucherId, p_stage: stage, p_reason: reason?.trim() ?? '', p_payload: payload,
  });
  if (error) throw error;
  return data;
}
