/** Durable coordination only. Domain code must verify server state before clearConfirmed. */
export interface FinancialPendingScope {namespace:string;userId:string;organizationId:string;businessKey:string}
export interface FinancialPendingRecord extends FinancialPendingScope {attemptId:string;requestKey?:string;completedIds:string[];startedAt:string}
export class FinancialPendingError extends TypeError {
  constructor(public readonly pending:FinancialPendingRecord|null){super('Thao tác trước chưa được đối chiếu. Mở các chứng từ đã tạo và kiểm tra với quản lý trước khi thực hiện tiếp.');this.name='FinancialPendingError';}
}
export class FinancialPendingStorageError extends TypeError {
  constructor(){super('Chưa đọc hoặc lưu được dấu vết thao tác trong trình duyệt. Kiểm tra quyền lưu dữ liệu và đối chiếu chứng từ trước khi thực hiện tiếp.');this.name='FinancialPendingStorageError';}
}
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const keyOf=(s:FinancialPendingScope)=>'ihome:financial-pending:v1:'+ [s.namespace,s.userId,s.organizationId,s.businessKey].map(encodeURIComponent).join(':');
const scopeFields=['namespace','userId','organizationId','businessKey'] as const;
export function createFinancialPendingStore(options:{storage?:StoragePort;now?:()=>Date}={}){
  const storage=()=>options.storage??globalThis.localStorage;
  function read(scope:FinancialPendingScope):FinancialPendingRecord|null {
    if(scopeFields.some(field=>!scope[field]))throw new FinancialPendingStorageError();
    try{
      const raw=storage().getItem(keyOf(scope));if(raw===null)return null;
      const row=JSON.parse(raw) as FinancialPendingRecord;
      if(!row||scopeFields.some(field=>row[field]!==scope[field])||typeof row.attemptId!=='string'||!row.attemptId||!Array.isArray(row.completedIds)||row.completedIds.some(id=>typeof id!=='string'||!id)||typeof row.startedAt!=='string'||!Number.isFinite(Date.parse(row.startedAt))||(row.requestKey!==undefined&&typeof row.requestKey!=='string'))throw new FinancialPendingError(null);
      return row;
    }catch(error){if(error instanceof FinancialPendingError)throw error;throw new FinancialPendingStorageError();}
  }
  function write(scope:FinancialPendingScope,row:FinancialPendingRecord){try{storage().setItem(keyOf(scope),JSON.stringify(row));}catch{throw new FinancialPendingStorageError();}}
  function markPending(scope:FinancialPendingScope,input:{attemptId?:string;requestKey?:string}={}):FinancialPendingRecord{
    const prior=read(scope);if(prior)throw new FinancialPendingError(prior);
    const row:FinancialPendingRecord={...scope,attemptId:input.attemptId??crypto.randomUUID(),...(input.requestKey?{requestKey:input.requestKey}:{}),completedIds:[],startedAt:(options.now?.()??new Date()).toISOString()};
    write(scope,row);return row;
  }
  function recordCompleted(scope:FinancialPendingScope,attemptId:string,completedIds:readonly string[]):FinancialPendingRecord{
    const row=read(scope);if(!row||row.attemptId!==attemptId)throw new FinancialPendingError(row);
    if(completedIds.some(id=>typeof id!=='string'||!id))throw new FinancialPendingError(row);
    const next={...row,completedIds:[...new Set([...row.completedIds,...completedIds])]};write(scope,next);return next;
  }
  function clearConfirmed(scope:FinancialPendingScope,expectedAttemptId:string):boolean{
    const row=read(scope);if(!row||row.attemptId!==expectedAttemptId)return false;
    try{storage().removeItem(keyOf(scope));}catch{throw new FinancialPendingStorageError();}return true;
  }
  return {read,markPending,recordCompleted,clearConfirmed};
}
export const financialPending=createFinancialPendingStore();
