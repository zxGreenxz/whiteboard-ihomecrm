// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PermissionsMap } from '@/hooks/useMyPermissions';
import type { Building, Room } from '../sampleData';
const h=vi.hoisted(()=>({signedIn:true,perms:{} as PermissionsMap}));
vi.mock('../usePhongTrong',()=>({usePhongTrong:()=>({data:[],isLoading:false,isError:false})}));
vi.mock('@/hooks/useAuth',()=>({useSession:()=>({data:h.signedIn?{user:{id:'sale'}}:null})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:h.perms})}));
vi.mock('../QuickDepositModal',()=>({QuickDepositModal:({room}:{room:Room|null})=>room?<div data-testid="quick-deposit">{room.id}</div>:null}));
vi.mock('../LockRoomModal',()=>({LockRoomModal:()=>null}));
vi.mock('../useTracking',()=>({
  useTracking:()=>({track:vi.fn(),trackError:vi.fn()}),useTrack:()=>({track:vi.fn(),trackError:vi.fn()}),
  TrackingProvider:({children}:{children:React.ReactNode})=>children,
}));
import PhongTrongPage from '../PhongTrongPage';
const room=(id:string,buildingId:string):Room=>({
  id,no:101,code:id,buildingId,buildingName:buildingId,buildingArea:'',buildingAddr:'',floor:1,type:'Studio',
  price:3,area:20,status:'free',amenities:[],availDate:null,imgCount:0,phClass:'',x:0,y:0,w:1,h:1,
});
const buildings:Building[]=['building-a','building-b'].map(id=>({
  id,code:id,name:id,area:'',district:'Q1',address:'',manager:'',phone:'',lift:false,policy:'',
  floors:[],rooms:[room(`room-${id}`,id)],freeCount:1,total:1,
}));
const view=()=>render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}>
  <PhongTrongPage embedded buildings={buildings}/></MemoryRouter>);
beforeEach(()=>{h.signedIn=true;h.perms={};localStorage.clear();sessionStorage.clear();});
afterEach(cleanup);
describe('quick deposit authority matches canonical writer',()=>{
  it('shows and opens quick deposit only within deposits.create building scope',()=>{
    h.perms={deposits:{create:{org_wide:false,building_ids:['building-a']}}};
    view();
    expect(screen.getAllByTitle('Tạo cọc giữ phòng')).toHaveLength(1);
    fireEvent.click(screen.getByTitle('Tạo cọc giữ phòng'));
    expect(screen.getByTestId('quick-deposit').textContent).toBe('room-building-a');
  });
  it('legacy sale_phong.create_deposit alone cannot mount a money dialog',()=>{
    h.perms={sale_phong:{create_deposit:true}};
    view();
    expect(screen.queryByTitle('Tạo cọc giữ phòng')).toBeNull();
    expect(screen.queryByTestId('quick-deposit')).toBeNull();
  });
  it('anonymous never sees the quick deposit action even with a cached permission map',()=>{
    h.signedIn=false;h.perms={deposits:{create:true}};
    view();expect(screen.queryByTitle('Tạo cọc giữ phòng')).toBeNull();
  });
  it('revoking building authority removes an already opened modal on rerender',()=>{
    h.perms={deposits:{create:true}};
    const mounted=view();fireEvent.click(screen.getAllByTitle('Tạo cọc giữ phòng')[0]);
    h.perms={deposits:{create:{org_wide:false,building_ids:['building-b']}}};
    mounted.rerender(<MemoryRouter><PhongTrongPage embedded buildings={buildings}/></MemoryRouter>);
    expect(screen.queryByTestId('quick-deposit')).toBeNull();
    expect(screen.getAllByTitle('Tạo cọc giữ phòng')).toHaveLength(1);
  });
});
