import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { rpcNullable } from '@/lib/rpcNullable';
const money=z.string().regex(/^\d+(?:\.\d+)?$/);
export const salarySourcePartSchema=z.object({source_id:z.string().uuid(),operation_id:z.string().uuid(),party_id:z.string().uuid(),voucher_id:z.string().uuid(),item_id:z.string().uuid(),period_month:z.string().date(),gross:money,withheld:money,net:money,proof_hash:z.string().min(1)}).strict();
export const salarySourceMetaSchema=z.object({voucher_id:z.string().uuid(),state:z.enum(['READY','NEEDS_REVIEW']),source_id:z.string().uuid().nullable(),staff_id:z.string().uuid().nullable(),part:salarySourcePartSchema.nullable(),issue:z.string().nullable()}).strict().refine(x=>x.state!=='READY'||(x.part!==null && x.part.voucher_id===x.voucher_id && x.part.source_id===x.source_id),'Nguồn lương không khớp');
export type SalarySourceMeta=z.infer<typeof salarySourceMetaSchema>;
export async function readSalarySourceParts(voucherIds:string[],periodMonth:string|null=null):Promise<Map<string,SalarySourceMeta>>{
 const result=new Map<string,SalarySourceMeta>();
 for(let n=0;n<voucherIds.length;n+=1000){
 const ids=z.array(z.string().uuid()).parse(voucherIds.slice(n,n+1000));
 const {data,error}=await supabase.rpc('read_rent_support_salary_parts_v1',{p_voucher_ids:ids,p_period_month:rpcNullable(periodMonth)});
 if(error)throw new Error('Không đọc được chứng cứ nguồn hoa hồng: '+error.message);
 for(const row of z.array(salarySourceMetaSchema).parse(data)){if(!ids.includes(row.voucher_id))throw new Error('Máy chủ trả sai phiếu');result.set(row.voucher_id,row);}
 }return result;
}
export async function salaryBridgeRequired(staffIds:string[],periodMonth:string):Promise<boolean>{
 const {data,error}=await supabase.rpc('rent_support_salary_bridge_required_v1',{p_staff_ids:z.array(z.string().uuid()).parse(staffIds),p_period_month:z.string().date().parse(periodMonth)});
 if(error)throw new Error('Không kiểm được nguồn kỳ lương: '+error.message);return z.boolean().parse(data);
}
