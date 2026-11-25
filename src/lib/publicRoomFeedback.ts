import {toast} from 'sonner';
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
/**
 * Cảnh báo trong hộp thu hồi / xoá link CÒN HOẠT ĐỘNG (link đã thu hồi không còn nguồn nào đọc). Từ đợt 2 Sale phòng
 * (20261125034429) trang Sale theo CÔNG TY: mọi link hoạt động của một công ty ra cùng một trang; bot Zalo
 * (public_sale_rooms_payload_v1) và Hermes (hermes_available_rooms_page_v1) chỉ cần công ty còn ÍT NHẤT MỘT link hoạt động,
 * không còn phụ thuộc link của ai. Nên ngoài link «demo» (/phongtrong) chỉ cảnh báo khi đây là link hoạt động cuối cùng
 * của công ty. Danh sách `all` là mọi link của công ty (list_public_room_tokens_v1). `botTokens`: link bot Zalo đang gửi khách
 * (useBotShareTokens — đọc được khi người xem có quyền xem Zalo); bot gửi kèm đúng link đó và tư vấn Sale qua Zalo chỉ đọc
 * trang qua link đó (zalo_sale_advice_delivery_v1), nên thu hồi link của bot làm hỏng tin bot dù công ty còn link khác.
 */
export function tokenRemovalWarnings(target:TokenLike,all:readonly TokenLike[],botTokens:readonly string[]=[]):string[]{
 const warnings:string[]=[];
 if(target.token===PHONG_TRONG_TOKEN)warnings.push('Link «demo» là nguồn của trang /phongtrong (link thương hiệu gửi khách). Thu hồi hoặc xoá thì trang /phongtrong báo «Liên kết không hợp lệ» với mọi khách.');
 if(target.revoked)return warnings;
 if(botTokens.includes(target.token))warnings.push('Đây là link bot Zalo đang gửi khách (mẫu tin «Phòng trống» trong Tự động hoá Zalo). Thu hồi hoặc xoá thì tin bot gửi kèm link hỏng và bot tư vấn Sale qua Zalo không còn trang để gửi. Đổi link trong cài đặt bot trước.');
 const conLai=all.some(t=>!t.revoked&&t.organization_id===target.organization_id&&t.token!==target.token);
 if(!conLai)warnings.push('Đây là link còn hoạt động cuối cùng của công ty. Bot Zalo và Hermes chỉ gửi phòng khi công ty còn ít nhất một link hoạt động; thu hồi hoặc xoá thì bot và Hermes không còn trang Sale để gửi khách.');
 return warnings;
}

