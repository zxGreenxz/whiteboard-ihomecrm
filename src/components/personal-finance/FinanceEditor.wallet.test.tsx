// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FinanceEditor } from './FinanceEditor';
import type { Snapshot } from '@/lib/personalFinance/contract';
import type { Editor } from './presentation';
vi.mock('@/hooks/personal-finance/usePersonalFinance',()=>({usePersonalFinanceMutation:()=>({isPending:false,prepare:vi.fn(),mutateAsync:vi.fn()})}));
afterEach(cleanup);
const snapshot:Snapshot={owner_id:'owner',schema_version:1,transactions:[],transfers:[],budgets:[],goals:[],categories:[],wallets:[
 {id:'bank',user_id:'owner',version:1,name:'Tk939',kind:'bank',icon:'wallet',hidden:false,is_default:true,opening_balance:0,balance:0},
 {id:'cash',user_id:'owner',version:1,name:'Tiền mặt',kind:'cash',icon:'wallet',hidden:false,is_default:false,opening_balance:0,balance:0},
]};
const show=(editor:Editor,s=snapshot)=>render(<FinanceEditor embedded editor={editor} snapshot={s} permissions={{create:true,edit:true,delete:true}} onClose={vi.fn()}/>);
it('new transaction uses a visible cash wallet despite the bank default',()=>{
 show({entity:'transaction'});
 expect((screen.getByLabelText('Ví thanh toán') as HTMLSelectElement).value).toBe('cash');
});
it('editing a transaction keeps its existing wallet',()=>{
 show({entity:'transaction',record:{id:'txn',version:1,type:'EXPENSE',amount:50000,txn_date:'2026-10-07',resolved_wallet_id:'bank',resolved_category_id:null}});
 expect((screen.getByLabelText('Ví thanh toán') as HTMLSelectElement).value).toBe('bank');
});
it('new transaction requires selection when no visible cash wallet exists',()=>{
 show({entity:'transaction'},{...snapshot,wallets:snapshot.wallets.map(w=>w.kind==='cash'?{...w,hidden:true}:w)});
 expect((screen.getByLabelText('Ví thanh toán') as HTMLSelectElement).value).toBe('');
});
