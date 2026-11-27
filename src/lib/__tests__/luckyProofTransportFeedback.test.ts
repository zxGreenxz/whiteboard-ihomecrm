// @vitest-environment jsdom
// Đợt 9 (mẫu PR #478) — ba ca cũ chốt hành vi «ghi dấu đã lên kế hoạch tải trước khi gửi; mất phản hồi thì không cho tải
// lại» (ô tải khoá mãi) đã đổi: mỗi lần tải là một đường dẫn mới với `x-upsert: false`, tải hỏng thì tải lại được, tệp mồ
// côi (nếu kho lỡ lưu) vô hại vì chưa gắn vào đội nào.
import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
import {uploadLuckyProof} from '../luckyDrawApi';
beforeEach(()=>vi.unstubAllGlobals());
const sentPaths=(fetchMock:ReturnType<typeof vi.fn>)=>fetchMock.mock.calls.map(([url])=>String(url).split('/lucky-proofs/')[1]);
it('a lost transport response throws, and the retry uploads a NEW object (no planned marker blocks it)',async()=>{
 const fetchMock=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ok:true,status:200});
 vi.stubGlobal('fetch',fetchMock);
 await expect(uploadLuckyProof('event',new File(['a'],'a.png'))).rejects.toThrow();
 const proof=await uploadLuckyProof('event',new File(['a'],'a.png'));
 const [first,second]=sentPaths(fetchMock);
 expect(first).toMatch(/^event\//);expect(second).toBe(proof.path);expect(second).not.toBe(first);
 expect(fetchMock.mock.calls.every(([,init])=>init.headers['x-upsert']==='false')).toBe(true);
 expect(Object.keys(localStorage)).toEqual([]);
});
it('a known storage permission rejection throws with its status',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));
 await expect(uploadLuckyProof('event',new File(['a'],'a.png'))).rejects.toMatchObject({status:403});
});
it('a storage server error throws and the next attempt is a new upload',async()=>{
 const fetchMock=vi.fn().mockResolvedValueOnce({ok:false,status:500}).mockResolvedValueOnce({ok:true,status:200});
 vi.stubGlobal('fetch',fetchMock);
 await expect(uploadLuckyProof('event',new File(['a'],'a.png'))).rejects.toMatchObject({status:500});
 await uploadLuckyProof('event',new File(['a'],'a.png'));
 const [first,second]=sentPaths(fetchMock);
 expect(second).not.toBe(first);
});
