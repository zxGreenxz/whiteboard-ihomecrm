import { FinancialWorkflowError } from "@/lib/financialWorkflowError";
import { supabase } from '@/integrations/supabase/client';
import { hasUnconfirmedResponse } from '@/lib/operationOutcome';
export class CopilotAdminUnknownError extends Error {
  override readonly name='CopilotAdminUnknownError';
  constructor(readonly receiptIds: readonly string[] = []){super('Chưa xác nhận được kết quả cập nhật Copilot. Giữ nội dung đang nhập, đọc lại cấu hình và đối chiếu trước khi thực hiện tiếp.' + (receiptIds.length ? ` Mã cần đối chiếu: ${receiptIds.join('; ')}.` : ''));}
}
export class CopilotAccountMissingError extends Error {
  override readonly name='CopilotAccountMissingError';
  constructor(){super('Không tìm thấy tài khoản có email này. Kiểm tra email đã đăng ký.');}
}
export const copilotAdminOutcomeUnknown=(error:unknown)=>error instanceof CopilotAdminUnknownError || error instanceof FinancialWorkflowError && error.outcome !== 'failure' || hasUnconfirmedResponse(error);
function equalValue(a:unknown,b:unknown):boolean {
  if(Object.is(a,b))return true;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((item,i)=>equalValue(item,b[i]));
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>;
  return Object.keys(aa).length===Object.keys(bb).length&&Object.keys(aa).every(key=>Object.prototype.hasOwnProperty.call(bb,key)&&equalValue(aa[key],bb[key]));
}
function requireReceipt<T>(data:T,expected:Record<string,unknown>):T {
  if(!data||typeof data!=='object'||!Object.entries(expected).every(([key,value])=>equalValue((data as Record<string,unknown>)[key],value))) throw new CopilotAdminUnknownError();
  return data;
}
export async function saveCopilotSettings(settings: Record<string, unknown>) {
  const { data, error } = await supabase.from('ai_copilot_settings').update({...settings,updated_at:new Date().toISOString()}).eq('id', true).select('*').maybeSingle();
  if(error) throw error;
  return requireReceipt(data,{id:true,...settings});
}
export async function addCopilotEntitlement(email: string) {
  const {data: profile,error: profileError} = await supabase.from('profiles').select('id').ilike('email',email.trim()).maybeSingle();
  if(profileError) throw profileError;
  if(!profile) throw new CopilotAccountMissingError();
  const {data,error}=await supabase.from('ai_copilot_entitlements').insert({user_id:profile.id,chat_enabled:true,ui_control_enabled:false}).select('*').maybeSingle();
  if(error) throw error;
  return requireReceipt(data,{user_id:profile.id,chat_enabled:true,ui_control_enabled:false});
}
export async function changeCopilotEntitlement(input:{user_id:string;field:'chat_enabled'|'ui_control_enabled';value:boolean}) {
  const patch=input.field==='chat_enabled'?{chat_enabled:input.value}:{ui_control_enabled:input.value};
  const {data,error}=await supabase.from('ai_copilot_entitlements').update(patch).eq('user_id',input.user_id).select('*').maybeSingle();
  if(error) throw error;
  return requireReceipt(data,{user_id:input.user_id,...patch});
}
export async function removeCopilotEntitlement(userId:string) {
  const {data,error}=await supabase.from('ai_copilot_entitlements').delete().eq('user_id',userId).select('user_id').maybeSingle();
  if(error) throw error;
  return requireReceipt(data,{user_id:userId});
}
export async function saveCopilotProvider(input:{provider:string;patch:Record<string,unknown>}) {
  const {data,error}=await supabase.from('ai_providers').update({...input.patch,updated_at:new Date().toISOString()}).eq('provider',input.provider).select('*').maybeSingle();
  if(error) throw error;
  return requireReceipt(data,{provider:input.provider,...input.patch});
}
