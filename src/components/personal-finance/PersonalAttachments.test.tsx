// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
const h=vi.hoisted(()=>({upload:vi.fn(),sign:vi.fn()}));
vi.mock('@/lib/personalFinance/personalAttachments',()=>({PERSONAL_ATTACHMENT_LIMIT:20,uploadPersonalAttachment:h.upload,signPersonalAttachment:h.sign}));
import { PersonalAttachments } from './PersonalAttachments';
import { PopoverContainerContext } from '@/components/ui/popover';
const owner='11111111-1111-4111-8111-111111111111';
const path=`${owner}/22222222-2222-4222-8222-222222222222.webp`;
const file=new File(['img'],'bill.png',{type:'image/png'});
function Harness({onChange=vi.fn(),ownerId=owner}:{onChange?:(paths:string[])=>void;ownerId?:string}){const [paths,setPaths]=useState<string[]>([]),[blocked,setBlocked]=useState(false);return <><PersonalAttachments ownerId={ownerId} instanceKey="editor" paths={paths} editable onChange={next=>{setPaths(next);onChange(next);}} onBlockedChange={setBlocked}/><button disabled={blocked}>Save</button></>;}
beforeEach(()=>{vi.resetAllMocks();h.sign.mockResolvedValue('https://signed.test/bill');});afterEach(cleanup);
it('retains failed files, blocks Save and retries while preserving successful paths',async()=>{
 h.upload.mockResolvedValueOnce(path).mockRejectedValueOnce(new Error('403 không có quyền'));
 render(<Harness/>);fireEvent.change(screen.getByLabelText('Thêm ảnh chứng từ'),{target:{files:[file,file]}});
 await screen.findByText('403 không có quyền');expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
 expect(await screen.findByAltText('Ảnh chứng từ 1')).toBeTruthy();
 h.upload.mockResolvedValueOnce(path.replace('22222222','33333333'));
 fireEvent.click(screen.getByText('Thử tải ảnh lại'));await screen.findByAltText('Ảnh chứng từ 2');
 expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false);expect(h.upload).toHaveBeenCalledTimes(3);
});
it('aborts on close and ignores a late upload completion',async()=>{
 let finish!:(path:string)=>void;h.upload.mockImplementation(()=>new Promise<string>(r=>{finish=r;}));
 const change=vi.fn(),view=render(<Harness onChange={change}/>);fireEvent.change(screen.getByLabelText('Thêm ảnh chứng từ'),{target:{files:[file]}});
 expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
 const signal=h.upload.mock.calls[0][2] as AbortSignal;view.unmount();expect(signal.aborted).toBe(true);
 await act(async()=>finish(path));expect(change).not.toHaveBeenCalled();
});
it('owner change ignores late result and allows the new editor to upload independently',async()=>{
 let finish!:(path:string)=>void;h.upload.mockImplementationOnce(()=>new Promise<string>(r=>{finish=r;}));
 const change=vi.fn(),view=render(<Harness onChange={change}/>);fireEvent.change(screen.getByLabelText('Thêm ảnh chứng từ'),{target:{files:[file]}});
 view.rerender(<Harness ownerId="other" onChange={change}/>);await act(async()=>finish(path));expect(change).not.toHaveBeenCalled();
 h.upload.mockResolvedValueOnce('other/new.png');fireEvent.change(screen.getByLabelText('Thêm ảnh chứng từ'),{target:{files:[file]}});await waitFor(()=>expect(change).toHaveBeenCalledWith(['other/new.png']));
});
it('signing failure shows retry, never a public image; retry opens lightbox',async()=>{
 h.sign.mockRejectedValueOnce(new Error('403'));render(<PersonalAttachments ownerId={owner} instanceKey="editor" paths={[path]} editable={false} onChange={vi.fn()} onBlockedChange={vi.fn()}/>);
 await screen.findByText('Không tải được ảnh chứng từ.');expect(screen.queryByAltText('Ảnh chứng từ 1')).toBeNull();
 fireEvent.click(screen.getByText('Thử tải ảnh 1 lại'));await screen.findByAltText('Ảnh chứng từ 1');
 fireEvent.click(screen.getByLabelText('Xem ảnh chứng từ 1'));expect(await screen.findByAltText('Ảnh chứng từ phóng lớn')).toBeTruthy();
});
it('inside a native modal sheet the lightbox portals into the sheet, not under its top layer',async()=>{
 const sheet=document.body.appendChild(document.createElement('dialog'));
 render(<PopoverContainerContext.Provider value={sheet}><PersonalAttachments ownerId={owner} instanceKey="editor" paths={[path]} editable={false} onChange={vi.fn()} onBlockedChange={vi.fn()}/></PopoverContainerContext.Provider>);
 fireEvent.click(await screen.findByLabelText('Xem ảnh chứng từ 1'));
 expect(sheet.contains(await screen.findByAltText('Ảnh chứng từ phóng lớn'))).toBe(true);
 sheet.remove();
});
it('rejects unsupported files and enforces 20 images before any upload',()=>{
 render(<Harness/>);fireEvent.change(screen.getByLabelText('Thêm ảnh chứng từ'),{target:{files:[new File(['pdf'],'a.pdf',{type:'application/pdf'})]}});expect(screen.getByText('Chỉ nhận ảnh JPG, PNG hoặc WebP.')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Thêm ảnh chứng từ'),{target:{files:Array(21).fill(file)}});expect(screen.getByText('Tối đa 20 ảnh chứng từ.')).toBeTruthy();expect(h.upload).not.toHaveBeenCalled();
});
