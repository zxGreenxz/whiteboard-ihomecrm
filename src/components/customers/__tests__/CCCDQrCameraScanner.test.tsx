// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const camera = vi.hoisted(() => ({
  captureCard: vi.fn(),
  retry: vi.fn(),
  selectDevice: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../useCccdQrCamera', () => ({
  useCccdQrCamera: () => ({
    status: 'scanning', error: '', devices: [], settings: null, capabilities: null,
    ...camera,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import CCCDQrCameraScanner from '../CCCDQrCameraScanner';

describe('CCCDQrCameraScanner capture ownership', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
