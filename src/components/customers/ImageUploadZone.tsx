import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { financialPending } from '@/lib/financialPending';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useState, useCallback, useRef } from 'react';
import { X, ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { imageValidation } from '@/lib/vehicleValidation';
import { uploadFile, type UploadImagePolicy } from '@/lib/storage';
import { StorageImage } from '@/components/ui/storage-image';
import { getSessionUser } from "@/lib/authSession";
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';

/**
 * VÌ SAO Ô ẢNH KHÔNG DÙNG DẤU "CHỜ ĐỐI CHIẾU" (23/11/2026):
 * Mỗi lần tải là một tên tệp MỚI (`<uid>/<thời điểm>-<stt>.<đuôi>`, upsert:false) và đường
 * dẫn chỉ tới biểu mẫu khi tải xong. Lần tải hỏng giữa chừng — kể cả khi máy chủ lỡ lưu —
 * chỉ để lại tệp mồ côi chưa gắn vào hồ sơ nào, nên tải lại luôn an toàn, không trùng gì.
 * Trước đây ô này ghi dấu chờ đối chiếu bền trong trình duyệt theo người dùng + tên ô mà
 * không có bước đối chiếu: một lần rớt mạng trên iPhone khoá ô "CCCD mặt trước" của người đó
 * ở MỌI khách, tải lại trang hay đăng xuất cũng không gỡ được.
 */
const DAU_CHO_CU = 'image-upload-zone';
function boDauChoCu(userId: string, bucket: string, label: string) {
  try {
    // 'actor-scope' là phạm vi persistentFinancialWorkflow dùng cho {scope:'actor'}.
    const scope = { namespace: DAU_CHO_CU, userId, organizationId: 'actor-scope', businessKey: `${bucket}:${label}` };
    const prior = financialPending.read(scope);
    if (prior) financialPending.clearConfirmed(scope, prior.attemptId);
  } catch {
    // Không còn đường nào đọc dấu này nữa; đọc/gỡ hỏng không được chặn việc tải ảnh.
  }
}

const CHUA_TAI_XONG = 'Chưa tải xong ảnh — mạng chập chờn hoặc bị ngắt giữa chừng. Ảnh chưa gắn vào hồ sơ; bấm "Thử lại ảnh chưa tải" hoặc chọn lại ảnh.';
function loiTaiAnh(error: unknown): string {
  if (error instanceof FinancialWorkflowError) return error.outcome === 'failure' ? error.message : CHUA_TAI_XONG;
  return recordWriteBlocked(error) ? CHUA_TAI_XONG : recordWriteMessage(error, 'tải ảnh');
}

interface ImageUploadZoneProps {
  label: string;
  value?: string;
  onChange: (url: string) => void;
  accept?: string;
  maxSizeMB?: number;
  bucket?: string;
  allowRoomVideo?: boolean;
  imagePolicy?: UploadImagePolicy;
  /** Cho phép chọn / kéo thả / dán nhiều ảnh cùng lúc. */
  multiple?: boolean;
  /**
   * Chỉ dùng khi multiple: gọi MỘT lần với tất cả URL upload thành công.
   * Bắt buộc dùng callback gộp (không gọi onChange nhiều lần) để tránh clobber
   * state khi caller append vào mảng (`[...imgs, url]`) — các lần gọi liên tiếp
   * sẽ ghi đè nhau vì cùng đọc một `imgs` cũ.
   */
  onAddMany?: (urls: string[]) => void;
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}

export default function ImageUploadZone({
  label,
  value,
  onChange,
  accept = 'image/png,image/jpeg,image/jpg',
  maxSizeMB = 10,
  bucket = 'customer-images',
  imagePolicy,
  allowRoomVideo = false,
  multiple = false,
  onAddMany,
  disabled = false,
  onUploadingChange,
}: ImageUploadZoneProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isClipboardHover, setIsClipboardHover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const [failedFiles,setFailedFiles]=useState<File[]>([]);

  const validateFile = useCallback(
    (file: File): string | null => {
      if (allowRoomVideo && bucket === 'room-sale-images' && file.type === 'video/mp4') {
        if (!/\.mp4$/i.test(file.name)) return 'Video phải có đuôi .mp4';
        return file.size > 0 && file.size <= 32 * 1024 * 1024 ? null : 'Video MP4 tối đa 32 MB';
      }
      const result = imageValidation.validate(file);
      if (!result.valid) return result.error || 'File không hợp lệ';
      if (maxSizeMB !== 10 && file.size > maxSizeMB * 1024 * 1024) {
        return `Kích thước file tối đa ${maxSizeMB}MB`;
      }
      return null;
    },
    [maxSizeMB, allowRoomVideo, bucket]
  );

  const handleUpload = useCallback(
    async (files: File[]) => {
      if(busy.current || disabled)return;
      const picked=multiple?files:files.slice(0,1);if(!picked.length)return;
      const valid:File[]=[];const failed:File[]=[];const messages:string[]=[];
      for(const file of picked){const problem=validateFile(file);if(problem){failed.push(file);messages.push(`${file.name}: ${problem}`);}else valid.push(file);}
      if(!valid.length){setFailedFiles(failed);setError(messages.join(' '));zoneRef.current?.focus();return;}
      busy.current=true;setIsUploading(true);onUploadingChange?.(true);setUploadingCount(valid.length);setError(null);
      const urls:string[]=[];
      try {
        let user:Awaited<ReturnType<typeof getSessionUser>>=null;let noSession='Phiên đăng nhập đã hết. Đăng nhập lại trước khi tải ảnh.';
        try{user=await getSessionUser();}catch(error){noSession=recordWriteMessage(error,'đọc phiên đăng nhập');}
        if(!user){failed.push(...valid);messages.push(noSession);}
        else{
          boDauChoCu(user.id,bucket,label);
          for(let i=0;i<valid.length;i++){
            const file=valid[i];
            try{
              const ext=file.name.split('.').pop()||'jpg';const path=`${user.id}/${Date.now()}-${i}.${ext}`;
              const saved=imagePolicy?await uploadFile(bucket,path,file,{imagePolicy}):await uploadFile(bucket,path,file);
              if(typeof saved!=='string'||!saved.trim())throw new FinancialWorkflowError(CHUA_TAI_XONG,'unknown',[]);
              urls.push(saved);
            }catch(error){
              failed.push(file);messages.push(`${file.name}: ${loiTaiAnh(error)}`);
              // Kết quả chưa rõ thường là mất mạng: dừng các ảnh còn lại, giữ chúng để Thử lại.
              if(recordWriteBlocked(error)){
                const rest=valid.slice(i+1);failed.push(...rest);
                if(rest.length)messages.push(`Chưa gửi: ${rest.map(item=>item.name).join(', ')}.`);
                break;
              }
            }
          }
        }
        if(urls.length){if(multiple&&onAddMany)onAddMany(urls);else onChange(urls[0]);}
        setFailedFiles(failed);
        setError(messages.length?`${picked.length>1?`Đã tải ${urls.length}/${picked.length} ảnh. `:''}${messages.join(' ')}`:null);
        if(messages.length)zoneRef.current?.focus();
      }finally{busy.current=false;setIsUploading(false);onUploadingChange?.(false);setUploadingCount(0);}

    },
    [bucket, label, imagePolicy, multiple, onAddMany, onChange, validateFile, disabled, onUploadingChange]
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
    if(busy.current || disabled)return;
    onChange('');
  }, [onChange, disabled]);

  const { onMouseEnter: onPasteMouseEnter, onMouseLeave: onPasteMouseLeave } = useClipboardImagePaste({
    onFiles: (files) => handleUpload(files),
    enabled: !value && !isUploading && !disabled,
    multiple,
  });
  const handleClipboardMouseEnter = useCallback(() => {
    setIsClipboardHover(true);
    onPasteMouseEnter();
  }, [onPasteMouseEnter]);
  const handleClipboardMouseLeave = useCallback(() => {
    setIsClipboardHover(false);
    onPasteMouseLeave();
  }, [onPasteMouseLeave]);

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
            disabled={disabled || isUploading}
            onClick={handleRemove}
            className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div
          ref={zoneRef}
          role="button"
          tabIndex={0}
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-disabled={isUploading || disabled}
          onKeyDown={event=>{if((event.key==='Enter'||event.key===' ')&&!busy.current&&!disabled){event.preventDefault();inputRef.current?.click();}}}
          data-clipboard-image-paste-target="upload"
          data-clipboard-image-paste-active={isClipboardHover && !isUploading ? 'true' : undefined}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => {if(!busy.current&&!disabled)inputRef.current?.click();}}
          onMouseEnter={handleClipboardMouseEnter}
          onMouseLeave={handleClipboardMouseLeave}
          className={cn(
            'flex flex-col items-center justify-center w-full h-32 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
            isDragOver
              ? 'border-primary bg-primary/5'
              : 'border-gray-300 hover:border-gray-400 bg-gray-50',
            (isUploading || disabled) && 'pointer-events-none opacity-60'
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
                  ? (allowRoomVideo ? 'Chọn ảnh hoặc video MP4 (tối đa 32 MB/video)' : 'Kéo thả, click hoặc Ctrl+V để tải nhiều ảnh')
                  : 'Kéo thả, click hoặc Ctrl+V để tải ảnh'}
              </span>
            </div>
          )}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        aria-label={`Chọn ${label}`}
        disabled={isUploading || disabled}
        accept={accept}
        multiple={multiple}
        onChange={handleFileChange}
        className="hidden"
      />
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {failedFiles.length>0&&<button type="button" disabled={isUploading || disabled} onClick={()=>{void handleUpload(failedFiles);}} className="text-sm underline">Thử lại ảnh chưa tải</button>}
    </div>
  );
}
