// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({upload:vi.fn(),sign:vi.fn(),actor:vi.fn()}));
vi.mock('@/lib/storage',()=>({uploadFileDetailed:h.upload}));
vi.mock('@/lib/authSession',()=>({getSessionUser:h.actor}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{storage:{from:()=>({createSignedUrl:h.sign})}}}));
import { isPersonalAttachmentType, uploadPersonalAttachment, signPersonalAttachment } from './personalAttachments';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import { UploadRejectedError } from '@/lib/uploadDeadline';
const owner='11111111-1111-4111-8111-111111111111';
const path=`${owner}/22222222-2222-4222-8222-222222222222.webp`;
beforeEach(()=>{vi.resetAllMocks();h.actor.mockResolvedValue({id:owner});});
it('retry retains the upload UUID and resumes matching storage without overwriting',async()=>{
 const file=new File(['bill'],'bill.png',{type:'image/png'});
 h.upload.mockRejectedValueOnce(new Error('connection')).mockResolvedValueOnce({path});
 await expect(uploadPersonalAttachment(owner,file)).rejects.toThrow('connection');
 expect(await uploadPersonalAttachment(owner,file)).toBe(path);
 expect(h.upload.mock.calls[1][1]).toBe(h.upload.mock.calls[0][1]);
 expect(h.upload.mock.calls[0][3].resilient.resumeExisting).toBe(false);expect(h.upload.mock.calls[1][3].resilient.resumeExisting).toBe(true);
});
it('a key already holding a different object (409 after resume) is dropped so the next retry uses a new key',async()=>{
 const file=new File(['bill'],'bill.png',{type:'image/png'});
 h.upload.mockRejectedValueOnce(new Error('connection')).mockRejectedValueOnce(new FinancialWorkflowError('rejected','failure',[],new UploadRejectedError(409,'conflict'))).mockResolvedValueOnce({path});
 await expect(uploadPersonalAttachment(owner,file)).rejects.toThrow('connection');
 await expect(uploadPersonalAttachment(owner,file)).rejects.toThrow('rejected');
 expect(await uploadPersonalAttachment(owner,file)).toBe(path);
 expect(h.upload.mock.calls[1][1]).toBe(h.upload.mock.calls[0][1]);expect(h.upload.mock.calls[2][1]).not.toBe(h.upload.mock.calls[0][1]);
 expect(h.upload.mock.calls[2][3].resilient.resumeExisting).toBe(false);
 expect(isPersonalAttachmentType('image/heic')).toBe(false);expect(isPersonalAttachmentType('image/webp')).toBe(true);
});
it('uses private evidence upload, no cleanup, signal and actual returned path',async()=>{
 h.upload.mockResolvedValue({path,url:'https://public.invalid',type:'image/webp',size:4});
 const signal=new AbortController().signal;
 expect(await uploadPersonalAttachment(owner,new File(['bill'],'bill.png',{type:'image/png'}),signal)).toBe(path);
 expect(h.upload).toHaveBeenCalledWith('personal-finance-attachments',expect.stringMatching(new RegExp(`^${owner}/[0-9a-f-]+\\.png$`)),expect.any(File),{imagePolicy:'evidence',maxBytes:5*1024*1024,resilient:{signal,deleteOnFailure:false,resumeExisting:false}});
});
it('rejects non-images, aborted uploads and owner changes without attaching results',async()=>{
 await expect(uploadPersonalAttachment(owner,new File(['pdf'],'bill.pdf',{type:'application/pdf'}))).rejects.toThrow();
 expect(h.upload).not.toHaveBeenCalled();
 const abort=new AbortController();abort.abort();
 await expect(uploadPersonalAttachment(owner,new File(['png'],'bill.png',{type:'image/png'}),abort.signal)).rejects.toThrow();
 h.upload.mockImplementation(async()=>{h.actor.mockResolvedValue({id:'other'});return {path};});
 await expect(uploadPersonalAttachment(owner,new File(['png'],'bill.png',{type:'image/png'}))).rejects.toThrow(/đăng nhập/);
});
it('never falls back to a public URL when private signing fails',async()=>{
 h.sign.mockResolvedValue({data:null,error:new Error('403')});
 await expect(signPersonalAttachment(owner,path)).rejects.toThrow();
 expect(h.sign).toHaveBeenCalledWith(path,3600);
 h.sign.mockResolvedValue({data:{signedUrl:'https://signed.test/bill'},error:null});
 expect(await signPersonalAttachment(owner,path)).toBe('https://signed.test/bill');
 await expect(signPersonalAttachment('other',path)).rejects.toThrow();
});
