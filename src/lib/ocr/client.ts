import type {
  OcrMode,
  OcrReadOptions,
  OcrRequest,
  OcrResponse,
  OcrScanner,
  OcrResult,
  OcrTextResult,
} from "./types";
export interface OcrWorkerLike {
  onmessage: ((e: MessageEvent<OcrResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(m: OcrRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export function createOcrScanner(
  options: {
    workerFactory?: () => OcrWorkerLike;
    initTimeoutMs?: number;
    processingTimeoutMs?: number;
  } = {},
): OcrScanner {
  const makeWorker =
    options.workerFactory ??
    (() =>
      new Worker(new URL("./ocr.worker.ts", import.meta.url), {
        type: "module",
      }));
  let worker: OcrWorkerLike | null = null,
    serial = 0,
    disposed = false;
  let cancel: (() => void) | null = null;
  const terminate = () => {
    worker?.terminate();
    worker = null;
  };
  function run<T extends OcrResult | OcrTextResult>(
    source: Blob | ImageData,
    mode: OcrMode,
    { signal, onProgress }: OcrReadOptions = {},
  ): Promise<T> {
      cancel?.();
      if (disposed || signal?.aborted)
        return Promise.resolve({ status: "cancelled", elapsedMs: 0 } as T);
      if (source instanceof Blob && source.size > 20 * 1024 * 1024)
        return Promise.resolve({ status: "image-invalid", elapsedMs: 0 } as T);
      return new Promise<T>((resolve) => {
        const id = ++serial,
          started = performance.now();
        let settled = false,
          reading = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (
          result: OcrResult | OcrTextResult,
          hardStop = false,
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          cancel = null;
          if (hardStop) terminate();
          resolve({ ...result, elapsedMs: performance.now() - started } as T);
        };
        const abort = () => finish({ status: "cancelled", elapsedMs: 0 }, true);
        cancel = abort;
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () => finish({ status: "engine-unavailable", elapsedMs: 0 }, true),
          options.initTimeoutMs ?? 60_000,
        );
        try {
          worker ??= makeWorker();
          const owned = worker;
          owned.onmessage = ({ data }) => {
            if (settled || owned !== worker || data.requestId !== id) return;
            if (data.type === "result") {
              finish(
                data.result,
                data.result.status === "engine-unavailable" ||
                  data.result.status === "timeout",
              );
              return;
            }
            if (data.stage === "reading" && !reading) {
              reading = true;
              clearTimeout(timer);
              timer = setTimeout(
                () => finish({ status: "timeout", elapsedMs: 0 }, true),
                options.processingTimeoutMs ?? 30_000,
              );
            }
            onProgress?.(data.stage);
          };
          owned.onerror = () =>
            finish({ status: "engine-unavailable", elapsedMs: 0 }, true);
          owned.postMessage(
            {
              type: "read",
              requestId: id,
              source,
              budgetMs: options.processingTimeoutMs ?? 30_000,
              mode,
            },
            typeof ImageData !== "undefined" && source instanceof ImageData
              ? [source.data.buffer]
              : [],
          );
        } catch {
          finish({ status: "engine-unavailable", elapsedMs: 0 }, true);
        }
      });
  }
  return {
    read(source, options) {
      return run<OcrResult>(source, "card", options);
    },
    readText(source, options) {
      return run<OcrTextResult>(source, "lines", options);
    },
    dispose() {
      disposed = true;
      cancel?.();
      terminate();
    },
  };
}
