import { useState, useCallback, useRef, useEffect, useId } from 'react';
import { Upload, X, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { uploadFile, deleteFile } from '@/lib/storage';
import { StorageImage } from '@/components/ui/storage-image';
import { friendlyError } from '@/lib/friendlyError';
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
  const errorId = useId();
  const [failures, setFailures] = useState<Array<{ file: File; reason: string; retryable: boolean }>>([]);
  const [summary, setSummary] = useState('');
  const [removeError, setRemoveError] = useState('');

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
        setFailures(fileArray.map(file => ({ file, reason: `Chỉ đính kèm tối đa ${maxFiles} tệp. Gỡ bớt tệp trước khi tải thêm.`, retryable: true })));
        return;
      }
      uploadActive.current = true;
      setIsUploading(true);
      onUploadingChange?.(true);

      try {
        const newUrls: string[] = [];
        const failed: typeof failures = [];

        for (const file of fileArray) {
          const error = validateAttachmentFile(file);
          if (error) {
            failed.push({ file, reason: error, retryable: false });
            continue;
          }

          try {
            const safeName = file.name.replace(/[^\w.\-]+/g, '_');
            const path = `${userId}/${Date.now()}-${safeName}`;
            const publicUrl = await uploadFile(BUCKET, path, file);
            sessionUploads.current.add(publicUrl);
            newUrls.push(publicUrl);
          } catch (err: unknown) {
            console.error('[AttachmentUpload] upload failed:', err);
            const feedback = friendlyError(err, `Chưa tải được tệp ${file.name}`, { operation: 'tải chứng từ' });
            failed.push({ file, reason: feedback.description, retryable: true });
          }
        }

        if (newUrls.length > 0) {
          onChange([...attachments, ...newUrls]);
        }
        setFailures(previous => [...previous.filter(item => !fileArray.includes(item.file)), ...failed]);
        setSummary(`Đã tải ${newUrls.length}/${fileArray.length} tệp. ${failed.length ? `${failed.length} tệp chưa tải được.` : 'Các tệp đã được thêm vào biểu mẫu.'}`);
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
      setRemoveError('');

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
        } catch (error) {
          console.error('[AttachmentUpload] delete failed:', error);
          const name = url.split('/').pop()?.split('?')[0] || 'đính kèm';
          setRemoveError(`Chưa xóa được tệp ${name}. Tệp vẫn được giữ trong danh sách; kiểm tra lại trước khi gỡ.`);
          return;
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
          role="button"
          tabIndex={isUploading ? -1 : 0}
          aria-label="Thêm chứng từ"
          aria-invalid={failures.length > 0}
          aria-describedby={failures.length > 0 ? errorId : undefined}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inputRef.current?.click(); } }}
          {...pasteHandlers}
          className={cn(
            'flex flex-col items-center justify-center w-full h-28 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
            isDragOver
              ? 'border-primary bg-primary/5'
              : 'border-gray-300 hover:border-gray-400 bg-gray-50',
            isUploading && 'pointer-events-none opacity-60'
            , failures.length > 0 && 'border-destructive'
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
      {summary && <p role="status" className="text-sm">{summary}</p>}
      {removeError && <p role="alert" className="text-sm text-destructive">{removeError}</p>}
      {failures.length > 0 && (
        <div id={errorId} role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm text-destructive">
          {failures.map(({ file, reason, retryable }, index) => (
            <div key={`${file.name}-${index}`}>
              <p>Chưa tải được tệp {file.name}. {reason}</p>
              <div className="flex gap-3">
                {retryable && <button type="button" disabled={disabled || isUploading} className="underline" aria-label={`Thử lại ${file.name}`} onClick={() => void handleUpload([file])}>Thử lại tệp này</button>}
                <button type="button" disabled={isUploading} className="underline" onClick={() => setFailures(current => current.filter(item => item.file !== file))}>Bỏ khỏi danh sách chờ</button>
              </div>
            </div>
          ))}
        </div>
      )}

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
                  title={deleteOnRemove && sessionUploads.current.has(url) && url.includes(`/object/public/${BUCKET}/`) ? 'Xóa tệp vừa tải khỏi kho và biểu mẫu' : 'Gỡ khỏi biểu mẫu; tệp đã lưu vẫn được giữ'}
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
