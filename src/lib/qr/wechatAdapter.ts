import { distinctCandidates, mapCandidates } from './candidates';
import { cvScope, initializeOpenCv } from './opencvRuntime';
import type { CvMat, CvNet, QrCv, WechatDetector } from './opencvRuntime';
import { MAX_VARIANT_PIXELS, rasterizeRegion } from './preprocess';
import type { Candidate, Point, Roi } from './types';
import assets from './assets.json';

type ModelModule = { cv: Promise<QrCv>; detect_prototxt: Uint8Array; detect_caffemodel: Uint8Array; sr_prototxt: Uint8Array; sr_caffemodel: Uint8Array };
type WechatRuntime = { cv: QrCv; dnn: QrCv; detector: WechatDetector; net: CvNet };
let initialization: Promise<WechatRuntime> | null = null;
let generation=0;

export function initializeWeChat(): Promise<WechatRuntime> {
  if(initialization) return initialization;
  const url=`${assets.directory}/wechat.mjs?attempt=${generation++}`;
  initialization=(async()=>{
    const [module,{cv:dnn}]=await Promise.all([import(/* @vite-ignore */ url) as Promise<ModelModule>,initializeOpenCv()]);
    const cv=await module.cv;
    for(const [name,bytes] of Object.entries({ 'detect.prototxt':module.detect_prototxt, 'detect.caffemodel':module.detect_caffemodel,'sr.prototxt':module.sr_prototxt,'sr.caffemodel':module.sr_caffemodel })) {
      cv.FS_createDataFile('/',name,bytes,true,false,false);
    }
    // The DNN module is shared with other local vision consumers. Unique names
    // also allow a failed WeChat initialization to retry without FS collisions.
    const prefix=`wechat-${generation}-`;
    dnn.FS_createDataFile('/',prefix+'detect.prototxt',module.detect_prototxt,true,false,false);
    dnn.FS_createDataFile('/',prefix+'detect.caffemodel',module.detect_caffemodel,true,false,false);
    const detector=new cv.wechat_qrcode_WeChatQRCode('detect.prototxt','detect.caffemodel','sr.prototxt','sr.caffemodel');
    try {
      const net=dnn.readNetFromCaffe(prefix+'detect.prototxt',prefix+'detect.caffemodel');
      return {cv,dnn,detector,net};
    } catch(error) {detector.delete();throw error;}
  })().catch(error=>{initialization=null;throw error;});
  return initialization;
}

/** Point-vector get() creates owned embind Mat wrappers, including duplicates. */
export function decodeWechatMat(cv: QrCv, detector: WechatDetector, mat: CvMat): Candidate[] {
  const scope=cvScope();
  try {
    const points=scope.own(new cv.MatVector());
    const codes=scope.own(detector.detectAndDecode(mat,points));
    const found: Candidate[]=[];
    for(let i=0;i<codes.size();i++) {
      const text=codes.get(i);
      const point=i<points.size()?points.get(i):null;
      try {
        const data=point?.data32F;
        const corners=data&&data.length>=8?Array.from({length:4},(_,j)=>({x:data[j*2],y:data[j*2+1]})) as [Point,Point,Point,Point]:undefined;
        if(text) found.push({text,engine:'wechat',corners});
      } finally {point?.delete();}
    }
    return distinctCandidates(found);
  } finally {scope.dispose();}
}

type LearnedBox = Roi & {score:number};
/** Pixel-exact cvtColor, in row strips: one full 8-bit gray Mat plus <=1MiB
 * RGBA scratch. Resampling RGBA before gray changed detector coverage. */
export function grayForDetection(image: ImageData, cv: QrCv): CvMat {
  const gray=new cv.Mat(image.height,image.width,cv.CV_8UC1);
  try {
    const stripRows=Math.max(1,Math.floor(262144/image.width));
    for(let y=0;y<image.height;y+=stripRows) {
      const rows=Math.min(stripRows,image.height-y),scope=cvScope();
      try {
        const data=image.data.subarray(y*image.width*4,(y+rows)*image.width*4);
        const source=scope.own(cv.matFromImageData({data,width:image.width,height:rows}));
        const strip=scope.own(new cv.Mat());
        cv.cvtColor(source,strip,cv.COLOR_RGBA2GRAY);
        gray.data.set(strip.data,y*image.width);
      } finally {scope.dispose();}
    }
    return gray;
  } catch(error) {gray.delete();throw error;}
}

