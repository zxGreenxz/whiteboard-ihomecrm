// Deploy only the shift planner and only after the TEST marker and project identity agree.
import { credential, ketNoi, batBuocDichTest } from './lib.mjs';
import { withTestLock } from './lock.mjs';
import { dungGoiDeploy, formDeploy } from './edge.mjs';
const slug='hermes-shift-test';
const c=credential(), {test}=await ketNoi(c);
await batBuocDichTest(c,test);
await withTestLock({cred:c,test},async()=>{
  const url='https://api.supabase.com/v1/projects/'+c.testRef+'/functions/deploy?slug='+slug;
  const body=formDeploy(dungGoiDeploy(slug),{name:slug,verify_jwt:true});
  const res=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+c.testPat},body});
  if(!res.ok)throw new Error('TEST Edge deploy HTTP '+res.status+': '+(await res.text()).slice(0,900));
  const row=await res.json();
  if(row.slug!==slug||row.verify_jwt!==true)throw new Error('Unexpected TEST Edge deployment receipt');
  console.log('TEST Edge',row.slug,'version',row.version,'verify_jwt',row.verify_jwt);
});
