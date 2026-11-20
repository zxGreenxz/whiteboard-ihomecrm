import { isRoomVideo } from '@/lib/roomMedia';
import { testMediaSource } from '@/lib/storage/testMedia';
import { StorageImage } from "@/components/ui/storage-image";
import ImageUploadZone from "@/components/customers/ImageUploadZone";
import { X, Star } from "lucide-react";
import { useRef } from "react";

/**
 * Grid ảnh sale 3 cột cho mobile: ảnh hiện có (đặt bìa = phần tử đầu, xoá) + ô
 * upload (ImageUploadZone) để thêm nhiều ảnh. Thứ tự mảng = thứ tự hiển thị.
 */
export default function MobileImageGrid({
  value, onChange, bucket = "room-sale-images", disabled = false, onUploadingChange, allowRoomVideo = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  bucket?: string;
  allowRoomVideo?: boolean;
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const imgs = value ?? [];
  const coverIndex = imgs.findIndex(url => !isRoomVideo(url));
  const latest = useRef(imgs);
  latest.current = imgs;
  const removeAt = (i: number) => onChange(imgs.filter((_, idx) => idx !== i));
  const toFront = (i: number) => {
    if (i === 0) return;
    const next = [...imgs];
    const [x] = next.splice(i, 1);
    next.unshift(x);
    onChange(next);
  };

  return (
    <div>
      {imgs.length > 0 && (
        <div className="sp-imggrid" style={{ marginBottom: 10 }}>
          {imgs.map((url, i) => (
            <div key={url + i} className="sp-imgcell">
              {isRoomVideo(url) ? <video src={testMediaSource(url)} controls playsInline preload="metadata" className="w-full h-28 object-contain" aria-label={`Video phòng ${i + 1}`} /> : <StorageImage value={url} alt={`Ảnh ${i + 1}`} />}
              {i === coverIndex ? (
                <span className="cover">Ảnh bìa</span>
              ) : !isRoomVideo(url) && (
                <button type="button" disabled={disabled} className="rm" style={{ left: 5, right: "auto", background: "rgba(31,122,82,.85)" }} title="Đặt làm bìa" onClick={() => toFront(i)}>
                  <Star size={12} />
                </button>
              )}
              <button type="button" disabled={disabled} className="rm" title="Xoá ảnh" onClick={() => removeAt(i)}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <ImageUploadZone
        label={allowRoomVideo ? "Thêm ảnh hoặc video" : "Thêm ảnh"}
        value=""
        multiple
        onChange={(url) => { if (url) onChange([...latest.current, url]); }}
        onAddMany={(urls) => { if (urls.length) onChange([...latest.current, ...urls]); }}
        disabled={disabled}
        onUploadingChange={onUploadingChange}
        bucket={bucket}
        allowRoomVideo={allowRoomVideo}
        accept={allowRoomVideo ? "image/png,image/jpeg,image/jpg,image/webp,video/mp4" : "image/png,image/jpeg,image/jpg,image/webp"}
        maxSizeMB={5}
      />
    </div>
  );
}
