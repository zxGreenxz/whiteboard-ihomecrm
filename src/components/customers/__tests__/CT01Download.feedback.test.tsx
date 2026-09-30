// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
type CustomerFixture = React.ComponentProps<typeof CT01DownloadButton>['customer'];
const h=vi.hoisted(()=>({download:vi.fn(),success:vi.fn(),error:vi.fn()}));
vi.mock('sonner',()=>({toast:{success:h.success,error:h.error}}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{}})}));
vi.mock('@/lib/permissionPages',()=>({canUse:()=>true}));
vi.mock('@/lib/ct01DownloadService',()=>({loadCT01Tenancies:async()=>[{building:{id:'b',name:'Tòa A'},roomNumber:'101'}]}));
vi.mock('@/lib/buildingLegalOwner',()=>({loadBuildingLegalOwner:async()=>({name:'Owner'})}));
vi.mock('@/lib/ct01Document',()=>({CT01InputError:class extends Error{},downloadCT01Document:h.download}));
import CT01DownloadButton from '../CT01DownloadButton';
beforeEach(()=>{vi.clearAllMocks();h.download.mockReset().mockResolvedValue(undefined);});afterEach(cleanup);
it('awaits file preparation and does not claim it was saved on the computer',async()=>{render(<CT01DownloadButton customer={{id:'c',full_name:'Khách'} as CustomerFixture}/>);fireEvent.click(screen.getByRole('button'));await waitFor(()=>expect(h.success).toHaveBeenCalledWith('Đã chuẩn bị tệp CT01 và hợp đồng thuê nhà để tải xuống.'));});
it('technical preparation failure stays safe and never reports successful download',async()=>{h.download.mockRejectedValue({code:'XX000',message:'SELECT private'});render(<CT01DownloadButton customer={{id:'c',full_name:'Khách'} as CustomerFixture}/>);fireEvent.click(screen.getByRole('button'));await waitFor(()=>expect(h.error).toHaveBeenCalledOnce());expect(h.error.mock.calls[0][0]).not.toContain('SELECT private');expect(h.success).not.toHaveBeenCalled();});
