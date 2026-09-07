import { describe, expect, it, vi } from 'vitest';
import { createQrScanner, type QrWorkerLike } from '../client';
import type { QrWorkerRequest, QrWorkerResponse } from '../types';

const createTestScanner = (dependencies: Parameters<typeof createQrScanner>[0]) =>
  createQrScanner({ workerCanRasterize: true, ...dependencies });

class FakeWorker implements QrWorkerLike {
  onmessage: ((event: MessageEvent<QrWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: QrWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: QrWorkerRequest) { this.posted.push(message); }
  emit(message: QrWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<QrWorkerResponse>); }
  fail() { this.onerror?.({} as ErrorEvent); }
}

const blob = () => new Blob(['qr'], { type: 'image/png' });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('QR worker client lifecycle', () => {
  it('separates deep model initialization from the remaining decode deadline', async () => {
    vi.useFakeTimers();
    const worker=new FakeWorker();
    const scanner=createTestScanner({workerFactory:()=>worker,now:()=>Date.now(),initTimeoutMs:500});
    const pending=scanner.scan(blob(),{mode:'image',budgetMs:100});
    await vi.advanceTimersByTimeAsync(0);worker.emit({type:'ready'});await vi.advanceTimersByTimeAsync(30);
    const request=worker.posted.find(item=>item.type==='scan')!;
    worker.emit({type:'initializing',requestId:request.requestId,initializing:true});
    await vi.advanceTimersByTimeAsync(400);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit({type:'initializing',requestId:request.requestId,initializing:false});
    await vi.advanceTimersByTimeAsync(70);
    await expect(pending).resolves.toMatchObject({status:'timeout'});
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('terminates a stalled deep model initialization and ignores its late completion', async () => {
    vi.useFakeTimers();
    const worker=new FakeWorker();
    const scanner=createTestScanner({workerFactory:()=>worker,now:()=>Date.now(),initTimeoutMs:200});
    const pending=scanner.scan(blob(),{mode:'camera-deep',budgetMs:100});
    await vi.advanceTimersByTimeAsync(0);worker.emit({type:'ready'});await vi.advanceTimersByTimeAsync(0);
    const request=worker.posted.find(item=>item.type==='scan')!;
    worker.emit({type:'initializing',requestId:request.requestId,initializing:true});
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({status:'engine-unavailable'});
    worker.emit({type:'initializing',requestId:request.requestId,initializing:false});
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.posted.filter(item=>item.type==='scan')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('terminates a busy worker when the scan deadline expires', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const scanner = createTestScanner({ workerFactory: () => worker, now: () => 10 });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 25 });
    await vi.advanceTimersByTimeAsync(0);
    worker.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toMatchObject({ status: 'timeout' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('terminates on abort and recreates the worker for the next scan', async () => {
    const firstWorker = new FakeWorker();
    const replacement = new FakeWorker();
    const workers = [firstWorker, replacement];
    const scanner = createTestScanner({ workerFactory: () => workers.shift()! });
    const abort = new AbortController();
    const first = scanner.scan(blob(), { mode: 'image', budgetMs: 1000, signal: abort.signal });
    await flush();
    firstWorker.emit({ type: 'ready' });
    await flush();
    abort.abort();
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    const second = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await flush();
    replacement.emit({ type: 'ready' });
    await flush();
    const request = replacement.posted.find((item) => item.type === 'scan')!;
    replacement.emit({ type: 'result', requestId: request.requestId, result: { status: 'not-found', elapsedMs: 2 } });
    await expect(second).resolves.toMatchObject({ status: 'not-found' });
  });

  it('resets a rejected init promise and recovers with one finite retry', async () => {
    vi.useFakeTimers();
    const first = new FakeWorker();
    const second = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const scanner = createTestScanner({ workerFactory: factory, initRetryBackoffMs: 5 });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    first.emit({ type: 'init-error', message: 'chunk offline' });
    await vi.advanceTimersByTimeAsync(5);
    second.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    const request = second.posted.find((item) => item.type === 'scan')!;
    second.emit({ type: 'result', requestId: request.requestId, result: { status: 'not-found', elapsedMs: 1 } });
    await expect(pending).resolves.toMatchObject({ status: 'not-found' });
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('ignores stale results after a crash and resolves only the active request id', async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const scanner = createTestScanner({ workerFactory: factory });
    const crashed = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await flush();
    first.emit({ type: 'ready' });
    await flush();
    const oldRequest = first.posted.find((item) => item.type === 'scan')!;
    first.fail();
    await expect(crashed).resolves.toMatchObject({ status: 'engine-unavailable' });

    const active = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await flush();
    second.emit({ type: 'ready' });
    await flush();
    const current = second.posted.find((item) => item.type === 'scan')!;
    second.emit({ type: 'result', requestId: oldRequest.requestId, result: { status: 'decoded', candidates: [{ text: 'stale', engine: 'zxing-wasm' }], elapsedMs: 1 } });
    second.emit({ type: 'result', requestId: current.requestId, result: { status: 'decoded', candidates: [{ text: 'fresh', engine: 'zxing-wasm' }], elapsedMs: 2 } });
    await expect(active).resolves.toMatchObject({ status: 'decoded', candidates: [{ text: 'fresh' }] });
  });

  it('settles immediately and terminates when aborted during initialization', async () => {
    const worker = new FakeWorker();
    const abort = new AbortController();
    const scanner = createTestScanner({ workerFactory: () => worker });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 1000, signal: abort.signal });
    await flush();
    abort.abort();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('settles initialization and does not resurrect a worker when disposed', async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const scanner = createTestScanner({ workerFactory: factory });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await flush();
    scanner.dispose();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('does not create the retry worker when disposed during backoff', async () => {
    vi.useFakeTimers();
    const first = new FakeWorker();
    const factory = vi.fn(() => first);
    const scanner = createTestScanner({ workerFactory: factory, initRetryBackoffMs: 50 });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    first.emit({ type: 'init-error', message: 'asset 404' });
    await vi.advanceTimersByTimeAsync(1);
    scanner.dispose();
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(factory).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('closes an owned bitmap once when worker construction fails twice', async () => {
    const close = vi.fn();
    class SyntheticBitmap { width = 10; height = 10; close = close; }
    vi.stubGlobal('ImageBitmap', SyntheticBitmap);
    const scanner = createTestScanner({ workerFactory: () => { throw new Error('constructor failed'); }, initRetryBackoffMs: 0 });
    await expect(scanner.scan(new SyntheticBitmap() as ImageBitmap, { mode: 'image', budgetMs: 1000 }))
      .resolves.toMatchObject({ status: 'engine-unavailable' });
    expect(close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('closes an owned bitmap once when transfer throws', async () => {
    const close = vi.fn();
    class SyntheticBitmap { width = 10; height = 10; close = close; }
    vi.stubGlobal('ImageBitmap', SyntheticBitmap);
    const worker = new FakeWorker();
    worker.postMessage = () => { throw new Error('transfer failed'); };
    const scanner = createTestScanner({ workerFactory: () => worker });
    const pending = scanner.scan(new SyntheticBitmap() as ImageBitmap, { mode: 'image', budgetMs: 1000 });
    await flush();
    worker.emit({ type: 'ready' });
    await expect(pending).resolves.toMatchObject({ status: 'engine-unavailable' });
    expect(close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('transfers main-rasterized ImageData when worker raster APIs are unavailable', async () => {
    class SyntheticImageData {
      data = new Uint8ClampedArray(16);
      width = 2;
      height = 2;
    }
    vi.stubGlobal('ImageData', SyntheticImageData);
    const worker = new FakeWorker();
    const image = new SyntheticImageData() as ImageData;
    const scanner = createQrScanner({
      workerFactory: () => worker,
      workerCanRasterize: false,
      rasterizeOnMain: async () => image,
    });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await flush();
    worker.emit({ type: 'ready' });
    await flush();
    const request = worker.posted.find((item) => item.type === 'scan')!;
    expect(request.source).toBe(image);
    worker.emit({ type: 'result', requestId: request.requestId, result: { status: 'not-found', elapsedMs: 1 } });
    await expect(pending).resolves.toMatchObject({ status: 'not-found' });
    vi.unstubAllGlobals();
  });

  it('rejects a Blob over 20 MiB before bitmap decode, canvas allocation, or worker creation', async () => {
    const createBitmap = vi.fn();
    const createCanvas = vi.fn();
    const workerFactory = vi.fn();
    vi.stubGlobal('createImageBitmap', createBitmap);
    vi.stubGlobal('document', { createElement: createCanvas });
    const scanner = createQrScanner({ workerCanRasterize: false, workerFactory });
    const source = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' });
    await expect(scanner.scan(source, { mode: 'image', budgetMs: 1000 }))
      .resolves.toMatchObject({ status: 'image-invalid' });
    expect(createBitmap).not.toHaveBeenCalled();
    expect(createCanvas).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('counts main raster preparation inside the deadline and closes a late bitmap without allocating canvas', async () => {
    vi.useFakeTimers();
    let release!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    const createCanvas = vi.fn();
    const workerFactory = vi.fn();
    class SyntheticBitmap { width = 10; height = 10; close = close; }
    vi.stubGlobal('ImageBitmap', SyntheticBitmap);
    vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { release = resolve; }));
    vi.stubGlobal('document', { createElement: createCanvas });
    const scanner = createQrScanner({ workerCanRasterize: false, workerFactory });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 5 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toMatchObject({ status: 'timeout' });
    release(new SyntheticBitmap() as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(createCanvas).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborting a pending bitmap decode closes the late bitmap without canvas or worker work', async () => {
    let release!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    const createCanvas = vi.fn();
    const workerFactory = vi.fn();
    class SyntheticBitmap { width = 10; height = 10; close = close; }
    vi.stubGlobal('ImageBitmap', SyntheticBitmap);
    vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { release = resolve; }));
    vi.stubGlobal('document', { createElement: createCanvas });
    const abort = new AbortController();
    const scanner = createQrScanner({ workerCanRasterize: false, workerFactory });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 1000, signal: abort.signal });
    await flush();
    abort.abort();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    release(new SyntheticBitmap() as ImageBitmap);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(createCanvas).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('disposing during bitmap decode closes the late bitmap without canvas or worker work', async () => {
    let release!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    const createCanvas = vi.fn();
    const workerFactory = vi.fn();
    class SyntheticBitmap { width = 10; height = 10; close = close; }
    vi.stubGlobal('ImageBitmap', SyntheticBitmap);
    vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { release = resolve; }));
    vi.stubGlobal('document', { createElement: createCanvas });
    const scanner = createQrScanner({ workerCanRasterize: false, workerFactory });
    const pending = scanner.scan(blob(), { mode: 'image', budgetMs: 1000 });
    await flush();
    scanner.dispose();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    release(new SyntheticBitmap() as ImageBitmap);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(createCanvas).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('pauses the camera processing budget during a healthy slow cold initialization', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const scanner = createTestScanner({ workerFactory: () => worker, initTimeoutMs: 5000 });
    const pending = scanner.scan(blob(), { mode: 'camera-fast', budgetMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    worker.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(99);
    const request = worker.posted.find((item) => item.type === 'scan')!;
    expect(request).toBeDefined();
    worker.emit({ type: 'result', requestId: request.requestId, result: { status: 'not-found', elapsedMs: 99 } });
    await expect(pending).resolves.toMatchObject({ status: 'not-found' });
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('restores the full camera processing deadline after slow initialization', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const scanner = createTestScanner({ workerFactory: () => worker, initTimeoutMs: 5000 });
    const pending = scanner.scan(blob(), { mode: 'camera-fast', budgetMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    worker.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ status: 'timeout' });
    expect(worker.posted.some((item) => item.type === 'scan')).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('preserves only the preparation remainder across slow initialization', async () => {
    vi.useFakeTimers();
    class SyntheticImageData { data = new Uint8ClampedArray(16); width = 2; height = 2; }
    vi.stubGlobal('ImageData', SyntheticImageData);
    const worker = new FakeWorker();
    const scanner = createQrScanner({
      workerFactory: () => worker,
      workerCanRasterize: false,
      now: () => Date.now(),
      rasterizeOnMain: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new SyntheticImageData() as ImageData;
      },
    });
    const pending = scanner.scan(blob(), { mode: 'camera-fast', budgetMs: 100 });
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(150);
    worker.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(39);
    const request = worker.posted.find((item) => item.type === 'scan')!;
    worker.emit({ type: 'result', requestId: request.requestId, result: { status: 'not-found', elapsedMs: 39 } });
    await expect(pending).resolves.toMatchObject({ status: 'not-found' });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
