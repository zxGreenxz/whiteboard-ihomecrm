import { MODEL, jobKind, prepare, solve, type ShiftInput } from './planner.ts';

const json=(value:unknown,status=200)=>Response.json(value,{status});
const url=Deno.env.get('SUPABASE_URL')??'';
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
async function rpc(fn:string,args:Record<string,unknown>){
  const rs=await fetch(url+'/rest/v1/rpc/'+fn,{method:'POST',headers:{'Content-Type':'application/json',apikey:service,Authorization:'Bearer '+service},body:JSON.stringify(args)});
  if(!rs.ok)throw new Error('shift_database_'+rs.status);
  return rs.json();
}
async function propose(problem:unknown):Promise<number[][]>{
  const base=Deno.env.get('QUICK_ENTRY_NINEROUTER_BASE_URL')??Deno.env.get('NINEROUTER_BASE_URL');
  const key=Deno.env.get('QUICK_ENTRY_NINEROUTER_KEY')??Deno.env.get('NINEROUTER_API_KEY');
  if(!key||!base)throw new Error('model_unavailable');
  const rs=await fetch(base.replace(/\/$/,'')+'/chat/completions',{
    method:'POST',signal:AbortSignal.timeout(100000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model:MODEL,reasoning_effort:'xhigh',max_tokens:12000,stream:false,
      messages:[
        {role:'system',content:'Optimize the two assigned motorbike inspection schedules for today. Keep an active visit first; urgent response, deadlines and lunch/home precede shorter travel. Node indices are zero-based, distances in metres. Each route must permute only its assigned visits, exactly once. Return JSON only: {"routes":[[0,1],[1,0]]}. Do not transfer assignments.'},
        {role:'user',content:JSON.stringify(problem)}
      ]})});
  if(!rs.ok)throw new Error('model_http_'+rs.status);
  const res=await rs.json();
  if(!/^(?:cx\/)?gpt-6\.2-astra(?:\(xhigh\))?$/.test(res.model??''))throw new Error('model_unconfirmed');
  const raw=res.choices?.[0]?.message?.content;
  if(typeof raw!=='string')throw new Error('invalid_proposal');
  const parsed=JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,''));
  if(!Array.isArray(parsed.routes))throw new Error('invalid_proposal');
  return parsed.routes;
}
Deno.serve(async req=>{
  if(req.method!=='POST')return json({error:'method'},405);
  // Platform verifies JWT. Only a project service credential may spend inference or publish a plan.
  if(!service||!url||req.headers.get('Authorization')!=='Bearer '+service)return json({error:'forbidden'},403);
  try{
    const {org,generation,token}=await req.json();
    if(typeof org!=='string'||typeof token!=='string'||!Number.isSafeInteger(generation))return json({error:'invalid'},400);
    const args={p_org:org,p_generation:generation,p_token:token};
    const data:ShiftInput|null=await rpc('hermes_shift_input_test_v1',args);
    if(!data)return json({status:'superseded'});
    const visits=data.people.map(p=>prepare(data,p));
    const routes=visits.map((v,i)=>solve(data,data.people[i],v));
    const publish=(state:string,model:string|null,final:boolean)=>rpc('hermes_shift_publish_test_v1',{...args,p_state:state,p_model:model,p_final:final,
      p_plans:Object.fromEntries(data.people.map((p,i)=>[p.id,{revision:generation,reason:data.reason,off:p.off||new Date(data.date+'T00:00:00Z').getUTCDay()===0,stops:routes[i].stops}]))});
    if(!visits.some(v=>v.length)){await publish('empty',null,true);return json({status:'empty'});}
    if(!await publish('pending',null,false))return json({status:'superseded'});
    let state='unavailable';
    try{
      const problem=visits.map((v,i)=>{
        const p=data.people[i], keys=[...v.map(x=>x.key),p.anchor??p.home,data.office,p.home];
        return {startIndex:v.length,lunchIndex:v.length+1,endIndex:v.length+2,
          minute:Math.max(480,Math.floor((Date.parse(data.at)-Date.parse(data.date+'T00:00:00+07:00'))/60000)),
          lunch:[690,810],shiftEnd:1050,baseline:routes[i].order,
          visits:v.map(x=>({active:x.active,urgent:x.urgent,full:x.full,daysLeft:x.daysLeft,duration:x.duration,deadline:x.deadline,categories:x.jobs.map(j=>jobKind(j.title))})),
          metres:keys.map(from=>keys.map(to=>data.metres[from]?.[to]??null))};
      });
      const hints=await propose(problem);
      if(hints.length!==visits.length||!hints.every((h,i)=>Array.isArray(h)&&h.length===visits[i].length&&new Set(h).size===h.length&&h.every(n=>Number.isInteger(n)&&n>=0&&n<h.length)))throw new Error('invalid_proposal');
      for(let i=0;i<visits.length;i++)routes[i]=solve(data,data.people[i],visits[i],hints[i]);
      state='checked';
    }catch(error){
      const msg=error instanceof Error?error.message:'unavailable';
      if(/^model_http_\d{3}$|^model_unconfirmed$|^invalid_proposal$/.test(msg))state=msg;
    }
    const saved=await publish(state,state==='checked'?MODEL:null,true);
    return json({status:saved?state:'superseded'});
  }catch{return json({error:'shift_compute_failed'},500);}
});
