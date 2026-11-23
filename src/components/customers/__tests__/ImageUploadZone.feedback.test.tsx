// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({upload:vi.fn()}));
vi.mock('@/lib/storage',()=>({uploadFile:io.upload}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/components/ui/storage-image',()=>({StorageImage:()=>null}));
vi.mock('@/hooks/useClipboardImagePaste',()=>({useClipboardImagePaste:()=>({onMouseEnter:vi.fn(),onMouseLeave:vi.fn()})}));
import ImageUploadZone from '../ImageUploadZone';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {financialPending} from '@/lib/financialPending';
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();});afterEach(cleanup);
// Mỗi lần tải là tên tệp mới và đường dẫn chỉ tới biểu mẫu khi xong, nên lần tải chưa rõ kết quả
// (mất mạng) không được khoá ô: dừng các ảnh còn lại, cho Thử lại ngay, kể cả sau khi mở lại ô.
it('unknown stops remaining uploads, then retry and a remounted zone upload again without a durable block',async()=>{
 io.upload.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được tệp đã tải.','unknown',[{id:'customer-images/actor/1-0.png',label:'Đường dẫn tệp cần đối chiếu'}]));
 io.upload.mockResolvedValueOnce('stored:front').mockResolvedValueOnce('stored:back').mockResolvedValueOnce('stored:again');
 const props={label:'Ảnh CCCD',multiple:true,onChange:vi.fn(),onAddMany:vi.fn()};
 const view=render(<ImageUploadZone {...props}/>);
 const files=[new File(['x'],'front.png',{type:'image/png'}),new File(['x'],'back.png',{type:'image/png'})];
 fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files}});
 const retry=await screen.findByRole('button',{name:'Thử lại ảnh chưa tải'});
 const alert=screen.getByRole('alert').textContent??'';
 expect(alert).toContain('Đã tải 0/2 ảnh.');expect(alert).toContain('front.png: Chưa tải xong ảnh');expect(alert).toContain('Chưa gửi: back.png.');
 expect(alert).not.toContain('customer-images/actor/1-0.png');
 expect(io.upload).toHaveBeenCalledTimes(1);expect(props.onAddMany).not.toHaveBeenCalled();
 expect(view.container.querySelector<HTMLInputElement>('input[type=file]')!.disabled).toBe(false);
 fireEvent.click(retry);
 await waitFor(()=>expect(props.onAddMany).toHaveBeenCalledWith(['stored:front','stored:back']));
 expect(io.upload.mock.calls.map(c=>c[2].name)).toEqual(['front.png','front.png','back.png']);
 expect(screen.queryByRole('alert')).toBeNull();
 view.unmount();
 const next=render(<ImageUploadZone {...props}/>);
 fireEvent.change(next.container.querySelector('input[type=file]')!,{target:{files:[files[0]]}});
 await waitFor(()=>expect(props.onAddMany).toHaveBeenLastCalledWith(['stored:again']));
 expect(io.upload).toHaveBeenCalledTimes(4);
});
it('a network rejection without receipt shows a retryable message instead of internal paths',async()=>{
 io.upload.mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce('customer-images/actor/2-0.png');
 const changed=vi.fn();
 const view=render(<ImageUploadZone label="CCCD mặt trước" onChange={changed} imagePolicy="identity-original"/>);
 fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'IMG_4256.png',{type:'image/png'})]}});
 await screen.findByRole('button',{name:'Thử lại ảnh chưa tải'});
 expect(screen.getByRole('alert').textContent).toMatch(/^IMG_4256\.png: Chưa tải xong ảnh/);
 fireEvent.click(screen.getByRole('button',{name:'Thử lại ảnh chưa tải'}));
 await waitFor(()=>expect(changed).toHaveBeenCalledWith('customer-images/actor/2-0.png'));
});
// Dấu cũ của bộ điều phối 'image-upload-zone' (phạm vi actor) đã khoá ô "CCCD mặt trước" trên
// iPhone thật 23/11/2026; bản mới phải tự gỡ nó và tải bình thường.
it('clears a stuck legacy pending marker for this zone and uploads',async()=>{
 const scope={namespace:'image-upload-zone',userId:'actor',organizationId:'actor-scope',businessKey:'customer-images:CCCD mặt trước'};
 const prior=financialPending.markPending(scope);financialPending.recordCompleted(scope,prior.attemptId,['customer-images/actor/1795411459951-0.png']);
 const other={...scope,businessKey:'customer-images:CCCD mặt sau'};financialPending.markPending(other);
 io.upload.mockResolvedValueOnce('customer-images/actor/new-0.png');
 const changed=vi.fn();
 const view=render(<ImageUploadZone label="CCCD mặt trước" onChange={changed}/>);
 fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'IMG_4256.png',{type:'image/png'})]}});
 await waitFor(()=>expect(changed).toHaveBeenCalledWith('customer-images/actor/new-0.png'));
 expect(screen.queryByRole('alert')).toBeNull();
 expect(financialPending.read(scope)).toBeNull();
 // Chỉ gỡ dấu của đúng ô đang tải; ô kia tự gỡ khi được dùng.
 expect(financialPending.read(other)).not.toBeNull();
});
it('known rejection retries only the failed file and keeps earlier successful URLs',async()=>{io.upload.mockResolvedValueOnce('stored:first').mockRejectedValueOnce(new FinancialWorkflowError('Ảnh bị từ chối.','failure',[])).mockResolvedValueOnce('stored:second');const props={label:'Ảnh',multiple:true,onChange:vi.fn(),onAddMany:vi.fn()};const view=render(<ImageUploadZone {...props}/>);fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'first.png',{type:'image/png'}),new File(['x'],'second.png',{type:'image/png'})]}});await screen.findByRole('button',{name:'Thử lại ảnh chưa tải'});expect(props.onAddMany).toHaveBeenCalledWith(['stored:first']);fireEvent.click(screen.getByRole('button',{name:'Thử lại ảnh chưa tải'}));await waitFor(()=>expect(props.onAddMany).toHaveBeenLastCalledWith(['stored:second']));expect(io.upload.mock.calls.map(c=>c[2].name)).toEqual(['first.png','second.png','second.png']);});
it('reports uploading to the containing editor until completed and honors its disabled state', async () => {
 const busy=vi.fn();const changed=vi.fn();let resolve:(value:string)=>void=()=>{};
 io.upload.mockImplementation(()=>new Promise<string>(done=>{resolve=done;}));
 const props={label:'Ảnh phòng',onChange:changed,onUploadingChange:busy};
 const view=render(<ImageUploadZone {...props} disabled />);
 const input=view.container.querySelector('input[type=file]')!;
 const files=[new File(['x'],'room.png',{type:'image/png'})];
 fireEvent.change(input,{target:{files}});expect(io.upload).not.toHaveBeenCalled();
 view.rerender(<ImageUploadZone {...props}/>);
 fireEvent.change(input,{target:{files}});
 await waitFor(()=>expect(io.upload).toHaveBeenCalledTimes(1));
 expect(busy.mock.calls).toEqual([[true]]);expect(changed).not.toHaveBeenCalled();
 resolve('room-sale-images/actor/room.jpg');
 await waitFor(()=>expect(changed).toHaveBeenCalledWith('room-sale-images/actor/room.jpg'));
 expect(busy.mock.calls).toEqual([[true],[false]]);
});
