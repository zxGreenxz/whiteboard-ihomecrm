// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {RentSupportReconciliationPanel} from './RentSupportReconciliationPanel';
const fixtures=vi.hoisted(()=>({error:false,candidate:null as Record<string,unknown>|null,preview:vi.fn()}));
vi.mock('@/hooks/useRentSupportLifecycle',()=>({
 useRentSupportLifecycle:()=>({isLoading:false,error:fixtures.error?new Error('read failed'):null,refetch:vi.fn(),data:{plan_revision:1,committed:'1800000',consumed:'900000',unused_committed:'900000',state:'NEEDS_REVIEW',issues:[{code:'TERMINATION_REVIEW',message:'Phần chưa dùng cần xử lý'}],sources:[]}}),
 useRentSupportReconciliationContext:()=>({isLoading:false,error:null,data:fixtures.candidate}),
 useRentSupportLifecycleActions:()=>({request:{isPending:false,mutateAsync:vi.fn()},preview:{isPending:false,mutateAsync:fixtures.preview},apply:{isPending:false,mutateAsync:vi.fn()}}),
}));
afterEach(()=>{cleanup();fixtures.error=false;fixtures.candidate=null;fixtures.preview.mockReset();});
it('opens review only in the selected contract context and preserves unused amount label',()=>{
 render(<RentSupportReconciliationPanel organizationId="org" contractId="contract" voucherId="voucher"/>);
 expect(screen.queryByText('Đã hưởng')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Hỗ trợ tiền thuê'}));
 expect(screen.getByText('Đã hưởng')).toBeTruthy();
 expect(screen.getByText('Đã giữ, chưa dùng')).toBeTruthy();
 expect(screen.getByText('Phần chưa dùng cần xử lý')).toBeTruthy();
});
it('shows a read failure without presenting unknown money as zero',()=>{
 fixtures.error=true;render(<RentSupportReconciliationPanel organizationId="org" contractId="contract" voucherId="voucher"/>);
 fireEvent.click(screen.getByRole('button',{name:'Hỗ trợ tiền thuê'}));
 expect(screen.getByRole('alert').textContent).toContain('Không tải được');
 expect(screen.queryByText('Đã hưởng')).toBeNull();
});
it('discards an in-flight preview when the user changes the attested amounts',async()=>{
 const id='00000000-0000-4000-8000-000000000001';
 fixtures.candidate={source_id:id,contract_id:id,voucher_id:id,party_id:id,kind:'COMMISSION',engine_net:'1200000',expected_approval_version:1,expected_posting_version:1,documents:[]};
 let finish:(value:unknown)=>void=()=>{};
 fixtures.preview.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<RentSupportReconciliationPanel organizationId={id} contractId={id} voucherId={id}/>);
 fireEvent.click(screen.getByRole('button',{name:'Hỗ trợ tiền thuê'}));
 fireEvent.change(screen.getByLabelText('Tổng quyền lợi trước khấu trừ'),{target:{value:'3000000'}});
 fireEvent.change(screen.getByLabelText('Số hỗ trợ đã giữ trước đây'),{target:{value:'1800000'}});
 fireEvent.change(screen.getByLabelText('Lý do và căn cứ đối chiếu'),{target:{value:'Verified exact source'}});
 fireEvent.click(screen.getByRole('button',{name:'Xem đối chiếu'}));
 fireEvent.change(screen.getByLabelText('Tổng quyền lợi trước khấu trừ'),{target:{value:'4000000'}});
 await act(async()=>finish({state:'READY',batch_hash:'old',totals:{gross:'3000000',previous_withheld:'1800000',net:'1200000'},rows:[]}));
 expect(screen.queryByRole('button',{name:'Lưu đối chiếu'})).toBeNull();
});
