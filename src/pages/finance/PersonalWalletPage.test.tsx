// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Snapshot } from '@/lib/personalFinance/contract';
import PersonalWalletPage from './PersonalWalletPage';
import { localMonth } from '@/lib/personalFinance/selectors';
import { shiftMonth } from '@/components/personal-finance/presentation';

const data=vi.hoisted(()=>({snapshot:{owner_id:'owner',schema_version:1,wallets:[],categories:[],transactions:[],transfers:[],budgets:[],goals:[]} as unknown as Snapshot}));
vi.mock('@/hooks/personal-finance/usePersonalFinance',()=>({usePersonalFinance:()=>({data:data.snapshot,refetch:vi.fn()}),usePersonalFinanceMutation:()=>({pending:[]})}));
vi.mock('@/hooks/personal-finance/usePersonalFinancePermissions',()=>({usePersonalFinancePermissions:()=>({data:undefined})}));
vi.mock('@/hooks/quick-entry/useQuickEntryController',()=>({useQuickEntryController:()=>({})}));
vi.mock('@/components/quick-entry/EmbeddedQuickEntry',()=>({QuickEntryInput:()=>null,QuickEntryDraftFeed:()=>null,PersonalPendingRequests:()=>null}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:{children:React.ReactNode})=><>{children}</>}));
vi.mock('@/hooks/useShareholders',()=>({useMyShareholder:()=>({data:null})}));
vi.mock('@/hooks/useShareholderProfit',()=>({useProfitAllocations:()=>({}),useShareholderDistributions:()=>({}),computeShareholderSummary:vi.fn()}));
afterEach(()=>{cleanup();data.snapshot={owner_id:'owner',schema_version:1,wallets:[],categories:[],transactions:[],transfers:[],budgets:[],goals:[]};});
it.each(['wallet','month','older report month','goal'])('shows a controlled money range error for %s and recovers on corrected snapshot',kind=>{
 if(kind==='wallet')data.snapshot.wallets=[{balance:Number.MAX_SAFE_INTEGER,name:'A',id:'a'},{balance:1,name:'B',id:'b'}] as Snapshot['wallets'];
 else if(kind==='goal')data.snapshot.goals=[{target:1e12,saved:0.00001}] as Snapshot['goals'];
 else data.snapshot.transactions=[Number.MAX_SAFE_INTEGER,1].map((amount,i)=>({id:String(i),user_id:'owner',type:'EXPENSE',amount,txn_date:`${kind==='month'?localMonth():shiftMonth(localMonth(),-1)}-01`,created_at:'2026-10-01T00:00:00Z',deleted_at:null,resolved_category_id:null,category:null})) as Snapshot['transactions'];
 const {rerender}=render(<PersonalWalletPage/>);
 expect(screen.getByRole('alert').textContent).toMatch(/biểu diễn chính xác/);
 expect(screen.queryByTestId('total-balance')).toBeNull();
 expect(screen.getByRole('button',{name:'Tải lại'})).toBeTruthy();
 data.snapshot={...data.snapshot,wallets:[],transactions:[],goals:[]};rerender(<PersonalWalletPage/>);
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByTestId('total-balance').textContent).toBe('0 ₫');
});
