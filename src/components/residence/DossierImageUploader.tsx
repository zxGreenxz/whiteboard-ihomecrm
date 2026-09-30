// Một hàng ảnh của hồ sơ tạm trú (CT01 đã ký / hợp đồng đã ký / giấy chỗ ở hợp pháp):
// chụp trực tiếp bằng camera (điện thoại), chọn tệp từ máy, hoặc DÁN ảnh bằng Ctrl+V
// (ảnh chụp màn hình, ảnh sao chép từ Zalo/Telegram) — xem thumbnail, xoá.
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { DossierFileError } from '@/lib/residenceDossierFiles';
import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StorageImage } from '@/components/ui/storage-image';
import { DOSSIER_KIND_LABEL, dossierStorageValue, type DossierKind, type ResidenceDossierFile } from '@/lib/residenceDossierFiles';

export interface DossierImageUploaderProps {
  kind: DossierKind;
  files: ResidenceDossierFile[];
  canEdit: boolean;
  /** Hợp đồng gắn với ảnh CT01/LEASE; bỏ trống với ảnh của toà. */
  contractId?: string;
  onUpload: (input: { kind: DossierKind; contractId?: string; file: File }) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  hint?: string;
  /** Nội dung thêm dưới hàng ảnh (ví dụ hạn đọc được trên hợp đồng). */
  children?: React.ReactNode;
}

// Cổng DVC chỉ nhận pdf/jpg/jpeg/tiff/png, nên không mở cửa cho WebP ngay từ ô chọn tệp.
const PICK_ACCEPT = 'image/png,image/jpeg,image/jpg';

