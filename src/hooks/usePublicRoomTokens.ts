import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {supabase} from '@/integrations/supabase/client';
import type {Database} from '@/integrations/supabase/types';
import {useOrganization} from '@/contexts/OrganizationContext';
import {getSessionUser} from '@/lib/authSession';
import {FinancialAlreadyRecordedError,FinancialWorkflowError,RepeatableWriteUnknownError} from '@/lib/financialWorkflow';
import {repeatableWrite} from '@/lib/recordWriteOutcome';
import {CREATE_TOKEN_NO_ORGANIZATION,unconfirmedPublicRoomReceipt,TOKEN_ADMIN_RULES,notifyRuleError} from '@/lib/publicRoomFeedback';
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
/** p_label NULL = xoá nhãn (types.ts không biểu diễn được tham số NULL của RPC). */
type ManageTokenRpcArgs=Database['public']['Functions']['manage_public_room_token_v1']['Args'];
type ManageTokenArgs={p_token:string;p_action:'rename'|'revoke'|'restore'|'delete';p_label?:string|null};
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
const report=(error:unknown,options:Options,operation:string)=>{if(!options.inlineError)notifyRuleError(error,`Chưa ${operation}`,'quản lý link chia sẻ',TOKEN_ADMIN_RULES);};
/**
 * Mọi link chia sẻ của CÔNG TY đang chọn (kể cả do người khác tạo), kèm tên người tạo. Cần quyền sale_phong.manage_tokens —
 * máy chủ kiểm (list_public_room_tokens_v1); màn không có quyền thì truyền enabled=false.
 */
export function usePublicRoomTokens({enabled=true}:{enabled?:boolean}={}){const {selectedOrganizationId}=useOrganization();return useQuery({queryKey:[...KEY,selectedOrganizationId],enabled:enabled&&!!selectedOrganizationId,meta:{errorDisplay:"inline"},queryFn:()=>listCompanyTokens(selectedOrganizationId!)});}
async function listCompanyTokens(organizationId:string):Promise<PublicRoomToken[]>{
 const {data,error}=await supabase.rpc('list_public_room_tokens_v1',{p_organization_id:organizationId});if(error)throw error;
 if(!Array.isArray(data)||!data.every(validToken)||data.some(row=>row.organization_id!==organizationId)||new Set(data.map(row=>row.token)).size!==data.length)throw new TypeError('Invalid public room token list');return data;
}
/** Link của chính người dùng (RLS) — cho Thống kê, nơi người xem không cần quyền quản link. */
export function useOwnPublicRoomTokens(){return useQuery({queryKey:OWN_KEY,meta:{errorDisplay:"inline"},queryFn:async():Promise<PublicRoomToken[]>=>{
 const {data,error}=await supabase.from('public_room_share_tokens').select('*').order('created_at',{ascending:false});if(error)throw error;
 if(!Array.isArray(data)||!data.every(validToken)||new Set(data.map(row=>row.token)).size!==data.length)throw new TypeError('Invalid public room token list');return data;
}});}
const invalidate=(qc:ReturnType<typeof useQueryClient>)=>Promise.all([qc.invalidateQueries({queryKey:KEY}),qc.invalidateQueries({queryKey:OWN_KEY})]);

// Đợt 8 (luật 5, cách A): tạo / đổi nhãn / thu hồi / khôi phục / xoá link không giữ dấu «chờ đối chiếu» nào. Kết quả chưa rõ
// thì báo rõ và cho bấm lại. Bộ nhớ dưới đây chỉ sống trong tab (không ghi xuống trình duyệt), để lần bấm sau trong tab biết
// lần trước chưa rõ: tạo link thì tra link vừa tạo trước khi tạo thêm; thu hồi thì đọc lại trạng thái link trước khi gửi.
// Dấu bản trước (namespace `public-room-admin`, phạm vi người dùng, khoá `token-create` / `token:<mã>`) gỡ sau lần ghi xong.
/**
 * Lần tạo link chưa rõ kết quả, theo người + công ty + nhãn: giờ gửi sớm nhất và các mã link ĐÃ BIẾT lúc gửi (danh sách đang
 * hiện trên màn), để link cùng nhãn có từ trước không bị nhận nhầm là link của lần chưa rõ.
 */
