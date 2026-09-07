import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root=process.cwd(), dist=resolve(root,'dist');
const config=JSON.parse(await readFile(resolve(root,'vercel.json'),'utf8'));
const csp=config.headers.flatMap(item=>item.headers).find(item=>item.key==='Content-Security-Policy').value;
const workerName=(await readdir(resolve(dist,'assets'))).find(name=>/^qr\.worker-.*\.js$/.test(name));
const adapterName=(await readdir(resolve(dist,'assets'))).find(name=>/^wechatAdapter-.*\.js$/.test(name));
assert.ok(workerName,'Run npm run build first');
const requests=[];
let failAsset=false;
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',csp);
  const pathname=new URL(req.url,'http://localhost').pathname;
  requests.push(pathname);
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local synthetic QR worker verification</title>');return;}
  if(pathname==='/strong-probe.mjs'){
    res.setHeader('Content-Type','text/javascript');
    res.end(`import {scanWeChat,initializeWeChat,grayForDetection} from '/assets/${adapterName}';
      self.onmessage=async(event)=>{try{
        const image=event.data, runtime=await initializeWeChat();
        const input=runtime.dnn.matFromImageData(image), reference=new runtime.dnn.Mat();
        runtime.dnn.cvtColor(input,reference,runtime.dnn.COLOR_RGBA2GRAY);
        const bounded=grayForDetection(image,runtime.dnn);
        const grayEqual=reference.data.length===bounded.data.length&&reference.data.every((value,i)=>value===bounded.data[i]);
        input.delete();reference.delete();bounded.delete();
        self.postMessage({candidates:await scanWeChat(image),grayEqual,wasmHeapBytes:runtime.cv.HEAPU8.byteLength+runtime.dnn.HEAPU8.byteLength});
      }catch(error){self.postMessage({error:String(error.message).slice(0,400)});}};`);
    return;
  }
  if(failAsset&&pathname.includes('/qr-assets/')){res.statusCode=404;res.end();return;}
  const file=resolve(dist,'.'+pathname);
  if(!file.startsWith(dist+sep)){res.statusCode=403;res.end();return;}
  try{
    res.setHeader('Content-Type',extname(file)==='.wasm'?'application/wasm':'text/javascript');
    res.setHeader('Cache-Control','public,max-age=3600');
    res.end(await readFile(file));
  }catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const channel=process.argv.includes('--edge')?'msedge':'chrome';
