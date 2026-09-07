import type * as Ort from "onnxruntime-web";
import type * as Cv from "@techstark/opencv-js";
import Clipper from "clipper-lib";
import { initializeOpenCv } from "../qr/opencvRuntime";
import {
  parseOcrFields,
  selectOcrFields,
  type OcrLine,
  type OcrReview,
} from "./parser";
import assets from "./assets.json";

type Runtime = {
  ort: typeof Ort;
  cv: typeof Cv;
  det: Ort.InferenceSession;
  rec: Ort.InferenceSession;
  encoder: Ort.InferenceSession;
  decoder: Ort.InferenceSession;
  latin: string[];
  vocab: string[];
};
type Quad = [number, number][];
let initialization: Promise<Runtime> | null = null;
let attempt = 0;
let ortModule: Promise<typeof Ort> | null = null;
function loadOrt(): Promise<typeof Ort> {
  ortModule ??= import(
    /* @vite-ignore */ `${assets.directory}/ort.wasm.min.mjs?attempt=${attempt++}`
  ).catch((error: unknown) => {
    ortModule = null;
    throw error;
  });
  return ortModule;
}
async function assetBytes(
  name: keyof typeof assets.files,
): Promise<ArrayBuffer> {
  const expected = assets.files[name];
  // A host may attach immutable headers even to a 404. One bounded reload
  // repairs negative/corrupt cache entries while successful assets stay cached.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${assets.directory}/${name}`, {
        cache: attempt ? "reload" : "default",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("OCR asset unavailable");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) !== expected.bytes) {
        await response.body?.cancel();
        throw Error("OCR asset size mismatch");
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error("OCR asset stream unavailable");
      const bytes = new Uint8Array(expected.bytes);
      let offset = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.length > bytes.length) {
            await reader.cancel();
            throw Error("OCR asset size mismatch");
          }
          bytes.set(value, offset);
          offset += value.length;
        }
      } finally {
        reader.releaseLock();
      }
      if (offset !== bytes.length) throw Error("OCR asset size mismatch");
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== expected.sha256) throw Error("OCR asset digest mismatch");
      return bytes.buffer;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw Error("OCR asset unavailable");
}
export function initializeOcr(): Promise<Runtime> {
  if (initialization) return initialization;
  initialization = (async () => {
    const ort = await loadOrt();
    ort.env.wasm.wasmPaths = `${location.origin}${assets.directory}/`;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = "fatal";
    const sessions: Ort.InferenceSession[] = [];
    try {
      const { cv } = await initializeOpenCv();
      const session = async (name: keyof typeof assets.files) => {
        const value = await ort.InferenceSession.create(
          await assetBytes(name),
          { executionProviders: ["wasm"], logSeverityLevel: 4 },
        );
        sessions.push(value);
        return value;
      };
      // Serial model allocation avoids four concurrent fetch/session peaks.
      const det = await session("ch_PP-OCRv5_det_mobile.onnx"),
        rec = await session("latin_PP-OCRv5_rec_mobile.onnx");
      const encoder = await session("encoder_qdq.onnx"),
        decoder = await session("decoder_int8.onnx");
      const latin: unknown = JSON.parse(
          new TextDecoder().decode(await assetBytes("latin-dict.json")),
        ),
        vocabulary: unknown = JSON.parse(
          new TextDecoder().decode(await assetBytes("vocab.json")),
        );
      if (
        !Array.isArray(latin) ||
        latin.length !== 504 ||
        !latin.every((x) => typeof x === "string") ||
        typeof vocabulary !== "string" ||
        [...vocabulary].length !== 229
      )
        throw Error("OCR vocabulary mismatch");
      return {
        ort,
        cv: cv as unknown as typeof Cv,
        det,
        rec,
        encoder,
        decoder,
        latin,
        vocab: ["pad", "sos", "eos", "unk", ...vocabulary],
      };
    } catch (error) {
      for (const session of sessions) await session.release();
      throw error;
    }
  })().catch((error) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

/** Bounded DB detector + CTC labels/numbers + Vietnamese name/residence reader.
 * Intermediate pixels, strings and tensors stay within this dedicated worker. */
export async function readOcrCard(
  image: ImageData,
  runtime: Runtime,
  deadline: number,
): Promise<OcrReview> {
  const { cv, ort, det, rec, encoder, decoder, latin, vocab } = runtime;
  const owned = new Set<{ delete(): void }>();
  const own = <T extends { delete(): void }>(v: T): T => {
    owned.add(v);
    return v;
  };
  const disposeAll = () => {
    let failure: unknown;
    for (const m of [...owned].reverse())
      try {
        m.delete();
      } catch (error) {
        failure ??= error;
      }
    owned.clear();
    if (failure) throw failure;
  };
  const drop = (v: { delete(): void }) => {
    owned.delete(v);
    v.delete();
  };
  const check = () => {
    if (performance.now() > deadline) throw Error("OCR timeout");
  };
  const release = (output: Ort.InferenceSession.OnnxValueMapType) => {
    for (const value of Object.values(output)) value.dispose();
  };
  async function infer(
    session: Ort.InferenceSession,
    input: Ort.Tensor,
  ): Promise<Ort.InferenceSession.OnnxValueMapType> {
    try {
      check();
      const result = await session.run({ [session.inputNames[0]]: input });
      try {
        check();
      } catch (error) {
        release(result);
        throw error;
      }
      return result;
    } finally {
      input.dispose();
    }
  }
  const distance = (a: number[], b: number[]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);
  const order = (points: Quad): Quad => {
    const sorted = [...points].sort((a, b) => a[0] - b[0]),
      l = sorted.slice(0, 2).sort((a, b) => a[1] - b[1]),
      r = sorted.slice(2).sort((a, b) => a[1] - b[1]);
    return [l[0], r[0], r[1], l[1]];
  };
  const points = (rect: Cv.RotatedRect): Quad =>
    cv.RotatedRect.points(rect).map((p) => [p.x, p.y]);
  function planar(mat: Cv.Mat, unit = false): Float32Array {
    if (mat.rows * mat.cols > 4_100_000) throw Error("OCR tensor bounds");
    const size = mat.rows * mat.cols,
      data = new Float32Array(3 * size);
    for (let i = 0; i < size; i++)
      for (let c = 0; c < 3; c++)
        data[c * size + i] = unit
          ? mat.data[i * 3 + c] / 255
          : (mat.data[i * 3 + c] / 255 - 0.5) / 0.5;
    return data;
  }
  async function detect(source: Cv.Mat): Promise<Quad[]> {
    check();
    const mx = Math.max(source.cols, source.rows),
      limit = mx < 960 ? 960 : mx < 1500 ? 1500 : 2000,
      ratio = Math.min(1, limit / mx);
    const w = Math.max(
        32,
        Math.round(Math.floor(source.cols * ratio) / 32) * 32,
      ),
      h = Math.max(32, Math.round(Math.floor(source.rows * ratio) / 32) * 32);
    const resized = own(new cv.Mat());
    cv.resize(source, resized, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
    const input = new ort.Tensor("float32", planar(resized), [1, 3, h, w]);
    drop(resized);
    const output = await infer(det, input);
    let scores: Cv.Mat, mask: Cv.Mat, ph: number, pw: number;
    try {
      const pred = Object.values(output)[0];
      ph = pred.dims[2];
      pw = pred.dims[3];
      if (
        !ph ||
        !pw ||
        ph * pw > 4_100_000 ||
        !(pred.data instanceof Float32Array)
      )
        throw Error("OCR detector shape");
      scores = own(cv.matFromArray(ph, pw, cv.CV_32FC1, Array.from(pred.data)));
      mask = own(new cv.Mat(ph, pw, cv.CV_8UC1));
      for (let i = 0; i < pw * ph; i++)
        mask.data[i] = pred.data[i] > 0.3 ? 255 : 0;
    } finally {
      release(output);
    }
    const kernel = own(cv.Mat.ones(2, 2, cv.CV_8U));
    cv.dilate(mask, mask, kernel);
    drop(kernel);
    const contours = own(new cv.MatVector()),
      hierarchy = own(new cv.Mat());
    cv.findContours(
      mask,
      contours,
      hierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );
    if (contours.size() > 1000) throw Error("OCR line limit");
    const boxes: Quad[] = [];
    for (let i = 0; i < Math.min(1000, contours.size()); i++) {
      check();
      const contour = own(contours.get(i)),
        rect = cv.minAreaRect(contour);
      drop(contour);
      if (Math.min(rect.size.width, rect.size.height) < 3) continue;
      const box = order(points(rect)),
        poly = own(
          cv.matFromArray(4, 1, cv.CV_32SC2, box.flat().map(Math.trunc)),
        ),
        polys = own(new cv.MatVector());
      polys.push_back(poly);
      const region = own(cv.Mat.zeros(ph, pw, cv.CV_8UC1));
      cv.fillPoly(region, polys, new cv.Scalar(255));
      const score = cv.mean(scores, region)[0];
      drop(region);
      drop(polys);
      drop(poly);
      if (score < 0.5) continue;
      const path = box.map((p) => ({ X: p[0], Y: p[1] })),
        area = Math.abs(Clipper.Clipper.Area(path)),
        perimeter = box.reduce(
          (s, p, j) => s + distance(p, box[(j + 1) % 4]),
          0,
        );
      if (!perimeter) continue;
      const offset = new Clipper.ClipperOffset();
      offset.AddPath(
        path,
        Clipper.JoinType.jtRound,
        Clipper.EndType.etClosedPolygon,
      );
      const expanded: { X: number; Y: number }[][] = [];
      offset.Execute(expanded, (area * 1.6) / perimeter);
      if (expanded.length !== 1 || expanded[0].length > 128) continue;
      const ep = own(
          cv.matFromArray(
            expanded[0].length,
            1,
            cv.CV_32FC2,
            expanded[0].flatMap((p) => [p.X, p.Y]),
          ),
        ),
        er = cv.minAreaRect(ep);
      drop(ep);
      if (Math.min(er.size.width, er.size.height) < 5) continue;
      const mapped: Quad = order(points(er)).map((p) => [
        Math.max(
          0,
          Math.min(source.cols - 1, Math.round((p[0] / pw) * source.cols)),
        ),
        Math.max(
          0,
          Math.min(source.rows - 1, Math.round((p[1] / ph) * source.rows)),
        ),
      ]);
      if (
        distance(mapped[0], mapped[1]) > 3 &&
        distance(mapped[0], mapped[3]) > 3
      )
        boxes.push(mapped);
      if (boxes.length > 128) throw Error("OCR line limit");
    }
    for (const m of [scores, mask, contours, hierarchy]) drop(m);
    return boxes;
  }
  function crop(source: Cv.Mat, box: Quad): Cv.Mat {
    check();
    const w = Math.max(
        1,
        Math.trunc(
          Math.max(distance(box[0], box[1]), distance(box[2], box[3])),
        ),
      ),
      h = Math.max(
        1,
        Math.trunc(
          Math.max(distance(box[0], box[3]), distance(box[1], box[2])),
        ),
      );
    if (w * h > 4_000_000 || Math.max(w, h) > 12000)
      throw Error("OCR crop bounds");
    const src = own(cv.matFromArray(4, 1, cv.CV_32FC2, box.flat())),
      dst = own(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h])),
      transform = own(cv.getPerspectiveTransform(src, dst)),
      out = own(new cv.Mat());
    cv.warpPerspective(
      source,
      out,
      transform,
      new cv.Size(w, h),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    );
    for (const m of [src, dst, transform]) drop(m);
    if (h / w >= 1.5) cv.rotate(out, out, cv.ROTATE_90_COUNTERCLOCKWISE);
    return out;
  }
  async function latinLine(
    line: Cv.Mat,
  ): Promise<{ text: string; confidence: number; truncated: boolean }> {
    const h = 48,
      needed = Math.ceil((h * line.cols) / line.rows),
      w = Math.max(320, Math.min(2048, needed)),
      rw = Math.min(w, needed),
      resized = own(new cv.Mat());
    cv.resize(line, resized, new cv.Size(rw, h), 0, 0, cv.INTER_LINEAR);
    const small = planar(resized),
      data = new Float32Array(3 * w * h);
    drop(resized);
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < h; y++)
        data.set(
          small.subarray(c * rw * h + y * rw, c * rw * h + (y + 1) * rw),
          c * w * h + y * w,
        );
    const output = await infer(
      rec,
      new ort.Tensor("float32", data, [1, 3, h, w]),
    );
    try {
      const pred = Object.values(output)[0],
        n = pred.dims[1],
        chars = pred.dims[2];
      if (chars !== 504 || n > 2048 || !(pred.data instanceof Float32Array))
        throw Error("OCR recognizer shape");
      let text = "",
        sum = 0,
        count = 0,
        prev = -1;
      for (let i = 0; i < n; i++) {
        let best = 0;
        for (let c = 1; c < chars; c++)
          if (pred.data[i * chars + c] > pred.data[i * chars + best]) best = c;
        if (best && best !== prev) {
          text += latin[best] ?? "";
          sum += pred.data[i * chars + best];
          count++;
        }
        prev = best;
      }
      return {
        text,
        confidence: count ? sum / count : 0,
        truncated: needed > 2048,
      };
    } finally {
      release(output);
    }
  }
  async function vietLine(
    line: Cv.Mat,
  ): Promise<{ text: string; truncated: boolean }> {
    const scaled = own(new cv.Mat()),
      rgb = own(new cv.Mat());
    const width64 = Math.round(line.cols * Math.max(1, 64 / line.rows)),
      height64 = Math.max(64, line.rows);
    if (width64 * height64 > 4_000_000) throw Error("OCR line bounds");
    cv.resize(
      line,
      scaled,
      new cv.Size(width64, height64),
      0,
      0,
      cv.INTER_CUBIC,
    );
    cv.cvtColor(scaled, rgb, cv.COLOR_BGR2RGB);
    drop(scaled);
    const width = Math.max(
        32,
        Math.min(
          512,
          Math.ceil(Math.floor((32 * rgb.cols) / rgb.rows) / 10) * 10,
        ),
      ),
      normalized = own(new cv.Mat());
    cv.resize(rgb, normalized, new cv.Size(width, 32), 0, 0, cv.INTER_LANCZOS4);
    drop(rgb);
    const input = new ort.Tensor("float32", planar(normalized, true), [
      1,
      3,
      32,
      width,
    ]);
    drop(normalized);
    const encoded = await infer(encoder, input);
    const tokens = [1];
    let text = "",
      ended = false;
    try {
      if (
        !encoded.memory ||
        encoded.memory.dims.reduce((a, b) => a * b, 1) > 1_000_000
      )
        throw Error("OCR encoder shape");
      for (let i = 0; i < 96; i++) {
        check();
        const tt = new ort.Tensor(
          "int64",
          BigInt64Array.from(tokens.map(BigInt)),
          [tokens.length, 1],
        );
        let output: Ort.InferenceSession.OnnxValueMapType;
        try {
          output = await decoder.run({
            [decoder.inputNames[0]]: tt,
            memory: encoded.memory,
          });
        } finally {
          tt.dispose();
        }
        let best = 0;
        try {
          check();
          const prediction = Object.values(output)[0],
            data = prediction.data;
          if (prediction.dims[prediction.dims.length - 1] !== 233 || !(data instanceof Float32Array))
            throw Error("OCR decoder shape");
          const offset = data.length - 233;
          for (let j = 1; j < 233; j++)
            if (data[offset + j] > data[offset + best]) best = j;
        } finally {
          release(output);
        }
        tokens.push(best);
        if (best === 2) {
          ended = true;
          break;
        }
        if (best > 3) text += vocab[best];
      }
      return { text, truncated: !ended };
    } finally {
      release(encoded);
    }
  }
  async function readLines(source: Cv.Mat, boxes: Quad[]): Promise<OcrLine[]> {
    const rows: OcrLine[] = [];
    for (const box of boxes) {
      const part = crop(source, box);
      let out: Omit<OcrLine, "box"> = await latinLine(part);
      if (out.confidence < 0.88) {
        cv.rotate(part, part, cv.ROTATE_180);
        const reverse = await latinLine(part);
        if (reverse.confidence > out.confidence)
          out = { ...reverse, reverse: true };
      }
      drop(part);
      rows.push({ ...out, box });
    }
    return rows;
  }
  try {
    check();
    if (
      !image.width ||
      !image.height ||
      image.width * image.height > 24_000_000
    )
      throw Error("OCR image bounds");
    const rgba = own(cv.matFromImageData(image)),
      source = own(new cv.Mat());
    cv.cvtColor(rgba, source, cv.COLOR_RGBA2BGR);
    drop(rgba);
    let boxes = await detect(source);
    const vertical = boxes.filter(
      (box) =>
        Math.max(...box.map((p) => p[1])) - Math.min(...box.map((p) => p[1])) >
        1.5 *
          (Math.max(...box.map((p) => p[0])) -
            Math.min(...box.map((p) => p[0]))),
    );
    if (vertical.length > boxes.length * 0.6) {
      cv.rotate(source, source, cv.ROTATE_90_COUNTERCLOCKWISE);
      boxes = await detect(source);
    }
    boxes.sort(
      (a, b) =>
        Math.min(...a.map((p) => p[1])) - Math.min(...b.map((p) => p[1])),
    );
    let rows = await readLines(source, boxes.slice(0, 3));
    // Per-line 180° recognition gives geometric evidence for rotating the whole
    // card before field anchoring, including either 90° input orientation.
    if (rows.filter((r) => r.reverse).length > rows.length * 0.5) {
      cv.rotate(source, source, cv.ROTATE_180);
      rows = await readLines(source, await detect(source));
    } else rows.push(...(await readLines(source, boxes.slice(3))));
    const size = { width: source.cols, height: source.rows },
      selection = selectOcrFields(rows, size);
    if (selection.status === "ambiguous") return parseOcrFields(rows, size);
    const selected = new Set([
      ...(selection.selected.name.length > 1
        ? selection.selected.name.slice(1)
        : selection.selected.name),
      ...selection.selected.address,
    ]);
    for (const index of selected) {
      check();
      const r = rows[index],
        part = crop(source, r.box);
      if (r.reverse) cv.rotate(part, part, cv.ROTATE_180);
      const viet = await vietLine(part);
      drop(part);
      rows[index] = {
        ...r,
        anchorText: r.text,
        text: viet.text,
        truncated: r.truncated || viet.truncated,
      };
    }
    return parseOcrFields(rows, size);
  } finally {
    disposeAll();
  }
}
