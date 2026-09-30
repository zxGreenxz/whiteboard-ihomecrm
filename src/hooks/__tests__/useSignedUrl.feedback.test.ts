import {it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({query:vi.fn(),sign:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:m.query}));
vi.mock('@/lib/storage',()=>({SIGNED_URL_TTL:3600,parseStorageRef:(v:string)=>v.startsWith('private/')?{path:v}:null,createSignedUrlFromStored:m.sign}));
import {useSignedUrl,useSignedUrlQuery} from '../useSignedUrl';
it('caller mới nhận lỗi/refetch; caller cũ giữ API URL và URL ngoài không cần ký',async()=>{const error={message:'private path failure'},refetch=vi.fn();m.query.mockReturnValue({data:undefined,error,isError:true,refetch});const result=useSignedUrlQuery('private/file',undefined,{errorDisplay:'inline'});expect(result.error).toBe(error);expect(result.refetch).toBe(refetch);expect(m.query.mock.calls[0][0].meta.errorDisplay).toBe('inline');expect(useSignedUrl('https://example.test/image')).toBe('https://example.test/image');expect(m.query.mock.calls[1][0].enabled).toBe(false);});
