// Dấu «chờ đối chiếu» của THU TIỀN HOÁ ĐƠN (kho riêng, không đi qua FinancialWorkflowGuard).
//
// Trước mỗi lệnh thu, trình duyệt ghi một dấu bền gồm khoá chống trùng của lệnh. Lệnh trả kết quả rõ thì gỡ dấu;
// rớt mạng hay lỗi lạ thì dấu ở lại để lần bấm sau đối chiếu với máy chủ trước khi thu.
//
// Máy chủ chống trùng theo khoá (đọc thân `record_invoice_collection_v5` trên production 24/11/2026): mỗi lệnh ghi
// một dòng `canonical_write_operations` theo (tổ chức, hoá đơn, người thu, khoá) trong CÙNG giao dịch với khoản thu.
// Cùng khoá + cùng nội dung ⇒ trả lại kết quả cũ; cùng khoá + khác nội dung ⇒ 23505 «idempotency_key đã dùng với
// nội dung khác»; lệnh cũ còn đang chạy ⇒ lệnh sau chờ khoá dòng rồi mới so. Nên khi tra chưa thấy khoản thu,
// gửi lại ĐÚNG khoá của dấu không thể thu hai lần. Trước đợt 2, tra chưa thấy (lệnh chưa tới máy chủ) hoặc thấy
// khoản thu đã bị hoàn tác thì chặn mãi mãi.
//
// Các nhánh khi còn dấu:
//   tra thấy khoản thu ACTIVE đúng khoá    ⇒ trả biên nhận đã đối chiếu, gỡ dấu, không gửi.
//   tra thấy nhưng đã bị hoàn tác          ⇒ gỡ dấu, báo rõ; lần bấm sau thu bằng khoá MỚI.
//   tra chưa thấy                          ⇒ gửi lại đúng khoá cũ. Máy chủ báo khoá đã dùng ⇒ lần trước ĐÃ thu: tra lại,
//                                            báo, gỡ dấu, không tự thu lần mới.
//   phép tra hỏng hoặc kết quả mơ hồ       ⇒ giữ dấu, báo hộp cảnh báo chung (sau 2 phút người dùng tự gỡ được).
import {financialReadNumber} from './financialReadValidation';
import {isConfirmedFinancialRejection} from './financialWorkflow';
import {FinancialAlreadyRecordedError} from './financialWorkflowError';
import {isAttemptRunning,pendingHasSettled,trackRunningAttempt,type FinancialPendingRecord,type FinancialPendingScope} from './financialPending';
import {pendingBlockMessage,pendingValve,type PendingValve,type PendingValveStore} from './pendingValve';

export interface CollectionScope {userId:string;organizationId:string;invoiceId:string}
export interface PendingCollection extends CollectionScope {idempotencyKey:string;startedAt:string}
const prefix='ihome:pending-collection:v1:';
const keyOf=(scope:CollectionScope)=>prefix+[scope.userId,scope.organizationId,scope.invoiceId].map(encodeURIComponent).join(':');
/** Tên kho trong hộp cảnh báo và nhật ký tự gỡ. Không nằm trong sổ chiến lược (sổ chỉ quét hai họ của lõi). */
export const PENDING_COLLECTION_NAMESPACE='pending-collection';
const OPERATION='thu tiền hoá đơn';
const CHECK_HINT='Mở hoá đơn → Các lần thanh toán để kiểm tra';

/** Chưa kết luận được lần thu trước: dấu còn giữ. `outcomeUnknown` (kế thừa TypeError) để nơi gọi khoá dòng đang thu. */
export class PendingCollectionError extends TypeError {
  constructor(message=`Dấu chờ đối chiếu của lần thu trước không đọc được. ${CHECK_HINT}; nếu chưa thấy khoản thu, nhờ quản lý đối chiếu trước khi thu tiếp.`,readonly pending?:FinancialPendingRecord){super(message);this.name='PendingCollectionError';}
}
export class CollectionStorageError extends Error {
  constructor(){super('Trình duyệt chưa lưu được dấu vết lần thu. Chưa gửi khoản thu; kiểm tra quyền lưu dữ liệu của trình duyệt trước khi tiếp tục.');this.name='CollectionStorageError';}
}
/**
 * Lần thu trước ĐÃ được ghi trên máy chủ (còn hiệu lực, hoặc đã bị hoàn tác sau đó). Dấu đã gỡ và lượt này không
 * thu gì. `outcome` là `failure`: không còn gì chờ đối chiếu.
 */
