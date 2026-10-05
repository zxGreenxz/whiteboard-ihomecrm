import type { Snapshot, PersonalTransaction } from './contract';
import { sumMoney, subtractMoney } from './money';

export const localMonth=(date=new Date())=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
export const selectTransactions=(s:Snapshot)=>s.transactions.filter(t=>t.user_id===s.owner_id && !t.deleted_at).sort((a,b)=>b.txn_date.localeCompare(a.txn_date)||b.created_at.localeCompare(a.created_at));
/** Snapshot balances already include opening balance and every transaction/transfer, including hidden wallets. */
export const selectBalance=(s:Snapshot)=>sumMoney(s.wallets.map(w=>w.balance));
export function selectMonth(s:Snapshot,month:string) {
 const transactions=selectTransactions(s).filter(t=>t.txn_date.slice(0,7)===month);
 const sum=(type:PersonalTransaction['type'])=>sumMoney(transactions.filter(t=>t.type===type).map(t=>t.amount));
 const income=sum('INCOME'),expense=sum('EXPENSE');
 const categories=new Map<string,{categoryId:string|null;legacyName:string|null;name:string;amounts:number[];type:PersonalTransaction['type']}>();
 for(const t of transactions){const id=t.resolved_category_id;const legacyName=id===null?t.category:null;const key=JSON.stringify([t.type,id,legacyName]);const group=categories.get(key)??{categoryId:id,legacyName,name:s.categories.find(c=>c.id===id)?.name??t.category??'Chưa phân loại',amounts:[],type:t.type};group.amounts.push(t.amount);categories.set(key,group);}
 const budgets=s.budgets.map(b=>{const spent=b.category_id===null?expense:sumMoney(transactions.filter(t=>t.type==='EXPENSE'&&t.resolved_category_id===b.category_id).map(t=>t.amount));return{...b,spent,remaining:subtractMoney(b.amount,spent),ratio:spent/b.amount};});
 return {month,transactions,income,expense,net:subtractMoney(income,expense),categories:[...categories.values()].map(({amounts,...group})=>({...group,amount:sumMoney(amounts)})),budgets};
}
export function selectGoals(s:Snapshot){return s.goals.map(g=>({...g,remaining:Math.max(0,subtractMoney(g.target,g.saved)),ratio:g.saved/g.target,contributions:s.transfers.filter(t=>t.user_id===s.owner_id&&!t.deleted_at&&t.goal_id===g.id)}));}
export const csvCell=(value:unknown)=>{let text=String(value??'');if(/^[\s]*[=+\-@]|^[\t\r\n]/.test(text))text="'"+text;return `"${text.replace(/"/g,'""')}"`;};
export function transactionsCsv(s:Snapshot,rows=selectTransactions(s)){
 return '\uFEFF'+[['Ngày','Loại','Số tiền','Ví','Danh mục','Mô tả'],...rows.filter(t=>t.user_id===s.owner_id).map(t=>[t.txn_date,t.type,t.amount,s.wallets.find(w=>w.id===t.resolved_wallet_id)?.name??'',s.categories.find(c=>c.id===t.resolved_category_id)?.name??t.category??'',t.description])].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
