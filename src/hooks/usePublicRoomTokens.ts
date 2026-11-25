import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {supabase} from '@/integrations/supabase/client';
import type {Database} from '@/integrations/supabase/types';
import {useOrganization} from '@/contexts/OrganizationContext';
import {getSessionUser} from '@/lib/authSession';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {CREATE_TOKEN_NO_ORGANIZATION,rememberToken,unconfirmedPublicRoomReceipt,TOKEN_ADMIN_RULES,notifyRuleError} from '@/lib/publicRoomFeedback';
import {rpcListPublicRoomTokens,rpcManagePublicRoomToken,type ManageTokenArgs} from '@/lib/publicRoomAdminRpc';
import {toast} from 'sonner';
type TokenRow=Database['public']['Tables']['public_room_share_tokens']['Row'];
/**
 * Link của công ty kèm tên người tạo (list_public_room_tokens_v1, đợt 2 Sale phòng). can_manage: người xem sửa / thu hồi /
 * xoá được link này (link của mình, hoặc có quyền Quản lý link ở PHẠM VI CÔNG TY); thiếu trường (link đọc qua RLS) = của mình.
 */
export type PublicRoomToken=TokenRow&{owner_name?:string|null;can_manage?:boolean};
const KEY=['public-room-tokens'] as const;
const OWN_KEY=['public-room-tokens-own'] as const;
type Options={inlineError?:boolean};
function validToken(data:unknown):data is PublicRoomToken{
 if(!data||typeof data!=='object'||Array.isArray(data))return false;const r=data as Record<string,unknown>;
 return typeof r.token==='string'&&!!r.token&&typeof r.owner_id==='string'&&!!r.owner_id&&(r.label===null||typeof r.label==='string')&&typeof r.revoked==='boolean'&&typeof r.created_at==='string'&&Number.isFinite(Date.parse(r.created_at))&&(r.organization_id===null||typeof r.organization_id==='string')
  &&(r.owner_name===undefined||r.owner_name===null||typeof r.owner_name==='string')&&(r.can_manage===undefined||typeof r.can_manage==='boolean');
}
/** Mã link trong một URL /r/:token — cùng mẫu zalo_sale_advice_delivery_v1 dùng để đọc link của bot. */
export function shareUrlToken(url:unknown):string|null{
 if(typeof url!=='string')return null;const m=/^https:\/\/[A-Za-z0-9.-]+\/r\/([A-Za-z0-9_-]+)\/?$/.exec(url.trim());return m?.[1]??null;
}
/**
 * Link bot Zalo đang gửi khách (zalo_automations «broadcast_vacant», config.template.shareUrl) của công ty đang chọn — để
 * cảnh báo khi thu hồi / xoá đúng link đó. Bảng đọc qua RLS theo quyền xem Zalo: người không có quyền đó nhận danh sách
 * rỗng (không cảnh báo được), lỗi đọc cũng im lặng — đây chỉ là lời nhắc thêm, máy chủ không dựa vào nó.
 */
export function useBotShareTokens({enabled=true}:{enabled?:boolean}={}){const {selectedOrganizationId}=useOrganization();return useQuery({queryKey:['zalo-bot-share-tokens',selectedOrganizationId],enabled:enabled&&!!selectedOrganizationId,meta:{silent:true},retry:false,queryFn:async():Promise<string[]>=>{
 const {data,error}=await supabase.from('zalo_automations').select('config').eq('organization_id',selectedOrganizationId!).eq('kind','broadcast_vacant').limit(10);if(error)throw error;
 return [...new Set((data??[]).map(row=>{const c=row.config as {template?:{shareUrl?:unknown}}|null;return shareUrlToken(c?.template?.shareUrl);}).filter((t):t is string=>!!t))];
}});}
const writeGuard=()=>persistentFinancialWorkflow('public-room-admin',{scope:'actor'});
const report=(error:unknown,options:Options,operation:string)=>{if(!options.inlineError)notifyRuleError(error,`Chưa ${operation}`,'quản lý link chia sẻ',TOKEN_ADMIN_RULES);};
/**
 * Mọi link chia sẻ của CÔNG TY đang chọn (kể cả do người khác tạo), kèm tên người tạo. Cần quyền sale_phong.manage_tokens —
 * máy chủ kiểm (list_public_room_tokens_v1); màn không có quyền thì truyền enabled=false.
 */