export class PriorCollectionSettledError extends FinancialAlreadyRecordedError {
  constructor(message:string,readonly collectionId:string|null,readonly reversed:boolean){super(message,collectionId?[collectionId]:[]);}
}

type Lookup=(pending:PendingCollection)=>Promise<unknown>;
type Send=(idempotencyKey:string)=>Promise<Record<string,unknown>>;
export interface PendingCollectionDeps {now?:()=>Date;valve?:Pick<PendingValve,'report'>}

// Khoá mà đối chiếu đã kết luận «lần trước đã thu» (còn hiệu lực hoặc đã hoàn tác). Hộp thu giữ khoá trong bộ nhớ
// để gửi lại cùng nội dung; gửi lại khoá ấy sau khi khoản thu của nó bị hoàn tác chỉ nhận về kết quả CŨ của khoản
// đã hoàn tác, nên lượt mới phải dùng khoá mới. Thu thành công thì nơi gọi tự bỏ khoá của mình.
const settledKeys=new Set<string>();
const freshKey=()=>`collect-${crypto.randomUUID()}`;

function parseRow(raw:string|null,scope:CollectionScope):PendingCollection|null {
  if(!raw)return null;
  const row=JSON.parse(raw) as PendingCollection;
  if(!row||row.userId!==scope.userId||row.organizationId!==scope.organizationId||row.invoiceId!==scope.invoiceId||typeof row.idempotencyKey!=='string'||!row.idempotencyKey)throw new PendingCollectionError();
  return row;
}
function readPending(scope:CollectionScope):PendingCollection|null {
  try{return parseRow(localStorage.getItem(keyOf(scope)),scope);}
  catch(error){if(error instanceof PendingCollectionError)throw error;throw new CollectionStorageError();}
}
/** Chỉ gỡ đúng dấu của khoá này; dấu đã là của lần gửi khác thì giữ nguyên. */
function clearPending(scope:CollectionScope,idempotencyKey:string):boolean {
  try{
    if(readPending(scope)?.idempotencyKey!==idempotencyKey)return false;
    localStorage.removeItem(keyOf(scope));return true;
  }catch{/* A retained identity is safe: next opening must reconcile it again. */return false;}
}
/** Dấu dưới dạng chung để hộp cảnh báo hiển thị, ghi nhật ký và gỡ đúng lần gửi (khoá = attemptId). */
function asPending(row:PendingCollection):FinancialPendingRecord {
  // Dấu thiếu giờ gửi (không do mã của mình ghi) coi như đã cũ, để hộp cảnh báo không chờ mãi.
  const startedAt=typeof row.startedAt==='string'&&Number.isFinite(Date.parse(row.startedAt))?row.startedAt:new Date(0).toISOString();
  return {namespace:PENDING_COLLECTION_NAMESPACE,userId:row.userId,organizationId:row.organizationId,businessKey:row.invoiceId,attemptId:row.idempotencyKey,requestKey:row.idempotencyKey,completedIds:[],startedAt,operation:OPERATION};
}
const scopeFromValve=(scope:FinancialPendingScope):CollectionScope|null=>scope.namespace===PENDING_COLLECTION_NAMESPACE?{userId:scope.userId,organizationId:scope.organizationId,invoiceId:scope.businessKey}:null;
/** Hai hàm hộp cảnh báo dùng để đọc lại và gỡ dấu thu tiền. */
export const pendingCollectionValveStore:PendingValveStore={
  read:scope=>{const own=scopeFromValve(scope);const row=own?readPending(own):null;return row?asPending(row):null;},
  clearConfirmed:(scope,attemptId)=>{const own=scopeFromValve(scope);return own?clearPending(own,attemptId):false;},
};

