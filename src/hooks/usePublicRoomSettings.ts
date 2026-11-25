import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {useOrganization} from '@/contexts/OrganizationContext';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,type FinancialWorkflowProgress} from '@/lib/financialWorkflow';
import {validPublicRoomSettings,unconfirmedPublicRoomReceipt,SETTINGS_NO_ORGANIZATION,SAVE_SETTINGS_RULES,notifyRuleError} from '@/lib/publicRoomFeedback';
import {supabase} from '@/integrations/supabase/client';
import type {Database} from '@/integrations/supabase/types';
import {toast} from 'sonner';
/** sale_policy: chính sách sale chung in ở khối đầu ảnh "DANH SÁCH PHÒNG TRỐNG" (NULL = không in). */
/** p_expected_updated_at NULL = công ty chưa có dòng cài đặt (CAS «chưa có»); types.ts không biểu diễn được tham số NULL. */
type SaveSettingsArgs=Database['public']['Functions']['save_public_room_settings_v1']['Args'];
export interface PublicRoomSettings{soon_days:number;show_rented:boolean;hotline_id:string|null;sale_policy:string|null}
export const PUBLIC_ROOM_SETTINGS_DEFAULTS:PublicRoomSettings={soon_days:30,show_rented:true,hotline_id:null,sale_policy:null};
/** Hotline của người đứng tên chung các toà (chủ cài đặt chung) trong công ty — chỉ những số này in được lên trang. */
export interface SettingsHotline{id:string;name:string|null;phone_number:string;is_active:boolean|null;created_at:string|null}
/**
 * Cài đặt chung trang Sale của CÔNG TY đang chọn (đợt 2 Sale phòng, 25/11/2026): dòng public_room_settings của người đứng
 * tên chung các toà; ai có quyền sale_phong.manage_settings đều sửa được (canManage do máy chủ trả). updatedAt là khoá CAS.
 */
export interface CompanyRoomSettings{settings:PublicRoomSettings;ownerId:string|null;exists:boolean;updatedAt:string|null;canManage:boolean;hotlines:SettingsHotline[]}
const KEY=['public-room-settings'] as const;
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const textOrNull=(v:unknown)=>v===null||typeof v==='string';
function validHotline(v:unknown):v is SettingsHotline{
 return isRecord(v)&&typeof v.id==='string'&&!!v.id&&textOrNull(v.name)&&typeof v.phone_number==='string'&&(v.is_active===null||typeof v.is_active==='boolean')&&textOrNull(v.created_at);
}
/** Đọc phản hồi get/save_public_room_settings_v1; sai hình ⇒ null (bên gọi coi là chưa xác nhận). */
export function parseCompanyRoomSettings(data:unknown,organizationId:string):CompanyRoomSettings|null{
 if(!isRecord(data)||data.organization_id!==organizationId||!textOrNull(data.owner_id)||typeof data.exists!=='boolean'||!textOrNull(data.updated_at)
  ||typeof data.can_manage!=='boolean'||!Array.isArray(data.hotlines)||!data.hotlines.every(validHotline))return null;
 const settings={soon_days:data.soon_days,show_rented:data.show_rented,hotline_id:data.hotline_id,sale_policy:data.sale_policy??null};
 if(!validPublicRoomSettings(settings))return null;
 return {settings:{soon_days:settings.soon_days,show_rented:settings.show_rented,hotline_id:settings.hotline_id,sale_policy:settings.sale_policy??null},
  ownerId:(data.owner_id as string|null),exists:data.exists,updatedAt:(data.updated_at as string|null),canManage:data.can_manage,hotlines:data.hotlines};
}
export function usePublicRoomSettings(){const {selectedOrganizationId}=useOrganization();return useQuery({queryKey:[...KEY,selectedOrganizationId],enabled:!!selectedOrganizationId,meta:{errorDisplay:"inline"},queryFn:async():Promise<CompanyRoomSettings>=>{
 const organizationId=selectedOrganizationId!;
 const {data,error}=await supabase.rpc('get_public_room_settings_v1',{p_organization_id:organizationId});if(error)throw error;
 const parsed=parseCompanyRoomSettings(data,organizationId);if(!parsed)throw new TypeError('Invalid public room settings');return parsed;
}});}
/** Giá trị cần lưu + updatedAt của bản đã đọc (CAS): người khác lưu trước thì máy chủ báo PT409 «đã có người sửa». */
export type SavePublicRoomSettingsInput=PublicRoomSettings&{expectedUpdatedAt:string|null};
export function useUpsertPublicRoomSettings(options:{inlineError?:boolean}={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async(input:SavePublicRoomSettingsInput)=>{
 const {expectedUpdatedAt,...values}=input;
 if(!validPublicRoomSettings(values))throw new FinancialWorkflowError('Cài đặt chưa hợp lệ: số ngày sắp trống là số nguyên 0–365, chính sách sale tối đa 2000 ký tự.','failure',[]);
 const organizationId=selectedOrganizationId;if(!organizationId)throw new FinancialWorkflowError(SETTINGS_NO_ORGANIZATION,'failure',[]);
 const expectedPolicy=values.sale_policy?.trim()||null;
 const write=async(progress:FinancialWorkflowProgress)=>{
  const {data,error}=await supabase.rpc('save_public_room_settings_v1',{p_organization_id:organizationId,p_expected_updated_at:expectedUpdatedAt,p_soon_days:values.soon_days,
   p_show_rented:values.show_rented,p_hotline_id:values.hotline_id,p_sale_policy:expectedPolicy} as SaveSettingsArgs);if(error)throw error;
  const saved=parseCompanyRoomSettings(data,organizationId);
  if(saved?.ownerId)progress.completed.push({id:saved.ownerId,label:'Cài đặt chung cần đối chiếu'});
  if(!saved||!saved.exists||saved.settings.soon_days!==values.soon_days||saved.settings.show_rented!==values.show_rented
   ||saved.settings.hotline_id!==values.hotline_id||saved.settings.sale_policy!==expectedPolicy)unconfirmedPublicRoomReceipt();return saved;
 };
 // Lưu theo CAS: lần gửi lại sau mất phản hồi mang đúng giá trị đã lưu ⇒ máy chủ trả như cũ (changed=false), không báo
 // xung đột; đủ biên nhận mới gỡ dấu "chờ đối chiếu" (không thì vẫn khoá như cũ).
 return persistentFinancialWorkflow('public-room-admin',{scope:'actor'}).run('settings','lưu cài đặt hiển thị',write,async(_prior,progress)=>({result:await write(progress)}));
},onSuccess:()=>{qc.invalidateQueries({queryKey:KEY});toast.success('Đã lưu cài đặt hiển thị');},onError:error=>{if(!options.inlineError)notifyRuleError(error,'Chưa lưu được cài đặt hiển thị','lưu cài đặt chung',SAVE_SETTINGS_RULES);}});}
