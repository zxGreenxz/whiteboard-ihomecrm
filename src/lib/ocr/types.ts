import type { OcrLine, OcrReview } from "./parser";
export type OcrProgress = "loading" | "reading";
export type OcrFailure = {
  status: "image-invalid" | "engine-unavailable" | "timeout" | "cancelled";
};
export type OcrResult = (OcrReview | OcrFailure) & { elapsedMs: number };
/** Mọi dòng chữ đọc được trên ảnh, chưa gán nghĩa — cho giấy tờ không phải CCCD
 * (hợp đồng ở nhờ) tự rút trường theo cách riêng. */
export type OcrTextLines = {
  status: "lines";
  lines: OcrLine[];
  size: { width: number; height: number };
};
export type OcrTextResult = (OcrTextLines | OcrFailure) & { elapsedMs: number };
/** `card` = đọc thẻ CCCD (mặc định); `lines` = trả dòng chữ thô. */
export type OcrMode = "card" | "lines";
export type OcrRequest = {
  type: "read";
  requestId: number;
  source: Blob | ImageData;
  budgetMs: number;
  mode?: OcrMode;
};
export type OcrResponse =
  | { type: "progress"; requestId: number; stage: OcrProgress }
  | { type: "result"; requestId: number; result: OcrResult | OcrTextResult };
export type OcrReadOptions = {
  signal?: AbortSignal;
  onProgress?: (stage: OcrProgress) => void;
};
export interface OcrScanner {
  read(source: Blob | ImageData, options?: OcrReadOptions): Promise<OcrResult>;
  /** Đọc mọi dòng chữ trên ảnh (giấy tờ bất kỳ), không gán nghĩa CCCD. */
  readText(
    source: Blob | ImageData,
    options?: OcrReadOptions,
  ): Promise<OcrTextResult>;
  dispose(): void;
}
