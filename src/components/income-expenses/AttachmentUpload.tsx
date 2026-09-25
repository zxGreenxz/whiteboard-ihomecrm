import { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, X, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { uploadFile, deleteFile } from '@/lib/storage';
import { StorageImage } from '@/components/ui/storage-image';
import { toast } from 'sonner';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';

const DEFAULT_BUCKET = 'income-expense-attachments';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const ACCEPT_STRING = 'image/jpeg,image/png,application/pdf';

interface AttachmentUploadProps {
  attachments: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
  userId: string;
  bucket?: string;
  onUploadingChange?: (uploading: boolean) => void;
  maxFiles?: number;
  /**
   * Cho nút X xoá file khỏi kho lưu trữ (mặc định true). Kể cả khi bật, X CHỈ
   * xoá file do chính lần gắn component này tải lên (E1, 25/09/2026); ảnh có
   * sẵn truyền vào qua `attachments` chỉ được gỡ khỏi danh sách. `false` = X
   * không bao giờ xoá file.
   */
  deleteOnRemove?: boolean;
}

/**
 * Validates file type and size.
 * Returns error message string if invalid, null if valid.
 */
export function validateAttachmentFile(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return 'Chỉ chấp nhận file JPG, PNG, PDF';
  }
  if (file.size > MAX_FILE_SIZE) {
    return 'Kích thước file tối đa 5MB';
  }
  return null;
}

export default function AttachmentUpload({
  attachments,
  onChange,
  disabled = false,
  userId,
  bucket = DEFAULT_BUCKET,
  onUploadingChange,
  maxFiles = Infinity,
  deleteOnRemove = true,
}: AttachmentUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadActive = useRef(false);

  /**
   * URL do CHÍNH lần mở form/hộp này tải lên — chỉ những file này X mới được xoá
   * khỏi kho (E1, 25/09/2026).
   *
   * Ảnh có sẵn (form Sửa, form Tạo bản sao, hộp Duyệt) là chứng từ của phiếu đã
   * lưu. Bản sao còn dùng CHUNG URL với phiếu gốc, nên trước đây bấm X để bỏ ảnh
   * khỏi bản sao là xoá mất file chứng từ của phiếu gốc. Không suy từ tên file
   * được: ảnh cũ cũng nằm đúng thư mục `<userId>/…` của người đang thao tác.
   */
  const sessionUploads = useRef<Set<string>>(new Set());
  useEffect(() => {
    const uploads = sessionUploads.current;
    return () => uploads.clear();
  }, []);

  const BUCKET = bucket;

  const handleUpload = useCallback(
    async (files: FileList | File[]) => {
      if (disabled || !userId || uploadActive.current) return;

      const fileArray = Array.from(files);
      if (attachments.length + fileArray.length > maxFiles) {
        toast.error(`Chỉ đính kèm tối đa ${maxFiles} tệp.`);
        return;
      }
      uploadActive.current = true;
      setIsUploading(true);
      onUploadingChange?.(true);

      try {
        const newUrls: string[] = [];

        for (const file of fileArray) {
          const error = validateAttachmentFile(file);
          if (error) {
            toast.error(error);
            continue;
          }

          try {
            const safeName = file.name.replace(/[^\w.\-]+/g, '_');
            const path = `${userId}/${Date.now()}-${safeName}`;
            const publicUrl = await uploadFile(BUCKET, path, file);
            sessionUploads.current.add(publicUrl);
            newUrls.push(publicUrl);
          } catch (err: any) {
            const msg = err?.message || err?.error || '';
            console.error('[AttachmentUpload] upload failed:', err);
            if (/bucket.*not.*found|404/i.test(msg)) {
              toast.error(
                `Bucket "${BUCKET}" chưa tồn tại. Hãy tạo bucket trên Supabase Storage hoặc apply migration.`
              );
            } else if (/row-level security|policy|permission|401|403/i.test(msg)) {
              toast.error('Bucket chặn quyền upload (RLS). Cần policy cho thư mục theo user id.');
            } else {
              toast.error(`Không thể tải lên: ${msg || 'lỗi không xác định'}`);
            }
          }
        }

        if (newUrls.length > 0) {
          onChange([...attachments, ...newUrls]);
        }
      } finally {
        uploadActive.current = false;
        setIsUploading(false);
        onUploadingChange?.(false);
      }
    },
    [attachments, disabled, onChange, userId, BUCKET, maxFiles, onUploadingChange]
  );

  const handleRemove = useCallback(
    async (url: string) => {
      if (disabled || uploadActive.current) return;

      // Ảnh có sẵn: chỉ gỡ khỏi danh sách của form, file giữ nguyên trong kho.
      if (deleteOnRemove && sessionUploads.current.has(url)) {
        try {
          // Extract path from URL: everything after /object/public/{bucket}/
          const marker = `/object/public/${BUCKET}/`;
          const idx = url.indexOf(marker);
          if (idx !== -1) {
            const path = decodeURIComponent(url.slice(idx + marker.length));
            await deleteFile(BUCKET, path);
          }
        } catch {
          toast.error('Không thể xóa file đính kèm');
        }
        sessionUploads.current.delete(url);
      }

      onChange(attachments.filter((a) => a !== url));
    },
    [attachments, disabled, onChange, BUCKET, deleteOnRemove]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        handleUpload(e.dataTransfer.files);
      }
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
      if (e.target.files && e.target.files.length > 0) {
        handleUpload(e.target.files);
      }
      if (inputRef.current) inputRef.current.value = '';
    },
    [handleUpload]
  );

  const pasteHandlers = useClipboardImagePaste({
    onFiles: (files) => handleUpload(files),
    enabled: !disabled && !isUploading,
    multiple: true,
  });

  const isPdf = (url: string) =>
    url.toLowerCase().endsWith('.pdf') || url.includes('.pdf');

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      {!disabled && (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
          {...pasteHandlers}
          className={cn(
            'flex flex-col items-center justify-center w-full h-28 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
            isDragOver
              ? 'border-primary bg-primary/5'
              : 'border-gray-300 hover:border-gray-400 bg-gray-50',
            isUploading && 'pointer-events-none opacity-60'
          )}
        >
          {isUploading ? (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-xs">Đang tải lên...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground">
              <Upload className="h-6 w-6" />
              <span className="text-xs">Kéo thả, click hoặc Ctrl+V để chọn file</span>
              <span className="text-[10px]">JPG, PNG, PDF — tối đa 5MB</span>
            </div>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_STRING}
        multiple
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Thumbnails */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((url) => (
            <div
              key={url}
              className="relative group w-20 h-20 rounded-lg border overflow-hidden bg-gray-100"
            >
              {isPdf(url) ? (
                <div className="flex items-center justify-center w-full h-full">
                  <FileText className="h-8 w-8 text-muted-foreground" />
                </div>
              ) : (
                <StorageImage
                  value={url}
                  alt="Đính kèm"
                  className="w-full h-full object-cover"
                />
              )}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemove(url)}
                  aria-label="Gỡ tệp đính kèm"
                  className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
