import type { Snapshot, PersonalTransaction } from './contract';
import { PersonalFinanceError } from './service';
export interface TransactionValues {
 type:'INCOME'|'EXPENSE';amount:number;txn_date:string;category?:string|null;description?:string|null;
 wallet_id?:string;category_id?:string;request_key?:string;
}
export function transactionInput(values:Partial<TransactionValues>,s:Snapshot,existing?:PersonalTransaction){
 const {request_key:_,category,...fields}=values;
 const data:Record<string,unknown>={...fields};
 const type=values.type??existing?.type;
 if(!existing||values.wallet_id!==undefined){
  const wallet=s.wallets.find(w=>w.id===(values.wallet_id??s.wallets.find(w=>w.is_default)?.id));
  if(!wallet)throw new PersonalFinanceError('validation','Chọn ví cá nhân đang sử dụng.');
  data.wallet_id=wallet.id;
 }
 if(!existing||category!==undefined||values.category_id!==undefined||values.type!==undefined&&values.type!==existing.type){
  const candidate=values.category_id?s.categories.find(c=>c.id===values.category_id):category?s.categories.find(c=>c.type===type&&(c.name===category||c.legacy_name===category)):s.categories.find(c=>c.type===type&&!c.hidden&&c.seed_key===(type==='INCOME'?'other-income':'other'));
  if(!candidate||candidate.type!==type||candidate.hidden&&candidate.id!==existing?.resolved_category_id)throw new PersonalFinanceError('validation','Chọn danh mục đúng loại thu hoặc chi.');
  data.category_id=candidate.id;
 }
 return data;
}
/** Only changed fields are sent: legacy fractions, whitespace and dates survive unrelated edits. */
export function transactionChanges(before:PersonalTransaction,next:TransactionValues):Partial<TransactionValues>{
 const result:Partial<TransactionValues>={};
 for(const key of ['type','amount','txn_date','description','category','wallet_id','category_id'] as const){
  if(next[key]!==undefined&&next[key]!==before[key])Object.assign(result,{[key]:next[key]});
 }
 return result;
}
