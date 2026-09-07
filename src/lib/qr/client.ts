import type { QrScanner, QrWorkerRequest, QrWorkerResponse, ScanOptions, ScanResult, WorkerScanSource } from './types';

export interface QrWorkerLike {
  onmessage: ((event: MessageEvent<QrWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: QrWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

type ScannerDependencies = {
  workerFactory?: () => QrWorkerLike;
  now?: () => number;
  initTimeoutMs?: number;
  initRetryBackoffMs?: number;
  workerCanRasterize?: boolean;
  rasterizeOnMain?: (source: Blob | ImageBitmap, stopped: () => boolean) => Promise<ImageData>;
};

const MAX_DECODE_PIXELS = 24_000_000;
const defaultWorkerFactory = () => new Worker(new URL('./qr.worker.ts', import.meta.url), { type: 'module' });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function validateBitmap(bitmap: ImageBitmap) {
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_DECODE_PIXELS) {
    throw new Error('Image dimensions exceed the QR decoder limit');
  }
}

async function defaultMainRasterize(source: Blob | ImageBitmap, stopped: () => boolean): Promise<ImageData> {
  const borrowedBitmap = typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap;
  const bitmap = borrowedBitmap ? source as ImageBitmap : await createImageBitmap(source);
  try {
    if (stopped()) throw new Error('QR rasterization cancelled');
    validateBitmap(bitmap);
    if (stopped()) throw new Error('QR rasterization cancelled');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    if (!borrowedBitmap) bitmap.close();
  }
}

export function createQrScanner(dependencies: ScannerDependencies = {}): QrScanner {
  const workerFactory = dependencies.workerFactory ?? defaultWorkerFactory;
  const now = dependencies.now ?? (() => performance.now());
  const initTimeoutMs = dependencies.initTimeoutMs ?? 5000;
  const retryBackoffMs = dependencies.initRetryBackoffMs ?? 100;
  const workerCanRasterize = dependencies.workerCanRasterize ?? typeof OffscreenCanvas !== 'undefined';
  const rasterizeOnMain = dependencies.rasterizeOnMain ?? defaultMainRasterize;
  let worker: QrWorkerLike | null = null;
  let initialization: {
    worker: QrWorkerLike;
    promise: Promise<QrWorkerLike>;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let requestId = 0;
  let disposed = false;
  let active: { id: number; finish: (result: ScanResult) => void; initialization: (initializing: boolean) => void } | null = null;
  let initializingCancel: ((status: 'cancelled') => void) | null = null;
  let queue: Promise<void> = Promise.resolve();

  const resetWorker = (reason = new Error('QR worker stopped')) => {
    const currentWorker = worker;
    const currentInitialization = initialization;
    worker = null;
    initialization = null;
    if (currentInitialization) {
      clearTimeout(currentInitialization.timer);
      currentInitialization.reject(reason);
    }
    currentWorker?.terminate();
  };

  const startWorker = (): Promise<QrWorkerLike> => {
    if (initialization) return initialization.promise;
    let candidate: QrWorkerLike;
    try { candidate = workerFactory(); }
    catch (error) { return Promise.reject(error); }
    worker = candidate;
    let rejectInitialization!: (error: Error) => void;
    const promise = new Promise<QrWorkerLike>((resolve, reject) => {
      rejectInitialization = reject;
      candidate.onmessage = (event) => {
        if (event.data.type === 'ready') {
          if (initialization?.worker === candidate) clearTimeout(initialization.timer);
          resolve(candidate);
          return;
        }
        if (event.data.type === 'init-error') {
          reject(new Error(event.data.message));
          return;
        }
        if (event.data.type === 'result' && active && event.data.requestId === active.id) active.finish(event.data.result);
        if (event.data.type === 'initializing' && active && event.data.requestId === active.id) active.initialization(event.data.initializing);
      };
      candidate.onerror = () => {
        const pending = active;
        resetWorker(new Error('QR worker crashed'));
        pending?.finish({ status: 'engine-unavailable', elapsedMs: 0 });
      };
    });
    const timer = setTimeout(() => rejectInitialization(new Error('QR engine initialization timed out')), initTimeoutMs);
    initialization = { worker: candidate, promise, reject: rejectInitialization, timer };
    promise.catch(() => {
      if (worker === candidate) resetWorker(new Error('QR worker initialization failed'));
    });
    return promise;
  };

  const acquireWorker = async (stopped: () => boolean) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (disposed || stopped()) throw new Error('cancelled');
      try { return await startWorker(); }
      catch (error) {
        if (disposed || stopped() || attempt === 1) throw error;
        await wait(retryBackoffMs);
        if (disposed || stopped()) throw new Error('cancelled');
      }
    }
    throw new Error('unreachable');
  };

  const runScan = (ownedSource: Blob | ImageBitmap, options: ScanOptions): Promise<ScanResult> => new Promise((resolve) => {
    const started = now();
    let settled = false;
    let dispatched = false;
    let ownedClosed = false;
    let source: WorkerScanSource = ownedSource;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let remainingBudgetMs = Math.max(0, options.budgetMs);

    const closeBeforeDispatch = () => {
      if (!dispatched && !ownedClosed && typeof ImageBitmap !== 'undefined' && ownedSource instanceof ImageBitmap) {
        ownedClosed = true;
        ownedSource.close();
      }
    };
    const finish = (result: ScanResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      initializingCancel = null;
      active = null;
      resolve({ ...result, elapsedMs: now() - started });
    };
    const cancel = (status: 'cancelled' | 'timeout') => {
      if (settled) return;
      if (dispatched && active) {
        try { worker?.postMessage({ type: 'cancel', requestId: active.id }); } catch { /* terminate below */ }
      }
      resetWorker(new Error(status));
      closeBeforeDispatch();
      finish({ status, elapsedMs: now() - started });
    };
    const abort = () => cancel('cancelled');
    initializingCancel = () => cancel('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => cancel('timeout'), Math.max(0, options.budgetMs));

    void (async () => {
      if (disposed || options.signal?.aborted) { cancel('cancelled'); return; }
      if (ownedSource instanceof Blob && ownedSource.size > 20 * 1024 * 1024) {
        finish({ status: 'image-invalid', elapsedMs: now() - started });
        return;
      }
      try {
        if (!workerCanRasterize) {
          source = await rasterizeOnMain(ownedSource, () => settled || disposed || options.signal?.aborted === true);
          closeBeforeDispatch();
        }
        else if (typeof ImageBitmap !== 'undefined' && ownedSource instanceof ImageBitmap) validateBitmap(ownedSource);
      } catch {
        closeBeforeDispatch();
        finish({ status: 'image-invalid', elapsedMs: now() - started });
        return;
      }
      if (settled || disposed || options.signal?.aborted) { cancel('cancelled'); return; }
      if (deadline) clearTimeout(deadline);
      deadline = null;
      remainingBudgetMs = Math.max(0, options.budgetMs - (now() - started));
      if (remainingBudgetMs === 0) { cancel('timeout'); return; }
      let target: QrWorkerLike;
      try { target = await acquireWorker(() => settled); }
      catch {
        if (!settled) {
          closeBeforeDispatch();
          finish({ status: disposed || options.signal?.aborted ? 'cancelled' : 'engine-unavailable', elapsedMs: now() - started });
        }
        return;
      }
      if (settled || disposed || options.signal?.aborted) { cancel('cancelled'); return; }
      const id = ++requestId;
      let decodeResumedAt = now();
      let deepInitializing = false;
      let deepInitializationUsed = false;
      active = { id, finish, initialization(initializing) {
        if (settled || initializing === deepInitializing) return;
        if (initializing) {
          if (deepInitializationUsed) return;
          deepInitializationUsed = true;
          deepInitializing = true;
          remainingBudgetMs = Math.max(0, remainingBudgetMs - (now() - decodeResumedAt));
          if (deadline) clearTimeout(deadline);
          deadline = setTimeout(() => {
            resetWorker(new Error('QR model initialization timed out'));
            finish({ status: 'engine-unavailable', elapsedMs: now() - started });
          }, initTimeoutMs);
        } else {
          deepInitializing = false;
          if (deadline) clearTimeout(deadline);
          decodeResumedAt = now();
          deadline = setTimeout(() => cancel('timeout'), remainingBudgetMs);
        }
      } };
      deadline = setTimeout(() => cancel('timeout'), remainingBudgetMs);
      const transfer: Transferable[] = typeof ImageData !== 'undefined' && source instanceof ImageData
        ? [source.data.buffer]
        : typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap ? [source] : [];
      try {
        target.postMessage({ type: 'scan', requestId: id, source, mode: options.mode, budgetMs: remainingBudgetMs }, transfer);
        dispatched = true;
      } catch {
        closeBeforeDispatch();
        resetWorker(new Error('QR worker transfer failed'));
        finish({ status: 'engine-unavailable', elapsedMs: now() - started });
      }
    })();
  });

  return {
    scan(source, options) {
      let resolve!: (result: ScanResult) => void;
      const result = new Promise<ScanResult>((done) => { resolve = done; });
      queue = queue.then(() => runScan(source, options).then(resolve), () => runScan(source, options).then(resolve));
      return result;
    },
    dispose() {
      disposed = true;
      initializingCancel?.('cancelled');
      const pending = active;
      resetWorker(new Error('QR scanner disposed'));
      pending?.finish({ status: 'cancelled', elapsedMs: 0 });
    },
  };
}
