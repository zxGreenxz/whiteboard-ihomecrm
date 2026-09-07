// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const camera = vi.hoisted(() => ({
  captureCard: vi.fn(),
  retry: vi.fn(),
  selectDevice: vi.fn(),
  stop: vi.fn(),
  beep: undefined as undefined | (() => void),
}));

vi.mock('../useCccdQrCamera', () => ({
  useCccdQrCamera: (options: { beep: () => void }) => {
    camera.beep = options.beep;
    return {
    status: 'scanning', error: '', devices: [{ deviceId: 'rear', label: 'Rear' }, { deviceId: 'front', label: 'Front' }], settings: { deviceId: 'rear' }, capabilities: null,
    ...camera,
  }; },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import CCCDQrCameraScanner from '../CCCDQrCameraScanner';

describe('CCCDQrCameraScanner capture ownership', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('does not hand off or close the replacement source when an old capture succeeds', async () => {
    let deliver!: (file: File) => void;
    camera.captureCard.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
    const onCapture = vi.fn();
    const onOpenChange = vi.fn();
    render(<CCCDQrCameraScanner open onOpenChange={onOpenChange} onParsed={vi.fn()} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Đọc chữ trên thẻ' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'front' } });
    await act(async () => { deliver(new File(['old'], 'old.jpg')); });
    expect(camera.selectDevice).toHaveBeenCalledWith('front');
    expect(onCapture).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Đọc chữ trên thẻ' }).hasAttribute('disabled')).toBe(false);
  });

  it('settles capture cancellation quietly and allows the current camera to capture again', async () => {
    camera.captureCard.mockRejectedValueOnce(new DOMException('Replaced', 'AbortError'));
    const onCapture = vi.fn();
    render(<CCCDQrCameraScanner open onOpenChange={vi.fn()} onParsed={vi.fn()} onCapture={onCapture} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Đọc chữ trên thẻ' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Đọc chữ trên thẻ' }).hasAttribute('disabled')).toBe(false);
  });

  it('handles rejected optional audio close without an unhandled rejection', async () => {
    vi.useFakeTimers();
    let closeCalls = 0;
    class AudioContextFixture {
      currentTime = 0;
      destination = {};
      createOscillator() { return { type: '', frequency: { value: 0 }, connect: () => ({ connect: () => undefined }), start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
      close() { closeCalls++; return Promise.reject(new Error('audio already closed')); }
    }
    vi.stubGlobal('AudioContext', AudioContextFixture);
    render(<CCCDQrCameraScanner open onOpenChange={vi.fn()} onParsed={vi.fn()} onCapture={vi.fn()} />);
    camera.beep?.();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls).toBe(1);
    // Vitest fails the run if this asynchronous rejection is unhandled.
  });

  it('does not deliver a full-frame capture after its parent unmounts', async () => {
    let deliver!: (file: File) => void;
    camera.captureCard.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
    const onCapture = vi.fn();
    const view = render(<CCCDQrCameraScanner open onOpenChange={vi.fn()} onParsed={vi.fn()} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Đọc chữ trên thẻ' }));
    view.unmount();
    await act(async () => { deliver(new File(['card'], 'camera.jpg', { type: 'image/jpeg' })); await Promise.resolve(); });
    expect(onCapture).not.toHaveBeenCalled();
  });
});
