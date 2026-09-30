// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>query([])}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>query([])}));
vi.mock('@/hooks/useJobTypes',()=>({useJobTypes:()=>query([]),useCreateJobType:()=>({isPending:false,mutateAsync:vi.fn()})}));
vi.mock('@/hooks/useJobs',()=>({useProfiles:()=>query([]),useCreateJob:()=>({isPending:false,mutateAsync:m.create})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'u'}})}));
vi.mock('@/hooks/use-mobile',()=>({useIsMobile:()=>false}));
vi.mock('@/hooks/useMaterials',()=>({useMaterials:()=>query([])}));
vi.mock('@/hooks/useMaterialUsages',()=>({useUpsertJobMaterialUsage:()=>({mutateAsync:vi.fn()})}));
vi.mock('@/components/income-expenses/AttachmentUpload',()=>({default:()=>null}));
vi.mock('@/components/materials/MaterialUsageItemsEditor',()=>({default:()=>null,newUsageItemRow:()=>({id:'line',material_id:null,quantity:''})}));
function query(data:unknown){return {data,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()}}
import TaskCreateDialog from '../TaskCreateDialog';
afterEach(cleanup);
it('tạo nhanh trống nêu cú pháp cần nhập, đánh đỏ và focus mô tả',async()=>{
 render(<TaskCreateDialog open onOpenChange={vi.fn()} onSuccess={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));const input=screen.getByRole('textbox',{name:/Mô tả nhanh/});
 await waitFor(()=>expect(input.getAttribute('aria-invalid')).toBe('true'));expect(document.activeElement).toBe(input);expect(screen.getByRole('alert').textContent).toContain('phòng');expect(m.create).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'201'}});expect(input.getAttribute('aria-invalid')).toBe('true');expect(screen.getByRole('alert').textContent).not.toBe('');
});
