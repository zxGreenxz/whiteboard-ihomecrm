import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { selectCccdCandidate, type CCCDQrData } from '@/lib/cccdQrParser';
import { createQrScanner } from '@/lib/qr/client';
import {
  captureFullFrameFile,
  captureVideoBitmap,
  nextCameraScan,
  selectSharpCameraFrame,
} from '@/lib/qr/cameraFrame';
import type { QrScanner } from '@/lib/qr/types';

export type CccdCameraStatus = 'idle' | 'starting' | 'scanning' | 'paused' | 'ambiguous' | 'detected' | 'error';

type CameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  zoom?: { min: number; max: number };
  torch?: boolean;
};

type CameraSettings = MediaTrackSettings & { focusMode?: string; zoom?: number; torch?: boolean };

type MediaDevicesLike = Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>;

type Options = {
  open: boolean;
  videoRef: RefObject<HTMLVideoElement>;
  containerRef: RefObject<HTMLElement>;
  onParsed: (data: CCCDQrData) => void | Promise<void>;
  onAmbiguous?: () => void;
  onClose: () => void;
  mediaDevices?: MediaDevicesLike;
  createScanner?: () => QrScanner;
  captureBitmap?: typeof captureVideoBitmap;
  captureFile?: typeof captureFullFrameFile;
  selectSharpFrame?: typeof selectSharpCameraFrame;
  now?: () => number;
  beep?: () => void;
  vibrate?: () => void;
};

