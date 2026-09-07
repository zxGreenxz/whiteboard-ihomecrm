import { useCallback, useEffect, useRef, useState } from "react";
import { createOcrScanner } from "@/lib/ocr/client";
import type { OcrScanner, OcrProgress, OcrResult } from "@/lib/ocr/types";
import type { CCCDQrData } from "@/lib/cccdQrParser";
export function useCccdOcr(
  onParsed: (data: CCCDQrData, taskId: number) => void | Promise<void>,
) {
  const scanner = useRef<OcrScanner | null>(null),
    abort = useRef<AbortController | null>(null),
    generation = useRef(0),
    mounted = useRef(true);
  const pending = useRef<{ file: File; taskId: number } | null>(null),
    callback = useRef(onParsed);
  callback.current = onParsed;
  const [result, setResult] = useState<OcrResult | null>(null),
    [status, setStatus] = useState<
      "idle" | OcrProgress | "result" | "applied" | "applying"
    >("idle");
  const cancel = useCallback(() => {
    ++generation.current;
    abort.current?.abort();
    abort.current = null;
    scanner.current?.dispose();
    scanner.current = null;
    pending.current = null;
    setResult(null);
    setStatus("idle");
  }, []);
  const start = useCallback(
    async (file: File, taskId: number) => {
      cancel();
      const token = generation.current;
      pending.current = { file, taskId };
      const controller = new AbortController();
      abort.current = controller;
      setStatus("loading");
      scanner.current = createOcrScanner();
      const extracted = await scanner.current.read(file, {
        signal: controller.signal,
        onProgress: (stage) => {
          if (mounted.current && generation.current === token) setStatus(stage);
        },
      });
      if (
        !mounted.current ||
        generation.current !== token ||
        controller.signal.aborted
      )
        return;
      setResult(extracted);
      setStatus("result");
      scanner.current?.dispose();
      scanner.current = null;
    },
    [cancel],
  );
  const retry = useCallback(() => {
    const owned = pending.current;
    if (owned) void start(owned.file, owned.taskId);
  }, [start]);
  const apply = useCallback(async (data: CCCDQrData) => {
    const owned = pending.current,
      token = generation.current;
    if (!owned) return;
    setStatus("applying");
    try {
      await callback.current(data, owned.taskId);
      if (mounted.current && token === generation.current) {
        setStatus("applied");
        setResult(null);
        scanner.current?.dispose();
        scanner.current = null;
        pending.current = null;
      }
    } catch {
      if (mounted.current && token === generation.current) setStatus("result");
    }
  }, []);
  const invalidate = useCallback(() => {
    ++generation.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidate();
      abort.current?.abort();
      scanner.current?.dispose();
      pending.current = null;
    };
  }, [invalidate]);
  return { start, cancel, retry, apply, result, status };
}
