/// <reference lib="webworker" />
import { initializeOcr, readOcrCard } from "./runtime";
import { readImageDimensions } from './imageBounds';
import type { OcrRequest, OcrResponse } from "./types";
const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (m: OcrResponse) => scope.postMessage(m);
let busy = false;
scope.onmessage = async ({ data }: MessageEvent<OcrRequest>) => {
  if (data.type !== "read" || busy) return;
  busy = true;
  const { source, requestId } = data,
    started = performance.now();
  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | null = null,
    stage: "image" | "runtime" | "reading" = "image";
  try {
    if (source instanceof Blob && source.size > 20 * 1024 * 1024)
      throw Error("image");
    let image: ImageData;
    if (source instanceof Blob) {
      const dimensions=readImageDimensions(new Uint8Array(await source.slice(0,512*1024).arrayBuffer()));
      if(!dimensions)throw Error('image');
      bitmap = await createImageBitmap(source);
      if (
        !bitmap.width ||
        !bitmap.height ||
        bitmap.width * bitmap.height > 24_000_000
      )
        throw Error("image");
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw Error("image");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      bitmap.close();
      bitmap = null;
      canvas.width = canvas.height = 0;
    } else {
      image = source;
      if (
        !image.width ||
        !image.height ||
        image.width * image.height > 24_000_000 ||
        image.data.length !== image.width * image.height * 4
      )
        throw Error("image");
      for (let i = 0; i < image.data.length; i += 4) {
        const alpha = image.data[i + 3] / 255;
        for (let c = 0; c < 3; c++)
          image.data[i + c] = image.data[i + c] * alpha + 255 * (1 - alpha);
        image.data[i + 3] = 255;
      }
    }
    stage = "runtime";
    send({ type: "progress", requestId, stage: "loading" });
    const runtime = await initializeOcr();
    stage = "reading";
    send({ type: "progress", requestId, stage: "reading" });
    const result = await readOcrCard(
      image,
      runtime,
      performance.now() + Math.min(60_000, Math.max(1, data.budgetMs)),
    );
    send({
      type: "result",
      requestId,
      result: { ...result, elapsedMs: performance.now() - started },
    });
  } catch (error) {
    send({
      type: "result",
      requestId,
      result: {
        status:
          stage === "image"
            ? "image-invalid"
            : error instanceof Error && error.message === "OCR timeout"
              ? "timeout"
              : "engine-unavailable",
        elapsedMs: performance.now() - started,
      },
    });
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 0;
    busy = false;
  }
};
