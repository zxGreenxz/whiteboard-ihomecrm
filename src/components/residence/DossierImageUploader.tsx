// Một hàng ảnh của hồ sơ tạm trú (CT01 đã ký / hợp đồng đã ký / giấy chỗ ở hợp pháp):
// chụp trực tiếp bằng camera (điện thoại) hoặc chọn tệp từ máy, xem thumbnail, xoá.
import { useRef, useState } from 'react';
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
}

// Cổng DVC chỉ nhận pdf/jpg/jpeg/tiff/png, nên không mở cửa cho WebP ngay từ ô chọn tệp.
const PICK_ACCEPT = 'image/png,image/jpeg,image/jpg';

export default function DossierImageUploader({ kind, files, canEdit, contractId, onUpload, onRemove, hint }: DossierImageUploaderProps) {
  const captureRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const label = DOSSIER_KIND_LABEL[kind];

  const handleFiles = async (list: FileList | null, input: HTMLInputElement) => {
    const picked = Array.from(list ?? []);
    input.value = '';
    if (picked.length === 0) return;
    setPending(picked.length);
    try {
      // Tuần tự để thứ tự ảnh giữ đúng thứ tự người dùng chọn/chụp.
      for (const file of picked) {
        try {
          await onUpload({ kind, contractId, file });
        } catch {
          /* mutation đã toast lỗi của tệp này; vẫn tải tiếp các tệp còn lại */
        }
        setPending((n) => Math.max(0, n - 1));
      }
    } finally {
      setPending(0);
    }
  };

  const handleRemove = async (id: string) => {
    setRemoving(id);
    try { await onRemove(id); } catch { /* hook đã toast */ } finally { setRemoving(null); }
  };

  return (
    <div className="space-y-2" data-dossier-kind={kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {label} <span className="text-muted-foreground font-normal">({files.length} ảnh)</span>
        </p>
        {canEdit && (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={pending > 0} onClick={() => captureRef.current?.click()}>
              <Camera className="h-4 w-4" /> Chụp ảnh
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending > 0} onClick={() => pickRef.current?.click()}>
              {pending > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              {pending > 0 ? `Đang tải ${pending} ảnh…` : 'Chọn tệp'}
            </Button>
          </div>
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={`Ảnh ${label}`}>
          {files.map((file) => (
            <li key={file.id} className="relative group h-24 w-24 overflow-hidden rounded-md border">
              <StorageImage value={dossierStorageValue(file)} alt={file.file_name || label} className="h-full w-full object-cover" />
              {canEdit && (
                <button type="button" aria-label="Xoá ảnh" disabled={removing === file.id}
                  onClick={() => void handleRemove(file.id)}
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
      <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden"
        aria-label={`Chụp ảnh ${label}`} onChange={(e) => void handleFiles(e.target.files, e.target)} />
      <input ref={pickRef} type="file" accept={PICK_ACCEPT} multiple className="hidden"
        aria-label={`Chọn tệp ${label}`} onChange={(e) => void handleFiles(e.target.files, e.target)} />
    </div>
  );
}
