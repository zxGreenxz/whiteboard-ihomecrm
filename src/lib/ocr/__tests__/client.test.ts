import { describe, it, expect, vi } from "vitest";
import { createOcrScanner, type OcrWorkerLike } from "../client";
import type { OcrRequest, OcrResponse } from "../types";
class WorkerFake implements OcrWorkerLike {
  onmessage: ((e: MessageEvent<OcrResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  messages: OcrRequest[] = [];
  terminated = false;
  postMessage(m: OcrRequest) {
    this.messages.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: OcrResponse) {
    this.onmessage?.({ data } as MessageEvent<OcrResponse>);
  }
}
describe("owned OCR client", () => {
  it("replacement cancels heavy work and ignores late result/progress", async () => {
    const workers: WorkerFake[] = [];
    const scanner = createOcrScanner({
      workerFactory: () => {
        const w = new WorkerFake();
        workers.push(w);
        return w;
      },
    });
    const progress = vi.fn(),
      first = scanner.read(new Blob(["one"]), { onProgress: progress });
    const old = workers[0];
    const second = scanner.read(new Blob(["two"]));
    expect((await first).status).toBe("cancelled");
    expect(old.terminated).toBe(true);
    old.reply({ type: "progress", requestId: 1, stage: "reading" });
    expect(progress).not.toHaveBeenCalled();
    workers[1].reply({
      type: "result",
      requestId: 2,
      result: { status: "image-invalid", elapsedMs: 1 },
    });
    expect((await second).status).toBe("image-invalid");
    scanner.dispose();
  });
  it("bounds initialization separately then hard terminates processing timeout", async () => {
    vi.useFakeTimers();
    const w = new WorkerFake();
    const scanner = createOcrScanner({
      workerFactory: () => w,
      initTimeoutMs: 100,
      processingTimeoutMs: 20,
    });
    const result = scanner.read(new Blob(["one"]));
    await vi.advanceTimersByTimeAsync(80);
    expect(w.terminated).toBe(false);
    w.reply({ type: "progress", requestId: 1, stage: "reading" });
    await vi.advanceTimersByTimeAsync(21);
    expect((await result).status).toBe("timeout");
    expect(w.terminated).toBe(true);
    vi.useRealTimers();
  });
  it("aborts downloads and can retry a failed worker without rejected promise cache", async () => {
    const workers: WorkerFake[] = [];
    const scanner = createOcrScanner({
      workerFactory: () => {
        const w = new WorkerFake();
        workers.push(w);
        return w;
      },
    });
    const first = scanner.read(new Blob(["one"]));
    workers[0].onerror?.();
    expect((await first).status).toBe("engine-unavailable");
    const controller = new AbortController(),
      second = scanner.read(new Blob(["two"]), { signal: controller.signal });
    controller.abort();
    expect((await second).status).toBe("cancelled");
    expect(workers[1].terminated).toBe(true);
  });
});
