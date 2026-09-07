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
  ocrRead: vi.fn(),
  ocrDispose: vi.fn(),
}));

vi.mock('@/lib/qr/client', () => ({
  createQrScanner: () => ({ scan: mocks.scan, dispose: mocks.dispose }),
}));
vi.mock('@/lib/ocr/client', () => ({createOcrScanner:()=>({read:mocks.ocrRead,dispose:mocks.ocrDispose})}));
vi.mock('@/lib/storage', () => ({
  uploadFile: (...args: unknown[]) => mocks.uploadFile(...args),
}));
vi.mock('@/lib/authSession', () => ({
  getSessionUser: () => Promise.resolve({ id: 'fictional-user' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../CCCDQrCameraScanner', () => ({
  default: ({ open, onParsed, onCapture }: {
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
    onCapture: (file: File) => void;
  }) => {
    React.useEffect(() => {
      if (!open) return undefined;
      mocks.cameraEffectStarts += 1;
      return () => { mocks.cameraEffectStops += 1; };
    }, [open, onParsed]);
    if (!open) return null;
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
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
      }, 'Deliver camera result'),
      React.createElement('button', {
        type: 'button',
        onClick: () => onCapture(new File(['full-card'], 'camera.jpg', { type: 'image/jpeg' })),
      }, 'Capture full card'),
    );
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
    mocks.ocrRead.mockReset();mocks.ocrDispose.mockReset();
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

  it('reviews all five OCR values without autofill, then applies edited values to the shared callback',async()=>{
    mocks.scan.mockResolvedValue({status:'not-found',elapsedMs:1});
    mocks.ocrRead.mockResolvedValue({status:'review',elapsedMs:1,data:{source:'ocr',idNumber:'001099999991',fullName:'NGUYỄN THỬ MỘT',dateOfBirth:'2000-02-29',gender:'Nữ',permanentAddress:'12 Đường Thử',idIssuePlace:'Cục Cảnh sát',idIssueDate:''},states:{idNumber:'readable',fullName:'check',dateOfBirth:'readable',gender:'readable',permanentAddress:'check'}});
    const onParsed=vi.fn();render(<form><CCCDQrUpload onParsed={onParsed}/></form>);
    const original=new File(['original'],'original.png',{type:'image/png'});
    fireEvent.change(screen.getByTestId('cccd-qr-file-input'),{target:{files:[original]}});
    await screen.findByTestId('cccd-ocr-review');expect(onParsed).not.toHaveBeenCalled();
    expect(mocks.ocrRead).toHaveBeenCalledWith(original,expect.anything());expect(mocks.dispose).toHaveBeenCalled();
    expect(document.querySelectorAll('form')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Họ và tên (từ ảnh)'),{target:{value:'NGUYỄN THỬ HAI'}});
    fireEvent.click(screen.getByRole('button',{name:'Áp dụng thông tin đã kiểm tra'}));
    await waitFor(()=>expect(onParsed).toHaveBeenCalledWith({source:'ocr',ocrReviewApplied:true,idNumber:'001099999991',fullName:'NGUYỄN THỬ HAI',dateOfBirth:'2000-02-29',gender:'Nữ',permanentAddress:'12 Đường Thử',idIssuePlace:'Cục Cảnh sát',idIssueDate:''},1));
  });
  it('does not apply incomplete OCR over previous identity and discards late OCR on replacement',async()=>{
    mocks.scan.mockResolvedValue({status:'not-found',elapsedMs:1});
    let deliver!:(value:unknown)=>void;mocks.ocrRead.mockImplementationOnce(()=>new Promise(r=>{deliver=r}));
    const onParsed=vi.fn();render(<CCCDQrUpload onParsed={onParsed}/>);
    fireEvent.change(screen.getByTestId('cccd-qr-file-input'),{target:{files:[new File(['old'],'old.png',{type:'image/png'})]}});
    await waitFor(()=>expect(mocks.ocrRead).toHaveBeenCalledTimes(1));
    mocks.scan.mockResolvedValue({status:'decoded',elapsedMs:1,candidates:[{text:payload,engine:'native'}]});
    fireEvent.change(screen.getByTestId('cccd-qr-file-input'),{target:{files:[new File(['new'],'new.png',{type:'image/png'})]}});
    await waitFor(()=>expect(onParsed).toHaveBeenCalledTimes(1));
    await act(async()=>deliver({status:'review',elapsedMs:1,data:{source:'ocr',idNumber:'001099999991',fullName:'',dateOfBirth:'',gender:'',permanentAddress:'',idIssueDate:'',idIssuePlace:'Cục Cảnh sát'},states:{idNumber:'readable',fullName:'missing',dateOfBirth:'missing',gender:'missing',permanentAddress:'missing'}}));
    expect(screen.queryByTestId('cccd-ocr-review')).toBeNull();expect(onParsed).toHaveBeenCalledTimes(1);
  });
  it('requires missing fields in preview and reset preserves the previously applied identity',async()=>{
    const onParsed=vi.fn();render(<CCCDQrUpload onParsed={onParsed}/>);
    fireEvent.change(screen.getByTestId('cccd-qr-file-input'),{target:{files:[new File(['qr'],'qr.png',{type:'image/png'})]}});
    await waitFor(()=>expect(onParsed).toHaveBeenCalledTimes(1));
    mocks.scan.mockResolvedValue({status:'not-found',elapsedMs:1});
    mocks.ocrRead.mockResolvedValue({status:'review',elapsedMs:1,data:{source:'ocr',idNumber:'001099999991',fullName:'',dateOfBirth:'',gender:'',permanentAddress:'',idIssueDate:'',idIssuePlace:'Cục Cảnh sát'},states:{idNumber:'readable',fullName:'missing',dateOfBirth:'missing',gender:'missing',permanentAddress:'missing'}});
    fireEvent.change(screen.getByTestId('cccd-qr-file-input'),{target:{files:[new File(['partial'],'partial.png',{type:'image/png'})]}});
    await screen.findByTestId('cccd-ocr-review');fireEvent.click(screen.getByRole('button',{name:'Áp dụng thông tin đã kiểm tra'}));
    await screen.findByText('Nhập họ và tên.');expect(onParsed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'Xoá ảnh QR'}));expect(screen.queryByTestId('cccd-ocr-review')).toBeNull();expect(onParsed).toHaveBeenCalledTimes(1);
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

  it('sends one camera full-card capture through the shared upload and OCR owner', async () => {
    mocks.scan.mockResolvedValue({ status: 'not-found', elapsedMs: 2 });
    mocks.ocrRead.mockResolvedValue({
      status: 'review', elapsedMs: 1,
      data: { source: 'ocr', idNumber: '001099999991', fullName: 'NGUYỄN THỬ', dateOfBirth: '2000-02-29', gender: 'Nữ', permanentAddress: '12 Đường Thử', idIssuePlace: 'Cục Cảnh sát', idIssueDate: '' },
      states: { idNumber: 'readable', fullName: 'check', dateOfBirth: 'readable', gender: 'readable', permanentAddress: 'check' },
    });
    render(<CCCDQrUpload onParsed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quét bằng camera' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture full card' }));
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'camera.jpg' }),
      expect.objectContaining({ mode: 'image' }),
    ));
    await screen.findByTestId('cccd-ocr-review');
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.ocrRead).toHaveBeenCalledWith(expect.objectContaining({ name: 'camera.jpg' }), expect.anything());
  });

  it('releases an existing upload scanner before opening the camera worker', async () => {
    mocks.scan.mockReturnValueOnce(new Promise(() => {}));
    render(<CCCDQrUpload onParsed={vi.fn()} />);
    fireEvent.change(screen.getByTestId('cccd-qr-file-input'), { target: { files: [new File(['qr'], 'pending.png', { type: 'image/png' })] } });
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Quét bằng camera' }));
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
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
