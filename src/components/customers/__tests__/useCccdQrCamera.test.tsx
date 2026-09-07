// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QrScanner, ScanResult } from '@/lib/qr/types';
import { useCccdQrCamera } from '../useCccdQrCamera';

type FakeTrack = MediaStreamTrack & {
  stop: ReturnType<typeof vi.fn>;
  applyConstraints: ReturnType<typeof vi.fn>;
  end: () => void;
};

function track(): FakeTrack {
  let ended: (() => void) | undefined;
  return {
    stop: vi.fn(),
    getCapabilities: vi.fn(() => ({ focusMode: ['continuous'], zoom: { min: 1, max: 4 }, torch: true })),
    getSettings: vi.fn(() => ({ deviceId: 'rear', width: 1920, height: 1080, focusMode: 'continuous', zoom: 1, torch: false })),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn((name: string, callback: () => void) => { if (name === 'ended') ended = callback; }),
    removeEventListener: vi.fn(),
    end: () => ended?.(),
  } as unknown as FakeTrack;
}

function stream(videoTrack = track()) {
  return { getTracks: () => [videoTrack], getVideoTracks: () => [videoTrack] } as unknown as MediaStream;
}

function harness(overrides: Record<string, unknown> = {}) {
  const video = document.createElement('video');
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
    readyState: { configurable: true, value: 4 },
  });
  video.play = vi.fn().mockResolvedValue(undefined);
  const videoRef = { current: video };
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, toJSON: () => ({}) });
  const containerRef = { current: container };
  const firstTrack = track();
  const firstStream = stream(firstTrack);
  const getUserMedia = vi.fn().mockResolvedValue(firstStream);
  const enumerateDevices = vi.fn().mockResolvedValue([{ kind: 'videoinput', deviceId: 'rear', groupId: 'g', label: 'Camera sau', toJSON: () => ({}) }]);
  const scan = vi.fn().mockResolvedValue({ status: 'not-found', elapsedMs: 1 } satisfies ScanResult);
  const dispose = vi.fn();
  const createScanner = vi.fn(() => ({ scan, dispose } as QrScanner));
  const captureBitmap = vi.fn().mockResolvedValue({ width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap);
  const captureFile = vi.fn().mockResolvedValue(new File(['card'], 'cccd-camera.jpg', { type: 'image/jpeg' }));
  const selectSharpFrame = vi.fn(async (capture: () => Promise<ImageBitmap>) => capture());
  return {
    video, videoRef, containerRef, firstTrack, firstStream, getUserMedia, enumerateDevices,
    scan, dispose, createScanner, captureBitmap, captureFile, selectSharpFrame,
    options: {
      open: true,
      videoRef,
      containerRef,
      onParsed: vi.fn(),
      onAmbiguous: vi.fn(),
      onClose: vi.fn(),
      mediaDevices: { getUserMedia, enumerateDevices },
      createScanner,
      captureBitmap,
      captureFile,
      selectSharpFrame,
      beep: vi.fn(),
      vibrate: vi.fn(),
      ...overrides,
    },
  };
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('useCccdQrCamera lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('starts once across callback rerenders and stops the owned stream and worker on close', async () => {
    const h = harness();
    const first = vi.fn();
    const latest = vi.fn();
    const { result, rerender } = renderHook(
      ({ open, onParsed }) => useCccdQrCamera({ ...h.options, open, onParsed }),
      { initialProps: { open: true, onParsed: first } },
    );
    await settle();
    expect(result.current.status).toBe('scanning');
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.firstTrack.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous', zoom: 1, torch: false }] });
    rerender({ open: true, onParsed: latest });
    await settle();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    rerender({ open: false, onParsed: latest });
    expect(h.firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.video.srcObject).toBeNull();
  });

  it('stops a stream delivered after a rapid close', async () => {
    let deliver!: (value: MediaStream) => void;
    const h = harness({});
    h.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    const lateTrack = track();
    const { rerender } = renderHook(({ open }) => useCccdQrCamera({ ...h.options, open }), { initialProps: { open: true } });
    rerender({ open: false });
    await act(async () => { deliver(stream(lateTrack)); await Promise.resolve(); });
    expect(lateTrack.stop).toHaveBeenCalledTimes(1);
    expect(h.video.play).not.toHaveBeenCalled();
  });

  it.each([
    ['NotAllowedError', 'Bạn cần cho phép truy cập camera để quét QR'],
    ['NotFoundError', 'Không tìm thấy camera trên thiết bị'],
  ])('reports %s without claiming to scan', async (name, message) => {
    const h = harness();
    h.getUserMedia.mockRejectedValueOnce(Object.assign(new Error(name), { name }));
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(message);
  });

  it('reports a rejected video play and stops its stream', async () => {
    const h = harness();
    h.video.play = vi.fn().mockRejectedValue(new Error('autoplay blocked'));
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('phát hình ảnh camera');
    expect(h.firstTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('stops in the background and starts a fresh stream on resume', async () => {
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    const h = harness();
    const secondTrack = track();
    h.getUserMedia.mockResolvedValueOnce(h.firstStream).mockResolvedValueOnce(stream(secondTrack));
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.status).toBe('paused');
    expect(h.firstTrack.stop).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('scanning');
  });

  it('stops the old stream when selecting another camera and reports an ended track', async () => {
    const h = harness();
    const secondTrack = track();
    h.getUserMedia.mockResolvedValueOnce(h.firstStream).mockResolvedValueOnce(stream(secondTrack));
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    act(() => result.current.selectDevice('front'));
    await settle();
    expect(h.firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(h.getUserMedia.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ video: expect.objectContaining({ deviceId: { exact: 'front' } }) }));
    act(() => secondTrack.end());
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('ngắt kết nối');
    expect(secondTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps one scan active and rejects a decoded result after close', async () => {
    let deliver!: (value: ScanResult) => void;
    const h = harness();
    h.scan.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    const onParsed = vi.fn();
    const { rerender } = renderHook(({ open }) => useCccdQrCamera({ ...h.options, open, onParsed }), { initialProps: { open: true } });
    await settle();
    expect(h.scan).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); });
    expect(h.scan).toHaveBeenCalledTimes(1);
    rerender({ open: false });
    await act(async () => { deliver({ status: 'decoded', candidates: [{ engine: 'native', text: '001234567890||NGUYỄN MINH AN|29022000|Nữ|12 Đường Mẫu|06052022' }], elapsedMs: 10 }); await Promise.resolve(); });
    expect(onParsed).not.toHaveBeenCalled();
  });

  it('runs fast ROI work between alternating deep ROI and full-frame jobs', async () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    renderHook(() => useCccdQrCamera(h.options));
    await settle();
    expect(h.scan.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ mode: 'camera-fast', budgetMs: 250 }));
    expect(h.captureBitmap.mock.calls[0]?.[2]).toBe(false);
    clock = 900;
    await act(async () => { vi.advanceTimersByTime(140); await Promise.resolve(); await Promise.resolve(); });
    expect(h.scan.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ mode: 'camera-deep', budgetMs: 1500 }));
    expect(h.captureBitmap.mock.calls[1]?.[2]).toBe(false);
    clock = 1800;
    await act(async () => { vi.advanceTimersByTime(140); await Promise.resolve(); await Promise.resolve(); });
    expect(h.scan.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ mode: 'camera-deep', budgetMs: 1500 }));
    expect(h.captureBitmap.mock.calls[2]?.[2]).toBe(true);
  });

  it('runs a fast ROI attempt after a slow deep scan completes', async () => {
    let clock = 0;
    let finishDeep!: (value: ScanResult) => void;
    const h = harness({ now: () => clock });
    h.scan
      .mockResolvedValueOnce({ status: 'not-found', elapsedMs: 1 })
      .mockImplementationOnce(() => new Promise((resolve) => { finishDeep = resolve; }))
      .mockResolvedValue({ status: 'not-found', elapsedMs: 1 });
    renderHook(() => useCccdQrCamera(h.options));
    await settle();
    clock = 900;
    await act(async () => { vi.advanceTimersByTime(140); await Promise.resolve(); await Promise.resolve(); });
    expect(h.scan.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ mode: 'camera-deep' }));
    clock = 1777;
    await act(async () => { finishDeep({ status: 'not-found', elapsedMs: 877 }); await Promise.resolve(); });
    clock = 1917;
    await act(async () => { vi.advanceTimersByTime(140); await Promise.resolve(); await Promise.resolve(); });
    expect(h.scan.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ mode: 'camera-fast' }));
  });

  it('delivers one valid identity through the latest callback and closes only the current session', async () => {
    const h = harness();
    h.scan.mockResolvedValueOnce({ status: 'decoded', candidates: [{ engine: 'native', text: '001234567890||NGUYỄN MINH AN|29022000|Nữ|12 Đường Mẫu|06052022' }], elapsedMs: 10 });
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = renderHook(({ onParsed }) => useCccdQrCamera({ ...h.options, onParsed }), { initialProps: { onParsed: first } });
    rerender({ onParsed: latest });
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(expect.objectContaining({ idNumber: '001234567890' }));
    expect(h.options.beep).toHaveBeenCalledTimes(1);
    expect(h.options.vibrate).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(600); await Promise.resolve(); });
    expect(h.options.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning when optional constraints fail and exposes the actual settings', async () => {
    const h = harness();
    h.firstTrack.applyConstraints.mockRejectedValueOnce(new Error('unsupported combination'));
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    expect(result.current.status).toBe('scanning');
    expect(result.current.settings).toEqual(expect.objectContaining({ deviceId: 'rear', torch: false }));
  });

  it('requires a single card when decoded candidates contain conflicting identities', async () => {
    const h = harness();
    h.scan.mockResolvedValueOnce({ status: 'decoded', elapsedMs: 3, candidates: [
      { engine: 'native', text: '001234567890||NGUYỄN MINH AN|29022000|Nữ|12 Đường Mẫu|06052022' },
      { engine: 'native', text: '001234567891||TRẦN MINH AN|01012001|Nam|13 Đường Mẫu|07052022' },
    ] });
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    expect(result.current.status).toBe('ambiguous');
    expect(h.options.onAmbiguous).toHaveBeenCalledTimes(1);
    expect(h.options.onParsed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(140); });
    expect(result.current.status).toBe('scanning');
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('captures one full frame after releasing camera resources', async () => {
    const h = harness();
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    const file = await result.current.captureCard();
    expect(h.captureFile).toHaveBeenCalledWith(h.video);
    expect(h.firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(file.name).toBe('cccd-camera.jpg');
  });

  it.each(['device', 'retry', 'close', 'unmount'] as const)('cancels delayed capture success after %s replaces its session', async (replacement) => {
    let deliver!: (file: File) => void;
    const h = harness();
    const nextTrack = track();
    const nextStream = stream(nextTrack);
    h.getUserMedia.mockResolvedValueOnce(h.firstStream).mockResolvedValue(nextStream);
    h.captureFile.mockReturnValueOnce(new Promise<File>((resolve) => { deliver = resolve; }));
    const { result, rerender, unmount } = renderHook(({ open }) => useCccdQrCamera({ ...h.options, open }), { initialProps: { open: true } });
    await settle();
    let pending!: Promise<File>;
    act(() => { pending = result.current.captureCard(); });
    const outcome = pending.then(() => 'stale-file', (error: Error) => error.name);
    act(() => {
      if (replacement === 'device') result.current.selectDevice('front');
      else if (replacement === 'retry') result.current.retry();
      else if (replacement === 'close') rerender({ open: false });
      else unmount();
    });
    await settle();
    await act(async () => { deliver(new File(['old'], 'old.jpg')); await pending.catch(() => undefined); });
    expect(await outcome).toBe('AbortError');
    expect(h.options.onParsed).not.toHaveBeenCalled();
    expect(h.options.onClose).not.toHaveBeenCalled();
    if (replacement === 'device' || replacement === 'retry') {
      expect(result.current.status).toBe('scanning');
      expect(h.video.srcObject).toBe(nextStream);
      expect(nextTrack.stop).not.toHaveBeenCalled();
      expect(result.current.error).toBe('');
    }
  });

  it('releases camera resources when full-frame capture throws synchronously', async () => {
    const h = harness({ captureFile: () => { throw new Error('canvas unavailable'); } });
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    expect(() => result.current.captureCard()).toThrow('canvas unavailable');
    expect(h.firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });

  it('enters a recoverable error after capture failure and starts a fresh stream on retry', async () => {
    const h = harness();
    const secondTrack = track();
    h.getUserMedia.mockResolvedValueOnce(h.firstStream).mockResolvedValueOnce(stream(secondTrack));
    h.captureFile.mockRejectedValueOnce(new Error('encoding failed')).mockResolvedValueOnce(new File(['card'], 'retry.jpg', { type: 'image/jpeg' }));
    const { result } = renderHook(() => useCccdQrCamera(h.options));
    await settle();
    await act(async () => { await expect(result.current.captureCard()).rejects.toThrow('encoding failed'); });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('chụp ảnh thẻ');
    act(() => result.current.retry());
    await settle();
    expect(result.current.status).toBe('scanning');
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    await expect(result.current.captureCard()).resolves.toEqual(expect.objectContaining({ name: 'retry.jpg' }));
    expect(secondTrack.stop).toHaveBeenCalledTimes(1);
  });
});