/** Mọi ảnh trong clipboard: Windows đặt ảnh chụp màn hình vào `files`, trình duyệt khác vào `items`. */
export function clipboardImages(event: ClipboardEvent): File[] {
  const clipboard = event.clipboardData;
  if (!clipboard) return [];
  const files = Array.from(clipboard.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length > 0) return files;
  return Array.from(clipboard.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
}

const isTextEntry = (el: Element | null) =>
  el instanceof HTMLElement && el.matches('input, textarea, [contenteditable="true"]');

export default function DossierImageUploader({ kind, files, canEdit, contractId, onUpload, onRemove, hint, children }: DossierImageUploaderProps) {
  const captureRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const [pending, setPending] = useState(0);
  const [failure,setFailure] = useState('');
  const [uploadBlocked,setUploadBlocked] = useState(false);
  const [deleteFailures,setDeleteFailures] = useState<Record<string,{message:string;blocked:boolean}>>({});
  const busy = useRef(false);
  const errorMessage = (error:unknown, operation:string) => error instanceof DossierFileError ? error.message : recordWriteMessage(error,operation);
  const [removing, setRemoving] = useState<string | null>(null);
  const label = DOSSIER_KIND_LABEL[kind];

  const handleFiles = async (picked: File[], input?: HTMLInputElement | null) => {
    if (input) input.value = '';
    if (picked.length === 0 || busy.current || uploadBlocked) return;
    busy.current = true;
    setFailure('');
    setPending(picked.length);
    let saved=0;
    const errors:string[]=[];
    try {
      // Tuần tự để thứ tự ảnh giữ đúng thứ tự người dùng chọn/chụp/dán.
      for (const [index,file] of picked.entries()) {
        try {
          await onUpload({ kind, contractId, file });
          saved += 1;
        } catch (error) {
          errors.push(`${file.name}: ${errorMessage(error,'tải ảnh hồ sơ')}`);
          if (recordWriteBlocked(error)) {
            setUploadBlocked(true);
            const remaining=picked.slice(index+1).map(next=>next.name);
            if (remaining.length) errors.push(`Chưa gửi các tệp: ${remaining.join(', ')}.`);
            break;
          }
        }
        setPending((n) => Math.max(0, n - 1));
      }
    } finally {
      busy.current = false;
      if (errors.length) { setFailure(`Đã tải ${saved}/${picked.length} ảnh. ${errors.join(' ')}`); zoneRef.current?.focus(); }
      setPending(0);
    }
  };
  const handleFilesRef = useRef(handleFiles);
  handleFilesRef.current = handleFiles;

  // Dán ảnh bằng Ctrl+V khi con trỏ đang ở trên khối này hoặc khối đang có tiêu điểm.
  // Nghe ở window (capture) như khối quét QR CCCD, và nhường nếu khối khác đang
  // giữ clipboard (`data-clipboard-image-paste-active`) hoặc người dùng đang gõ
  // ở một ô nhập ngoài khối.
  useEffect(() => {
    if (!canEdit) return;
    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const zone = zoneRef.current;
      const active = document.activeElement;
      const ownsFocus = !!(zone && active && zone.contains(active));
      if (!hovered.current && !ownsFocus) return;
      if (isTextEntry(active) && !ownsFocus) return;
      const other = document.querySelector('[data-clipboard-image-paste-active="true"]');
      if (other && other !== zone) return;
      const images = clipboardImages(event);
      if (images.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void handleFilesRef.current(images);
    };
    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, [canEdit]);

  const setHovered = (value: boolean) => {
    hovered.current = value;
    zoneRef.current?.setAttribute('data-clipboard-image-paste-active', value ? 'true' : 'false');
  };

  return (
    <div ref={zoneRef} className="space-y-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" data-dossier-kind={kind}
      data-clipboard-image-paste-target={`dossier-${kind}`}
      tabIndex={canEdit ? 0 : undefined}
      aria-label={canEdit ? `${label}: dán ảnh bằng Ctrl+V` : undefined}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {label} <span className="text-muted-foreground font-normal">({files.length} ảnh)</span>
        </p>
        {canEdit && (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={pending > 0 || uploadBlocked} onClick={() => captureRef.current?.click()}>
              <Camera className="h-4 w-4" /> Chụp ảnh
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending > 0 || uploadBlocked} onClick={() => pickRef.current?.click()}
              title="Chọn tệp từ máy, hoặc đưa chuột vào đây rồi bấm Ctrl+V để dán ảnh">
              {pending > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              {pending > 0 ? `Đang tải ${pending} ảnh…` : 'Chọn tệp'}
            </Button>
          </div>
        )}
      </div>
      {(hint || canEdit) && (
        <p className="text-xs text-muted-foreground">
          {hint}{hint ? ' ' : ''}{canEdit && 'Hoặc đưa chuột vào đây rồi bấm Ctrl+V để dán ảnh.'}
        </p>
      )}
      {failure && <p role="alert" className="text-xs text-destructive">{failure}</p>}
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={`Ảnh ${label}`}>
          {files.map((file) => (
            <li key={file.id} className="relative group h-24 w-24 overflow-hidden rounded-md border">
              <StorageImage value={dossierStorageValue(file)} alt={file.file_name || label} className="h-full w-full object-cover" />
              {canEdit && (
                <button type="button" aria-label="Xoá ảnh" disabled={removing !== null || deleteFailures[file.id]?.blocked}
                  onClick={() => {
                    setRemoving(file.id);
                    onRemove(file.id).catch((error:unknown) => {
                      setDeleteFailures(previous=>({...previous,[file.id]:{message:errorMessage(error,'xoá ảnh hồ sơ'),blocked:recordWriteBlocked(error)}}));
                    }).finally(() => setRemoving(null));
                  }}
                  className="absolute right-1 top-1 rounded-full bg-red-600 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:opacity-50">
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Chưa có ảnh.</p>
      )}
      {Object.entries(deleteFailures).map(([id,error])=><p key={id} role="alert" className="text-xs text-destructive">{error.message}</p>)}
      {children}
      <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden"
        aria-label={`Chụp ảnh ${label}`} onChange={(e) => void handleFiles(Array.from(e.target.files ?? []), e.target)} />
      <input ref={pickRef} type="file" accept={PICK_ACCEPT} multiple className="hidden"
        aria-label={`Chọn tệp ${label}`} onChange={(e) => void handleFiles(Array.from(e.target.files ?? []), e.target)} />
    </div>
  );
}
