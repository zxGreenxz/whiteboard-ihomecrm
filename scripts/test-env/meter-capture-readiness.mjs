// TEST smoke only. A PostgREST schema-cache reload must never replay a write.
const READ_ACTIONS=new Set(['catalog','getCapture','listCaptures','resolveQr','resolveBilling','evidence','documentReceipt','documentEvidence','restRead']);
const SAFE_CODE=/^(?:[0-9A-Z]{5}|PGRST[0-9]{3}|(?:meter_capture_|worker_|original_|evidence_|invalid_)[a-z0-9_]{1,48}|unauthorized)$/;
export function safeMeterErrorCode(payload){
 return payload&&typeof payload==='object'
  ?[payload.code,payload.error].find(value=>typeof value==='string'&&value.length<=64&&SAFE_CODE.test(value))??null:null;
}
export class MeterTestHttpError extends Error{
 constructor(label,status,payload){
  const code=safeMeterErrorCode(payload);
  super(`${label} returned HTTP ${status}${code?` (${code})`:''}.`);
  this.name='MeterTestHttpError';this.status=status;this.code=code;
 }
}
export async function withMeterReadRetry(action,request,hooks={}){
 if(!READ_ACTIONS.has(action))return request(60_000);
 const now=hooks.now??(()=>performance.now()),sleep=hooks.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const onRetry=hooks.onRetry??(event=>console.log(JSON.stringify({event:'meter_test_read_retry',...event})));
 const deadline=now()+90_000;
 let last;
 for(let attempt=1;attempt<=31;attempt++){
  const remaining=deadline-now();
  if(remaining<=0)throw last??new Error('TEST read readiness deadline elapsed.');
  try{return await request(Math.max(1,Math.min(15_000,Math.floor(remaining))));}
  catch(error){
   if(!(error instanceof MeterTestHttpError)||error.code!=='PGRST002'||![502,503].includes(error.status))throw error;
   last=error;
   if(attempt===31||deadline-now()<=3_000)throw error;
   onRetry({action,attempt,delayMs:3_000,code:'PGRST002'});
   await sleep(3_000);
  }
 }
 throw last;
}
