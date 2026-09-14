// Headless real form/hook fixture; synthetic transport only, zero business writes.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';
const root = process.cwd();
const entry = '\0owner-fixture.tsx';
const backend = '\0owner-backend';
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useBuildingLegalOwnerForm } from '@/hooks/useBuildingLegalOwnerForm';
import { BuildingLegalOwnerFields } from '@/components/buildings/BuildingLegalOwnerFields';
import { Toaster } from 'sonner';
import '@/index.css';
function Fixture(){
 const owner=useBuildingLegalOwnerForm(new URLSearchParams(location.search).has('edit')?'existing':undefined,true);
 return <main style={{maxWidth:700,margin:20}}><Toaster/><form onSubmit={async e=>{e.preventDefault();if(await owner.validate())await owner.save('building').catch(()=>{});}}>
 <BuildingLegalOwnerFields {...owner}/><button type="submit">Lưu chủ sở hữu</button></form></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const server = await createServer({ configFile:false, root, esbuild:{jsx:'automatic'}, cacheDir:path.join(root,'.tmp-ct01-lease/owner-vite'),
  optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','react-hook-form','@hookform/resolvers/zod','zod','sonner','@radix-ui/react-label','@radix-ui/react-slot','class-variance-authority','clsx','tailwind-merge','date-fns']},
  resolve:{alias:[{find:'@/integrations/supabase/client',replacement:'virtual:owner-backend'},{find:'@',replacement:path.join(root,'src')}]},
  plugins:[{name:'owner-fixture',resolveId(id){if(id==='/owner.tsx')return entry;if(id==='virtual:owner-backend')return backend;},
    async load(id){if(id===entry)return(await transformWithEsbuild(fixture,'owner.tsx',{loader:'tsx',jsx:'automatic'})).code;
      if(id===backend)return `window.ownerCalls=[];let failed=false;export const supabase={from(){return{select(){return{eq(){return{async maybeSingle(){return{data:{full_name:'Nguyễn Chủ',birth_year:1970,id_number:'001122',id_issue_date:null,id_issue_place:'',permanent_address:''},error:null}}}}}}}},async rpc(name,args){window.ownerCalls.push(args);if(!failed){failed=true;return{error:{code:'network'}};}return{error:null};}};`;},
    configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(!req.url?.startsWith('/owner.html'))return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/owner.html','<html lang="vi"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/owner.tsx"></script></body></html>'));});}
  }],server:{host:'127.0.0.1',port:0} });
await server.listen();
const address=server.httpServer.address();assert(address&&typeof address!=='string');
const origin=`http://127.0.0.1:${address.port}`;
const browser=await chromium.launch({headless:true});
try{
 for(const edit of [false,true]){
  const page=await browser.newPage(); const errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  await page.goto(`${origin}/owner.html${edit?'?edit=1':''}`,{waitUntil:'networkidle'});
  const identity=page.getByLabel('CCCD/CMND chủ sở hữu',{exact:true});
  await identity.waitFor();
  assert.equal(await page.getByLabel('Nơi cấp CCCD/CMND',{exact:true}).inputValue(),'Cục Cảnh sát');
  if(edit)assert.equal(await identity.inputValue(),'001122');
  await identity.fill('001234567890');
  await page.getByLabel('Họ tên chủ sở hữu',{exact:true}).fill('Chủ sở hữu thử nghiệm');
  await page.getByRole('button',{name:'Lưu chủ sở hữu'}).click();
  await page.getByText('Thông tin tòa nhà có thể đã được lưu; chưa lưu được chủ sở hữu pháp lý. Vui lòng thử lại.').waitFor();
  assert.equal(await identity.inputValue(),'001234567890');
  await page.getByRole('button',{name:'Lưu chủ sở hữu'}).click();
  await page.waitForFunction(()=>window.ownerCalls.length>=2);
  const calls=await page.evaluate(()=>window.ownerCalls);
  assert.equal(calls[1].p_owner.id_number,'001234567890');
  assert.equal(calls[1].p_owner.id_issue_place,'Cục Cảnh sát');
  await page.getByRole('button',{name:'Lưu chủ sở hữu'}).click();
  assert.equal(await page.evaluate(()=>window.ownerCalls.length),2);
  assert.deepEqual(errors,[]); await page.close();
 }
 console.log('PASS owner create/edit fields, load, leading zeros, failed-save retry, unchanged retry; console errors 0; external API writes 0');
}finally{await browser.close();await server.close();}