const uncertainCreates=new Map<string,{at:number;known:ReadonlySet<string>}>();
/** Lần thu hồi / khôi phục / xoá chưa rõ kết quả, theo công ty + link: trạng thái đích. */
const uncertainChanges=new Map<string,'revoke'|'restore'|'delete'>();
/** Giờ máy và giờ máy chủ có thể lệch: tra link tạo trong khoảng này quanh lần gửi chưa rõ. */
const CREATE_LOOKBACK_MS=10*60_000;
/**
 * Nhãn gửi lên = nhãn đã cắt khoảng trắng ở hai đầu. Máy chủ cắt bằng btrim() — chỉ cắt dấu cách — nên trước đây nhãn có
 * tab / xuống dòng / khoảng trắng Unicode ở hai đầu được LƯU NGUYÊN, lệch với nhãn trình duyệt so (đã trim) ⇒ biên nhận
 * luôn «chưa rõ» và dấu kẹt. Gửi nhãn đã cắt thì btrim() không đổi gì và biên nhận khớp.
 */
function normalizedTokenLabel(label:string|null|undefined):string|null{return label?.trim()||null;}
async function forgetLegacyTokenPending(businessKey:string){
 try{const {forgetLegacyPending}=await import('@/lib/legacyPendingExit');await forgetLegacyPending({namespace:'public-room-admin',businessKey},{organizationId:'actor-scope'});}
 catch{/* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần ghi sau gỡ lại. */}
}
/**
 * Link vừa được lần gửi chưa rõ tạo ra (của chính người dùng, đúng công ty, đúng nhãn, sau giờ gửi); `null` = đọc được và
 * KHÔNG có. Đọc hỏng không phải «không có»: ném lỗi chưa rõ, lần bấm sau đọc lại (không tạo link khi chưa biết lần trước).
 */
