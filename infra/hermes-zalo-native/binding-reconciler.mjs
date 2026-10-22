import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { provisionNativeBinding } from './binding-provisioning.mjs';
import { assertNativeProfileDmOnly, provisionNativeProfile, validateNativeProvisioningConfiguration } from './profile-provisioning.mjs';
const fail=()=>{throw Error('native_binding_reconciler_invalid');};
// Mã lỗi công khai báo ra status() (không bao giờ nuốt thành "pending" trơn): profile bị K1 chặn.
const PUBLIC_BLOCKS=['native_profile_shared_platform'];
const same=(a,b)=>['assistantId','userId','organizationId'].every(key=>a[key]===b[key]);
/** Bounded host maintenance. Only configured assistant/bot/profile mappings are
 * read. Encrypted enrollment supplies the EXACT selected connection credential.
 * No process is launched/restarted; receipts remain restart_pending until the
 * existing controlled restart is performed and verified externally.
 */
export function createNativeBindingReconciler({configuration,handoff,backend,transport,timers={setTimeout,clearTimeout}}={}) {
  const config=validateNativeProvisioningConfiguration(configuration);
  if([handoff?.list,backend?.resolveConnection,transport?.call,timers?.setTimeout,timers?.clearTimeout].some(fn=>typeof fn!=='function'))fail();
  const controller=new AbortController();let running,timer,closed,closing=false,started=false,state='idle',pending=0,blocked=[];
  const block=(mapping,error)=>{if(PUBLIC_BLOCKS.includes(error?.message))blocked.push(Object.freeze({profile:mapping.profile,code:error.message}));};
  const cycle=async()=>{
    state='checking';pending=0;blocked=[];
    try {
      const enrollments=await handoff.list({signal:controller.signal});
      if(!Array.isArray(enrollments)||enrollments.length>256)fail();
      for(const mapping of config.profiles) {
        if(closing)break;
        try {
          const selector={assistantId:mapping.assistantId,accountId:mapping.accountId};
          const work=await transport.call('readZaloProvisioningWork',selector,{signal:controller.signal});
          if(work?.status==='empty'&&Object.keys(work).length===1)continue;
          if(!work||work.status!=='queued'||!Number.isSafeInteger(work.revision)||work.revision<1||!work.binding||
            !same(mapping,work.binding)||work.binding.accountId!==mapping.accountId)fail();
          const snapshot=work.binding;
          const ack=async value=>transport.call('acknowledgeZaloProvisioning',{...selector,bindingId:snapshot.bindingId,
            expectedRevision:work.revision,state:value},{signal:controller.signal});
          if(snapshot.status==='unavailable'){pending++;await ack('unavailable');continue;}
          const pendingCredential=async()=>{
            pending++;await ack('pending_credential');
            if(!closing)provisionNativeProfile({configuration:config,mapping,snapshot,credentialPending:true});
          };
          let token;
          if(snapshot.status==='active') {
            const matched=enrollments.filter(row=>row.connectionId===snapshot.connectionId&&same(row,mapping));
            if(matched.length!==1){await pendingCredential();continue;}
            token=matched[0].token;
            let owner;
            try {owner=await backend.resolveConnection(token,{signal:controller.signal});}
            catch {await pendingCredential();continue;}
            if(owner?.connectionId!==snapshot.connectionId||!same(owner,mapping)||!Number.isSafeInteger(owner.expiresAt)||owner.expiresAt<=Date.now()){
              await pendingCredential();continue;
            }
          } else if(snapshot.status!=='revoked')fail();
          // K1 TRƯỚC khi ghi liên kết native hay xác nhận restart_pending (review #253): profile sắp nhận token CRM mà bật
          // nền tảng có nhóm thì dừng ở đây, không để trạng thái nửa vời (native đã ghi, profile bị từ chối). Thu hồi vẫn chạy.
          if(snapshot.status==='active'){
            try{assertNativeProfileDmOnly(mapping);}catch(error){pending++;block(mapping,error);continue;}
          }
          const options={transport,bindingId:snapshot.bindingId,profileBinding:{assistantId:mapping.assistantId,
            userId:mapping.userId,organizationId:mapping.organizationId,profile:mapping.profile},
            configFile:config.configFile,tokenFile:path.join(path.dirname(config.configFile),mapping.profile+'.issued.'+randomUUID()+'.token'),
            stateRoot:config.stateRoot,listenPort:config.listenPort,signal:controller.signal};
          const plan=await provisionNativeBinding(options);
          if(plan.status==='unavailable'){pending++;await ack('unavailable');continue;}
          // Persist restart-required BEFORE either operator/profile mutation.
          // A lost ACK prevents this cycle's writes; a crash after publication
          // leaves durable pending evidence for the next host process.
          await ack('restart_pending');
          pending++;
          const native=plan.status==='planned'?await provisionNativeBinding({...options,apply:true,expect:plan.expectedRevision}):plan;
          // A changed queue revision is never acknowledged with a newer token
          // or identity. Re-read before publishing the profile's MCP capability.
          const current=await transport.call('readZaloProvisioningWork',selector,{signal:controller.signal});
          if(current.revision!==work.revision||JSON.stringify(current.binding)!==JSON.stringify(snapshot)){pending++;continue;}
          provisionNativeProfile({configuration:config,mapping,snapshot,token,revoked:snapshot.status==='revoked'});
          // No restart verification API exists. A disk no-op is never proof
          // that a running worker/profile loaded this configuration.
          void native;
        } catch(error) {pending++;block(mapping,error);}
      }
      state=pending?'pending':'ready';
    } catch {state='unavailable';pending++;}
  };
  const poll=()=>{if(closing)return;running=cycle().finally(()=>{running=undefined;if(!closing){timer=timers.setTimeout(poll,config.pollIntervalMs);timer?.unref?.();}});void running.catch(()=>{});};
  return Object.freeze({
    start(){if(closing)fail();if(!started){started=true;poll();}},
    async reconcile(){if(closing)fail();if(running)return running;running=cycle();try{await running;}finally{running=undefined;}},
    status(){return Object.freeze({state,pending,...(blocked.length?{blocked:Object.freeze([...blocked])}:{})});},
    close(){if(!closed){closing=true;controller.abort();timers.clearTimeout(timer);closed=Promise.resolve().then(async()=>{await running;state='closed';});void closed.catch(()=>{});}return closed;}
  });
}
