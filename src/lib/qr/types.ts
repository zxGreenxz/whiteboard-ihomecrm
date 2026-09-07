export type QrEngine = 'native' | 'zxing-wasm' | 'jsqr' | 'zxing-js' | 'wechat';
export type Roi = { x: number; y: number; width: number; height: number };
export type QrMode = 'image' | 'camera-fast' | 'camera-deep';
export type Point = { x: number; y: number };
export type Candidate = {
  text: string;
  engine: QrEngine;
  corners?: [Point, Point, Point, Point];
};
export type ScanResult =
  | { status: 'decoded'; candidates: Candidate[]; elapsedMs: number }
  | { status: 'not-found' | 'timeout' | 'cancelled'; elapsedMs: number }
  | { status: 'engine-unavailable' | 'image-invalid'; elapsedMs: number };
export type ScanOptions = { mode: QrMode; budgetMs: number; signal?: AbortSignal };
export interface QrScanner {
  scan(source: Blob | ImageBitmap, options: ScanOptions): Promise<ScanResult>;
  dispose(): void;
}

export type WorkerScanSource = Blob | ImageBitmap | ImageData | ArrayBuffer;
export type QrWorkerRequest =
  | { type: 'scan'; requestId: number; source: WorkerScanSource; mode: QrMode; budgetMs: number }
  | { type: 'cancel'; requestId: number };
export type QrWorkerResponse =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'initializing'; requestId: number; initializing: boolean }
  | { type: 'result'; requestId: number; result: ScanResult };
