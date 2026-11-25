import {actionErrorMessage} from './actionFeedback';
import {FinancialWorkflowError,type FinancialWorkflowProgress} from './financialWorkflow';
import {friendlyError,type OperationErrorRule} from './friendlyError';
export function rememberToken(progress:FinancialWorkflowProgress,data:unknown){if(data&&typeof data==='object'&&'token' in data&&typeof data.token==='string'&&data.token)progress.completed.push({id:data.token,label:'Link chia sẻ cần đối chiếu'});}
export function unconfirmedPublicRoomReceipt(cause?:unknown):never{throw new FinancialWorkflowError('Chưa xác nhận được kết quả đã lưu. Giữ nội dung đang nhập và kiểm tra trạng thái trước khi thao tác tiếp.','unknown',[],cause);}
export const SALE_POLICY_MAX=2000;
export function validPublicRoomSettings(data:unknown):data is {soon_days:number;show_rented:boolean;hotline_id:string|null;sale_policy?:string|null}{if(!data||typeof data!=='object'||Array.isArray(data))return false;const r=data as Record<string,unknown>;return typeof r.soon_days==='number'&&Number.isInteger(r.soon_days)&&r.soon_days>=0&&r.soon_days<=365&&typeof r.show_rented==='boolean'&&(r.hotline_id===null||(typeof r.hotline_id==='string'&&!!r.hotline_id))&&(r.sale_policy===undefined||r.sale_policy===null||(typeof r.sale_policy==='string'&&r.sale_policy.length<=SALE_POLICY_MAX));}

/** Chưa chọn công ty thì không gửi lời tạo link (máy chủ cũng từ chối người thuộc nhiều công ty không gửi công ty). */
export const CREATE_TOKEN_NO_ORGANIZATION='Chưa chọn công ty. Chọn công ty ở đầu trang rồi tạo link.';
/**
 * Lý do máy chủ trả khi tạo link — nguồn: supabase/migrations/20261124171545_link_chia_se_va_thong_ke_ghi_ro_cong_ty.sql
 * (create_public_room_token), và câu 23502 của app_private.autofill_org_strict cho máy chủ chưa áp migration đó.
 */
export const CREATE_TOKEN_RULES:readonly OperationErrorRule[]=[
 {code:'42501',message:'public_room_token_permission',recovery:'contact-admin',
  description:'Tài khoản chưa được cấp quyền «Quản lý link chia sẻ» ở công ty đang chọn. Nhờ chủ công ty bật quyền này trong Phân quyền.'},
 {code:'42501',message:'public_room_token_not_member',recovery:'reload',
  description:'Tài khoản không phải thành viên của công ty đang chọn, nên không tạo được link ở công ty này. Chọn công ty mà tài khoản là thành viên rồi tạo lại.'},
 {code:'22023',message:'public_room_token_org_required',recovery:'reload',
  description:'Tài khoản thuộc nhiều công ty nên phải chọn công ty. Chọn công ty ở đầu trang rồi tạo lại.'},
 {code:'23502',message:/không suy được organization_id/,recovery:'contact-admin',
  description:'Máy chủ chưa xác định được link thuộc công ty nào. Tải lại trang rồi tạo lại; nếu vẫn lỗi, báo quản trị viên.'},
];
/** Câu báo khi tạo link hỏng: «Không tạo được link» + lý do thật; kết quả chưa rõ thì giữ câu đối chiếu cũ. */
export function createTokenErrorMessage(error:unknown):string{
 if(error instanceof FinancialWorkflowError&&error.outcome!=='failure')return actionErrorMessage(error,'Chưa xác nhận được thao tác link chia sẻ.');
 const feedback=friendlyError(error,'Không tạo được link',{operation:'tạo link chia sẻ',rules:CREATE_TOKEN_RULES});
 return `${feedback.title.replace(/[.。]+$/,'')}. ${feedback.description}`;
}

/** Token của trang /phongtrong (src/app/routes/publicRoutes.tsx: <PhongTrongPage token="demo" />). */
export const PHONG_TRONG_TOKEN='demo';
type TokenLike={token:string;owner_id:string;organization_id:string|null;revoked:boolean;created_at:string;label?:string|null};
const tenLink=(t:TokenLike)=>t.label?.trim()?`«${t.label.trim()}»`:`/r/${t.token}`;
/**
 * Cảnh báo trong hộp thu hồi / xoá link CÒN HOẠT ĐỘNG (link đã thu hồi không còn nguồn nào đọc).
 * - Bot Zalo (app_private.public_sale_rooms_payload_v1) lấy phòng của MỖI người đứng tên qua link hoạt động SỚM NHẤT
 *   (created_at, rồi token) của người đó trong công ty ⇒ chỉ cảnh báo bot khi đây là link sớm nhất: còn link khác thì bot
 *   chuyển nguồn sang link kế tiếp, hết link thì bot không còn phòng của người này.
 * - Hermes (app_private.public_room_link_grants_v1) đọc phòng đã đăng của TỪNG link còn hoạt động ⇒ mọi link đều có thể
 *   đang giữ phòng đã đăng; danh sách phòng theo từng link chưa có ở đây (đợt 2 đổi bot/Hermes sang theo công ty).
 * Danh sách `all` là link mà RLS cho người dùng thấy (link của chính họ).
 */
export function tokenRemovalWarnings(target:TokenLike,all:readonly TokenLike[]):string[]{
 const warnings:string[]=[];
 if(target.token===PHONG_TRONG_TOKEN)warnings.push('Link «demo» là nguồn của trang /phongtrong (link thương hiệu gửi khách). Thu hồi hoặc xoá thì trang /phongtrong báo «Liên kết không hợp lệ» với mọi khách.');
 if(target.revoked)return warnings;
 const cungNguon=all.filter(t=>!t.revoked&&t.owner_id===target.owner_id&&t.organization_id===target.organization_id&&t.token!==target.token);
 const truoc=(x:TokenLike,y:TokenLike)=>(Date.parse(x.created_at)-Date.parse(y.created_at))||x.token.localeCompare(y.token);
 const ke=[...cungNguon].sort(truoc)[0];
 const somNhat=!ke||truoc(target,ke)<0;
 if(somNhat)warnings.push(ke
  ?`Bot Zalo đang lấy danh sách phòng của bạn qua link này (link hoạt động sớm nhất của bạn ở công ty này). Thu hồi hoặc xoá thì bot chuyển sang link ${tenLink(ke)}.`
  :'Đây là link còn hoạt động cuối cùng của bạn ở công ty này. Bot Zalo lấy danh sách phòng của bạn qua link này; thu hồi hoặc xoá thì bot không còn phòng của bạn để đăng.');
 warnings.push('Link này có thể đang giữ phòng đã đăng cho Hermes; thu hồi hoặc xoá thì Hermes không còn gửi các phòng đăng qua link này.');
 return warnings;
}
