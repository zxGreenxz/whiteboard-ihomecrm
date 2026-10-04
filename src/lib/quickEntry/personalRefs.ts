import type { Category, Wallet } from '@/lib/personalFinance/contract';
import type { QuickDraft, TransactionType } from './draft';
export type PersonalCategoryRef=Pick<Category,'id'|'name'|'type'|'hidden'> & {legacy_name?:string|null};
export function resolvePersonalDraft(d:QuickDraft,wallets:Wallet[],categories:PersonalCategoryRef[]):QuickDraft {
 if(d.mode!=='personal')return d;
 return {...d,transactionType:d.transactionType??'EXPENSE',personalWalletId:d.personalWalletId??wallets.find(w=>w.is_default)?.id??null,
  lines:d.lines.map(l=>{const type=l.transactionType??d.transactionType??'EXPENSE';const selected=categories.find(c=>c.id===l.personalCategoryId&&c.type===type);
   const legacy=!l.personalCategoryId&&l.personalCategory?categories.find(c=>c.type===type&&!c.hidden&&(c.name===l.personalCategory||c.legacy_name===l.personalCategory)):null;
   return {...l,transactionType:type,personalCategoryId:selected?.id??legacy?.id??null};})};
}
export function inferTransactionType(text:string):TransactionType{
 if(/(?:^|[\s,;])(?:trả\s+lương|chi\s+lương|thanh\s+toán\s+lương)(?:\s|$)/i.test(text)||/^\s*(?:chi|trả|thanh toán|mua|đóng)(?:\s|$)/i.test(text))return 'EXPENSE';
 return /(?:^|[\s,;])(?:thu(?:\s+tiền)?|nhận\s+(?:lương|tiền|thưởng)|lương|được\s+(?:trả|tặng)|bán\s+.*\s+được)(?:\s|$)/i.test(text)?'INCOME':'EXPENSE';
}
