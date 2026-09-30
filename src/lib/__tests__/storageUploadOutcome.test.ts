import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({upload:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{storage:{from:()=>({upload:io.upload,getPublicUrl:(path:string)=>({data:{publicUrl:'stored:'+path}})})}}}));
vi.mock('../imageCompress',()=>({compressImage:async(file:File)=>file.type==='application/pdf'?file:new File(['compressed'],'image.webp',{type:'image/webp'})}));
vi.mock('../storage/r2Config',()=>({isR2Bucket:()=>false,isR2PublicBucket:()=>false,parseR2Ref:()=>null}));
vi.mock('../storage/r2Client',()=>({uploadToR2:vi.fn(),signR2:vi.fn()}));
vi.mock('../signedUrlBatcher',()=>({createSignedUrlBatched:vi.fn()}));
import {uploadFile} from '../storage';
import {FinancialWorkflowError} from '../financialWorkflow';
beforeEach(()=>vi.resetAllMocks());
it.each([null,{path:'wrong.webp'}])('upload requires a matching path receipt',async(data)=>{io.upload.mockResolvedValue({data,error:null});const failure=await uploadFile('bucket','actor/front.png',new File(['x'],'front.png')).catch(e=>e);expect(failure).toBeInstanceOf(FinancialWorkflowError);expect(failure.completed[0].id).toBe('bucket/actor/front.webp');});
it('unknown upload retains the actual compressed key without raw provider details',async()=>{io.upload.mockRejectedValue(new Error('SQL secret body'));const failure=await uploadFile('bucket','actor/front.png',new File(['x'],'front.png')).catch(e=>e);expect(failure).toBeInstanceOf(FinancialWorkflowError);expect(failure.completed[0].id).toBe('bucket/actor/front.webp');expect(failure.message).not.toContain('SQL secret');});

it.each([['known rejection',403,'failure'],['unconfirmed response',undefined,'unknown']] as const)('generic PDF upload feedback names the correct object after %s',async(_case,statusCode,outcome)=>{
 const file=new File(['bill'],'bill.pdf',{type:'application/pdf'});const cause=Object.assign(new Error('private provider details'),{statusCode});io.upload.mockRejectedValue(cause);
 const failure=await uploadFile('bucket','actor/bill.pdf',file).catch((error:unknown)=>error);
 expect(failure).toBeInstanceOf(FinancialWorkflowError);if(!(failure instanceof FinancialWorkflowError))throw new Error('Expected upload feedback');
 expect(failure.outcome).toBe(outcome);expect(failure.cause).toBe(cause);expect(failure.message).toContain('tệp');expect(failure.message).not.toMatch(/ảnh|private provider details/);
 expect(io.upload).toHaveBeenCalledWith('actor/bill.pdf',file,{cacheControl:'31536000',upsert:false});
 if(outcome==='unknown')expect(failure.completed).toEqual([{id:'bucket/actor/bill.pdf',label:'Đường dẫn tệp cần đối chiếu'}]);else expect(failure.completed).toEqual([]);
});
