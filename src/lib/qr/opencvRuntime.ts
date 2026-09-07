import assets from './assets.json';
/** Narrow boundary for the two hash-pinned OpenCV builds; no upstream globals. */
export interface CvOwned { delete(): void }
export interface CvMat extends CvOwned { data: Uint8Array; data32F: Float32Array; rows: number; cols: number }
export interface CvVector<T> extends CvOwned { size(): number; get(index: number): T }
export interface WechatDetector extends CvOwned { detectAndDecode(mat: CvMat, points: CvVector<CvMat>): CvVector<string> }
export interface CvNet extends CvOwned { setInput(blob: CvMat, name: string): void; forward(name: string): CvMat }
export interface QrCv {
  Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
  MatVector: new () => CvVector<CvMat>;
  Size: new (width: number,height: number) => unknown;
  Scalar: new () => unknown;
  wechat_qrcode_WeChatQRCode: new (detectProto: string,detectModel: string,srProto: string,srModel: string) => WechatDetector;
  FS_createDataFile(parent: string,name: string,data: Uint8Array,read: boolean,write: boolean,own: boolean): void;
  matFromImageData(image: Pick<ImageData,'data'|'width'|'height'>): CvMat;
  cvtColor(source: CvMat,target: CvMat,code: number): void;
  resize(source: CvMat,target: CvMat,size: unknown,fx: number,fy: number,interpolation: number): void;
  blobFromImage(source: CvMat,scale: number,size: unknown,mean: unknown,swapRB: boolean,crop: boolean): CvMat;
  readNetFromCaffe(proto: string,model: string): CvNet;
  COLOR_RGBA2GRAY: number; CV_8UC1: number; INTER_CUBIC: number; INTER_LANCZOS4: number;
}
let runtime: Promise<{cv: QrCv}> | null = null;
let generation = 0;

/** OpenCV 4.12 resolves to itself. Always box it: awaiting the raw thenable
 * recursively assimilates it and prevents the worker becoming ready. */
export function initializeOpenCv(): Promise<{cv: QrCv}> {
  if (runtime) return runtime;
  const url = `${assets.directory}/opencv.mjs?attempt=${generation++}`;
  runtime = import(/* @vite-ignore */ url).then((module: {ready: Promise<{cv: QrCv}>}) => module.ready)
    .catch(error => { runtime=null; throw error; });
  return runtime;
}

export function cvScope() {
  const owned: CvOwned[]=[];
  return {
    own<T extends CvOwned>(object: T): T { owned.push(object); return object; },
    dispose() {
      let failure: unknown;
      for(const object of owned.reverse()) { try { object.delete(); } catch(error) { failure??=error; } }
      owned.length=0;
      if(failure) throw failure;
    },
  };
}
