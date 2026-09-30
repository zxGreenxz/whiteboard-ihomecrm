import type {FinancialWorkflowGuard,FinancialWorkflowProgress} from './financialWorkflow';
import {confirmedRecordId} from './recordWriteOutcome';

interface BuildingSaveOptions {
  key:string;
  organizationId:string;
  expectedCore:Record<string,unknown>;
  writeCore:()=>Promise<unknown>;
  readCore:(ids:readonly string[])=>Promise<unknown>;
  saveRelated:(buildingId:string,progress:FinancialWorkflowProgress,recovering:boolean)=>Promise<void>;
  onCoreConfirmed?:(buildingId:string)=>void;
}
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
/** Positive core identity and payload agreement are required before resuming child writes. */
export async function runBuildingSaveWorkflow(guard:FinancialWorkflowGuard,options:BuildingSaveOptions):Promise<string>{
  const finish=async(id:string,progress:FinancialWorkflowProgress,recovering:boolean)=>{
    options.onCoreConfirmed?.(id);
    progress.stage='đối chiếu và lưu chủ sở hữu, dịch vụ';
    await options.saveRelated(id,progress,recovering);
    return id;
  };
  return guard.run(options.key,'lưu tòa nhà và dữ liệu liên quan',async progress=>{
    const id=confirmedRecordId(await options.writeCore(),'lưu tòa nhà',options.key.startsWith('edit:')?options.key.slice(5):undefined);
    progress.completed.push({id,label:'Đã lưu tòa nhà'});
    return finish(id,progress,false);
  },async(pending,progress)=>{
    if(!pending.completedIds.length)return null;
    const rows=await options.readCore(pending.completedIds);
    if(!Array.isArray(rows))return null;
    const matches=rows.filter((row:unknown)=>{
      if(!row||typeof row!=='object')return false;
      const record=row as Record<string,unknown>;
      return typeof record.id==='string' && pending.completedIds.includes(record.id) && record.organization_id===options.organizationId
        && (!options.key.startsWith('edit:')||record.id===options.key.slice(5))
        && Object.entries(options.expectedCore).every(([key,value])=>canonical(record[key])===canonical(value));
    });
    if(matches.length!==1)return null;
    return {result:await finish((matches[0] as {id:string}).id,progress,true)};
  },options.organizationId);
}