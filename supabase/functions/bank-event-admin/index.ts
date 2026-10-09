import {bearer,boundedText,decryptPayload,Dependencies,failed,JsonObject,newToken,object,readJson,reply,RequestError,rpcError,runtimeDependencies,sha256,UUID,validTimestamp} from '../_shared/bank-events.ts';
const fields:Record<string,string[]>={list_sources:[],status:[],create_source:['name'],rotate_source:['sourceId'],set_source_enabled:['sourceId','enabled'],revoke_source:['sourceId'],get_event:['eventId'],list_events:['limit','cursor','sourceId','eventType','query','from','to']};
function validatedInput(value:unknown):{action:string;input:JsonObject;limit:number} {
  if(!object(value)||typeof value.action!=='string'||!Object.hasOwn(fields,value.action))throw new RequestError(400,'invalid_action');
  const action=value.action;
  if(Object.keys(value).some(k=>k!=='action'&&!fields[action].includes(k)))throw new RequestError(400,'invalid_request');
  const input={...value};delete input.action;
  for(const field of ['sourceId','eventId']) {
    if(field in input&&(typeof input[field]!=='string'||!UUID.test(input[field])))throw new RequestError(400,'invalid_request');
  }
  if(['rotate_source','set_source_enabled','revoke_source'].includes(action)&&!input.sourceId)throw new RequestError(400,'invalid_request');
  if(action==='get_event'&&!input.eventId)throw new RequestError(400,'invalid_request');
  if(action==='create_source'&&(!boundedText(input.name,480,true)||(input.name as string).trim().length<1||(input.name as string).trim().length>120))throw new RequestError(400,'invalid_request');
  if(action==='set_source_enabled'&&typeof input.enabled!=='boolean')throw new RequestError(400,'invalid_request');
  const limit=input.limit===undefined?25:input.limit;
  if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>100)throw new RequestError(400,'invalid_request');
  if('query'in input&&!boundedText(input.query,120))throw new RequestError(400,'invalid_request');
  if('eventType'in input&&!['sms.received','notification.received','gateway.test'].includes(String(input.eventType)))throw new RequestError(400,'invalid_request');
  for(const field of ['from','to'])if(field in input&&!validTimestamp(input[field]))throw new RequestError(400,'invalid_request');
  if(typeof input.from==='string'&&typeof input.to==='string'&&Date.parse(input.from)>=Date.parse(input.to))throw new RequestError(400,'invalid_request');
  if('cursor'in input) {
    try {
      if(typeof input.cursor!=='string'||input.cursor.length>256)throw new Error();
      const cursor:unknown=JSON.parse(atob(input.cursor));
      if(!object(cursor)||!validTimestamp(cursor.time)||typeof cursor.id!=='string'||!UUID.test(cursor.id))throw new Error();
      input.beforeTime=cursor.time;input.beforeId=cursor.id;delete input.cursor;
    }catch{throw new RequestError(400,'invalid_cursor');}
  }
  return {action,input,limit};
}
export function createHandler(deps:Dependencies={}) {
  const {env,rpc,authorizeAdmin}=runtimeDependencies(deps);
  return async(request:Request):Promise<Response>=>{
    if(request.method==='OPTIONS')return reply(200,{ok:true});
    try {
      if(request.method!=='POST')throw new RequestError(405,'method_not_allowed');
      const authorization=bearer(request);
      if(!await authorizeAdmin(authorization))throw new RequestError(403,'forbidden');
      const {action,input,limit}=validatedInput(await readJson(request));
      let token:string|undefined;
      if(action==='create_source'||action==='rotate_source') {
        token=newToken();const digest=await sha256(token);input.credentialDigest=digest;input.fingerprint=`sha256:${digest.slice(0,12)}`;
      }
      const result=await rpc('bank_event_admin_v1',{p_action:action,p_input:input},authorization);
      if(result.error)throw rpcError(result.error.code);
      if(!object(result.data))throw new RequestError(502,'invalid_admin_receipt');
      const data={...result.data};
      if(action==='list_events') {
        if(!Array.isArray(data.events))throw new RequestError(502,'invalid_admin_receipt');
        const hasMore=data.events.length>limit;data.events=data.events.slice(0,limit);
        const last=(data.events as unknown[]).at(-1);
        data.nextCursor=hasMore&&object(last)?btoa(JSON.stringify({time:last.receivedAt,id:last.id})):null;
      }else if(action==='get_event') {
        const payload=await decryptPayload(env,data);
        return reply(200,{ok:true,data:{event:data.event,payload}});
      }else if(action==='status') {
        let ingestUrl:string|null=null;
        try {const url=new URL(env('BANK_EVENT_INGEST_URL')??'');if(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash)ingestUrl=url.href;}catch{/* Unconfigured URL is represented honestly. */}
        data.ingestUrl=ingestUrl;
      }
      if(token)data.token=token;
      return reply(200,{ok:true,data});
    }catch(error){return failed(error);}
  };
}
if(import.meta.main)Deno.serve(createHandler());
