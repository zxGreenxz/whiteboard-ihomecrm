// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CCCDQrData } from '@/lib/cccdQrParser';
import type { QrScanner, ScanResult } from '@/lib/qr/types';
import { useCccdQrInput } from '../useCccdQrInput';

const payload =
  '001234567890||Nguyễn Minh An|29022000|Nữ|12 Đường Mẫu|06052022';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function paste(file?: File, text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: file ? [file] : [],
      items: [],
      getData: () => text,
    },
  });
  window.dispatchEvent(event);
  return event;
}

function Harness({ scanner, onParsed }: {
  scanner: QrScanner;
  onParsed?: (data: CCCDQrData, taskId: number) => void;
}) {
  const qr = useCccdQrInput({
    onParsed: onParsed ?? (() => undefined),
    createScanner: () => scanner,
  });
  return (
    <>
      <div
        data-testid="qr-zone"
        ref={qr.zoneRef}
        tabIndex={0}
        onMouseEnter={qr.onMouseEnter}
        onMouseLeave={qr.onMouseLeave}
      />
      <input aria-label="name" />
      <input aria-label="phone" />
      <output data-testid="status">{qr.status}</output>
    </>
  );
}

describe('useCccdQrInput clipboard ownership', () => {
  const file = new File(['image'], 'qr.png', { type: 'image/png' });
  let scanner: QrScanner;
  let scan: Mock<QrScanner['scan']>;

  beforeEach(() => {
    scan = vi.fn<QrScanner['scan']>().mockResolvedValue({
      status: 'decoded',
      candidates: [{ text: payload, engine: 'native' }],
      elapsedMs: 10,
    });
    scanner = { scan, dispose: vi.fn() };
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('registers one paste listener and removes it on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<Harness scanner={scanner} />);
    expect(add.mock.calls.filter(([type]) => String(type) === 'paste')).toHaveLength(1);
    view.unmount();
    expect(remove.mock.calls.filter(([type]) => String(type) === 'paste')).toHaveLength(1);
  });

  it('accepts an image by hover or retained focus, but not without ownership', async () => {
    render(<Harness scanner={scanner} />);
    paste(file);
    expect(scan).not.toHaveBeenCalled();

    fireEvent.mouseEnter(screen.getByTestId('qr-zone'));
    await act(async () => { paste(file); });
    expect(scan).toHaveBeenCalledTimes(1);

    act(() => screen.getByTestId('qr-zone').focus());
    fireEvent.mouseLeave(screen.getByTestId('qr-zone'));
    await act(async () => { paste(file); });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('leaves name and phone text paste and already-handled events alone', () => {
    render(<Harness scanner={scanner} />);
    act(() => screen.getByTestId('qr-zone').focus());
    for (const label of ['name', 'phone']) {
      act(() => screen.getByLabelText(label).focus());
      const textEvent = paste(undefined, label === 'name' ? 'Nguyễn' : '0900000000');
      expect(textEvent.defaultPrevented).toBe(false);
    }
    expect(scan).not.toHaveBeenCalled();

    act(() => screen.getByTestId('qr-zone').focus());
    const handled = new Event('paste', { cancelable: true }) as ClipboardEvent;
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(scan).not.toHaveBeenCalled();
  });

  it('ignores non-image clipboard files without preventing paste', () => {
    render(<Harness scanner={scanner} />);
    act(() => screen.getByTestId('qr-zone').focus());
    const event = paste(new File(['text'], 'note.txt', { type: 'text/plain' }));
    expect(event.defaultPrevented).toBe(false);
    expect(scan).not.toHaveBeenCalled();
  });
});

describe('useCccdQrInput task lifecycle', () => {
  const imageA = new File(['A'], 'a.png', { type: 'image/png' });
  const imageB = new File(['B'], 'b.png', { type: 'image/png' });
  let nextUrl = 0;

  beforeEach(() => {
    nextUrl = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:${++nextUrl}`),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets B replace busy A and applies only the current task', async () => {
    const a = deferred<ScanResult>();
    const b = deferred<ScanResult>();
    const scan = vi.fn()
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const scanner: QrScanner = { scan, dispose: vi.fn() };
    const onParsed = vi.fn();
    const onTaskStart = vi.fn();
    const { result } = renderHook(() => useCccdQrInput({
      onParsed,
      onTaskStart,
      createScanner: () => scanner,
    }));

    act(() => { void result.current.acceptFile(imageA); });
    const firstSignal = scan.mock.calls[0][1].signal as AbortSignal;
    act(() => { void result.current.acceptFile(imageB); });
    expect(firstSignal.aborted).toBe(true);
    expect(onTaskStart.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');

    await act(async () => {
      b.resolve({
        status: 'decoded',
        candidates: [{ text: payload, engine: 'native' }],
        elapsedMs: 8,
      });
      await b.promise;
    });
    await act(async () => {
      a.resolve({
        status: 'decoded',
        candidates: [{
          text: payload.replace('001234567890', '009876543210'),
          engine: 'wechat',
        }],
        elapsedMs: 20,
      });
      await a.promise;
    });

    expect(onParsed).toHaveBeenCalledTimes(1);
    expect(onParsed).toHaveBeenCalledWith(expect.objectContaining({ idNumber: '001234567890' }), 2);
    expect(result.current.status).toBe('success');
    expect(result.current.originalFile).toBe(imageB);
  });

  it('invalidates pending work and preview on reset and unmount', async () => {
    const pending = deferred<ScanResult>();
    const scanner: QrScanner = {
      scan: vi.fn(() => pending.promise),
      dispose: vi.fn(),
    };
    const onParsed = vi.fn();
    const hook = renderHook(() => useCccdQrInput({
      onParsed,
      createScanner: () => scanner,
    }));

    act(() => { void hook.result.current.acceptFile(imageA); });
    act(() => hook.result.current.reset());
    expect(hook.result.current.status).toBe('idle');
    expect(hook.result.current.originalFile).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    pending.resolve({
      status: 'decoded',
      candidates: [{ text: payload, engine: 'native' }],
      elapsedMs: 10,
    });
    await act(async () => pending.promise);
    expect(onParsed).not.toHaveBeenCalled();

    act(() => { void hook.result.current.acceptFile(imageB); });
    hook.unmount();
    expect(scanner.dispose).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2');
  });

  it.each<[ScanResult['status'], string]>([
    ['image-invalid', 'image-invalid'],
    ['engine-unavailable', 'engine-unavailable'],
    ['not-found', 'not-found'],
    ['timeout', 'not-found'],
  ])('maps scanner result %s to %s without dropping the original file', async (scannerStatus, status) => {
    const scanner: QrScanner = {
      scan: vi.fn().mockResolvedValue({ status: scannerStatus, elapsedMs: 2 }),
      dispose: vi.fn(),
    };
    const { result } = renderHook(() => useCccdQrInput({
      onParsed: vi.fn(),
      createScanner: () => scanner,
    }));
    await act(async () => { await result.current.acceptFile(imageA); });
    expect(result.current.status).toBe(status);
    expect(result.current.originalFile).toBe(imageA);
  });

  it('distinguishes decoded non-CCCD and multiple CCCDs', async () => {
    const scan = vi.fn()
      .mockResolvedValueOnce({
        status: 'decoded',
        candidates: [{ text: 'https://example.invalid', engine: 'native' }],
        elapsedMs: 2,
      })
      .mockResolvedValueOnce({
        status: 'decoded',
        candidates: [
          { text: payload, engine: 'native' },
          { text: payload.replace('001234567890', '009876543210'), engine: 'wechat' },
        ],
        elapsedMs: 2,
      });
    const scanner: QrScanner = { scan, dispose: vi.fn() };
    const { result } = renderHook(() => useCccdQrInput({
      onParsed: vi.fn(),
      createScanner: () => scanner,
    }));
    await act(async () => { await result.current.acceptFile(imageA); });
    expect(result.current.status).toBe('not-cccd');
    await act(async () => { await result.current.acceptFile(imageB); });
    expect(result.current.status).toBe('ambiguous');
  });

  it('turns an unexpected scanner rejection into a non-technical engine error', async () => {
    const scanner: QrScanner = {
      scan: vi.fn().mockRejectedValue(new Error('private decoder detail')),
      dispose: vi.fn(),
    };
    const { result } = renderHook(() => useCccdQrInput({
      onParsed: vi.fn(),
      createScanner: () => scanner,
    }));
    await act(async () => { await result.current.acceptFile(imageA); });
    expect(result.current.status).toBe('engine-unavailable');
    expect(result.current.diagnostics).toEqual({ code: 'engine-unavailable' });
  });

  it('turns a synchronous scanner setup failure into a non-technical engine error', async () => {
    const { result } = renderHook(() => useCccdQrInput({
      onParsed: vi.fn(),
      createScanner: () => { throw new Error('private setup detail'); },
    }));
    await act(async () => { await result.current.acceptFile(imageA); });
    expect(result.current.status).toBe('engine-unavailable');
    expect(result.current.diagnostics).toEqual({ code: 'engine-unavailable' });
    expect(result.current.originalFile).toBe(imageA);
  });

  it('can dispose an idle QR worker and recreate it while retaining the source file', async () => {
    const first: QrScanner = {
      scan: vi.fn().mockResolvedValue({ status: 'not-found', elapsedMs: 2 }),
      dispose: vi.fn(),
    };
    const second: QrScanner = {
      scan: vi.fn().mockResolvedValue({ status: 'not-found', elapsedMs: 2 }),
      dispose: vi.fn(),
    };
    const createScanner = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const { result } = renderHook(() => useCccdQrInput({
      onParsed: vi.fn(),
      createScanner,
    }));
    await act(async () => { await result.current.acceptFile(imageA); });
    expect(result.current.originalFile).toBe(imageA);
    act(() => result.current.disposeScanner());
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(result.current.originalFile).toBe(imageA);
    await act(async () => { await result.current.acceptFile(imageB); });
    expect(createScanner).toHaveBeenCalledTimes(2);
    expect(second.scan).toHaveBeenCalled();
  });
});
