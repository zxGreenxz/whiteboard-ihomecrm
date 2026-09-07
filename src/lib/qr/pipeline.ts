import { buildRegions, distinctCandidates, mapCandidates } from './candidates';
import { QrImageError, scanNative, scanZxing, sourceToImageData } from './engines';
import { makeVariants, rasterizeRegion } from './preprocess';
import type { Candidate, ScanOptions, ScanResult, WorkerScanSource } from './types';

type PipelineOptions = ScanOptions & { onInitialization?: (initializing: boolean) => void };

/** Called in the owned worker. The client watchdog can terminate synchronous
 * WASM; these cooperative checks avoid starting another crop after its deadline. */
export async function runPipeline(source: WorkerScanSource, options: PipelineOptions): Promise<ScanResult> {
  const began=performance.now();
  let initializationMs=0;
  const elapsed=()=>performance.now()-began;
  const stopped=()=>options.signal?.aborted===true||elapsed()-initializationMs>=options.budgetMs;
  const finish=(candidates: Candidate[]): ScanResult => options.signal?.aborted
    ? {status:'cancelled',elapsedMs:elapsed()}
    : stopped()?{status:'timeout',elapsedMs:elapsed()}
    : candidates.length?{status:'decoded',candidates:distinctCandidates(candidates),elapsedMs:elapsed()}
    : {status:'not-found',elapsedMs:elapsed()};
  if(stopped())return finish([]);
  let available=false, strongUnavailable=false;
  let candidates: Candidate[]=[];
  try {
    if(typeof ImageBitmap!=='undefined'&&source instanceof ImageBitmap) {
      if(!source.width||!source.height||source.width*source.height>24_000_000)throw new QrImageError('Image dimensions exceed the QR decoder limit');
      try {
        const native=await scanNative(source);
        if(stopped()||(options.mode==='camera-fast'&&native.length))return finish(native);
        candidates.push(...native);
      } catch { /* Keep WASM fallback when native support is absent or broken. */ }
    }
    let image=await sourceToImageData(source);
    // ImageData callers bypass canvas; normalize their alpha using the same white
    // background once. Opaque camera/image rasters retain their original buffer.
    for(let i=3;i<image.data.length;i+=4)if(image.data[i]!==255){
      image=rasterizeRegion(image,{x:0,y:0,width:image.width,height:image.height},1,false,24_000_000);break;
    }
    if(stopped())return finish([]);
    try { candidates.push(...await scanZxing(image));available=true; } catch { /* Independent strong engine can still recover. */ }
    if(stopped()||options.mode==='camera-fast') {
      if(!available&&!stopped())return{status:'engine-unavailable',elapsedMs:elapsed()};
      return finish(candidates);
    }
    // Source-group ablation selected only nearest 2x (development 3/5→5/5,
    // synthetic holdout 8/10→10/10). This bounded ambiguity check also runs after
    // a raw/native hit: one easy QR must not hide a second recoverable code.
    // Never enlarge a full high-resolution card or start WeChat after these hits.
    for(const variant of makeVariants(image,['nearest'])) {
      if(stopped())return finish([]);
      try {
        const decoded=await scanZxing(variant);available=true;
        candidates.push(...mapCandidates(decoded,{x:0,y:0,width:image.width,height:image.height},variant.width,variant.height));
      } catch {
        if(candidates.length)return{status:'engine-unavailable',elapsedMs:elapsed()};
      }
    }
    if(candidates.length||stopped())return finish(candidates);
    const initializationBegan=performance.now();
    options.onInitialization?.(true);
    let strong: typeof import('./wechatAdapter') | null=null;
    try {
      strong=await import('./wechatAdapter');
      await strong.initializeWeChat();
    } catch {strongUnavailable=true;}
    finally {initializationMs+=performance.now()-initializationBegan;options.onInitialization?.(false);}
    if(stopped())return finish([]);
    if(strong&&!strongUnavailable) {
      try {candidates=await strong.scanWeChat(image,stopped);available=true;} catch {strongUnavailable=true;}
      if(candidates.length||stopped())return finish(candidates);
    }
    // Full image was tried before candidate detection. Tiles are cropped directly
    // from it, never from a globally resized thumbnail. One raster at a time.
    const tileCandidates: Candidate[]=[];
    for(const roi of buildRegions(image.width,image.height)) {
      if(roi.width===image.width&&roi.height===image.height)continue;
      if(stopped())return finish([]);
      const crop=rasterizeRegion(image,roi);
      for(const variant of makeVariants(crop,['raw','nearest'])) {
        if(stopped())return finish([]);
        try {candidates=await scanZxing(variant);available=true;} catch {continue;}
        tileCandidates.push(...mapCandidates(candidates,roi,variant.width,variant.height));
      }
    }
    if(tileCandidates.length)return finish(tileCandidates);
    if(strongUnavailable||!available)return{status:'engine-unavailable',elapsedMs:elapsed()};
    return finish([]);
  } catch(error) {
    return{status:error instanceof QrImageError||error instanceof DOMException?'image-invalid':'engine-unavailable',elapsedMs:elapsed()};
  }
}
