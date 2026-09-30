import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({upload:vi.fn(),rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('@/lib/storage',()=>({uploadFileDetailed:m.upload,sanitizeStorageFileName:(s:string)=>s}));
vi.mock('@/hooks/useZaloChat',()=>({QK:{},mapMsg:(row:unknown)=>row}));
import {createZaloMediaSender,ZaloMediaSendError} from '../chat-zalo/useZaloMedia';
beforeEach(()=>{m.upload.mockReset();m.rpc.mockReset();});
const stored=(name:string)=>({url:`https://example.test/actual/${name}`,path:`actual/${name}`,type:'image/jpeg',size:1});
const values=()=>({conversationId:'conversation-1',accountId:'a',kind:'image' as const,attachments:[{file:new File(['a'],'a.jpg')},{file:new File(['b'],'b.jpg')}]});
it('retains successful uploads and retries only the unfinished file',async()=>{
 const send=createZaloMediaSender();const v=values();
 m.upload.mockResolvedValueOnce(stored('a.jpg')).mockRejectedValueOnce(new Error('storage sql internal')).mockResolvedValueOnce(stored('b.jpg'));
 m.rpc.mockResolvedValue({data:[{id:'m1'},{id:'m2'}],error:null});
 await expect(send(v)).rejects.toMatchObject({uploaded:expect.arrayContaining([expect.objectContaining({filename:'a.jpg'})]),outcomeUnknown:false});
 await expect(send(v)).resolves.toHaveLength(2);
 expect(m.upload).toHaveBeenCalledTimes(3);expect(m.rpc).toHaveBeenCalledTimes(1);
});
it('blocks resending an unknown queue result and preserves uploaded paths',async()=>{
 const send=createZaloMediaSender();const v=values();m.upload.mockImplementation(async(_bucket:string,key:string)=>stored(key));m.rpc.mockResolvedValue({data:null,error:{message:'SQLSTATE internal'}});
 const error=await send(v).catch(e=>e);
 expect(error).toBeInstanceOf(ZaloMediaSendError);expect(error.uploaded).toHaveLength(2);expect(error.outcomeUnknown).toBe(true);expect(error.message).not.toContain('SQLSTATE');
 await expect(send(v)).rejects.toBeInstanceOf(ZaloMediaSendError);expect(m.rpc).toHaveBeenCalledTimes(1);
});
