// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({update:vi.fn(),remove:vi.fn(),sourceError:false,retry:vi.fn()}));
vi.mock('@/hooks/useAssets',()=>({useUpdateAsset:()=>({mutateAsync:io.update,isPending:false}),useDeleteAsset:()=>({mutateAsync:io.remove,isPending:false})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[],isLoading:false,isError:false,refetch:io.retry})}));
vi.mock('@/hooks/useRooms',()=>({useRooms:()=>({data:[],isLoading:false,isError:false,refetch:io.retry})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(config:{queryKey:string[]})=>({data:[],isLoading:false,isError:io.sourceError&&config.queryKey[0]==='asset-categories',refetch:io.retry})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
import {EditAssetDialog} from '../EditAssetDialog';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
afterEach(()=>{cleanup();vi.resetAllMocks();io.sourceError=false;});
const asset={id:'a1',code:'A1',name:'Ghế',category_id:'cat1',quantity:1,condition:'GOOD',purchase_price:100} as never;
it('unknown asset receipt keeps ID and draft across refresh and prevents replay',async()=>{
 io.update.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận tài sản.','unknown',[{id:'a1',label:'Tài sản cần đối chiếu'}]));
 const close=vi.fn();const view=render(<EditAssetDialog open onOpenChange={close} asset={asset}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên tài sản'),{target:{value:'Draft ghế'}});fireEvent.click(screen.getByRole('button',{name:'Lưu thay đổi'}));await screen.findByRole('alert');
 view.rerender(<EditAssetDialog open={false} onOpenChange={close} asset={{...asset as object,name:'Reloaded'} as never}/>);view.rerender(<EditAssetDialog open onOpenChange={close} asset={{...asset as object,name:'Reloaded'} as never}/>);
 expect((screen.getByPlaceholderText('Nhập tên tài sản') as HTMLInputElement).value).toBe('Draft ghế');expect(screen.getByRole('alert').textContent).toContain('a1');fireEvent.click(screen.getByRole('button',{name:'Lưu thay đổi'}));expect(io.update).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();
});
it('category source failure has explicit retry and prevents saving a stale selection',async()=>{
 io.sourceError=true;render(<EditAssetDialog open onOpenChange={vi.fn()} asset={asset}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải đủ');fireEvent.click(screen.getByRole('button',{name:'Lưu thay đổi'}));expect(io.update).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Tải lại dữ liệu'}));await waitFor(()=>expect(io.retry).toHaveBeenCalled());
});
it('delete unknown keeps confirmation open with the target ID and blocks a second delete',async()=>{
 io.remove.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận xóa.','unknown',[{id:'a1',label:'Tài sản cần đối chiếu'}]));render(<EditAssetDialog open onOpenChange={vi.fn()} asset={asset}/>);fireEvent.click(screen.getByRole('button',{name:'Xóa'}));
 const dialog=screen.getByRole('alertdialog');fireEvent.click(within(dialog).getByRole('button',{name:'Xóa'}));
 await waitFor(()=>expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toContain('a1'));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Xóa'}));expect(io.remove).toHaveBeenCalledTimes(1);
});