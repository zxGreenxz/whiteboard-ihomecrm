// @vitest-environment jsdom
// Đợt 10c: hộp «Đánh dấu đã kiểm» gửi GIÁ TRỊ MUỐN ĐẶT theo đúng trạng thái hộp đang hiện (không bật/tắt), và sau một
// lần chưa rõ kết quả thì nút không bị khoá: bấm lại gửi lại ngay đúng giá trị đó, máy chủ khoá phiếu rồi so nên không
// đảo ngược. Máy chủ giả dựng theo thân migration 20261126202634.
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {fakeRecordServer,pendingKeys,type FakeRecordServer} from '@/hooks/__tests__/fakeRecordServer';

const io=vi.hoisted(()=>({server:undefined as unknown as FakeRecordServer}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:(table:string)=>io.server.from(table),get rpc(){return io.server.rpc;}}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),warning:vi.fn(),success:vi.fn(),info:vi.fn()}}));
import {IncomeExpenseVerifyDialog} from '../IncomeExpenseVerifyDialog';
import type {IncomeExpenseWithRelations} from '@/hooks/useIncomeExpenses';

type Row=Record<string,unknown>;
const row=()=>io.server.rows.income_expenses[0] as Row;
const verifyCalls=()=>io.server.rpcCalls.filter(call=>call.name==='verify_income_expense_v1');
const renderDialog=(voucher:Row,onOpenChange=vi.fn())=>{
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false},queries:{retry:false}}})}>
    <IncomeExpenseVerifyDialog open onOpenChange={onOpenChange} voucher={voucher as unknown as IncomeExpenseWithRelations}/>
  </QueryClientProvider>);
  return onOpenChange;
};

beforeEach(()=>{
  localStorage.clear();
  io.server=fakeRecordServer();
  io.server.rows.income_expenses=[{id:'v1',code:'PC2511001',name:'Sửa ống nước',type:'EXPENSE',payment_id:null,approval_status:'APPROVED',posting_status:'POSTED',approval_version:2,posting_version:1,verified_at:null,verified_by_name:null,verified_note:null}];
  io.server.rpcHandlers.verify_income_expense_v1=args=>{
    const target=row();
    if(typeof args.p_verified!=='boolean'){target.verified_at=target.verified_at?null:new Date().toISOString();return {data:null,error:null};}
    const changed=(target.verified_at!==null)!==args.p_verified;
    if(changed)Object.assign(target,{verified_at:args.p_verified?new Date().toISOString():null,verified_note:args.p_verified?args.p_note??null:null});
    return {data:{id:target.id,changed,verified:args.p_verified,verified_at:target.verified_at,verified_by_name:null},error:null};
  };
});
afterEach(cleanup);

describe('hộp «Đã kiểm» gửi giá trị muốn đặt', () => {
  it('phiếu chưa kiểm: «Xác nhận đã kiểm» gửi p_verified = true kèm ghi chú', async () => {
    const onOpenChange=renderDialog({...row()});
    fireEvent.change(screen.getByLabelText('Ghi chú kiểm tra (tuỳ chọn)'),{target:{value:'  đã đối chiếu  '}});
    fireEvent.click(screen.getByRole('button',{name:'Xác nhận đã kiểm'}));
    await waitFor(()=>expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(verifyCalls().map(call=>call.args)).toEqual([{p_id:'v1',p_note:'đã đối chiếu',p_verified:true}]);
    expect(row().verified_at).not.toBeNull();
  });
  it('phiếu đã kiểm: «Bỏ kiểm» gửi p_verified = false', async () => {
    row().verified_at='2026-11-24T01:00:00.000Z';
    const onOpenChange=renderDialog({...row(),verified_by_name:'Nhân viên A'});
    fireEvent.click(screen.getByRole('button',{name:'Bỏ kiểm'}));
    await waitFor(()=>expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(verifyCalls().map(call=>call.args.p_verified)).toEqual([false]);
    expect(row().verified_at).toBeNull();
  });
  it('mất phản hồi: nút không bị khoá; bấm lại gửi lại ngay đúng giá trị, phiếu vẫn Đã kiểm (không đảo ngược)', async () => {
    io.server.failNext('verify_income_expense_v1','rpc','drop-after');
    const onOpenChange=renderDialog({...row()});
    const button=screen.getByRole('button',{name:'Xác nhận đã kiểm'}) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận được kết quả'));
    expect(row().verified_at).not.toBeNull();
    await waitFor(()=>expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(()=>expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(verifyCalls().map(call=>call.args.p_verified)).toEqual([true,true]);
    expect(row().verified_at).not.toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
});
