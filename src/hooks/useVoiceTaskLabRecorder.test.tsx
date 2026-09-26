// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoiceTaskLabRecorder } from './useVoiceTaskLabRecorder';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('voice trial microphone lifecycle', () => {
  it('stops a late permission stream after the user cancels', async () => {
    const stop = vi.fn();
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('MediaRecorder', class { static isTypeSupported() { return true; } });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const { result } = renderHook(() => useVoiceTaskLabRecorder());
    let starting!: Promise<void>;
    act(() => { starting = result.current.start('9router'); });
    act(() => { result.current.clear(); });
    await act(async () => { grant({ getTracks: () => [{ stop }] } as unknown as MediaStream); await starting; });
    expect(stop).toHaveBeenCalledOnce();
    expect(result.current.state).toBe('idle');
    expect(result.current.audio).toBeNull();
  });

  it('stops a permission stream that arrives after unmount', async () => {
    const stop = vi.fn();
    let grant!: (stream: MediaStream) => void;
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('MediaRecorder', class { static isTypeSupported() { return true; } });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve; }) } });
    const { result, unmount } = renderHook(() => useVoiceTaskLabRecorder());
    let starting!: Promise<void>;
    act(() => { starting = result.current.start('9router'); });
    unmount();
    await act(async () => { grant({ getTracks: () => [{ stop }] } as unknown as MediaStream); await starting; });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('stops at sixty seconds and uploads the actual recorder codec, then revokes playback on clear', async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const revoke = vi.fn();
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:recording', revokeObjectURL: revoke });
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported() { return true; }
      mimeType = 'audio/mp4';
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/mp4' }) }); this.onstop?.(); }
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } });
    const { result } = renderHook(() => useVoiceTaskLabRecorder());
    await act(async () => { await result.current.start('9router'); });
    expect(result.current.state).toBe('recording');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current.state).toBe('recorded');
    expect(result.current.audio?.blob.type).toBe('audio/mp4');
    expect(stopTrack).toHaveBeenCalledOnce();
    act(() => { result.current.clear(); });
    expect(revoke).toHaveBeenCalledWith('blob:recording');
    expect(result.current.audio).toBeNull();
  });

  it('rejects a recording over 10 MiB and releases the microphone', async () => {
    const stopTrack = vi.fn();
    let emit!: (size: number) => void;
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported() { return true; }
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      start() { this.state = 'recording'; emit = size => this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }); }
      stop() { this.state = 'inactive'; }
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } });
    const { result } = renderHook(() => useVoiceTaskLabRecorder());
    await act(async () => { await result.current.start('9router'); });
    act(() => { emit(10 * 1024 * 1024 + 1); });
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toContain('10 MiB');
    expect(result.current.audio).toBeNull();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
