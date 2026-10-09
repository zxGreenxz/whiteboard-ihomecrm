import {bearer,Dependencies,encryptPayload,failed,HASH,object,readJson,reply,RequestError,rpcError,runtimeDependencies,sha256,UUID,validateEvent,validTimestamp} from '../_shared/bank-events.ts';

export function createHandler(deps: Dependencies={}) {
  const {env,rpc}=runtimeDependencies(deps);
  return async(request:Request):Promise<Response>=>{
    if(request.method==='OPTIONS')return reply(200,{ok:true});
    try {
      if(request.method!=='POST')throw new RequestError(405,'method_not_allowed');
      const authorization=bearer(request),token=authorization.slice(7);
      if(token.length<32||token.length>256)throw new RequestError(401,'unauthorized');
      const key=request.headers.get('x-idempotency-key');
      if(!key||!HASH.test(key))throw new RequestError(400,'invalid_idempotency_key');
      const event=validateEvent(await readJson(request),key);
      const heartbeat=event.event==='gateway.heartbeat';
      const hash=await sha256(JSON.stringify(event));
      const encrypted=heartbeat?null:await encryptPayload(env,event,hash);
      const result=await rpc('bank_event_ingest_v1',{
        p_digest:await sha256(token),p_external_id:event.id,p_device_id:event.deviceId,
        p_event_type:event.event,p_occurred_at:event.receivedAt,p_payload_hash:hash,
        p_ciphertext:encrypted?.ciphertext??null,p_nonce:encrypted?.nonce??null,p_key_id:encrypted?.keyId??null,
        p_heartbeat:heartbeat?Object.fromEntries(['smsEnabled','notificationsEnabled','notificationAccess','smsPermission','appVersion','receivedAt'].map(k=>[k,event[k]])):null,
      });
      if(result.error)throw rpcError(result.error.code);
      const receipt=result.data;
      if(!object(receipt)||!['accepted','duplicate','heartbeat'].includes(String(receipt.status))
        ||typeof receipt.sourceId!=='string'||!UUID.test(receipt.sourceId)||receipt.externalId!==event.id||!validTimestamp(receipt.acceptedAt)
        ||(heartbeat?receipt.status!=='heartbeat'||receipt.eventId!==null:
          receipt.status==='heartbeat'||typeof receipt.eventId!=='string'||!UUID.test(receipt.eventId)))throw new RequestError(502,'invalid_storage_receipt');
      return reply(receipt.status==='accepted'?201:200,{schemaVersion:1,ok:true,data:receipt});
    }catch(error){return failed(error);}
  };
}
if(import.meta.main)Deno.serve(createHandler());
