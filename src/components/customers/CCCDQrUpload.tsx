import { useCallback, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { QrCode, Loader2, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { parseCccdQr, type CCCDQrData } from '@/lib/cccdQrParser';
import { toast } from 'sonner';

interface CCCDQrUploadProps {
  onParsed: (data: CCCDQrData) => void;
}

/**
 * Decode QR từ một File (PNG/JPG). Trả chuỗi đã decode hoặc null.
 * Dùng canvas + jsQR. Resize ảnh lớn xuống tối đa 1600px để tăng tốc.
 */
async function decodeQrFromFile(file: File): Promise<string | null> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Không thể đọc ảnh'));
    el.src = dataUrl;
  });

  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);

  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  return result ? result.data : null;
}

export default function CCCDQrUpload({ onParsed }: CCCDQrUploadProps) {
  const [isDecoding, setIsDecoding] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          toast.error('Không phát hiện được mã QR. Thử ảnh rõ nét hơn.');
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

  const pasteHandlers = useClipboardImagePaste({
    onFiles: (files) => void handleFile(files[0]),
    enabled: !isDecoding,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <QrCode className="h-4 w-4 text-green-600" />
        <h3 className="text-sm font-semibold text-gray-700">Quét QR CCCD</h3>
        <span className="text-xs text-muted-foreground">
          Chụp/upload/Ctrl+V ảnh có mã QR để tự động điền thông tin
        </span>
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
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