const browser=await chromium.launch({headless:true,channel});
try{
  const browserCdp=await browser.newBrowserCDPSession();
  async function processSample(){
    const {processInfo}=await browserCdp.send('SystemInfo.getProcessInfo');
    const sample={cpuSeconds:processInfo.reduce((sum,p)=>sum+p.cpuTime,0)};
    const ids=processInfo.map(p=>p.id).filter(id=>Number.isSafeInteger(id)&&id>0);
    if(process.platform==='win32'&&ids.length){
      const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true});
      const memory=JSON.parse(output),rows=Array.isArray(memory)?memory:[memory];
      sample.summedWorkingSetBytes=rows.reduce((sum,p)=>sum+p.WorkingSet64,0);
      sample.summedPrivateBytes=rows.reduce((sum,p)=>sum+p.PrivateMemorySize64,0);
    }
    return sample;
  }
  const processBefore=await processSample();
  const page=await browser.newPage({bypassCSP:false});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message.slice(0,250)));
  await page.goto(origin);
  const bootstrap=workerUrl=>{
    window.worker=new Worker(workerUrl,{type:'module'});
    window.ready=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('worker ready timeout')),5000);
      window.worker.onerror=()=>{clearTimeout(timeout);reject(Error('worker error'));};
      window.worker.onmessage=event=>{if(event.data.type==='ready'){clearTimeout(timeout);resolve();}};
    });
    window.serial=0;
    window.scan=async(spec,mode='image',budgetMs=5000)=>{
      await window.ready;
      const canvas=new OffscreenCanvas(spec.width,spec.height),ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,spec.width,spec.height);
      for(const code of spec.codes){
        ctx.save();ctx.translate(code.x,code.y);
        if(code.rotate)ctx.rotate(code.rotate);
        ctx.fillStyle='#000';
        if(code.quad){
          const [p0,p1,p2,p3]=code.quad;
          const dx1=p1.x-p2.x,dx2=p3.x-p2.x,dx3=p0.x-p1.x+p2.x-p3.x;
          const dy1=p1.y-p2.y,dy2=p3.y-p2.y,dy3=p0.y-p1.y+p2.y-p3.y;
          const denominator=dx1*dy2-dx2*dy1,g=(dx3*dy2-dx2*dy3)/denominator,h=(dx1*dy3-dx3*dy1)/denominator;
          const project=(x,y)=>{const u=x/code.size,v=y/code.size,z=g*u+h*v+1;return{x:((p1.x-p0.x+g*p1.x)*u+(p3.x-p0.x+h*p3.x)*v+p0.x)/z,y:((p1.y-p0.y+g*p1.y)*u+(p3.y-p0.y+h*p3.y)*v+p0.y)/z};};
          for(let y=0;y<code.size;y++)for(let x=0;x<code.size;x++)if(code.matrix[y*code.size+x]){
            const points=[project(x,y),project(x+1,y),project(x+1,y+1),project(x,y+1)];
            ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(const p of points.slice(1))ctx.lineTo(p.x,p.y);ctx.closePath();ctx.fill();
          }
        }else for(let y=0;y<code.size;y++)for(let x=0;x<code.size;x++)if(code.matrix[y*code.size+x])ctx.fillRect(x*code.scale,y*code.scale,code.scale,code.scale);
        ctx.restore();
      }
      const source=ctx.getImageData(0,0,spec.width,spec.height);
      if(spec.coverage){
        // Match the independent mixed-difficulty regression's exact coverage
        // raster; browser fillRect rounds fractional edges differently.
        source.data.fill(255);
        for(const code of spec.codes)for(let y=0;y<code.size;y++)for(let x=0;x<code.size;x++)if(code.matrix[y*code.size+x]){
          for(let py=Math.floor(code.y+y*code.scale);py<Math.ceil(code.y+(y+1)*code.scale);py++)for(let px=Math.floor(code.x+x*code.scale);px<Math.ceil(code.x+(x+1)*code.scale);px++){
            const coverage=(Math.min(px+1,code.x+(x+1)*code.scale)-Math.max(px,code.x+x*code.scale))*(Math.min(py+1,code.y+(y+1)*code.scale)-Math.max(py,code.y+y*code.scale));
            const i=(py*spec.width+px)*4;source.data[i]=source.data[i+1]=source.data[i+2]=source.data[i]*(1-coverage);
          }
        }
      }
      window.lastRaster=new ImageData(new Uint8ClampedArray(source.data),source.width,source.height);canvas.width=canvas.height=0;
      const requestId=++window.serial,start=performance.now();let initMs=0,initStart=0;
      return new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>{window.worker.terminate();reject(Error('bounded worker scan timeout'));},budgetMs+6000);
        window.worker.onmessage=event=>{
          const message=event.data;if(message.requestId!==requestId)return;
          if(message.type==='initializing'){if(message.initializing)initStart=performance.now();else initMs+=performance.now()-initStart;}
          if(message.type==='result'){clearTimeout(timeout);resolve({...message.result,wallMs:performance.now()-start,initMs});}
        };
        window.worker.postMessage({type:'scan',requestId,source,mode,budgetMs},[source.data.buffer]);
      });
    };
  };
  await page.evaluate(bootstrap,`/assets/${workerName}`);
  const payload='001099999991||NGUYỄN THỬ MỘT|01011990|Nam|Địa chỉ giả A|01012024';
  const second='001099999992||TRẦN THỬ HAI|02021992|Nữ|Địa chỉ giả B|02022024';
  const code=(text,x,y,scale,rotate=0)=>{const qr=QRCode.create(text,{errorCorrectionLevel:'M'});return{x,y,scale,rotate,size:qr.modules.size,matrix:[...qr.modules.data]};};
  const rows=[];
  const quad=[{x:150,y:60},{x:470,y:120},{x:400,y:440},{x:90,y:390}];
  const tight=code(payload,0,0,1.4);
  const smallSecond=code(second,0,0,1.25);
  smallSecond.x=600-Math.ceil(smallSecond.size*smallSecond.scale);
  smallSecond.y=300-Math.ceil(smallSecond.size*smallSecond.scale);
  for(const spec of [
    {id:'corner-4000',width:4000,height:3000,codes:[code(payload,3750,2720,4)],expected:[payload]},
    {id:'seam',width:4000,height:3000,codes:[code(payload,1090,1080,5)],expected:[payload]},
    {id:'large',width:2200,height:2200,codes:[code(payload,130,130,35)],expected:[payload]},
    {id:'rotated',width:500,height:500,codes:[code(second,100,50,5,.3)],expected:[second]},
    {id:'perspective',width:560,height:520,codes:[{...code(second,0,0,5),quad}],expected:[second],corners:quad},
    {id:'tight-nearest',width:Math.ceil(tight.size*tight.scale),height:Math.ceil(tight.size*tight.scale),codes:[tight],expected:[payload],engine:'zxing-wasm'},
    {id:'multiple',width:1200,height:700,codes:[code(payload,20,20,5),code(second,500,350,5),code(payload,900,20,4)],expected:[payload,second]},
    {id:'mixed-difficulty',width:600,height:300,codes:[code(payload,20,20,5),smallSecond],expected:[payload,second],engine:'zxing-wasm',coverage:true},
    {id:'blank-cold',width:640,height:480,codes:[],expected:[]},
    {id:'blank-warm',width:640,height:480,codes:[],expected:[]},
  ]){
    const result=await page.evaluate(spec=>window.scan(spec),spec);
    assert.equal(result.status,spec.expected.length?'decoded':'not-found',spec.id);
    assert.deepEqual((result.candidates??[]).map(item=>item.text).sort(),spec.expected.sort(),spec.id);
    if(spec.engine)assert.equal(result.candidates[0].engine,spec.engine,spec.id);
    if(spec.corners)for(const point of spec.corners)assert.ok(result.candidates[0].corners.some(p=>Math.hypot(p.x-point.x,p.y-point.y)<7),'perspective source corner mismatch');
    rows.push({caseId:spec.id,status:result.status,engines:[...new Set((result.candidates??[]).map(c=>c.engine))],wallMs:Math.round(result.wallMs),initMs:Math.round(result.initMs)});
  }
  const wasmPaths=[...new Set(requests.filter(path=>path.endsWith('.wasm')))];
  assert.equal(wasmPaths.length,3,'ZXing plus both OpenCV WASM assets must actually load');
  for(const path of wasmPaths){const response=await page.request.get(origin+path);assert.equal(response.headers()['content-type'],'application/wasm');}
  await page.context().setOffline(true);
  const warmOffline=await page.evaluate(()=>window.scan({width:640,height:480,codes:[]}));
  assert.equal(warmOffline.status,'not-found');
  await page.context().setOffline(false);
  // Exercise the real production adapter's decode bindings, including point
  // matrices and multiple payloads, in an actual module worker under this CSP.
  await page.evaluate(spec=>window.scan(spec),{width:1200,height:700,codes:[code(payload,20,20,5),code(second,500,350,5),code(payload,900,20,4)]});
  const strong=await page.evaluate(()=>new Promise((resolve,reject)=>{
    const worker=new Worker('/strong-probe.mjs',{type:'module'});
    const timeout=setTimeout(()=>{worker.terminate();reject(Error('strong probe timeout'));},10000);
    worker.onmessage=event=>{if(!('grayEqual' in event.data)&&!('error' in event.data))return;clearTimeout(timeout);worker.terminate();resolve(event.data);};
    worker.onerror=()=>{clearTimeout(timeout);worker.terminate();reject(Error('strong probe crashed'));};
    worker.postMessage(window.lastRaster);
  }));
  assert.ok(!strong.error,strong.error);
  assert.equal(strong.grayEqual,true,'bounded row-strip gray must match full cv.cvtColor exactly');
  assert.deepEqual(strong.candidates.map(c=>c.text).sort(),[payload,second].sort());
  for(const candidate of strong.candidates)assert.equal(candidate.corners.length,4);
  // A fresh context prevents HTTP cache from disguising asset404. Retry in the
  // same worker verifies rejected imports/runtime promises are not cached.
  const recovery=await browser.newPage({bypassCSP:false});
  await recovery.goto(origin);await recovery.evaluate(bootstrap,`/assets/${workerName}`);
  failAsset=true;
  const failed=await recovery.evaluate(()=>window.scan({width:640,height:480,codes:[]}));
  assert.equal(failed.status,'engine-unavailable');
  failAsset=false;
  const recovered=await recovery.evaluate(()=>window.scan({width:640,height:480,codes:[]}));
  assert.equal(recovered.status,'not-found');
  await recovery.close();
  assert.deepEqual(errors,[]);
  const processAfter=await processSample();
  const report={browser:channel,bypassCSP:false,productionWorker:workerName,rows,wasmPaths,offlineWarm:warmOffline.status,strongDistinctCandidates:strong.candidates.length,grayByteEquality:strong.grayEqual,strongWasmHeapBytes:strong.wasmHeapBytes,asset404:failed.status,asset404Recovery:recovered.status,processBefore,processAfter,cpuSeconds:processAfter.cpuSeconds-processBefore.cpuSeconds,errors};
  const outputIndex=process.argv.indexOf('--output');
  if(outputIndex!==-1)await writeFile(resolve(process.argv[outputIndex+1]),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await browser.close();server.close();}
