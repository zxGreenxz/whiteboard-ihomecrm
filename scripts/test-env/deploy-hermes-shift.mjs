// Deploy only the shift planner and only after the TEST marker and project identity agree.
import { credential, ketNoi, batBuocDichTest } from './lib.mjs';
import { withTestLock } from './lock.mjs';
import { dungGoiDeploy, formDeploy } from './edge.mjs';
const slug='hermes-shift-test';
const c=credential(), {test}=await ketNoi(c);
await batBuocDichTest(c,test);
await withTestLock({cred:c,test},async()=>{
  // Hosted Edge's database key can differ from the project's legacy service JWT used by pg_net.
  const project='https://api.supabase.com/v1/projects/'+c.testRef;
  const headers={Authorization:'Bearer '+c.testPat};
  const keys=await fetch(project+'/api-keys?reveal=true',{headers});
  if(!keys.ok)throw new Error('Cannot verify TEST dispatch credential');
  const token=(await keys.json()).find(k=>k.name==='service_role')?.api_key;
  const claims=JSON.parse(Buffer.from(token?.split('.')[1]??'','base64url').toString('utf8'));
  if(claims.role!=='service_role'||claims.ref!==c.testRef)throw new Error('Wrong TEST dispatch credential');
  const set=await fetch(project+'/secrets',{method:'POST',headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify([{name:'HERMES_SHIFT_DISPATCH_JWT',value:token}])});
  if(!set.ok)throw new Error('Cannot set TEST dispatch credential: '+set.status);
  const url='https://api.supabase.com/v1/projects/'+c.testRef+'/functions/deploy?slug='+slug;
  const body=formDeploy(dungGoiDeploy(slug),{name:slug,verify_jwt:true});
  const res=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+c.testPat},body});
  if(!res.ok)throw new Error('TEST Edge deploy HTTP '+res.status+': '+(await res.text()).slice(0,900));
  const row=await res.json();
  if(row.slug!==slug||row.verify_jwt!==true)throw new Error('Unexpected TEST Edge deployment receipt');
  console.log('TEST Edge',row.slug,'version',row.version,'verify_jwt',row.verify_jwt);
});
