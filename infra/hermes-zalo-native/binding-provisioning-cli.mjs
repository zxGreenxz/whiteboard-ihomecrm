#!/usr/bin/env node
import { nativeAbsolute, nativePrivateRead } from '../../worker/lib/hermes-native-files.js';
import { createStorePool } from '../hermes-broker/store-pool.mjs';
import { createStoreTransport } from '../hermes-broker/store-transport.mjs';
import { provisionNativeBinding } from './binding-provisioning.mjs';
import { isMainModule } from './operator.mjs';

const fail = () => { throw new Error('native_binding_provisioning_invalid'); };
function load(file) {
  const config=JSON.parse(nativePrivateRead(nativeAbsolute(file),16384));
  if (!config || Object.keys(config).some(key=>!['version','store','bindingId','profileBinding','native'].includes(key)) ||
      config.version!==1 || !config.store || !config.native ||
      Object.keys(config.store).some(key=>!['projectRef','host','role','passwordFile','caFile'].includes(key)) ||
      Object.keys(config.native).some(key=>!['configFile','tokenFile','stateRoot','listenPort'].includes(key))) fail();
  return config;
}
function connect(store) {
  const password=nativePrivateRead(store.passwordFile,4096);
  const ca=store.caFile===undefined ? undefined : nativePrivateRead(store.caFile,65536);
  const pool=createStorePool({ projectRef:store.projectRef,host:store.host,role:store.role,password,...(ca===undefined?{}:{ca}) });
  return { transport:createStoreTransport({pool,expectedRole:store.role}), close:()=>pool.end() };
}
/** The operator supplies a private host-owned mapping file. The only database
 * operation is the fixed readZaloBinding call; no shell/provider/session start.
 * Default preview never changes disk. Apply still reports restart unverified.
 */
export async function runBindingProvisioningCli(argv,{loadConfig=load,connectStore=connect,
  write=line=>process.stdout.write(line),error=line=>process.stderr.write(line)}={}) {
  let connection;
  try {
    if (argv.length===1 && argv[0]==='--help') {
      write(JSON.stringify({usage:'--config <private-absolute-json> [--apply --expect <preview-revision>]',
        activation:'existing controlled worker restart and private token delivery required'})+'\n');return 0;
    }
    if (!Array.isArray(argv)||argv[0]!=='--config'||typeof argv[1]!=='string'||
        !(argv.length===2 || argv.length===5 && argv[2]==='--apply' && argv[3]==='--expect' && /^[a-f0-9]{64}$/.test(argv[4]))) fail();
    const config=await loadConfig(argv[1]);
    connection=await connectStore(config.store);
    const result=await provisionNativeBinding({...config.native,bindingId:config.bindingId,profileBinding:config.profileBinding,
      transport:connection.transport,apply:argv.length===5,expect:argv[4],signal:new AbortController().signal});
    write(JSON.stringify(result)+'\n');return 0;
  } catch {
    error(JSON.stringify({error:'native_binding_provisioning_failed',runtimeStatus:'unverified'})+'\n');return 1;
  } finally {
    if(connection) try { await connection.close(); }
    catch { error(JSON.stringify({error:'native_binding_provisioning_failed',runtimeStatus:'unverified'})+'\n'); return 1; }
  }
}
if(isMainModule(process.argv[1],import.meta.url)) process.exitCode=await runBindingProvisioningCli(process.argv.slice(2));