async function findCreatedToken(userId:string,organizationId:string,label:string|null,since:number,known:ReadonlySet<string>):Promise<PublicRoomToken|null>{
 const unread=(cause:unknown)=>new RepeatableWriteUnknownError('tạo link chia sẻ',cause,[],'Chưa kiểm được link của lần bấm trước (lần đó mất phản hồi), nên chưa tạo thêm. Bấm tạo lại: máy đọc lại danh sách link trước.');
 let reply:{data:unknown;error:unknown};
 try{
  reply=await supabase.from('public_room_share_tokens').select('*').eq('owner_id',userId).eq('organization_id',organizationId)
   .gte('created_at',new Date(since-CREATE_LOOKBACK_MS).toISOString()).order('created_at',{ascending:false});
 }catch(error){throw unread(error);}
 if(reply.error)throw unread(reply.error);
 if(!Array.isArray(reply.data)||!reply.data.every(validToken))throw unread(new TypeError('Invalid public room token list'));
 return reply.data.find(row=>row.label===label&&row.revoked===false&&!known.has(row.token))??null;
}
/** Link chia sẻ thuộc công ty đang chọn: máy chủ kiểm thành viên + quyền ở đúng công ty đó và ghi công ty vào link. */
export function useCreatePublicRoomToken(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async(label?:string|null)=>{
 const organizationId=selectedOrganizationId;if(!organizationId)throw new FinancialWorkflowError(CREATE_TOKEN_NO_ORGANIZATION,'failure',[]);
 const user=await getSessionUser();if(!user)throw {code:'PGRST301',message:'Not authenticated'};const expectedLabel=normalizedTokenLabel(label);
 const memory=[user.id,organizationId,expectedLabel??''].join('\u0000');const prior=uncertainCreates.get(memory);
 if(prior){
  // Luật 4: lần trước đã tạo thì báo mã link và thôi, không tự tạo thêm; bấm lần nữa là ý định tạo link mới.
  const created=await findCreatedToken(user.id,organizationId,expectedLabel,prior.at,prior.known);
  if(created){uncertainCreates.delete(memory);throw new FinancialAlreadyRecordedError(`Link chia sẻ ${created.token} có thể đã được tạo ở lần bấm trước (lần đó mất phản hồi): cùng nhãn, tạo quanh lần bấm đó. Kiểm tra danh sách; chưa tạo thêm. Bấm tạo lần nữa nếu vẫn cần một link mới.`,[created.token]);}
 }
 const startedAt=Date.now();
 const known=new Set<string>();
 for(const queryKey of [KEY,OWN_KEY])for(const [,rows] of qc.getQueriesData<PublicRoomToken[]>({queryKey}))if(Array.isArray(rows))rows.forEach(row=>known.add(row.token));
 try{
  const data=await repeatableWrite('tạo link chia sẻ',async()=>{
   const {data,error}=await supabase.rpc('create_public_room_token',{p_label:expectedLabel??undefined,p_organization_id:organizationId});if(error)throw error;
   if(!validToken(data)||data.owner_id!==user.id||data.organization_id!==organizationId||data.label!==expectedLabel||data.revoked!==false)unconfirmedPublicRoomReceipt();return data;
  });
  uncertainCreates.delete(memory);await forgetLegacyTokenPending('token-create');return data;
 }catch(error){
  if(error instanceof RepeatableWriteUnknownError){
   if(!prior)uncertainCreates.set(memory,{at:startedAt,known});
   throw new RepeatableWriteUnknownError('tạo link chia sẻ',error.cause,[],'Bấm tạo lại: máy tìm link vừa tạo trước, có rồi thì báo mã link, không tạo thêm.');
  }
  throw error;
 }
},onSuccess:row=>{void invalidate(qc);toast.success(`Đã tạo link chia sẻ ${row.token}`);},onError:error=>{void invalidate(qc);report(error,options,'tạo link chia sẻ');}});}
/** Đổi nhãn / thu hồi / khôi phục / xoá qua manage_public_room_token_v1 (kiểm quyền ở máy chủ; ghi thẳng bảng đã bị chặn). */
async function manage(organizationId:string|null|undefined,args:ManageTokenArgs):Promise<Record<string,unknown>>{
 if(!organizationId)throw new FinancialWorkflowError('Chưa chọn công ty. Chọn công ty ở đầu trang rồi thao tác link.','failure',[]);
 const {data,error}=await supabase.rpc('manage_public_room_token_v1',{p_organization_id:organizationId,...args} as ManageTokenRpcArgs);if(error)throw error;
 if(!data||typeof data!=='object'||Array.isArray(data)||(data as Record<string,unknown>).token!==args.p_token)unconfirmedPublicRoomReceipt();
 return data as Record<string,unknown>;
}
export function useUpdateTokenLabel(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async({token,label}:{token:string;label:string|null})=>{
 const expectedLabel=normalizedTokenLabel(label);
 // Đặt giá trị theo mã link: ghi lại bao nhiêu lần cũng cùng nhãn.
 const data=await repeatableWrite('đổi nhãn link',async()=>{
  const data=await manage(selectedOrganizationId,{p_token:token,p_action:'rename',p_label:expectedLabel});
  if(!validToken(data)||data.label!==expectedLabel)unconfirmedPublicRoomReceipt();return data;
 });
 await forgetLegacyTokenPending(`token:${token}`);return data;
},onSuccess:row=>{void invalidate(qc);toast.success(`Đã cập nhật nhãn link ${row.token}`);},onError:error=>{void invalidate(qc);report(error,options,'đổi nhãn link');}});}
/** Trạng thái hiện tại của link trong công ty. `null` = không còn link đó; ném lỗi = chưa đọc được. */
async function readCompanyToken(organizationId:string,token:string):Promise<PublicRoomToken|null>{
 return (await listCompanyTokens(organizationId)).find(row=>row.token===token)??null;
}
export type TokenRevokeResult=PublicRoomToken&{alreadyApplied?:boolean};
/**
 * Thu hồi / khôi phục link — thao tác BẢO MẬT. Sau một lần chưa rõ kết quả, không bao giờ báo như đã thu hồi: lần bấm sau
 * (trong tab, hoặc khi còn dấu bản trước của link) đọc lại trạng thái link trước. Đã đúng trạng thái ⇒ báo, không gửi lệnh.
 * Chưa đúng, hoặc đọc hỏng ⇒ gửi ngay (thu hồi / khôi phục lặp lại không đổi gì thêm; không chờ 2 phút).
 */
