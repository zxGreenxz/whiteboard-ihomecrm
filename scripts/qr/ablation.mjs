import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import QRCode from 'qrcode';

const root=process.cwd(),dist=resolve(root,'dist');
const wasm=(await readdir(resolve(dist,'assets'))).find(name=>name.startsWith('zxing_reader-')&&name.endsWith('.wasm'));
const entry=await build({stdin:{contents:'export {scanZxing} from "./engines"; export {makeVariants} from "./preprocess";',resolveDir:resolve(root,'src/lib/qr'),loader:'ts'},bundle:true,format:'esm',platform:'browser',write:false,plugins:[{name:'wasm-url',setup(build){build.onResolve({filter:/\.wasm\?url$/},()=>({path:'wasm-url',namespace:'qr'}));build.onLoad({filter:/.*/,namespace:'qr'},()=>({contents:`export default '/assets/${wasm}'`,loader:'js'}));}}]});
const policy=JSON.parse(await readFile('vercel.json','utf8')).headers.flatMap(h=>h.headers).find(h=>h.key==='Content-Security-Policy').value;
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',policy);
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic isolated filter ablation</title>');return;}
  if(req.url==='/ablation.mjs'){res.setHeader('Content-Type','text/javascript');res.end(entry.outputFiles[0].text);return;}
  if(req.url===`/assets/${wasm}`){res.setHeader('Content-Type','application/wasm');res.end(await readFile(resolve(dist,'assets',wasm)));return;}
  res.statusCode=404;res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
  const page=await browser.newPage({bypassCSP:false});await page.goto(`http://127.0.0.1:${server.address().port}`);
  const rows=[];
  // Split by source card, before generating variants. Holdout cards never enter
  // development filter selection; labels/payloads are entirely synthetic.
  for(const [group,split,payload,ecc] of [
    ['synthetic-card-A','development','001099999991||NGUYỄN THỬ MỘT|01011990|Nam|Địa chỉ giả A|01012024','M'],
    ['synthetic-card-B','holdout','001099999992||TRẦN THỬ HAI|02021992|Nữ|Địa chỉ giả B|02022024','Q'],
    ['synthetic-card-C','holdout','001099999993||ĐỖ KIỂM THỬ BA|31121988|Nam|Địa chỉ giả dài để tăng phiên bản mã QR|03032024','H'],
  ]){
    const qr=QRCode.create(payload,{errorCorrectionLevel:ecc});
    for(const [variant,scale,blur,contrast,quiet] of [['raw',4,0,1,4],['tight-small',1.4,0,1,0],['blurred',2,.7,1,4],['low-contrast',2,0,.14,4],['uneven',2,0,.45,4]]){
      const result=await page.evaluate(async spec=>{
        const engine=await import('/ablation.mjs'),canvas=new OffscreenCanvas(Math.ceil((spec.size+spec.quiet*2)*spec.scale),Math.ceil((spec.size+spec.quiet*2)*spec.scale)),ctx=canvas.getContext('2d');
        ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle=`rgba(0,0,0,${spec.contrast})`;ctx.filter=`blur(${spec.blur}px)`;
        for(let y=0;y<spec.size;y++)for(let x=0;x<spec.size;x++)if(spec.matrix[y*spec.size+x])ctx.fillRect((x+spec.quiet)*spec.scale,(y+spec.quiet)*spec.scale,spec.scale,spec.scale);
        if(spec.variant==='uneven'){ctx.filter='none';const gradient=ctx.createLinearGradient(0,0,canvas.width,canvas.height);gradient.addColorStop(0,'rgba(0,0,0,.55)');gradient.addColorStop(1,'rgba(255,255,255,.1)');ctx.fillStyle=gradient;ctx.fillRect(0,0,canvas.width,canvas.height);}
        const original=ctx.getImageData(0,0,canvas.width,canvas.height),rows=[];
        for(const kind of ['raw','nearest','smooth','contrast','threshold','unsharp','border']){
          const start=performance.now();let candidates=[];
          for(const image of engine.makeVariants(original,[kind]))candidates=await engine.scanZxing(image);
          rows.push({kind,success:candidates.some(c=>c.text===spec.payload),wrongPayload:candidates.some(c=>c.text!==spec.payload),elapsedMs:Math.round(performance.now()-start)});
        }
        canvas.width=canvas.height=0;return rows;
      },{matrix:[...qr.modules.data],size:qr.modules.size,variant,scale,blur,contrast,quiet,payload});
      rows.push(...result.map(row=>({sourceGroup:group,split,variant,...row})));
    }
  }
  const summary={};
  for(const split of ['development','holdout'])for(const kind of ['raw','nearest','smooth','contrast','threshold','unsharp','border']){
    const selected=rows.filter(row=>row.split===split&&row.kind===kind);
    summary[`${split}:${kind}`]={success:selected.filter(r=>r.success).length,total:selected.length,wrongPayload:selected.filter(r=>r.wrongPayload).length,ms:selected.reduce((sum,r)=>sum+r.elapsedMs,0)};
  }
  const report={notice:'Synthetic source-card split only; not evidence for customer-image holdout.',summary,rows};
  const outputIndex=process.argv.indexOf('--output');if(outputIndex!==-1)await writeFile(resolve(process.argv[outputIndex+1]),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(summary));
}finally{await browser.close();server.close();}
