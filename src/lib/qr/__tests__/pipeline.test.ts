import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { runPipeline } from '../pipeline';
import { scanZxing } from '../engines';
import { rasterizeRegion } from '../preprocess';

beforeAll(async()=>{
  const wasm=await readFile(new URL('../../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm',import.meta.url));
  vi.stubGlobal('fetch',async()=>new Response(wasm,{headers:{'Content-Type':'application/wasm'}}));
  vi.stubGlobal('ImageData',class {constructor(public data: Uint8ClampedArray,public width:number,public height:number){}});
});
const payloads=['001099999991||NGUYỄN THỬ MỘT|01011990|Nam|Địa chỉ giả A|01012024','001099999992||TRẦN THỬ HAI|02021992|Nữ|Địa chỉ giả B|02022024'];
function scene(width:number,height:number,codes:{text:string;x:number;y:number;scale:number;rotate?:boolean}[]): ImageData {
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  for(const code of codes){
    const qr=QRCode.create(code.text,{errorCorrectionLevel:'M'}),s=qr.modules.size;
    for(let y=0;y<s;y++)for(let x=0;x<s;x++)if(qr.modules.get(x,y))for(let dy=0;dy<code.scale;dy++)for(let dx=0;dx<code.scale;dx++){
      const px=code.x+(code.rotate?s-1-y:x)*code.scale+dx,py=code.y+(code.rotate?x:y)*code.scale+dy,i=(py*width+px)*4;
      data[i]=data[i+1]=data[i+2]=0;
    }
  }
  return new ImageData(data,width,height);
}
function mixedDifficultyScene(): ImageData {
  const width=600,height=300,scale=1.25;
  const [easy,small]=payloads.map(text=>QRCode.create(text,{errorCorrectionLevel:'M'}));
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  for(const [qr,left,top,s] of [[easy,20,20,5],[small,width-Math.ceil(small.modules.size*scale),height-Math.ceil(small.modules.size*scale),scale]] as const) {
    for(let y=0;y<qr.modules.size;y++)for(let x=0;x<qr.modules.size;x++)if(qr.modules.get(y,x)) {
      for(let py=Math.floor(top+y*s);py<Math.ceil(top+(y+1)*s);py++)for(let px=Math.floor(left+x*s);px<Math.ceil(left+(x+1)*s);px++) {
        const coverage=(Math.min(px+1,left+(x+1)*s)-Math.max(px,left+x*s))*(Math.min(py+1,top+(y+1)*s)-Math.max(py,top+y*s));
        const i=(py*width+px)*4;
        data[i]=data[i+1]=data[i+2]=data[i]*(1-coverage);
      }
    }
  }
  return new ImageData(data,width,height);
}
describe('real QR pipeline source geometry',()=>{
  it.each(['image','camera-deep'] as const)('preserves a second code rescued by bounded nearest after a raw hit in %s',async mode=>{
    const source=mixedDifficultyScene();
    expect((await scanZxing(source)).map(c=>c.text)).toEqual([payloads[0]]);
    const nearest=await scanZxing(rasterizeRegion(source,{x:0,y:0,width:600,height:300},2));
    expect(nearest.map(c=>c.text).sort()).toEqual(payloads);
    const result=await runPipeline(source,{mode,budgetMs:5000});
    expect(result.status).toBe('decoded');
    if(result.status==='decoded')expect(result.candidates.map(c=>c.text).sort()).toEqual(payloads);
  });
  it('reports timeout instead of a partial raw hit when the required nearest check exceeds budget',async()=>{
    let now=0;
    const ImageDataCtor=globalThis.ImageData;
    const clock=vi.spyOn(performance,'now').mockImplementation(()=>now);
    vi.stubGlobal('ImageData',class extends ImageDataCtor {
      constructor(data:Uint8ClampedArray,width:number,height:number){super(data,width,height);if(width===1200)now=100;}
    });
    try {
      const source=mixedDifficultyScene();
      expect((await scanZxing(source)).map(c=>c.text)).toEqual([payloads[0]]);
      expect(await runPipeline(source,{mode:'image',budgetMs:90})).toMatchObject({status:'timeout'});
    } finally {clock.mockRestore();vi.stubGlobal('ImageData',ImageDataCtor);}
  });
  it.each([
    ['4000x3000 corner',4000,3000,3750,2720,4,false],
    ['tile seam',4000,3000,1090,1080,5,false],
    ['larger than tile',2200,2200,130,130,35,false],
    ['tight crop rotated',250,250,10,10,4,true],
  ] as const)('decodes %s and maps corners to original pixels',async(_,width,height,x,y,scale,rotate)=>{
    const source=scene(width,height,[{text:payloads[0],x,y,scale,rotate}]);
    const result=await runPipeline(source,{mode:'camera-fast',budgetMs:10000});
    expect(result.status).toBe('decoded');
    if(result.status!=='decoded')return;
    expect(result.candidates.map(c=>c.text)).toEqual([payloads[0]]);
    const corners=result.candidates[0].corners!;
    expect(Math.min(...corners.map(p=>p.x))).toBeCloseTo(x,-1);
    expect(Math.min(...corners.map(p=>p.y))).toBeCloseTo(y,-1);
  });
  it('preserves ambiguity and deduplicates repeated copies',async()=>{
    const source=scene(1200,700,[{text:payloads[0],x:20,y:20,scale:5},{text:payloads[1],x:500,y:350,scale:5},{text:payloads[0],x:900,y:20,scale:4}]);
    const result=await runPipeline(source,{mode:'camera-fast',budgetMs:10000});
    expect(result.status).toBe('decoded');
    if(result.status==='decoded')expect(result.candidates.map(c=>c.text).sort()).toEqual(payloads);
  });
  it('does not report success after budget or cancellation',async()=>{
    const source=scene(100,100,[]);
    expect((await runPipeline(source,{mode:'image',budgetMs:0})).status).toBe('timeout');
    const controller=new AbortController();controller.abort();
    expect((await runPipeline(source,{mode:'image',budgetMs:1000,signal:controller.signal})).status).toBe('cancelled');
  });
});