export function useSetTokenRevoked(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async({token,revoked}:{token:string;revoked:boolean}):Promise<TokenRevokeResult>=>{
 const organizationId=selectedOrganizationId;if(!organizationId)throw new FinancialWorkflowError('Chưa chọn công ty. Chọn công ty ở đầu trang rồi thao tác link.','failure',[]);
 const memory=`${organizationId}\u0000${token}`;const target=revoked?'revoke':'restore';
 let current:PublicRoomToken|null|undefined;
 if(uncertainChanges.has(memory)){try{current=await readCompanyToken(organizationId,token);}catch{current=undefined;}}
 else{
  try{
   const {settleLegacyPending}=await import('@/lib/legacyPendingExit');
   current=(await settleLegacyPending({namespace:'public-room-admin',businessKey:`token:${token}`},()=>readCompanyToken(organizationId,token),{organizationId:'actor-scope'}))?.verdict;
  }catch{current=undefined;}
 }
 if(current===null){uncertainChanges.delete(memory);throw {code:'P0002',message:'public_room_token_not_found'};}
 if(current&&current.revoked===revoked){uncertainChanges.delete(memory);return {...current,alreadyApplied:true};}
 try{
  const data=await repeatableWrite(revoked?`thu hồi link ${token}`:`khôi phục link ${token}`,async()=>{
   const data=await manage(organizationId,{p_token:token,p_action:target});
   if(!validToken(data)||data.revoked!==revoked)unconfirmedPublicRoomReceipt();return data;
  });
  uncertainChanges.delete(memory);await forgetLegacyTokenPending(`token:${token}`);return data;
 }catch(error){
  if(error instanceof RepeatableWriteUnknownError){
   uncertainChanges.set(memory,target);
   throw new RepeatableWriteUnknownError(revoked?`thu hồi link ${token}`:`khôi phục link ${token}`,error.cause,[],revoked
    ?'Link có thể vẫn đang hoạt động. Bấm Thu hồi lại: máy đọc lại trạng thái link, còn hoạt động thì thu hồi ngay (thu hồi lặp lại không đổi gì thêm).'
    :'Link có thể vẫn đang bị thu hồi. Bấm Khôi phục lại: máy đọc lại trạng thái link rồi mới gửi.');
  }
  throw error;
 }
},onSuccess:row=>{void invalidate(qc);const done=row.revoked?`Đã thu hồi link ${row.token}`:`Đã khôi phục link ${row.token}`;toast.success(row.alreadyApplied?`${done} (lần bấm trước đã ghi; không gửi thêm).`:done);},
onError:error=>{void invalidate(qc);report(error,options,'đổi trạng thái link');}});}
export function useDeletePublicRoomToken(options:Options={}){const qc=useQueryClient();const {selectedOrganizationId}=useOrganization();return useMutation({mutationFn:async(token:string)=>{
 const memory=`${selectedOrganizationId}\u0000${token}`;
 try{
  // manage_public_room_token_v1 khoá dòng; xoá lại một link đã xoá trả removed:false (khớp 0 dòng nghĩa là đã xoá).
  const result=await repeatableWrite('xóa link chia sẻ',async()=>{
   const data=await manage(selectedOrganizationId,{p_token:token,p_action:'delete'});
   if(typeof data.removed!=='boolean')unconfirmedPublicRoomReceipt();
   return {token,removed:data.removed?1:0,...(!data.removed&&uncertainChanges.get(memory)==='delete'?{afterUnconfirmed:true}:{})};
  });
  uncertainChanges.delete(memory);await forgetLegacyTokenPending(`token:${token}`);return result;
 }catch(error){if(error instanceof RepeatableWriteUnknownError)uncertainChanges.set(memory,'delete');throw error;}
},onSuccess:result=>{void invalidate(qc);if(result.removed)toast.success(`Đã xóa link ${result.token}`);else if(result.afterUnconfirmed)toast.info(`Link ${result.token} đã được xoá ở lần bấm trước (lần đó mất phản hồi); không có thay đổi mới.`);else toast.info(`Link ${result.token} không còn trong danh sách; không có thay đổi mới.`);},onError:error=>{void invalidate(qc);report(error,options,'xóa link chia sẻ');}});}
