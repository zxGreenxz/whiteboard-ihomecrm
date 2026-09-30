// @vitest-environment jsdom
import React,{useState} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';

const h=vi.hoisted(()=>({loads:vi.fn(),report:vi.fn()}));
vi.mock('@/components/errors/boundaryReporter',()=>({reportBoundaryError:h.report}));
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();h.report.mockReset();document.body.innerHTML='';
 vi.doMock('../formErrors',async()=>{h.loads();return vi.importActual<typeof import('../formErrors')>('../formErrors');});
});
afterEach(async()=>{cleanup();document.body.innerHTML='';await vi.dynamicImportSettled();vi.doUnmock('../formErrors');vi.restoreAllMocks();});
const subject=()=>import('../asyncFormErrors');

it('does not load focus machinery at import or for empty/root-only errors',async()=>{
 const {focusFirstError}=await subject();expect(h.loads).not.toHaveBeenCalled();
 document.body.innerHTML='<input name="email" />';
 for(const errors of [{},null,{root:{server:{message:'Chưa lưu được'}}}])expect(await focusFirstError(errors)).toBe(false);
 await vi.dynamicImportSettled();expect(h.loads).not.toHaveBeenCalled();expect(document.activeElement).toBe(document.body);
});
it('loads the real helper only for errors and preserves root/order/reveal and mounted control focus',async()=>{
 const {focusFirstError}=await subject();expect(h.loads).not.toHaveBeenCalled();
 document.body.innerHTML='<input name="identifier" id="outside"/><form><input name="password"/><details><summary>Thông tin</summary><input name="identifier" id="inside"/></details></form>';
 const root=document.querySelector('form');if(!root)throw new Error('Expected form root');
 const reveal=vi.fn<(name:string)=>Promise<void>>(async()=>{});
 expect(await focusFirstError({password:'Nhập mật khẩu',identifier:'Nhập tài khoản'},{root,order:['identifier','password'],reveal})).toBe(true);
 expect(document.activeElement?.id).toBe('inside');expect(document.querySelector('details')?.open).toBe(true);expect(reveal).toHaveBeenCalledExactlyOnceWith('identifier');expect(h.loads).toHaveBeenCalledOnce();expect(h.report).not.toHaveBeenCalled();
});
it('chunk failure still focuses the first visible enabled errored control in passed order inside the root',async()=>{
 const failure=new TypeError('private unavailable focus chunk');vi.doMock('../formErrors',()=>{h.loads();throw failure;});
 const {focusFirstError}=await subject();
 document.body.innerHTML='<input name="identifier" id="outside"/><form><input name="password" id="password"/><input name="identifier" disabled/><input name="identifier" type="hidden"/><div hidden><input name="identifier"/></div><div aria-hidden="true"><input name="identifier"/></div><div inert><input name="identifier"/></div><div style="display:none"><input name="identifier"/></div><div style="visibility:hidden"><input name="identifier"/></div><input name="identifier" id="inside"/><input name="clean"/></form>';
 const root=document.querySelector('form');if(!root)throw new Error('Expected form root');
 expect(await focusFirstError({password:'Nhập mật khẩu',identifier:'Nhập tài khoản'},{root,order:['identifier','password']})).toBe(true);
 expect(document.activeElement?.id).toBe('inside');expect(h.report).toHaveBeenCalledOnce();expect(h.report.mock.calls[0]?.[0]).toMatchObject({cause:{cause:failure}});expect(document.body.textContent).not.toContain('private');
});
it('fallback waits for React to commit controls while keeping inline errors visible',async()=>{
 vi.doMock('../formErrors',()=>{throw new Error('focus chunk unavailable');});const {focusFirstError}=await subject();
 function AuthForm(){const [failed,setFailed]=useState(false);return <form onSubmit={event=>{event.preventDefault();setTimeout(()=>setFailed(true),0);void focusFirstError({email:'Nhập email'});}}><button type="submit">Kiểm tra</button>{failed&&<><input name="email" aria-invalid="true"/><p role="alert">Nhập email</p></>}</form>;}
 render(<AuthForm/>);fireEvent.click(screen.getByRole('button',{name:'Kiểm tra'}));
 expect(await screen.findByRole('alert')).toBeTruthy();await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('email'));
});
it('fallback leaves focus unchanged when no errored control is enabled or visible',async()=>{
 vi.doMock('../formErrors',()=>{throw new Error('focus chunk unavailable');});const {focusFirstError}=await subject();
 document.body.innerHTML='<form><fieldset disabled><input name="email"/></fieldset><input name="other"/></form>';
 expect(await focusFirstError({email:'Nhập email'})).toBe(false);expect(document.activeElement).toBe(document.body);expect(h.report).toHaveBeenCalledOnce();
});
it('a failing diagnostic sink cannot reject fallback focus',async()=>{
 vi.doMock('../formErrors',()=>{throw new Error('focus chunk unavailable');});h.report.mockImplementation(()=>{throw new Error('diagnostic unavailable');});const {focusFirstError}=await subject();
 document.body.innerHTML='<input name="email"/>';
 expect(await focusFirstError({email:'Nhập email'})).toBe(true);expect(document.activeElement?.getAttribute('name')).toBe('email');
});
