import { getSessionUser } from '@/lib/authSession';
import { uploadFileDetailed } from '@/lib/storage';
import { supabase } from '@/integrations/supabase/client';
import { personalAttachmentPathSchema } from './contract';

export const PERSONAL_ATTACHMENT_BUCKET='personal-finance-attachments';
export const PERSONAL_ATTACHMENT_LIMIT=20;
const extensions:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
const attempts=new WeakMap<File,Map<string,string>>();
function checkPath(ownerId:string,path:string){
 if(!personalAttachmentPathSchema.safeParse(path).success||!path.startsWith(`${ownerId}/`))throw new Error('Ảnh chứng từ không thuộc chủ ví hiện tại.');
}
async function checkOwner(ownerId:string,signal?:AbortSignal){
 if(signal?.aborted)throw new DOMException('Đã hủy tải ảnh.','AbortError');
 if((await getSessionUser())?.id!==ownerId)throw new Error('Phiên đăng nhập đã thay đổi.');
 if(signal?.aborted)throw new DOMException('Đã hủy tải ảnh.','AbortError');
}
export async function uploadPersonalAttachment(ownerId:string,file:File,signal?:AbortSignal):Promise<string>{
 const ext=extensions[file.type];if(!ext)throw new Error('Chỉ nhận ảnh JPG, PNG hoặc WebP.');
 await checkOwner(ownerId,signal);
 const prior=attempts.get(file),existing=prior?.get(ownerId),key=existing??`${ownerId}/${crypto.randomUUID()}.${ext}`;
 const owners=prior??new Map<string,string>();owners.set(ownerId,key);attempts.set(file,owners);
 const result=await uploadFileDetailed(PERSONAL_ATTACHMENT_BUCKET,key,file,{imagePolicy:'evidence',maxBytes:5*1024*1024,resilient:{signal,deleteOnFailure:false,resumeExisting:!!existing}});
 await checkOwner(ownerId,signal);checkPath(ownerId,result.path);
 return result.path;
}
export async function signPersonalAttachment(ownerId:string,path:string):Promise<string>{
 checkPath(ownerId,path);await checkOwner(ownerId);
 const {data,error}=await supabase.storage.from(PERSONAL_ATTACHMENT_BUCKET).createSignedUrl(path,3600);
 await checkOwner(ownerId);
 if(error||!data?.signedUrl)throw new Error('Không tải được ảnh chứng từ. Thử lại.');
 return data.signedUrl;
}