type LookupVerdict={kind:'active';receipt:Record<string,unknown>}|{kind:'reversed';collectionId:string}|{kind:'missing'}|{kind:'unclear'};
function readLookup(value:unknown,pending:PendingCollection):LookupVerdict {
  if(value===null||value===undefined)return {kind:'missing'};
  const row=value&&typeof value==='object'?value as Record<string,unknown>:{};
  if(typeof row.id!=='string'||!row.id||row.invoice_id!==pending.invoiceId||row.organization_id!==pending.organizationId||row.actor_id!==pending.userId||row.idempotency_key!==pending.idempotencyKey)return {kind:'unclear'};
  if(row.status==='REVERSED')return {kind:'reversed',collectionId:row.id};
  if(row.status!=='ACTIVE')return {kind:'unclear'};
  try{return {kind:'active',receipt:{collection_id:row.id,invoice_id:row.invoice_id,applied_amount:financialReadNumber(row.applied_amount),recovered:true}};}
  catch{return {kind:'unclear'};}
}
const confirmedReceipt=(result:Record<string,unknown>,scope:CollectionScope)=>result&&result.invoice_id===scope.invoiceId&&typeof result.collection_id==='string'&&!!result.collection_id;
const unconfirmedReceipt=()=>new PendingCollectionError(`Chưa xác nhận được biên nhận của lần thu vừa gửi. ${CHECK_HINT}; lần bấm sau sẽ đối chiếu với máy chủ trước khi thu.`);
/** Hai câu 23505 của `record_invoice_collection_v5` chứng minh khoá đã được dùng ở một lần thu đã ghi. */
const KEY_ALREADY_USED=/idempotency_key đã (?:dùng với nội dung khác|hoàn tất ở đường payment tương thích)/;
const errorCode=(error:unknown)=>error&&typeof error==='object'?String((error as {code?:unknown}).code??''):'';
const errorMessage=(error:unknown)=>error&&typeof error==='object'?String((error as {message?:unknown}).message??''):'';

function settled(pending:PendingCollection,verdict:{collectionId:string|null;reversed:boolean}):never {
  settledKeys.add(pending.idempotencyKey);
  clearPending(pending,pending.idempotencyKey);
  const code=verdict.collectionId?` (mã ${verdict.collectionId})`:'';
  throw new PriorCollectionSettledError(verdict.reversed
    ? `Lần thu trước của hoá đơn này đã được ghi rồi bị hoàn tác${code}. Đã gỡ dấu chờ đối chiếu; lần này chưa thu gì. Kiểm tra số còn phải thu rồi bấm thu lại nếu vẫn cần thu.`
    : `Lần thu trước của hoá đơn này đã được ghi${code}. Không thu thêm; ${CHECK_HINT.toLowerCase()} trước khi thu tiếp.`,
  verdict.collectionId,verdict.reversed);
}

/** Bị chặn bởi dấu chưa kết luận: báo hộp cảnh báo chung (kênh phụ) rồi ném câu báo nêu việc kẹt và giờ kẹt. */
function blocked(pending:PendingCollection,deps:PendingCollectionDeps):never {
  const record=asPending(pending);
  try{(deps.valve??pendingValve).report({pending:record,blockedOperation:OPERATION,store:pendingCollectionValveStore});}catch{/* giữ lỗi chính */}
  throw new PendingCollectionError(pendingBlockMessage(record,pendingHasSettled(record,(deps.now??(()=>new Date()))())),record);
}

/** Tra khoản thu theo khoá của dấu; trả kết luận hoặc ném (đã ghi / chưa kết luận). `missing` để nơi gọi quyết. */
async function lookupPrior(pending:PendingCollection,lookup:Lookup,deps:PendingCollectionDeps):Promise<{kind:'active';receipt:Record<string,unknown>}|{kind:'missing'}> {
  // Lượt ghi của dấu này còn chạy trong tab (bấm lần hai khi lần đầu chưa xong): chưa có gì để đối chiếu.
  if(isAttemptRunning(pending.idempotencyKey))blocked(pending,deps);
  let found:unknown;
  const stop=trackRunningAttempt(pending.idempotencyKey);
  try{found=await lookup(pending);}catch{stop();blocked(pending,deps);}
  stop();
  const verdict=readLookup(found,pending);
  if(verdict.kind==='reversed')settled(pending,{collectionId:verdict.collectionId,reversed:true});
  if(verdict.kind==='unclear')blocked(pending,deps);
  if(verdict.kind==='active')clearPending(pending,pending.idempotencyKey);
  return verdict as {kind:'active';receipt:Record<string,unknown>}|{kind:'missing'};
}

