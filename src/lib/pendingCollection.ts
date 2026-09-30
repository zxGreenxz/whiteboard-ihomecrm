import {voucherOutcomeUnknown} from './voucherFeedback';
import {financialReadNumber} from './financialReadValidation';
import {isConfirmedFinancialRejection} from './financialWorkflow';

export interface CollectionScope {userId:string;organizationId:string;invoiceId:string}
export interface PendingCollection extends CollectionScope {idempotencyKey:string;startedAt:string}
const prefix='ihome:pending-collection:v1:';
const keyOf=(scope:CollectionScope)=>prefix+[scope.userId,scope.organizationId,scope.invoiceId].map(encodeURIComponent).join(':');
export class PendingCollectionError extends TypeError {
  constructor(){super('Lần thu trước chưa được đối chiếu. Mở hoá đơn → Các lần thanh toán để kiểm tra; nếu chưa thấy khoản thu, nhờ quản lý đối chiếu trước khi thu tiếp.');this.name='PendingCollectionError';}
}
export class CollectionStorageError extends Error {
  constructor(){super('Trình duyệt chưa lưu được dấu vết lần thu. Chưa gửi khoản thu; kiểm tra quyền lưu dữ liệu của trình duyệt trước khi tiếp tục.');this.name='CollectionStorageError';}
}
type Lookup=(pending:PendingCollection)=>Promise<unknown>;
function readPending(scope:CollectionScope):PendingCollection|null {
  try {const raw=localStorage.getItem(keyOf(scope));if(!raw)return null;const row=JSON.parse(raw) as PendingCollection;
    if(row.userId!==scope.userId||row.organizationId!==scope.organizationId||row.invoiceId!==scope.invoiceId||typeof row.idempotencyKey!=='string'||!row.idempotencyKey)throw new PendingCollectionError();return row;
  } catch(error){if(error instanceof PendingCollectionError)throw error;throw new CollectionStorageError();}
}
function clearPending(scope:CollectionScope){try{localStorage.removeItem(keyOf(scope));}catch{/* A retained identity is safe: next opening must reconcile it again. */}}
function receiptFromLookup(value:unknown,pending:PendingCollection):Record<string,unknown> {
  const row=value&&typeof value==='object'?value as Record<string,unknown>:{};
  if(typeof row.id!=='string'||!row.id||row.invoice_id!==pending.invoiceId||row.organization_id!==pending.organizationId||row.actor_id!==pending.userId||row.idempotency_key!==pending.idempotencyKey||row.status!=='ACTIVE')throw new PendingCollectionError();
  return {collection_id:row.id,invoice_id:row.invoice_id,applied_amount:financialReadNumber(row.applied_amount),recovered:true};
}
/** Only IDs and request identity persist, never amounts, notes, attachments or a replay payload. */
export async function runDurableCollection(scope:CollectionScope,idempotencyKey:string,send:()=>Promise<Record<string,unknown>>,lookup:Lookup):Promise<Record<string,unknown>> {
  if(!scope.organizationId||!scope.userId||!scope.invoiceId)throw new Error('Chưa xác định được tổ chức của hoá đơn. Tải lại hoá đơn trước khi thu tiền.');
  const run=async()=>{
    const pending=readPending(scope);
    if(pending){let receipt:Record<string,unknown>;try{receipt=receiptFromLookup(await lookup(pending),pending);}catch{throw new PendingCollectionError();}clearPending(scope);return receipt;}
    const identity:PendingCollection={...scope,idempotencyKey,startedAt:new Date().toISOString()};
    try{localStorage.setItem(keyOf(scope),JSON.stringify(identity));}catch{throw new CollectionStorageError();}
    try{const result=await send();if(result.invoice_id!==scope.invoiceId||typeof result.collection_id!=='string'||!result.collection_id)throw new PendingCollectionError();clearPending(scope);return result;}catch(error){if(isConfirmedFinancialRejection(error))clearPending(scope);throw error;}
  };
  // Serialize supported browser tabs around the durable identity; the server still owns payment CAS/idempotency.
  return typeof navigator!=='undefined'&&navigator.locks?navigator.locks.request(keyOf(scope),run):run();
}

/** Check prior identity before recalculating debt: the prior request may already have paid it. */
export async function reconcilePendingCollection(userId:string,invoiceId:string,lookup:Lookup):Promise<Record<string,unknown>|null>{
  let pending:PendingCollection|null=null;
  try{
    const userPrefix=prefix+encodeURIComponent(userId)+':';
    const invoiceSuffix=':'+encodeURIComponent(invoiceId);
    for(let index=0;index<localStorage.length;index++){
      const key=localStorage.key(index);
      if(!key?.startsWith(userPrefix)||!key.endsWith(invoiceSuffix))continue;
      const value=JSON.parse(localStorage.getItem(key)!) as PendingCollection;
      if(pending||value.userId!==userId||value.invoiceId!==invoiceId||!value.organizationId)throw new PendingCollectionError();
      pending=value;
    }
  }catch(error){if(error instanceof PendingCollectionError)throw error;throw new CollectionStorageError();}
  if(!pending)return null;
  return runDurableCollection(pending,pending.idempotencyKey,async()=>{throw new PendingCollectionError();},lookup);
}
