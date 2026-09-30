import {beforeEach,expect,it,vi} from 'vitest';
interface DatabaseReply { data: unknown; error: unknown }
interface AdminWriteQueryMock {
 update: () => AdminWriteQueryMock; insert: () => AdminWriteQueryMock;
 delete: () => AdminWriteQueryMock; select: () => AdminWriteQueryMock;
 eq: () => AdminWriteQueryMock; ilike: () => AdminWriteQueryMock;
 maybeSingle: () => Promise<DatabaseReply>;
}
const m=vi.hoisted(()=>({result:{data:null,error:null} as {data:unknown,error:unknown},profile:{data:{id:'u1'},error:null},writes:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:(table:string)=>{const q:AdminWriteQueryMock={update:()=>{m.writes();return q},insert:()=>{m.writes();return q},delete:()=>{m.writes();return q},select:()=>q,eq:()=>q,ilike:()=>q,maybeSingle:async()=>table==='profiles'?m.profile:m.result};return q}}}));
import {saveCopilotSettings,addCopilotEntitlement,changeCopilotEntitlement,removeCopilotEntitlement,saveCopilotProvider} from '../adminWrites';
beforeEach(()=>{vi.clearAllMocks();m.result={data:null,error:null};m.profile={data:{id:'u1'},error:null};});
it.each([()=>saveCopilotSettings({chat_enabled:true}),()=>addCopilotEntitlement('test@example.com'),()=>changeCopilotEntitlement({user_id:'u1',field:'chat_enabled',value:true}),()=>removeCopilotEntitlement('u1'),()=>saveCopilotProvider({provider:'p1',patch:{enabled:true}})])('không nhận payload trống làm biên nhận ghi',async write=>{await expect(write()).rejects.toMatchObject({name:'CopilotAdminUnknownError'});});
it('biên nhận phải khớp đối tượng và giá trị yêu cầu',async()=>{m.result.data={provider:'p2',enabled:true};await expect(saveCopilotProvider({provider:'p1',patch:{enabled:true}})).rejects.toMatchObject({name:'CopilotAdminUnknownError'});});
it('biên nhận models hợp lệ không phụ thuộc thứ tự khóa JSON',async()=>{m.result.data={provider:'p1',models:[{label:'M',id:'m'}]};await expect(saveCopilotProvider({provider:'p1',patch:{models:[{id:'m',label:'M'}]}})).resolves.toBeTruthy();});
