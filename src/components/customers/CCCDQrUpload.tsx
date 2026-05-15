import { useCallback, useRef, useState } from 'react';
import { QrCode, Loader2, X, CheckCircle2, AlertCircle, Camera } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { parseCccdQr, type CCCDQrData } from '@/lib/cccdQrParser';
import { decodeQrFromFile } from '@/lib/qrDecoder';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import CCCDQrCameraScanner from './CCCDQrCameraScanner';

interface CCCDQrUploadProps {
  onParsed: (data: CCCDQrData) => void;
}

export default function CCCDQrUpload({ onParsed }: CCCDQrUploadProps) {
  const [isDecoding, setIsDecoding] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('File không phải ảnh');
        return;
      }
      setError(null);
      setSuccess(false);
      setIsDecoding(true);
      const previewUrl = URL.createObjectURL(file);
      setPreview(previewUrl);

      try {
        const qrText = await decodeQrFromFile(file);
        if (!qrText) {
          setError('Không phát hiện được mã QR trong ảnh');
          toast.error('Không phát hiện được mã QR. Thử ảnh rõ nét hơn hoặc dùng camera.');
          return;
        }
        const parsed = parseCccdQr(qrText);
        if (!parsed) {
          setError('QR rỗng');
          return;
        }
        onParsed(parsed);
        setSuccess(true);
        toast.success('Đã đọc thông tin từ QR CCCD');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Lỗi khi đọc QR';
        setError(msg);
        toast.error(msg);
      } finally {
        setIsDecoding(false);
      }
    },
    [onParsed]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsDragOver(false), []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      if (inputRef.current) inputRef.current.value = '';
    },
    [handleFile]
  );

  const handleReset = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setSuccess(false);
    setError(null);
  }, [preview]);

  const handleCameraParsed = useCallback(
    (data: CCCDQrData) => {
      onParsed(data);
      setSuccess(true);
      setError(null);
      setPreview(null);
    },
    [onParsed]
  );

  const pasteHandlers = useClipboardImagePaste({
    onFiles: (files) => void handleFile(files[0]),
    enabled: !isDecoding,
  });

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

      {preview ? (
        <div className="flex items-start gap-3">
          <div className="relative w-32 h-32 rounded-lg border overflow-hidden bg-gray-50 shrink-0">
            <img src={preview} alt="QR" className="w-full h-full object-contain" />
            <button
              type="button"
              onClick={handleReset}
              className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1"
              aria-label="Xoá ảnh QR"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="flex-1 text-sm">
            {isDecoding && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Đang đọc QR...</span>
              </div>
            )}
            {success && !isDecoding && (
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                <span>Đã tự động điền các trường thông tin bên dưới.</span>
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 text-red-600">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
          {...pasteHandlers}
          className={cn(
            'flex flex-col items-center justify-center w-full h-28 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
            isDragOver
              ? 'border-green-500 bg-green-50'
              : 'border-gray-300 hover:border-gray-400 bg-gray-50'
          )}
        >
          <QrCode className="h-6 w-6 text-muted-foreground" />
          <span className="text-xs text-muted-foreground mt-1">
            Kéo thả, click hoặc Ctrl+V ảnh chứa mã QR CCCD
          </span>
          {success && (
            <span className="mt-1 text-xs text-green-600 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Đã đọc QR từ camera
            </span>
          )}
        </div>
      )}

      <input
        ref={inputRef}
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
