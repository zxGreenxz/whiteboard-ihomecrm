import type { OcrReview } from "./parser";
export type OcrProgress = "loading" | "reading";
export type OcrResult = (
  | OcrReview
  | { status: "image-invalid" | "engine-unavailable" | "timeout" | "cancelled" }
) & { elapsedMs: number };
export type OcrRequest = {
  type: "read";
  requestId: number;
  source: Blob | ImageData;
  budgetMs: number;
};
export type OcrResponse =
  | { type: "progress"; requestId: number; stage: OcrProgress }
  | { type: "result"; requestId: number; result: OcrResult };
export interface OcrScanner {
  read(
    source: Blob | ImageData,
    options?: {
      signal?: AbortSignal;
      onProgress?: (stage: OcrProgress) => void;
    },
  ): Promise<OcrResult>;
  dispose(): void;
}