/** Tra chưa thấy: gửi lại ĐÚNG khoá của dấu. Máy chủ chống trùng theo khoá nên không thể thu hai lần. */
async function resend(pending:PendingCollection,send:Send,lookup:Lookup,deps:PendingCollectionDeps):Promise<Record<string,unknown>> {
  // Cùng khoá nhưng giờ gửi mới: lượt gửi lại này cũng phải đủ 2 phút mới được coi là đã kết thúc (hộp cảnh báo,
  // nhánh gỡ dấu khi bị từ chối ở lần sau). Không ghi được thì chưa gửi.
  try{localStorage.setItem(keyOf(pending),JSON.stringify({...pending,startedAt:(deps.now??(()=>new Date()))().toISOString()}));}catch{throw new CollectionStorageError();}
  const stop=trackRunningAttempt(pending.idempotencyKey);
  let result:Record<string,unknown>;
  try{result=await send(pending.idempotencyKey);}
  catch(error){
    stop();
    if(error instanceof PendingCollectionError)throw error;
    if(errorCode(error)==='23505'){
      // Khoá đã được dùng: lần trước ĐÃ thu (có thể nội dung khác lượt này). Tra lại để báo đúng mã; không thu lần mới.
      const again=await lookupPrior(pending,lookup,deps);
      if(again.kind==='active')settled(pending,{collectionId:String(again.receipt.collection_id),reversed:false});
      if(KEY_ALREADY_USED.test(errorMessage(error)))settled(pending,{collectionId:null,reversed:false});
      blocked(pending,deps);
    }
    // Lời từ chối của lượt gửi lại chỉ chứng minh LƯỢT NÀY không ghi. Lần gửi trước (giờ gửi trong `pending`, trước khi
    // làm mới ở trên) chỉ được coi là chưa ghi khi tra vẫn chưa thấy và nó chắc chắn đã kết thúc (quá 2 phút); trước đó
    // dấu ở lại để lần sau gửi lại cùng khoá.
    if(isConfirmedFinancialRejection(error)&&pendingHasSettled(asPending(pending),(deps.now??(()=>new Date()))()))clearPending(pending,pending.idempotencyKey);
    throw error;
  }
  stop();
  if(!confirmedReceipt(result,pending))throw unconfirmedReceipt();
  clearPending(pending,pending.idempotencyKey);
  return result;
}

async function sendFresh(scope:CollectionScope,idempotencyKey:string,send:Send,deps:PendingCollectionDeps):Promise<Record<string,unknown>> {
  const identity:PendingCollection={...scope,idempotencyKey,startedAt:(deps.now??(()=>new Date()))().toISOString()};
  try{localStorage.setItem(keyOf(scope),JSON.stringify(identity));}catch{throw new CollectionStorageError();}
  const stop=trackRunningAttempt(idempotencyKey);
  let result:Record<string,unknown>;
  try{result=await send(idempotencyKey);}
  catch(error){stop();if(isConfirmedFinancialRejection(error))clearPending(scope,idempotencyKey);throw error;}
  stop();
  if(!confirmedReceipt(result,scope))throw unconfirmedReceipt();
  clearPending(scope,idempotencyKey);
  return result;
}

const withCollectionLock=<T>(scope:CollectionScope,run:()=>Promise<T>):Promise<T>=>
  // Serialize supported browser tabs around the durable identity; the server still owns payment CAS/idempotency.
  typeof navigator!=='undefined'&&navigator.locks?navigator.locks.request(keyOf(scope),run):run();

/**
 * Gửi một lệnh thu có dấu bền. `send` nhận khoá thật sự được gửi: khi còn dấu của lần trước, đó là khoá CŨ của dấu.
 * Only IDs and request identity persist, never amounts, notes, attachments or a replay payload.
 */
export async function runDurableCollection(scope:CollectionScope,idempotencyKey:string,send:Send,lookup:Lookup,deps:PendingCollectionDeps={}):Promise<Record<string,unknown>> {
  if(!scope.organizationId||!scope.userId||!scope.invoiceId)throw new Error('Chưa xác định được tổ chức của hoá đơn. Tải lại hoá đơn trước khi thu tiền.');
  return withCollectionLock(scope,async()=>{
    const pending=readPending(scope);
    if(pending){
      const prior=await lookupPrior(pending,lookup,deps);
      if(prior.kind==='active')return prior.receipt;
      return resend(pending,send,lookup,deps);
    }
    return sendFresh(scope,settledKeys.has(idempotencyKey)?freshKey():idempotencyKey,send,deps);
  });
}

/**
 * Check prior identity before recalculating debt: the prior request may already have paid it.
 * Trả biên nhận khi khoản thu trước đã có; `null` khi không có dấu hoặc tra chưa thấy (lượt thu sẽ gửi lại khoá cũ).
 */
export async function reconcilePendingCollection(userId:string,invoiceId:string,lookup:Lookup,deps:PendingCollectionDeps={}):Promise<Record<string,unknown>|null>{
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
  const scope:CollectionScope={userId,organizationId:pending.organizationId,invoiceId};
  return withCollectionLock(scope,async()=>{
    const live=readPending(scope);
    if(!live)return null;
    const prior=await lookupPrior(live,lookup,deps);
    return prior.kind==='active'?prior.receipt:null;
  });
}
