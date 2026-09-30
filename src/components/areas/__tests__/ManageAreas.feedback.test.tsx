// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({save:vi.fn(),assign:vi.fn(),retry:vi.fn().mockResolvedValue({isError:false})}));
vi.mock('@/hooks/useAreas',()=>({useAreas:()=>({data:[{id:'a1',name:'Khu A'}],isError:false,isLoading:false,refetch:io.retry}),useCreateArea:()=>({mutate:io.save,isPending:false}),useUpdateArea:()=>({mutate:io.save,isPending:false}),useDeleteArea:()=>({mutate:io.save,isPending:false}),useAssignBuildingsToArea:()=>({mutate:io.assign,isPending:false}),AreaDeletePartialError:class extends Error{},AreaMembershipPartialError:class extends Error{}}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'b1',area_ids:['a1']}],isError:false,isLoading:false,refetch:io.retry})}));
vi.mock('@/components/buildings/BuildingMultiSelect',()=>({BuildingMultiSelect:({onChange}:{onChange:(value:string[])=>void})=><button onClick={()=>onChange(['b2'])}>Đổi tòa</button>}));
import ManageAreasDialog from '../ManageAreasDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('unknown membership retains IDs and a successful refresh cannot authorize replay',async()=>{io.assign.mockImplementation((_input,options)=>options.onError(new FinancialWorkflowError('Chưa hoàn tất gán tòa.','partial',[{id:'a1:b2',label:'Liên kết đã lưu'}])));const props={open:true,onOpenChange:vi.fn()};const view=render(<ManageAreasDialog {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Đổi tòa'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('a1:b2'));fireEvent.click(screen.getByRole('button',{name:'Tải lại để đối chiếu'}));await waitFor(()=>expect(io.retry).toHaveBeenCalled());view.rerender(<ManageAreasDialog {...props} open={false}/>);view.rerender(<ManageAreasDialog {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Đổi tòa'}));expect(io.assign).toHaveBeenCalledTimes(1);expect(screen.getByRole('alert').textContent).toContain('a1:b2');});