function cameraError(error: unknown): string {
  if (error instanceof Error && error.name === 'NotAllowedError') return 'Bạn cần cho phép truy cập camera để quét QR';
  if (error instanceof Error && error.name === 'NotFoundError') return 'Không tìm thấy camera trên thiết bị';
  return error instanceof Error && error.message ? error.message : 'Không mở được camera';
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useCccdQrCamera(options: Options) {
  const [status, setStatus] = useState<CccdCameraStatus>('idle');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [settings, setSettings] = useState<CameraSettings | null>(null);
  const [capabilities, setCapabilities] = useState<CameraCapabilities | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [restart, setRestart] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const release = useCallback((invalidate = true, abort = true) => {
    if (invalidate) ++sessionRef.current;
    if (abort) abortRef.current?.abort();
    abortRef.current = null;
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = null;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    scannerRef.current?.dispose();
    scannerRef.current = null;
    const owned = streamRef.current;
    streamRef.current = null;
    stopStream(owned);
    const video = optionsRef.current.videoRef.current;
    if (video?.srcObject === owned) video.srcObject = null;
  }, []);

  const stop = useCallback(() => {
    release();
    setStatus('idle');
  }, [release]);

  const retry = useCallback(() => setRestart((value) => value + 1), []);
  const selectDevice = useCallback((nextDeviceId: string) => setDeviceId(nextDeviceId), []);

  const captureCard = useCallback(() => {
    const video = optionsRef.current.videoRef.current;
    if (!video) return Promise.reject(new Error('Camera frame is not ready'));
    let pending: Promise<File>;
    try {
      pending = (optionsRef.current.captureFile ?? captureFullFrameFile)(video);
    } catch (caught) {
      release();
      setError('Không thể chụp ảnh thẻ. Vui lòng khởi động lại camera.');
      setStatus('error');
      throw caught;
    }
    release();
    const releasedSession = sessionRef.current;
    setStatus('idle');
    return pending.then((file) => {
      if (sessionRef.current !== releasedSession) throw new DOMException('Camera capture replaced', 'AbortError');
      return file;
    }).catch((caught: unknown) => {
      if (sessionRef.current !== releasedSession) throw new DOMException('Camera capture replaced', 'AbortError');
      if (sessionRef.current === releasedSession) {
        setError('Không thể chụp ảnh thẻ. Vui lòng khởi động lại camera.');
        setStatus('error');
      }
      throw caught;
    });
  }, [release]);

  // A capture releases the scan session before encoding finishes, so the scan
  // effect's conditional cleanup alone cannot invalidate it on unmount.
  useEffect(() => () => release(), [release]);

  useEffect(() => {
    if (!options.open) {
      release();
      setStatus('idle');
      return undefined;
    }
    if (document.visibilityState === 'hidden') {
      setStatus('paused');
      return undefined;
    }

    release();
    const session = ++sessionRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('starting');
    setError('');
    setCapabilities(null);
    setSettings(null);
    let endedTrack: MediaStreamTrack | null = null;
    let endedHandler: (() => void) | null = null;

    const current = () => sessionRef.current === session && !controller.signal.aborted;
    const fail = (message: string) => {
      if (!current()) return;
      setError(message);
      setStatus('error');
      release();
    };

    const schedule = (run: () => void, delay = 140) => {
      if (!current()) return;
      scanTimerRef.current = setTimeout(run, delay);
    };

    const start = async () => {
      const configured = optionsRef.current.mediaDevices ?? navigator.mediaDevices;
      if (!configured?.getUserMedia) { fail('Trình duyệt không hỗ trợ camera'); return; }
      let stream: MediaStream;
      try {
        stream = await configured.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch (caught) {
        fail(cameraError(caught));
        return;
      }
      if (!current()) { stopStream(stream); return; }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) { fail('Không tìm thấy camera trên thiết bị'); return; }
      endedTrack = track;
      endedHandler = () => {
        if (!current()) return;
        fail('Camera đã ngắt kết nối. Vui lòng thử lại.');
      };
      track.addEventListener('ended', endedHandler, { once: true });

      if (typeof track.getCapabilities === 'function') {
        try {
          const supported = track.getCapabilities() as CameraCapabilities;
          if (current()) setCapabilities(supported);
          const advanced: Record<string, unknown> = {};
          if (supported.focusMode?.includes('continuous')) advanced.focusMode = 'continuous';
          if (supported.zoom) advanced.zoom = Math.min(supported.zoom.max, Math.max(supported.zoom.min, 1));
          if (supported.torch) advanced.torch = false;
          if (Object.keys(advanced).length > 0) {
            try { await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints); }
            catch { /* Optional camera tuning must not block the basic stream. */ }
          }
          if (current() && typeof track.getSettings === 'function') setSettings(track.getSettings() as CameraSettings);
        } catch { /* Some WebKit tracks expose methods that still throw. */ }
      }
      if (!current()) { stopStream(stream); return; }
      const video = optionsRef.current.videoRef.current;
      if (!video) { fail('Không thể gắn camera vào màn hình'); return; }
      video.srcObject = stream;
      try { await video.play(); }
      catch { fail('Không thể phát hình ảnh camera. Vui lòng thử lại.'); return; }
      if (!current()) return;
      try {
        const listed = await configured.enumerateDevices();
        if (current()) setDevices(listed.filter((item) => item.kind === 'videoinput'));
      } catch { /* Device picker is optional after a working stream is open. */ }
      if (!current()) return;
      const scanner = (optionsRef.current.createScanner ?? createQrScanner)();
      scannerRef.current = scanner;
      setStatus('scanning');
      let lastDeepAt = (optionsRef.current.now ?? performance.now.bind(performance))();
      let deepFullFrame = false;

      const scanNext = async () => {
        if (!current()) return;
        const frameVideo = optionsRef.current.videoRef.current;
        const container = optionsRef.current.containerRef.current;
        if (!frameVideo || !container || frameVideo.readyState < 2 || !frameVideo.videoWidth) {
          schedule(() => { void scanNext(); });
          return;
        }
        const clock = optionsRef.current.now ?? performance.now.bind(performance);
        const now = clock();
        const plan = nextCameraScan(now, lastDeepAt, deepFullFrame);
        if (plan.mode === 'camera-deep') {
          deepFullFrame = !deepFullFrame;
        }
        let bitmap: ImageBitmap;
        try {
          const capture = () => (optionsRef.current.captureBitmap ?? captureVideoBitmap)(frameVideo, container, plan.fullFrame);
          bitmap = plan.mode === 'camera-deep'
            ? await (optionsRef.current.selectSharpFrame ?? selectSharpCameraFrame)(capture, { signal: controller.signal })
            : await capture();
        } catch {
          if (current()) schedule(() => { void scanNext(); });
          return;
        }
        if (!current()) { bitmap.close(); return; }
        let result;
        try { result = await scanner.scan(bitmap, { mode: plan.mode, budgetMs: plan.budgetMs, signal: controller.signal }); }
        catch { fail('Bộ đọc QR camera chưa sẵn sàng. Vui lòng thử lại.'); return; }
        if (!current()) return;
        if (plan.mode === 'camera-deep') lastDeepAt = clock();
        if (result.status === 'decoded') {
          const selection = selectCccdCandidate(result.candidates);
          if (selection.status === 'ambiguous') {
            setStatus('ambiguous');
            optionsRef.current.onAmbiguous?.();
            schedule(() => { void scanNext(); });
            return;
          } else if (selection.status === 'valid') {
            setStatus('detected');
            release(false, false);
            if (!current()) return;
            optionsRef.current.beep?.();
            optionsRef.current.vibrate?.();
            await optionsRef.current.onParsed(selection.data);
            if (!current()) return;
            closeTimerRef.current = setTimeout(() => {
              if (current()) optionsRef.current.onClose();
            }, 600);
            return;
          }
        }
        if (current()) setStatus('scanning');
        schedule(() => { void scanNext(); });
      };
      void scanNext();
    };
    void start();

    return () => {
      if (endedTrack && endedHandler) endedTrack.removeEventListener('ended', endedHandler);
      if (sessionRef.current === session) release();
    };
  }, [deviceId, options.open, release, restart]);

  useEffect(() => {
    const handleVisibility = () => {
      if (!optionsRef.current.open) return;
      if (document.visibilityState === 'hidden') {
        release();
        setStatus('paused');
      } else {
        setRestart((value) => value + 1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [release]);

  return { status, error, devices, settings, capabilities, selectDevice, retry, stop, captureCard };
}
