// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Snapshot } from '@/lib/personalFinance/contract';
const h=vi.hoisted(()=>({prepare:vi.fn(),mutate:vi.fn(),upload:vi.fn(),sign:vi.fn()}));
vi.mock('@/hooks/personal-finance/usePersonalFinance',()=>({usePersonalFinanceMutation:()=>({ownerId:'11111111-1111-4111-8111-111111111111',isPending:false,prepare:h.prepare,mutateAsync:h.mutate})}));
vi.mock('@/lib/personalFinance/personalAttachments',()=>({PERSONAL_ATTACHMENT_LIMIT:20,uploadPersonalAttachment:h.upload,signPersonalAttachment:h.sign}));
import { FinanceEditor } from './FinanceEditor';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const path=`${owner}/${other}.png`;
const s:Snapshot={owner_id:owner,schema_version:1,transactions:[],transfers:[],budgets:[],goals:[],categories:[{id:other,user_id:owner,version:1,type:'EXPENSE',name:'Ăn',icon:'',color:'',hidden:false,seed_key:null,legacy_name:null}],wallets:[{id:owner,user_id:owner,version:1,name:'cash',kind:'cash',icon:'',hidden:false,is_default:true,opening_balance:0,balance:0}]};
const record={id:other,version:1,type:'EXPENSE',amount:5,txn_date:'2026-10-07',wallet_id:owner,category_id:other,resolved_wallet_id:owner,resolved_category_id:other,description:'cũ',attachment_paths:[path]};
const show=(permissions={create:true,edit:true,delete:true},onClose=vi.fn())=>render(<FinanceEditor embedded editor={{entity:'transaction',record}} snapshot={s} permissions={permissions} onClose={onClose}/>);
beforeEach(()=>{vi.resetAllMocks();h.sign.mockResolvedValue('https://signed.test/bill');h.prepare.mockImplementation(payload=>({payload}));h.mutate.mockResolvedValue({entities:[]});});afterEach(cleanup);
it('shows private images and preserves paths when editing notes',async()=>{
 show();expect(await screen.findByAltText('Ảnh chứng từ 1')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Ghi chú'),{target:{value:'mới'}});fireEvent.click(screen.getByText('Lưu thay đổi'));
 await waitFor(()=>expect(h.prepare).toHaveBeenCalled());
 expect(h.prepare.mock.calls[0][0].data).toEqual({description:'mới'});
});
it('unlink is local until Save; cancel keeps the persisted transaction',async()=>{
 const close=vi.fn();show(undefined,close);await screen.findByAltText('Ảnh chứng từ 1');
 fireEvent.click(screen.getByLabelText('Gỡ ảnh chứng từ 1'));fireEvent.click(screen.getByText('Hủy'));
 expect(close).toHaveBeenCalled();expect(h.prepare).not.toHaveBeenCalled();expect(record.attachment_paths).toEqual([path]);
 cleanup();show();await screen.findByAltText('Ảnh chứng từ 1');fireEvent.click(screen.getByLabelText('Gỡ ảnh chứng từ 1'));fireEvent.click(screen.getByText('Lưu thay đổi'));
 await waitFor(()=>expect(h.prepare).toHaveBeenCalled());expect(h.prepare.mock.calls[0][0].data).toEqual({attachment_paths:[]});
});
it('read-only details show images without add/unlink controls',async()=>{
 show({create:false,edit:false,delete:false});await screen.findByAltText('Ảnh chứng từ 1');
 expect(screen.queryByLabelText('Thêm ảnh chứng từ')).toBeNull();expect(screen.queryByLabelText('Gỡ ảnh chứng từ 1')).toBeNull();
});
it('cancel aborts an upload immediately and ignores its completion even before outer unmount',async()=>{
 let finish!:(path:string)=>void;h.upload.mockImplementation(()=>new Promise<string>(r=>{finish=r;}));const close=vi.fn();show(undefined,close);
 fireEvent.change(screen.getByLabelText('Thêm ảnh chứng từ'),{target:{files:[new File(['img'],'bill.png',{type:'image/png'})]}});
 expect((screen.getByText('Lưu thay đổi') as HTMLButtonElement).disabled).toBe(true);const signal=h.upload.mock.calls[0][2] as AbortSignal;
 fireEvent.click(screen.getByText('Hủy'));expect(close).toHaveBeenCalledOnce();expect(signal.aborted).toBe(true);
 await act(async()=>finish(path));expect(h.prepare).not.toHaveBeenCalled();
});
