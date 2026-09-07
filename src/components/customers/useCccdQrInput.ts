import { useCallback, useEffect, useRef, useState } from 'react';
import { selectCccdCandidate, type CCCDQrData } from '@/lib/cccdQrParser';
import { createQrScanner } from '@/lib/qr/client';
import type { QrScanner, ScanResult } from '@/lib/qr/types';

export type CccdQrInputStatus =
  | 'idle'
  | 'decoding'
  | 'success'
  | 'image-invalid'
  | 'engine-unavailable'
  | 'not-found'
  | 'not-cccd'
  | 'ambiguous';

type Options = {
  onParsed: (data: CCCDQrData, taskId: number) => void | Promise<void>;
  onTaskStart?: (taskId: number) => void;
  createScanner?: () => QrScanner;
  budgetMs?: number;
};

type Diagnostics = {
  code: ScanResult['status'] | 'not-cccd' | 'ambiguous';
  elapsedMs?: number;
};

function isTextEntry(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.matches('input, textarea, [contenteditable="true"]');
}

function clipboardImage(event: ClipboardEvent): File | null {
  const clipboard = event.clipboardData;
  if (!clipboard) return null;
  for (const file of Array.from(clipboard.files)) {
    if (file.type.startsWith('image/')) return file;
  }
  for (const item of Array.from(clipboard.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

export function useCccdQrInput({
  onParsed,
  onTaskStart,
  createScanner: makeScanner = createQrScanner,
  budgetMs = 3000,
}: Options) {
  const scannerRef = useRef<QrScanner | null>(null);
  const makeScannerRef = useRef(makeScanner);
  makeScannerRef.current = makeScanner;

  const zoneRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);
  const mountedRef = useRef(true);
  const taskIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const previewRef = useRef<string | null>(null);
  const onParsedRef = useRef(onParsed);
  const onTaskStartRef = useRef(onTaskStart);
  onParsedRef.current = onParsed;
  onTaskStartRef.current = onTaskStart;

  const [status, setStatus] = useState<CccdQrInputStatus>('idle');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  const revokePreview = useCallback(() => {
    if (!previewRef.current) return;
    URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
  }, []);

  const getScanner = useCallback(() => {
    if (!scannerRef.current) scannerRef.current = makeScannerRef.current();
    return scannerRef.current;
  }, []);

  const disposeScanner = useCallback(() => {
    scannerRef.current?.dispose();
    scannerRef.current = null;
  }, []);

  const beginGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const taskId = ++taskIdRef.current;
    onTaskStartRef.current?.(taskId);
    return taskId;
  }, []);

  const reset = useCallback(() => {
    const taskId = beginGeneration();
    revokePreview();
    setPreviewUrl(null);
    setOriginalFile(null);
    setDiagnostics(null);
    setStatus('idle');
    return taskId;
  }, [beginGeneration, revokePreview]);

  const acceptFile = useCallback((file: File): Promise<void> => {
    const taskId = beginGeneration();
    revokePreview();
    setPreviewUrl(null);
    setDiagnostics(null);

    if (!file.type.startsWith('image/')) {
      setOriginalFile(null);
      setStatus('image-invalid');
      return Promise.resolve();
    }

    const preview = URL.createObjectURL(file);
    previewRef.current = preview;
    setPreviewUrl(preview);
    setOriginalFile(file);
    setStatus('decoding');

    const controller = new AbortController();
    abortRef.current = controller;
    let scanPromise: Promise<ScanResult>;
    try {
      scanPromise = getScanner().scan(file, {
        mode: 'image',
        budgetMs,
        signal: controller.signal,
      });
    } catch {
      abortRef.current = null;
      disposeScanner();
      setDiagnostics({ code: 'engine-unavailable' });
      setStatus('engine-unavailable');
      return Promise.resolve();
    }
    return scanPromise
      .then(async (result) => {
        if (!mountedRef.current || taskId !== taskIdRef.current) return;
        abortRef.current = null;
        if (result.status !== 'decoded') {
          if (result.status === 'cancelled') return;
          if (result.status === 'image-invalid' || result.status === 'engine-unavailable') {
            setDiagnostics({ code: result.status, elapsedMs: result.elapsedMs });
            setStatus(result.status);
            return;
          }
          setDiagnostics({ code: result.status, elapsedMs: result.elapsedMs });
          setStatus('not-found');
          return;
        }

        const selection = selectCccdCandidate(result.candidates);
        if (selection.status !== 'valid') {
          const classified = selection.status === 'invalid' ? 'not-cccd' : 'ambiguous';
          setDiagnostics({ code: classified, elapsedMs: result.elapsedMs });
          setStatus(classified);
          return;
        }
        await onParsedRef.current(selection.data, taskId);
        if (!mountedRef.current || taskId !== taskIdRef.current) return;
        setStatus('success');
      })
      .catch(() => {
        if (!mountedRef.current || taskId !== taskIdRef.current) return;
        abortRef.current = null;
        setDiagnostics({ code: 'engine-unavailable' });
        setStatus('engine-unavailable');
      });
  }, [beginGeneration, budgetMs, disposeScanner, getScanner, revokePreview]);

  const onMouseEnter = useCallback(() => { hoveredRef.current = true; }, []);
  const onMouseLeave = useCallback(() => { hoveredRef.current = false; }, []);

  useEffect(() => {
    mountedRef.current = true;
    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const zone = zoneRef.current;
      const active = document.activeElement;
      if (isTextEntry(active) && !zone?.contains(active)) return;

      const otherHoveredTarget = document.querySelector(
        '[data-clipboard-image-paste-active="true"]',
      );
      const ownsFocus = Boolean(zone && active && zone.contains(active));
      if (otherHoveredTarget || (!hoveredRef.current && !ownsFocus)) return;

      const file = clipboardImage(event);
      if (!file) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void acceptFile(file);
    };
    window.addEventListener('paste', handlePaste, true);
    return () => {
      mountedRef.current = false;
      ++taskIdRef.current;
      abortRef.current?.abort();
      abortRef.current = null;
      revokePreview();
      disposeScanner();
      window.removeEventListener('paste', handlePaste, true);
    };
  }, [acceptFile, disposeScanner, revokePreview]);

  return {
    zoneRef,
    onMouseEnter,
    onMouseLeave,
    acceptFile,
    reset,
    disposeScanner,
    status,
    previewUrl,
    originalFile,
    diagnostics,
  };
}