function detectBoxes(image: ImageData, runtime: WechatRuntime, stopped:()=>boolean): LearnedBox[] {
  const {dnn,net}=runtime;
  const found: LearnedBox[]=[];
  const gray=grayForDetection(image,dnn);
  try {for(const targetArea of [400,640]) {
    if(stopped()) break;
    const scope=cvScope();
    try {
      const ratio=Math.min(1,targetArea/Math.sqrt(image.width*image.height));
      const small=scope.own(new dnn.Mat());
      dnn.resize(gray,small,new dnn.Size(Math.max(1,Math.floor(image.width*ratio)),Math.max(1,Math.floor(image.height*ratio))),0,0,dnn.INTER_CUBIC);
      const blob=scope.own(dnn.blobFromImage(small,1/255,new dnn.Size(small.cols,small.rows),new dnn.Scalar(),false,false));
      net.setInput(blob,'data');
      const output=scope.own(net.forward('detection_output')), data=output.data32F;
      for(let i=0;i+6<data.length;i+=7) if(data[i+1]===1&&data[i+2]>.2) {
        const x=Math.max(0,Math.min(image.width,data[i+3]*image.width)),y=Math.max(0,Math.min(image.height,data[i+4]*image.height));
        const right=Math.max(x,Math.min(image.width,data[i+5]*image.width)),bottom=Math.max(y,Math.min(image.height,data[i+6]*image.height));
        if(right>x&&bottom>y)found.push({x,y,width:right-x,height:bottom-y,score:data[i+2]});
      }
    } finally {scope.dispose();}
    if(found.length) break;
  }} finally {gray.delete();}
  return found.sort((a,b)=>b.score-a.score).slice(0,3);
}

// Development spike ablation selected these six independent transforms. No
// image identity/payload dependent branch; no denoise or compounded filtering.
const transforms=[ [.15,1,'cubic'],[.15,1.5,'cubic'],[.15,2.5,'lanczos'],[.06,1,'cubic'],[.06,1.5,'lanczos'],[.25,3,'lanczos'] ] as const;

export async function scanWeChat(image: ImageData, stopped:()=>boolean=()=>false): Promise<Candidate[]> {
  const runtime=await initializeWeChat();
  const {cv,dnn,detector}=runtime;
  if(stopped()) return [];
  const full={x:0,y:0,width:image.width,height:image.height};
  const raster=rasterizeRegion(image,full);
  const mat=cv.matFromImageData(raster);
  let found: Candidate[];
  try { found=mapCandidates(decodeWechatMat(cv,detector,mat),full,raster.width,raster.height); }
  finally {mat.delete();}
  if(found.length||stopped())return found;
  for(const box of detectBoxes(image,runtime,stopped)) {
    const seen=new Set<string>();
    for(const [pad,scale,interpolation] of transforms) {
      if(stopped())return distinctCandidates(found);
      const x=Math.max(0,Math.floor(box.x-box.width*pad)),y=Math.max(0,Math.floor(box.y-box.height*pad));
      const right=Math.min(image.width,Math.floor(box.x+box.width*(1+pad))),bottom=Math.min(image.height,Math.floor(box.y+box.height*(1+pad)));
      const roi={x,y,width:right-x,height:bottom-y};
      const raster=rasterizeRegion(image,roi);
      const safeScale=Math.min(scale,Math.sqrt(MAX_VARIANT_PIXELS/(raster.width*raster.height)));
      const width=Math.max(1,Math.round(raster.width*safeScale)),height=Math.max(1,Math.round(raster.height*safeScale));
      const key=`${x}:${y}:${right}:${bottom}:${width}:${height}`;
      if(seen.has(key))continue;
      seen.add(key);
      const scope=cvScope();
      try {
        const input=scope.own(dnn.matFromImageData(raster)),resized=scope.own(new dnn.Mat());
        dnn.resize(input,resized,new dnn.Size(width,height),0,0,interpolation==='cubic'?dnn.INTER_CUBIC:dnn.INTER_LANCZOS4);
        const mat=scope.own(cv.matFromImageData({data:new Uint8ClampedArray(resized.data),width,height}));
        const candidates=mapCandidates(decodeWechatMat(cv,detector,mat),roi,width,height);
        found.push(...candidates);
        if(candidates.length)break; // Continue other boxes to preserve ambiguity.
      } finally {scope.dispose();}
    }
  }
  return distinctCandidates(found);
}
