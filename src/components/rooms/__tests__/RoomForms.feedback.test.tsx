// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {RoomWithRelations} from '@/types/room';
import type {Database} from '@/integrations/supabase/types';
const io=vi.hoisted(()=>({create:vi.fn(),update:vi.fn(),remove:vi.fn(),sourceError:false,refetch:vi.fn()}));
vi.mock('@/hooks/useRooms',()=>({useCreateRoom:()=>({mutateAsync:io.create,isPending:false}),useUpdateRoom:()=>({mutateAsync:io.update,isPending:false}),useDeleteRoom:()=>({mutateAsync:io.remove,isPending:false})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'11111111-1111-4111-8111-111111111111',name:'Tòa A',status:'ACTIVE'}],isLoading:false,isError:io.sourceError,refetch:io.refetch})}));
vi.mock('@/hooks/useFloors',()=>({useFloors:()=>({data:[{id:'f1',floor_number:1}],isLoading:false,isError:false,refetch:io.refetch})}));
vi.mock('@/hooks/useDocumentTemplates',()=>({useDocumentTemplatesByType:()=>({data:[],isLoading:false,isError:false,refetch:io.refetch})}));
vi.mock('../RoomPriceHistorySection',()=>({RoomPriceHistorySection:()=>null}));
vi.mock('../QuickCreateBuildingDialog',()=>({default:()=>null}));
vi.mock('../QuickCreateFloorDialog',()=>({default:()=>null}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import RoomFormDialog from '../RoomFormDialog';
import {EditRoomDialog} from '../EditRoomDialog';
import {DeleteRoomDialog} from '../DeleteRoomDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {toast} from 'sonner';
const room:RoomWithRelations & Database['public']['Tables']['rooms']['Row']={id:'r1',building_id:'11111111-1111-4111-8111-111111111111',name:'P101',floor:1,rent_price:100,deposit_amount:100,status:'AVAILABLE',area:null,max_occupants:null,code:null,description:null,images:null,amenities:null,invoice_template_id:null,lease_template_id:null,created_at:'2026-09-30T00:00:00Z',updated_at:'2026-09-30T00:00:00Z',deleted_at:null,name_sort:null,organization_id:'org-a',room_type:null,sale_note:null,sale_bonus_note:null};
vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();io.sourceError=false;});
it('delete failure keeps the alert dialog open and never emits a second success',async()=>{
 io.remove.mockRejectedValue({code:'42501',message:'raw SQL'});const close=vi.fn();render(<DeleteRoomDialog open onOpenChange={close} room={room}/>);
 fireEvent.click(screen.getByRole('button',{name:'Xoá'}));await screen.findByRole('alert');
 expect(close).not.toHaveBeenCalled();expect(screen.getByRole('alert').textContent).not.toContain('raw SQL');expect(toast.success).not.toHaveBeenCalled();
});
it.each([['room',RoomFormDialog,'Cập nhật'],['edit',EditRoomDialog,'Cập nhật']])('%s unknown preserves draft and ID through close/reopen and query refresh',async(_name,Dialog,submit)=>{
 io.update.mockRejectedValue(new FinancialWorkflowError('Chưa xác nhận căn hộ.','unknown',[{id:'r1',label:'Căn hộ'}]));const close=vi.fn();
 const view=render(<Dialog open onOpenChange={close} room={room}/>);
 fireEvent.change(screen.getByLabelText(/Tên (căn hộ|phòng)/),{target:{value:'P101 sửa dở'}});fireEvent.click(screen.getByRole('button',{name:submit}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('r1'));
 expect(close).not.toHaveBeenCalled();
 view.rerender(<Dialog open={false} onOpenChange={close} room={{...room}}/>);view.rerender(<Dialog open onOpenChange={close} room={{...room}}/>);
 expect((screen.getByLabelText(/Tên (căn hộ|phòng)/) as HTMLInputElement).value).toBe('P101 sửa dở');
 fireEvent.click(screen.getByRole('button',{name:submit}));expect(io.update).toHaveBeenCalledTimes(1);
});
it('room source error blocks saving and offers retry without pretending sources are empty',async()=>{
 io.sourceError=true;render(<RoomFormDialog open onOpenChange={vi.fn()} room={room}/>);
 expect(screen.getByRole('alert').textContent).toMatch(/tải|Tải/);fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));expect(io.update).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:/Tải lại/}));expect(io.refetch).toHaveBeenCalled();
});
