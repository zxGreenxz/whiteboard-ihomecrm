// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
import {uploadLuckyProof} from '../luckyDrawApi';
beforeEach(()=>vi.unstubAllGlobals());
it('retains the planned object before a transport response is lost',async()=>{const planned=vi.fn(),rejected=vi.fn();vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>{expect(planned).toHaveBeenCalledTimes(1);throw new TypeError('Failed to fetch');}));await expect(uploadLuckyProof('event',new File(['a'],'a.png'),{onPlanned:planned,onRejected:rejected})).rejects.toThrow();expect(planned).toHaveBeenCalledWith(expect.objectContaining({path:expect.stringMatching(/^event\//),name:'a.png'}));expect(rejected).not.toHaveBeenCalled();});
it('known storage permission rejection clears only its planned object',async()=>{const planned=vi.fn(),rejected=vi.fn();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));await expect(uploadLuckyProof('event',new File(['a'],'a.png'),{onPlanned:planned,onRejected:rejected})).rejects.toThrow();expect(rejected).toHaveBeenCalledWith(planned.mock.calls[0][0]);});
it('storage server error retains the planned object and cannot be retried as a new upload',async()=>{const planned=vi.fn(),rejected=vi.fn();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:500}));await expect(uploadLuckyProof('event',new File(['a'],'a.png'),{onPlanned:planned,onRejected:rejected})).rejects.toThrow();expect(planned).toHaveBeenCalledTimes(1);expect(rejected).not.toHaveBeenCalled();});
