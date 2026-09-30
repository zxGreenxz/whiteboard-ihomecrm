import { getSessionUser } from './authSession';
import { FinancialWorkflowError, FinancialWorkflowGuard } from './financialWorkflow';
import { FinancialPendingStorageError } from './financialPending';

/** Scope is resolved at submission, never frozen to the first organization render. */
export function persistentFinancialWorkflow(namespace:string,options:{scope?:'selected'|'target'|'actor'}={}):FinancialWorkflowGuard {
  return new FinancialWorkflowGuard({scope:async (businessKey, targetOrganizationId)=>{
    if(options.scope==='target'||options.scope==='actor'){
      const user=await getSessionUser();if(!user)throw {code:'PGRST301',message:'Not authenticated'};
      // Some authorized actions intentionally span organizations. Their coordination scope
      // must stay stable across a selection change; authorization remains on the server.
      const organizationId=options.scope==='actor'?'actor-scope':targetOrganizationId;
      if(!organizationId)throw new FinancialWorkflowError('Không xác định được tổ chức của chứng từ. Tải lại chứng từ trước khi tiếp tục.','failure',[]);
      return {namespace,userId:user.id,organizationId,businessKey};
    }
    let organizationId:string|null;
    try{organizationId=globalThis.localStorage.getItem('ihomecrm.selectedOrganizationId');}
    catch{throw new FinancialPendingStorageError();}
    const user=await getSessionUser();
    if(!user)throw {code:'PGRST301',message:'Not authenticated'};
    let currentOrganizationId:string|null;
    try{currentOrganizationId=globalThis.localStorage.getItem('ihomecrm.selectedOrganizationId');}
    catch{throw new FinancialPendingStorageError();}
    if(currentOrganizationId!==organizationId)throw new FinancialWorkflowError('Tổ chức đang chọn đã thay đổi. Mở lại biểu mẫu trong tổ chức cần xử lý trước khi tiếp tục.','failure',[]);
    if(!organizationId)throw new FinancialWorkflowError('Không xác định được tổ chức cho thao tác này. Chọn tổ chức và mở lại biểu mẫu trước khi tiếp tục.','failure',[]);
    if(targetOrganizationId!==undefined && targetOrganizationId!==organizationId)throw new FinancialWorkflowError('Biểu mẫu thuộc tổ chức khác với tổ chức đang chọn. Mở lại biểu mẫu trong đúng tổ chức trước khi tiếp tục.','failure',[]);
    return {namespace,userId:user.id,organizationId,businessKey};
  }});
}
