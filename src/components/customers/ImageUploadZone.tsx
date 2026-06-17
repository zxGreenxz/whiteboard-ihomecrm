import { useState, useCallback, useRef } from 'react';
import { Upload, X, ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { imageValidation } from '@/lib/vehicleValidation';
import { uploadFile } from '@/lib/storage';
import { StorageImage } from '@/components/ui/storage-image';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { toast } from 'sonner';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';

interface ImageUploadZoneProps {
  label: string;
  value?: string;
  onChange: (url: string) => void;
  accept?: string;
  maxSizeMB?: number;
  bucket?: string;
  /** Cho phép chọn / kéo thả / dán nhiều ảnh cùng lúc. */
  multiple?: boolean;
  /**
   * Chỉ dùng khi multiple: gọi MỘT lần với tất cả URL upload thành công.
   * Bắt buộc dùng callback gộp (không gọi onChange nhiều lần) để tránh clobber
   * state khi caller append vào mảng (`[...imgs, url]`) — các lần gọi liên tiếp
   * sẽ ghi đè nhau vì cùng đọc một `imgs` cũ.
   */
  onAddMany?: (urls: string[]) => void;
}

export default function ImageUploadZone({
  label,
  value,
  onChange,
  accept = 'image/png,image/jpeg,image/jpg',
  maxSizeMB = 10,
  bucket = 'customer-images',
  multiple = false,
  onAddMany,
}: ImageUploadZoneProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateFile = useCallback(
    (file: File): string | null => {
      const result = imageValidation.validate(file);
      if (!result.valid) return result.error || 'File không hợp lệ';
      if (maxSizeMB !== 10 && file.size > maxSizeMB * 1024 * 1024) {
        return `Kích thước file tối đa ${maxSizeMB}MB`;
      }
      return null;
    },
    [maxSizeMB]
  );

  const handleUpload = useCallback(
    async (files: File[]) => {
      // Lọc theo chế độ: single chỉ lấy file đầu.
      const picked = multiple ? files : files.slice(0, 1);
      if (picked.length === 0) return;

      // Validate trước; báo lỗi đầu tiên nhưng vẫn upload các file hợp lệ.
      const valid: File[] = [];
      let firstError: string | null = null;
      for (const f of picked) {
        const err = validateFile(f);
        if (err) {
          if (!firstError) firstError = err;
        } else {
          valid.push(f);
        }
      }
      setError(firstError);
      if (valid.length === 0) return;

      setIsUploading(true);
      setUploadingCount(valid.length);

      try {
        const user = await getSessionUser();
        if (!user) throw new Error('Not authenticated');

        const urls: string[] = [];
        for (let i = 0; i < valid.length; i++) {
          const file = valid[i];
          const ext = file.name.split('.').pop() || 'jpg';
          // Hậu tố index để không trùng path khi upload nhiều file trong cùng ms.
          const path = `${user.id}/${Date.now()}-${i}.${ext}`;
          try {
            urls.push(await uploadFile(bucket, path, file));
          } catch (err) {
            console.error('Upload error:', err);
            toast.error(
              valid.length > 1
                ? `Không thể tải lên "${file.name}".`
                : 'Không thể tải ảnh lên. Vui lòng thử lại.'
            );
          }
        }

        if (urls.length === 0) return;
        if (multiple && onAddMany) onAddMany(urls);
        else onChange(urls[0]);
      } catch (err) {
        console.error('Upload error:', err);
        toast.error('Không thể tải ảnh lên. Vui lòng thử lại.');
      } finally {
        setIsUploading(false);
        setUploadingCount(0);
      }
    },
    [bucket, multiple, onAddMany, onChange, validateFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      handleUpload(Array.from(e.dataTransfer.files));
    },
    [handleUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleUpload(Array.from(e.target.files ?? []));
      if (inputRef.current) inputRef.current.value = '';
    },
    [handleUpload]
  );

  const handleRemove = useCallback(() => {
    onChange('');
    setError(null);
  }, [onChange]);

  const pasteHandlers = useClipboardImagePaste({
    onFiles: (files) => handleUpload(files),
    enabled: !value && !isUploading,
    multiple,
  });

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {value ? (
        <div className="relative group w-full h-32 rounded-lg border overflow-hidden">
          <StorageImage
            value={value}
            alt={label}
            className="w-full h-full object-cover"
          />
          <button
            type="button"
            onClick={handleRemove}
            className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
          {...pasteHandlers}
          className={cn(
            'flex flex-col items-center justify-center w-full h-32 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
            isDragOver
              ? 'border-primary bg-primary/5'
              : 'border-gray-300 hover:border-gray-400 bg-gray-50',
            isUploading && 'pointer-events-none opacity-60'
          )}
        >
          {isUploading ? (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-xs">
                {uploadingCount > 1 ? `Đang tải ${uploadingCount} ảnh...` : 'Đang tải...'}
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <ImageIcon className="h-6 w-6" />
              <span className="text-xs text-center px-2">
                {multiple
                  ? 'Kéo thả, click hoặc Ctrl+V để tải nhiều ảnh'
                  : 'Kéo thả, click hoặc Ctrl+V để tải ảnh'}
              </span>
            </div>
          )}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleFileChange}
        className="hidden"
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