/** Chưa chọn công ty thì không gửi lời lưu cài đặt chung (cài đặt thuộc công ty). */
export const SETTINGS_NO_ORGANIZATION='Chưa chọn công ty. Chọn công ty ở đầu trang rồi lưu cài đặt.';
/** Lý do máy chủ trả khi lưu cài đặt chung — nguồn: save_public_room_settings_v1 (20261125034429_sale_phong_theo_cong_ty.sql). */
export const SAVE_SETTINGS_RULES:readonly OperationErrorRule[]=[
 {code:'PT409',message:'public_room_settings_conflict',recovery:'reload',
  description:'Đã có người sửa cài đặt chung sau khi bạn mở. Bỏ bản nháp cài đặt để đọc lại rồi sửa tiếp.'},
 {code:'42501',message:'public_room_settings_permission',recovery:'contact-admin',
  description:'Cài đặt chung có hiệu lực cho cả công ty nên cần quyền «Cài đặt hiển thị» ở phạm vi TOÀN CÔNG TY (quyền theo toà/khu không đủ). Nhờ chủ công ty cấp quyền này trong Phân quyền.'},
 {code:'42501',message:'public_room_settings_not_member',recovery:'reload',
  description:'Tài khoản không phải thành viên của công ty đang chọn.'},
 {code:'22023',message:'public_room_settings_hotline_invalid',recovery:'reload',
  description:'Hotline đã chọn không còn là hotline đang bật của cài đặt chung. Chọn lại hotline rồi lưu.'},
 {code:'22023',message:'public_room_settings_invalid',recovery:'reload',
  description:'Số ngày sắp trống là số nguyên 0–365, chính sách sale chung tối đa 2000 ký tự.'},
 {code:'55000',message:'public_room_settings_owner_ambiguous',recovery:'contact-admin',
  description:'Công ty chưa có toà hoặc các toà đang đứng tên nhiều người, nên chưa xác định được cài đặt chung. Báo quản trị viên.'},
 {code:'55000',message:'public_room_settings_owner_other_org',recovery:'contact-admin',
  description:'Người đứng tên các toà của công ty này đang dùng cài đặt chung cho một công ty khác; một người đứng tên cho hai công ty chưa có cài đặt riêng từng công ty. Báo quản trị viên.'},
];
/** Câu báo khi lưu cài đặt chung hỏng: lý do thật của máy chủ; kết quả chưa rõ thì giữ câu đối chiếu cũ. */
export function saveSettingsErrorMessage(error:unknown):string{
 if(error instanceof FinancialWorkflowError&&error.outcome!=='failure')return actionErrorMessage(error,'Chưa lưu được cài đặt chung. Bản nháp vẫn được giữ.');
 const feedback=friendlyError(error,'Chưa lưu được cài đặt chung',{operation:'lưu cài đặt chung',rules:SAVE_SETTINGS_RULES});
 return `${feedback.title.replace(/[.。]+$/,'')}. ${feedback.description}`;
}
/** Lý do máy chủ trả khi xem / đổi nhãn / thu hồi / khôi phục / xoá link — nguồn: list/manage_public_room_token_v1. */
export const TOKEN_ADMIN_RULES:readonly OperationErrorRule[]=[
 {code:'42501',message:'public_room_token_permission',recovery:'contact-admin',
  description:'Tài khoản chưa được cấp quyền «Quản lý link chia sẻ» ở công ty đang chọn. Nhờ chủ công ty bật quyền này trong Phân quyền.'},
 {code:'42501',message:'public_room_token_permission_org',recovery:'contact-admin',
  description:'Link này do người khác tạo. Sửa, thu hồi hoặc xoá link của người khác cần quyền «Quản lý link chia sẻ» ở phạm vi TOÀN CÔNG TY. Nhờ chủ công ty cấp quyền này, hoặc nhờ người tạo link thao tác.'},
 {code:'42501',message:'public_room_token_not_member',recovery:'reload',
  description:'Tài khoản không phải thành viên của công ty đang chọn.'},
 {code:'22023',message:'public_room_token_invalid',recovery:'reload',
  description:'Thao tác link không hợp lệ. Tải lại trang rồi thử lại.'},
 {code:'P0002',message:'public_room_token_not_found',recovery:'reload',
  description:'Không thấy link này trong công ty đang chọn (có thể đã bị xoá). Tải lại danh sách.'},
];
/** Câu báo khi thao tác link hỏng: «Không … được» + lý do thật; kết quả chưa rõ thì giữ câu đối chiếu cũ. */
export function tokenAdminErrorMessage(error:unknown,title:string):string{
 if(error instanceof FinancialWorkflowError&&error.outcome!=='failure')return actionErrorMessage(error,'Chưa xác nhận được thao tác link chia sẻ.');
 const feedback=friendlyError(error,title,{operation:'quản lý link chia sẻ',rules:TOKEN_ADMIN_RULES});
 return `${feedback.title.replace(/[.。]+$/,'')}. ${feedback.description}`;
}
/** Báo lỗi bằng toast (khi màn không hiện lỗi tại chỗ) với đúng lý do của máy chủ theo bộ luật của thao tác. */
export function notifyRuleError(error:unknown,title:string,operation:string,rules:readonly OperationErrorRule[]):void{
 const feedback=friendlyError(error,title,{operation,rules});toast.error(feedback.title,{description:feedback.description});
}
