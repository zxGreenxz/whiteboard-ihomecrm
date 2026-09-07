// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  dispose: vi.fn(),
  uploadFile: vi.fn(),
  cameraEffectStarts: 0,
  cameraEffectStops: 0,
}));

vi.mock('@/lib/qr/client', () => ({
  createQrScanner: () => ({ scan: mocks.scan, dispose: mocks.dispose }),
}));
vi.mock('@/lib/storage', () => ({
  uploadFile: (...args: unknown[]) => mocks.uploadFile(...args),
}));
vi.mock('@/lib/authSession', () => ({
  getSessionUser: () => Promise.resolve({ id: 'fictional-user' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../CCCDQrCameraScanner', () => ({
  default: ({ open, onParsed }: {
    open: boolean;
    onParsed: (data: {
      idNumber: string;
      fullName: string;
      dateOfBirth: string;
      gender: string;
      permanentAddress: string;
      idIssueDate: string;
      idIssuePlace: string;
    }) => void;
  }) => {
    React.useEffect(() => {
      if (!open) return undefined;
      mocks.cameraEffectStarts += 1;
      return () => { mocks.cameraEffectStops += 1; };
    }, [open, onParsed]);
    if (!open) return null;
    return React.createElement('button', {
      type: 'button',
      onClick: () => onParsed({
        idNumber: '001234567890',
        fullName: 'Nguyễn Minh An',
        dateOfBirth: '2000-02-29',
        gender: 'Nữ',
        permanentAddress: '12 Đường Mẫu',
        idIssueDate: '2022-05-06',
        idIssuePlace: 'Cục Cảnh Sát',
      }),
    }, 'Deliver camera result');
  },
}));

import CCCDQrUpload from '../CCCDQrUpload';
import ImageUploadZone from '../ImageUploadZone';

const payload =
  '001234567890||Nguyễn Minh An|29022000|Nữ|12 Đường Mẫu|06052022';

function paste(file: File) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [file], items: [] },
  });
  window.dispatchEvent(event);
  return event;
}

describe('CCCDQrUpload', () => {
  beforeEach(() => {
    mocks.scan.mockReset().mockResolvedValue({
      status: 'decoded',
      candidates: [{ text: payload, engine: 'native' }],
      elapsedMs: 12,
    });
    mocks.dispose.mockReset();
    mocks.uploadFile.mockReset().mockResolvedValue('stored/front.png');
    mocks.cameraEffectStarts = 0;
    mocks.cameraEffectStops = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:qr'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the shared scanner and reports a successful autofill', async () => {
    const onParsed = vi.fn();
    render(<CCCDQrUpload onParsed={onParsed} />);
    const file = new File(['qr'], 'qr.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('cccd-qr-file-input'), {
        target: { files: [file] },
      });
    });
    expect(mocks.scan).toHaveBeenCalledWith(file, expect.objectContaining({ mode: 'image' }));
    expect(onParsed).toHaveBeenCalledWith(expect.objectContaining({ idNumber: '001234567890' }), 1);
    expect(screen.getByText('Đã tự động điền thông tin CCCD.')).toBeTruthy();
  });

  it('keeps one camera effect after delivery and clears its success on image replacement/reset', async () => {
    const firstOnParsed = vi.fn().mockResolvedValue(undefined);
    const latestOnParsed = vi.fn().mockResolvedValue(undefined);
    const view = render(<CCCDQrUpload onParsed={firstOnParsed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quét bằng camera' }));
    expect(mocks.cameraEffectStarts).toBe(1);
    view.rerender(<CCCDQrUpload onParsed={latestOnParsed} />);
    expect(mocks.cameraEffectStarts).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deliver camera result' }));
    });
    expect(firstOnParsed).not.toHaveBeenCalled();
    expect(latestOnParsed).toHaveBeenCalledTimes(1);
    expect(mocks.cameraEffectStarts).toBe(1);
    expect(mocks.cameraEffectStops).toBe(0);
    expect(screen.getByText('Đã đọc QR từ camera')).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByTestId('cccd-qr-file-input'), {
        target: { files: [new File(['qr'], 'replacement.png', { type: 'image/png' })] },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Xoá ảnh QR' }));
    expect(screen.queryByText('Đã đọc QR từ camera')).toBeNull();
  });

  it('keeps the QR listener from stealing pastes owned by either hovered ID image upload', async () => {
    const onParsed = vi.fn();
    const onFront = vi.fn();
    const onBack = vi.fn();
    mocks.uploadFile
      .mockResolvedValueOnce('stored/front.png')
      .mockResolvedValueOnce('stored/back.png');
    render(
      <>
        <CCCDQrUpload onParsed={onParsed} />
        <ImageUploadZone label="CCCD mặt trước" onChange={onFront} />
        <ImageUploadZone label="CCCD mặt sau" onChange={onBack} />
      </>,
    );
    const qrZone = screen.getByTestId('cccd-qr-zone');
    act(() => qrZone.focus());
    const uploadZones = screen.getAllByText('Kéo thả, click hoặc Ctrl+V để tải ảnh')
      .map((element) => element.closest('[data-clipboard-image-paste-target="upload"]')!);

    fireEvent.mouseEnter(uploadZones[0]);
    paste(new File(['front'], 'front.png', { type: 'image/png' }));
    await waitFor(() => expect(onFront).toHaveBeenCalledWith('stored/front.png'));
    fireEvent.mouseLeave(uploadZones[0]);
    fireEvent.mouseEnter(uploadZones[1]);
    paste(new File(['back'], 'back.png', { type: 'image/png' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledWith('stored/back.png'));
    expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(onParsed).not.toHaveBeenCalled();
  });

  it('owns focused QR paste exactly once when no image upload is hovered', async () => {
    render(
      <>
        <CCCDQrUpload onParsed={vi.fn()} />
        <ImageUploadZone label="CCCD mặt trước" onChange={vi.fn()} />
        <ImageUploadZone label="CCCD mặt sau" onChange={vi.fn()} />
      </>,
    );
    act(() => screen.getByTestId('cccd-qr-zone').focus());
    const uploadZone = screen.getAllByText('Kéo thả, click hoặc Ctrl+V để tải ảnh')[0]
      .closest('[data-clipboard-image-paste-target="upload"]')!;
    const query = vi.spyOn(document, 'querySelector');
    query.mockImplementation((selector: string) =>
      selector === '[data-clipboard-image-paste-target="upload"]:hover'
        ? uploadZone
        : Document.prototype.querySelector.call(document, selector));
    const event = paste(new File(['qr'], 'qr.png', { type: 'image/png' }));
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1));
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });
});
