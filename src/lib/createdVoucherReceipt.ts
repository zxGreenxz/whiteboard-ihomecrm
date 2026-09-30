import {supabase} from '@/integrations/supabase/client';

export interface CreatedVoucherReceipt {
  id: string;
  voucher_id: string;
  code: string;
  approval_status: string | null;
  posting_status: string | null;
}

/** Some older writers return only an ID. A failed read is not a failed write. */
export async function readCreatedVoucherReceipt(value: unknown): Promise<CreatedVoucherReceipt> {
  const receipt = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const id = receipt.voucher_id ?? receipt.id;
  if (typeof id !== 'string' || !id) throw new TypeError('Missing created voucher receipt');
  const result: CreatedVoucherReceipt = {id,voucher_id:id,code:typeof receipt.code==='string'?receipt.code:'',approval_status:null,posting_status:null};
  try {
    const {data,error} = await supabase.from('income_expenses').select('code,approval_status,posting_status').eq('id',id).maybeSingle();
    if (!error && data) return {...result,code:data.code ?? result.code,approval_status:data.approval_status,posting_status:data.posting_status};
  } catch (error) {
    console.error('Could not read created voucher state:',error);
  }
  return result;
}
