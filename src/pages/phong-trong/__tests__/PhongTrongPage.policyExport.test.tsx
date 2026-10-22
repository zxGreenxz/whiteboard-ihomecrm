// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Building, Room } from '../sampleData';
const h=vi.hoisted(()=>({query:{data:[] as Building[],isLoading:false,isError:false,error:null,refetch:vi.fn(),readFresh:vi.fn()},download:vi.fn()}));
vi.mock('../usePhongTrong',()=>({usePhongTrong:()=>h.query}));
vi.mock('../exportRoomListImage',()=>({downloadRoomListImage:h.download}));
vi.mock('@/hooks/useAuth',()=>({useSession:()=>({data:null})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:null})}));
vi.mock('../QuickDepositModal',()=>({QuickDepositModal:()=>null}));
vi.mock('../LockRoomModal',()=>({LockRoomModal:()=>null}));
vi.mock('../useTracking',()=>({useTracking:()=>({track:vi.fn(),trackError:vi.fn()}),useTrack:()=>({track:vi.fn(),trackError:vi.fn()}),TrackingProvider:({children}:{children:React.ReactNode})=>children}));
import PhongTrongPage from '../PhongTrongPage';
const room:Room={id:'r',no:101,code:'101',buildingId:'b',buildingName:'Tòa A',buildingArea:'',buildingAddr:'',floor:1,type:'Studio',price:3,area:20,status:'free',amenities:[],availDate:null,imgCount:0,phClass:'',x:0,y:0,w:1,h:1,saleNote:'Ưu đãi cũ'};
const buildings:Building[]=[{id:'b',code:'b',name:'Tòa A',area:'',district:'Q1',address:'',manager:'',phone:'',lift:false,policy:'',floors:[],rooms:[room],freeCount:1,total:1}];
const fresh:Building[]=[{...buildings[0]!,rooms:[{...room,saleNote:'Ghi chú nền'}]}];
beforeEach(()=>{vi.clearAllMocks();h.query.data=buildings;h.query.readFresh.mockResolvedValue(fresh);h.download.mockResolvedValue(1);localStorage.clear();sessionStorage.clear();});
afterEach(cleanup);
const open=(props:Parameters<typeof PhongTrongPage>[0])=>render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><PhongTrongPage {...props}/></MemoryRouter>);
it('C10 public image export reads fresh policy state before drawing',async()=>{
 open({token:'local'});fireEvent.click(screen.getByTitle('Tải ảnh danh sách phòng trống'));
 await waitFor(()=>expect(h.download).toHaveBeenCalledWith(fresh));expect(h.query.readFresh).toHaveBeenCalledTimes(1);
});
it('C11 a failed refresh cannot export the cached expired promotion',async()=>{
 h.query.readFresh.mockRejectedValue(new Error('offline'));open({token:'local'});fireEvent.click(screen.getByTitle('Tải ảnh danh sách phòng trống'));
 await screen.findByText('Chưa xác minh được danh sách mới nhất để tạo ảnh. Vui lòng thử lại.');expect(h.download).not.toHaveBeenCalled();
});
it('C12 supplied in-app data export uses its authenticated refresh callback',async()=>{
 const refresh=vi.fn().mockResolvedValue(fresh);open({buildings,readFreshBuildings:refresh});
 fireEvent.click(screen.getByTitle('Tải ảnh danh sách phòng trống'));await waitFor(()=>expect(h.download).toHaveBeenCalledWith(fresh));
 expect(refresh).toHaveBeenCalledTimes(1);expect(h.query.readFresh).not.toHaveBeenCalled();
});
