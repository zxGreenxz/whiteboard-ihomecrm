import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, CheckCircle2, Loader2, QrCode, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CCCDQrData } from '@/lib/cccdQrParser';
import CCCDQrCameraScanner from './CCCDQrCameraScanner';
import { useCccdQrInput, type CccdQrInputStatus } from './useCccdQrInput';

interface CCCDQrUploadProps {
  onParsed: (data: CCCDQrData, taskId: number) => void | Promise<void>;
  onTaskStart?: (taskId: number) => void;
}

const statusMessage: Partial<Record<CccdQrInputStatus, string>> = {
  'image-invalid': 'Ảnh không hợp lệ hoặc định dạng chưa được hỗ trợ.',
  'engine-unavailable': 'Bộ đọc QR chưa sẵn sàng. Vui lòng thử lại.',
  'not-found': 'Không tìm thấy mã QR trong ảnh.',
  'not-cccd': 'Mã QR trong ảnh không phải QR CCCD hợp lệ.',
  ambiguous: 'Ảnh có nhiều QR CCCD. Vui lòng chọn ảnh chỉ có một thẻ.',
};

export default function CCCDQrUpload({ onParsed, onTaskStart }: CCCDQrUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraSuccess, setCameraSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const currentTaskIdRef = useRef(0);
  const onParsedRef = useRef(onParsed);
  const onTaskStartRef = useRef(onTaskStart);
  onParsedRef.current = onParsed;
  onTaskStartRef.current = onTaskStart;

  const handleTaskStart = useCallback((taskId: number) => {
    currentTaskIdRef.current = taskId;
    setCameraSuccess(false);
    onTaskStartRef.current?.(taskId);
  }, []);
  const qr = useCccdQrInput({ onParsed, onTaskStart: handleTaskStart });
  const { acceptFile, reset } = qr;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files[0];
    if (file) void acceptFile(file);
  }, [acceptFile]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void acceptFile(file);
    event.target.value = '';
  }, [acceptFile]);

  const handleCameraParsed = useCallback(async (data: CCCDQrData) => {
    const taskId = reset();
    await onParsedRef.current(data, taskId);
    if (mountedRef.current && currentTaskIdRef.current === taskId) {
      setCameraSuccess(true);
    }
  }, [reset]);

  const error = statusMessage[qr.status];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <QrCode className="h-4 w-4 text-green-600" />
        <h3 className="text-sm font-semibold text-gray-700">Quét QR CCCD</h3>
        <span className="text-xs text-muted-foreground flex-1 min-w-[120px]">
          Camera/upload/Ctrl+V để tự động điền thông tin
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setCameraOpen(true)}
        >
          <Camera className="h-3.5 w-3.5" />
          Quét bằng camera
        </Button>
      </div>

      <div
        ref={qr.zoneRef}
        data-testid="cccd-qr-zone"
        data-clipboard-image-paste-target="qr"
        tabIndex={0}
        role="button"
        aria-label="Chọn hoặc dán ảnh QR CCCD"
        onMouseEnter={qr.onMouseEnter}
        onMouseLeave={qr.onMouseLeave}
        onDrop={handleDrop}
        onDragOver={(event) => { event.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onClick={(event) => {
          event.currentTarget.focus();
          inputRef.current?.click();
        }}
        className={cn(
          'w-full min-h-28 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
          isDragOver ? 'border-green-500 bg-green-50' : 'border-gray-300 hover:border-gray-400 bg-gray-50',
        )}
      >
        {qr.previewUrl ? (
          <div className="flex items-start gap-3 p-2">
            <div className="relative w-24 h-24 rounded-md border overflow-hidden bg-white shrink-0">
              <img src={qr.previewUrl} alt="QR CCCD đang xử lý" className="w-full h-full object-contain" />
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); qr.reset(); }}
                className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1"
                aria-label="Xoá ảnh QR"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="flex-1 text-sm pt-1">
              {qr.status === 'decoding' && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang đọc QR...</span>
                </div>
              )}
              {qr.status === 'success' && (
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Đã tự động điền thông tin CCCD.</span>
                </div>
              )}
              {error && (
                <div className="flex items-center gap-2 text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  <span>{error}</span>
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">Dán hoặc chọn ảnh khác để thay thế.</p>
            </div>
          </div>
        ) : (
          <div className="flex h-28 flex-col items-center justify-center">
            <QrCode className="h-6 w-6 text-muted-foreground" />
            <span className="text-xs text-muted-foreground mt-1">
              Kéo thả, click hoặc Ctrl+V ảnh chứa mã QR CCCD
            </span>
            {cameraSuccess && (
              <span className="mt-1 text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Đã đọc QR từ camera
              </span>
            )}
            {error && <span className="mt-1 text-xs text-red-600">{error}</span>}
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        data-testid="cccd-qr-file-input"
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      <CCCDQrCameraScanner
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onParsed={handleCameraParsed}
      />
    </div>
  );
}