export function usePublicRoomTokens({enabled=true}:{enabled?:boolean}={}){const {selectedOrganizationId}=useOrganization();return useQuery({queryKey:[...KEY,selectedOrganizationId],enabled:enabled&&!!selectedOrganizationId,meta:{errorDisplay:"inline"},queryFn:async():Promise<PublicRoomToken[]>=>{
 const organizationId=selectedOrganizationId!;
 const {data,error}=await rpcListPublicRoomTokens({p_organization_id:organizationId});if(error)throw error;
 if(!Array.isArray(data)||!data.every(validToken)||data.some(row=>row.organization_id!==organizationId)||new Set(data.map(row=>row.token)).size!==data.length)throw new TypeError('Invalid public room token list');return data;
}});}
/** Link của chính người dùng (RLS) — cho Thống kê, nơi người xem không cần quyền quản link. */
export function useOwnPublicRoomTokens(){return useQuery({queryKey:OWN_KEY,meta:{errorDisplay:"inline"},queryFn:async():Promise<PublicRoomToken[]>=>{
 const {data,error}=await supabase.from('public_room_share_tokens').select('*').order('created_at',{ascending:false});if(error)throw error;
 if(!Array.isArray(data)||!data.every(validToken)||new Set(data.map(row=>row.token)).size!==data.length)throw new TypeError('Invalid public room token list');return data;
}});}
const invalidate=(qc:ReturnType<typeof useQueryClient>)=>Promise.all([qc.invalidateQueries({queryKey:KEY}),qc.invalidateQueries({queryKey:OWN_KEY})]);
/** Link luôn thuộc công ty ĐANG CHỌN: máy chủ kiểm thành viên + quyền ở đúng công ty đó và ghi công ty vào link. */
export function useCreatePublicRoomToken(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async(label?:string|null)=>{
 const organizationId=selectedOrganizationId;if(!organizationId)throw new FinancialWorkflowError(CREATE_TOKEN_NO_ORGANIZATION,'failure',[]);
 const user=await getSessionUser();if(!user)throw {code:'PGRST301',message:'Not authenticated'};const expectedLabel=label?.trim()||null;
 return writeGuard().run('token-create','tạo link chia sẻ',async progress=>{
  const {data,error}=await supabase.rpc('create_public_room_token',{p_label:label??undefined,p_organization_id:organizationId});if(error)throw error;rememberToken(progress,data);
  if(!validToken(data)||data.owner_id!==user.id||data.organization_id!==organizationId||data.label!==expectedLabel||data.revoked!==false)unconfirmedPublicRoomReceipt();return data;
 });
},onSuccess:row=>{void invalidate(qc);toast.success(`Đã tạo link chia sẻ ${row.token}`);},onError:error=>report(error,options,'tạo link chia sẻ')});}
/** Đổi nhãn / thu hồi / khôi phục / xoá qua manage_public_room_token_v1 (kiểm quyền ở máy chủ; ghi thẳng bảng đã bị chặn). */
async function manage(organizationId:string|null|undefined,args:Omit<ManageTokenArgs,'p_organization_id'>):Promise<Record<string,unknown>>{
 if(!organizationId)throw new FinancialWorkflowError('Chưa chọn công ty. Chọn công ty ở đầu trang rồi thao tác link.','failure',[]);
 const {data,error}=await rpcManagePublicRoomToken({p_organization_id:organizationId,...args});if(error)throw error;
 if(!data||typeof data!=='object'||Array.isArray(data)||(data as Record<string,unknown>).token!==args.p_token)unconfirmedPublicRoomReceipt();
 return data as Record<string,unknown>;
}
export function useUpdateTokenLabel(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async({token,label}:{token:string;label:string|null})=>{
 const expectedLabel=label?.trim()||null;return writeGuard().run(`token:${token}`,'đổi nhãn link',async progress=>{
  const data=await manage(selectedOrganizationId,{p_token:token,p_action:'rename',p_label:expectedLabel});rememberToken(progress,data);
  if(!validToken(data)||data.label!==expectedLabel)unconfirmedPublicRoomReceipt();return data;
 });
},onSuccess:row=>{void invalidate(qc);toast.success(`Đã cập nhật nhãn link ${row.token}`);},onError:error=>report(error,options,'đổi nhãn link')});}
export function useSetTokenRevoked(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async({token,revoked}:{token:string;revoked:boolean})=>{
 return writeGuard().run(`token:${token}`,'đổi trạng thái link',async progress=>{
  const data=await manage(selectedOrganizationId,{p_token:token,p_action:revoked?'revoke':'restore'});rememberToken(progress,data);
  if(!validToken(data)||data.revoked!==revoked)unconfirmedPublicRoomReceipt();return data;
 });
},onSuccess:row=>{void invalidate(qc);toast.success(row.revoked?`Đã thu hồi link ${row.token}`:`Đã khôi phục link ${row.token}`);},onError:error=>report(error,options,'đổi trạng thái link')});}
export function useDeletePublicRoomToken(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async(token:string)=>{
 return writeGuard().run(`token:${token}`,'xóa link chia sẻ',async progress=>{
  const data=await manage(selectedOrganizationId,{p_token:token,p_action:'delete'});
  if(typeof data.removed!=='boolean')unconfirmedPublicRoomReceipt();if(data.removed)rememberToken(progress,data);
  return {token,removed:data.removed?1:0};
 });
},onSuccess:result=>{void invalidate(qc);if(result.removed)toast.success(`Đã xóa link ${result.token}`);else toast.info(`Link ${result.token} không còn trong danh sách; không có thay đổi mới.`);},onError:error=>report(error,options,'xóa link chia sẻ')});}
