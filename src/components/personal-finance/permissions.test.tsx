// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RowActions, Reports } from './FinanceViews';
import { LAUNCHER_SECTIONS } from '@/pages/home/launcherTiles';
import type { Snapshot } from '@/lib/personalFinance/contract';
afterEach(cleanup);
it('reports a precise decimal total across independent category buckets',()=>{
 const s={owner_id:'owner',schema_version:1,wallets:[],categories:[],transfers:[],budgets:[],goals:[],transactions:[0.1,0.2].map((amount,i)=>({id:String(i),user_id:'owner',type:'EXPENSE',amount,txn_date:'2026-10-01',created_at:'2026-10-01T00:00:00Z',deleted_at:null,resolved_category_id:null,category:`legacy-${i}`}))} as unknown as Snapshot;
 render(<Reports snapshot={s} month="2026-10" onMonth={vi.fn()} onDrill={vi.fn()}/>);
 expect(screen.getByRole('img',{name:'Chi 0,3 ₫'})).toBeTruthy();
 expect(screen.queryByText(/0,30000000000000004/)).toBeNull();
});
const snapshot={transactions:[],transfers:[],goals:[],wallets:[],categories:[],budgets:[]} as unknown as Snapshot;
it.each([
 [{create:false,edit:false,delete:false},0,0],
 [{create:true,edit:false,delete:false},0,0],
 [{create:false,edit:true,delete:false},1,0],
 [{create:false,edit:false,delete:true},0,1],
] as const)('uses distinct edit and delete permissions %j',(permissions,editCount,deleteCount)=>{
 render(<RowActions entity="transaction" row={{id:'row',description:'Tiền ăn'}} snapshot={snapshot} permissions={permissions} edit={vi.fn()}/>);
 expect(screen.queryAllByRole('button',{name:'Sửa giao dịch Tiền ăn'})).toHaveLength(editCount);
 expect(screen.queryAllByRole('button',{name:'Xóa giao dịch Tiền ăn'})).toHaveLength(deleteCount);
});
it('keeps goal contribution edits unavailable even for writers',()=>{
 render(<RowActions entity="transfer" row={{id:'row',goal_id:'goal'}} snapshot={snapshot} permissions={{create:true,edit:true,delete:true}} edit={vi.fn()}/>);
 expect(screen.queryByRole('button',{name:/Sửa/})).toBeNull();
 expect(screen.getByRole('button',{name:/Xóa/}).title).toContain('giữ nguyên');
});
it('puts the personal wallet in the personal launcher section with its own view permission',()=>{
 const tile=LAUNCHER_SECTIONS.find(s=>s.label==='Cá nhân')?.items.find(t=>t.href==='/finance/personal-wallet');
 expect(tile).toMatchObject({module:'personal_finance',action:'view',title:'Ví cá nhân'});
});
