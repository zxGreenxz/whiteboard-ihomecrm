import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useState, useCallback, useRef } from 'react';
import { Upload, X, ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { imageValidation } from '@/lib/vehicleValidation';
import { uploadFile, type UploadImagePolicy } from '@/lib/storage';
import { StorageImage } from '@/components/ui/storage-image';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';

interface ImageUploadZoneProps {
  label: string;
  value?: string;
  onChange: (url: string) => void;
  accept?: string;
  maxSizeMB?: number;
  bucket?: string;
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
}

export default function ImageUploadZone({
  label,
  value,
  onChange,
  accept = 'image/png,image/jpeg,image/jpg',
  maxSizeMB = 10,
  bucket = 'customer-images',
  imagePolicy,
  multiple = false,
  onAddMany,
}: ImageUploadZoneProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isClipboardHover, setIsClipboardHover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const guard = useRef(persistentFinancialWorkflow('image-upload-zone',{scope:'actor'}));
  const [blocked,setBlocked]=useState(false);
  const [failedFiles,setFailedFiles]=useState<File[]>([]);

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
      if(busy.current || blocked)return;
      const picked=multiple?files:files.slice(0,1);if(!picked.length)return;
      const valid:File[]=[];const failed:File[]=[];const messages:string[]=[];
      for(const file of picked){const problem=validateFile(file);if(problem){failed.push(file);messages.push(`${file.name}: ${problem}`);}else valid.push(file);}
      if(!valid.length){setFailedFiles(failed);setError(messages.join(' '));zoneRef.current?.focus();return;}
      busy.current=true;setIsUploading(true);setUploadingCount(valid.length);setError(null);
      const urls:string[]=[];
      try {
        for(let i=0;i<valid.length;i++){
          const file=valid[i];
          try{
            const url=await guard.current.run(`${bucket}:${label}`,'tải ảnh',async(progress)=>{
              const user=await getSessionUser();if(!user)throw new FinancialWorkflowError('Phiên đăng nhập đã hết. Đăng nhập lại trước khi tải ảnh.','failure',[]);
              const ext=file.name.split('.').pop()||'jpg';const path=`${user.id}/${Date.now()}-${i}.${ext}`;
              const saved=imagePolicy?await uploadFile(bucket,path,file,{imagePolicy}):await uploadFile(bucket,path,file);
              if(typeof saved!=='string'||!saved.trim())throw new FinancialWorkflowError('Chưa xác nhận được đường dẫn ảnh. Giữ tệp để đối chiếu.','unknown',[{id:`${bucket}/${path}`,label:'Đường dẫn ảnh cần đối chiếu'}]);
              return saved;
            });
            urls.push(url);
          }catch(error){
            failed.push(file);messages.push(`${file.name}: ${recordWriteMessage(error,'tải ảnh')}`);
            if(recordWriteBlocked(error)){
              setBlocked(true);const rest=valid.slice(i+1);failed.push(...rest);
              if(rest.length)messages.push(`Chưa gửi: ${rest.map(item=>item.name).join(', ')}.`);
              break;
            }
          }
        }
        if(urls.length){if(multiple&&onAddMany)onAddMany(urls);else onChange(urls[0]);}
        setFailedFiles(failed);
        setError(messages.length?`Đã nhận đường dẫn ${urls.length}/${picked.length} ảnh. ${messages.join(' ')}`:null);
        if(messages.length)zoneRef.current?.focus();
      }finally{busy.current=false;setIsUploading(false);setUploadingCount(0);}

    },
    [bucket, label, imagePolicy, multiple, onAddMany, onChange, validateFile, blocked]
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
    if(busy.current || blocked)return;
    onChange('');
  }, [onChange]);

  const { onMouseEnter: onPasteMouseEnter, onMouseLeave: onPasteMouseLeave } = useClipboardImagePaste({
    onFiles: (files) => handleUpload(files),
    enabled: !value && !isUploading && !blocked,
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
          aria-disabled={isUploading || blocked}
          onKeyDown={event=>{if((event.key==='Enter'||event.key===' ')&&!busy.current&&!blocked){event.preventDefault();inputRef.current?.click();}}}
          data-clipboard-image-paste-target="upload"
          data-clipboard-image-paste-active={isClipboardHover && !isUploading ? 'true' : undefined}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => {if(!busy.current&&!blocked)inputRef.current?.click();}}
          onMouseEnter={handleClipboardMouseEnter}
          onMouseLeave={handleClipboardMouseLeave}
          className={cn(
            'flex flex-col items-center justify-center w-full h-32 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
            isDragOver
              ? 'border-primary bg-primary/5'
              : 'border-gray-300 hover:border-gray-400 bg-gray-50',
            (isUploading || blocked) && 'pointer-events-none opacity-60'
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
        aria-label={`Chọn ${label}`}
        disabled={isUploading || blocked}
        accept={accept}
        multiple={multiple}
        onChange={handleFileChange}
        className="hidden"
      />
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {failedFiles.length>0&&!blocked&&<button type="button" disabled={isUploading} onClick={()=>{void handleUpload(failedFiles);}} className="text-sm underline">Thử lại ảnh chưa tải</button>}
    </div>
  );
}
