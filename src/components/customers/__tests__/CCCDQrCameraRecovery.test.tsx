// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  dispose: vi.fn(),
  captureFile: vi.fn(),
  captureBitmap: vi.fn(),
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
}));

vi.mock('@/lib/qr/client', () => ({
  createQrScanner: () => ({ scan: mocks.scan, dispose: mocks.dispose }),
}));
vi.mock('@/lib/qr/cameraFrame', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('@/lib/qr/cameraFrame')>();
  return {
    ...original,
    captureFullFrameFile: (...args: unknown[]) => mocks.captureFile(...args),
    captureVideoBitmap: (...args: unknown[]) => mocks.captureBitmap(...args),
    selectSharpCameraFrame: (capture: () => Promise<ImageBitmap>) => capture(),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import CCCDQrCameraScanner from '../CCCDQrCameraScanner';

function fakeStream() {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
    getSettings: vi.fn(() => ({ deviceId: 'fictional-camera' })),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack;
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, track };
}

describe('CCCDQrCameraScanner recovery', () => {
  beforeEach(() => {
    const first = fakeStream();
    const second = fakeStream();
    mocks.getUserMedia.mockReset().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    mocks.enumerateDevices.mockReset().mockResolvedValue([]);
    mocks.scan.mockReset().mockResolvedValue({ status: 'not-found', elapsedMs: 1 });
    mocks.dispose.mockReset();
    mocks.captureBitmap.mockReset().mockResolvedValue({ width: 16, height: 16, close: vi.fn() } as unknown as ImageBitmap);
    mocks.captureFile.mockReset()
      .mockRejectedValueOnce(new Error('encoding failed'))
      .mockResolvedValueOnce(new File(['card'], 'retry.jpg', { type: 'image/jpeg' }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mocks.getUserMedia, enumerateDevices: mocks.enumerateDevices },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('restarts the camera after capture failure and delivers a successful retry', async () => {
    const onCapture = vi.fn();
    render(<CCCDQrCameraScanner open onOpenChange={vi.fn()} onParsed={vi.fn()} onCapture={onCapture} />);
    const capture = await screen.findByRole('button', { name: 'Đọc chữ trên thẻ' });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);
    const retry = await screen.findByRole('button', { name: 'Thử lại' });
    expect(screen.getByText('Không thể chụp ảnh thẻ. Vui lòng khởi động lại camera.')).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.getUserMedia).toHaveBeenCalledTimes(2));
    const secondCapture = await screen.findByRole('button', { name: 'Đọc chữ trên thẻ' });
    await waitFor(() => expect((secondCapture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(secondCapture);
    await waitFor(() => expect(onCapture).toHaveBeenCalledWith(expect.objectContaining({ name: 'retry.jpg' })));
  });
});
